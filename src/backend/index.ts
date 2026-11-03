import { createTranslator, setTranslator } from './localization'
import { z } from 'zod'
import type { PluginDataApi, PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { EmailAccount, CachedMessage } from '../mailTypes'
import { cacheMailboxes, cachedMailboxes, cachedSentFolder, parseEmailAddresses, queryMessages, readMessage } from './query'
import { readAccounts as readEmailAccounts, upsertAccount, getAccount as getEmailAccount, removeAccountFiles, readFolder, mergeFolder, establishFolderEpoch, appendMessage, folderCacheStats, updateMessageFlags, moveCachedMessage, emailStoreContext, captureAccountRestore, restoreAccountFiles, forgetCachedMessage, cachedFolderHeaders, pruneFolder, cachedFolderUids, removeFromFolder, dropLocalCopies, readStructure, storeOpenedBody, type EmailStoreContext } from './cache'
import { accountEndpoint, credentialName, MAIL_CREDENTIAL_STORE, verifyImap, verifySmtp, mailDiagnostic, listFolders, fetchFolder, fetchMessageContent, fetchAttachmentSlice, appendSentMessage, sendMail, MailSendError, MailActionUncertain, applyMessageAction as applyRemoteMessageAction, type MailTransportApi } from './transport'
import { encodeBytes } from './encoding'
import { createMailWorkQueue } from './workQueue'
import { automationHeaders, MailRefusal, prepareAutomaticMail, type MailAutomationServices } from './automation'
import { createWorkflowAdapter } from './workflow'

interface MailRpc {
  handleOperation?: PluginBackendApi['rpc']['handleOperation']
  handle(name: string, handler: (payload: unknown) => Promise<unknown>): () => void
  emit(name: string, payload: unknown): void
}

export interface MailBackendApi extends MailTransportApi { services?: MailAutomationServices; notifications?: PluginBackendApi['notifications']; lifecycle?: PluginBackendApi['lifecycle']; settings?: PluginBackendApi['settings']; data: PluginDataApi; rpc: MailRpc; i18n?: { t(key: string, params?: Record<string, string | number>): string } }
interface MailBackendContext extends EmailStoreContext, MailTransportApi { /** The last opened body too large for the cache, as decoded pieces. */ opened?: Map<string, { text?: string[]; html?: string[] }>; /** Where the bounded UID SEARCH of older cached UIDs continues, per folder; a restart starts again from the oldest. */ reconcileCursors?: Map<string, { uidValidity: number; after: number }>; services?: MailAutomationServices & Partial<Pick<PluginBackendApi['services'], 'emit'>>; notifications?: PluginBackendApi['notifications']; settings?: PluginBackendApi['settings']; rpc: MailRpc; t: ReturnType<typeof createTranslator> }

class RemoteMailCacheError extends Error {
  constructor(message: string, readonly result: unknown) { super(message) }
}

const hostSchema = z.object({ host: z.string().min(1), port: z.number().int().positive(), secure: z.boolean() })

const accountId = (provider: string): string => `${provider}-${crypto.randomUUID()}`
// Validated but kept as given, so accounts.json gets back the removed record's exact key order.
const restoredAccountSchema = z.object({ id: z.string().regex(/^pureemail-[0-9a-f-]{36}$/), provider: z.literal('pureemail'), address: z.string().email(), imap: hostSchema, smtp: hostSchema, createdAt: z.number() }).passthrough()
const syncStateSchema = z.object({ uidValidity: z.number().int().positive().nullable(), cursor: z.string().max(32).nullable(), lastSyncAt: z.string().max(64).nullable() })

async function centralMailAccounts(scope: MailBackendContext): Promise<EmailAccount[]> {
  const hosts = {
    google: { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
    microsoft: { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } }
  }
  return (await scope.accounts.list()).flatMap((account): EmailAccount[] => {
    const endpoints = hosts[account.provider as keyof typeof hosts]
    return account.capabilities.includes('mail') && account.address && endpoints
      ? [{ id: account.id, provider: account.provider, address: account.address, displayName: account.displayName, createdAt: 0, secretState: account.credentialState, ...endpoints }]
      : []
  })
}

async function resolveAccount(scope: MailBackendContext, id: string): Promise<EmailAccount | null> {
  return (await centralMailAccounts(scope)).find((account) => account.id === id) ?? await getEmailAccount(scope, id)
}

function mailMethod<Schema extends z.ZodTypeAny, Result>(schema: Schema, run: (scope: MailBackendContext, payload: z.output<Schema>) => Promise<Result> | Result) {
  return { schema, run: (scope: MailBackendContext, payload: unknown) => run(scope, schema.parse(payload)) }
}

// Cached reads wait only for work that deletes or replaces cached mail, never behind an account's network work (sync, folders, send).
const CACHED_READS = new Set(['queryMessages', 'readMessage'])
const CACHE_REPLACING = new Set(['removeAccount', 'restoreAccount', 'restoreSyncState', 'forgetCachedMessage'])

const methods = {
  queryMessages: mailMethod(z.object({
    accountId: z.string().min(1), view: z.enum(['recent', 'unread', 'flagged', 'folder']),
    accountIds: z.array(z.string().min(1)).max(100).optional(),
    filters: z.object({ contact: z.enum(['all', 'known', 'unknown']).optional(), vip: z.enum(['all', 'vip', 'others']).optional(), spam: z.enum(['default', 'spam', 'not-spam', 'all']).optional(), categoryId: z.string().max(200).optional(), categoryIds: z.array(z.string().min(1).max(200)).min(1).max(500).optional(), categoryAccountId: z.string().min(1).optional() }).optional(),
    folder: z.string().min(1).optional(), query: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(200).optional(), cursor: z.string().max(10000).optional()
  }).refine((value) => value.view !== 'folder' || Boolean(value.folder), 'A folder is required.'),
  async (scope, input) => queryMessages(scope, input)),
  readMessage: mailMethod(z.object({ accountId: z.string().min(1), folder: z.string().min(1), uid: z.number().int().nonnegative(), uidValidity: z.number().int().positive().optional() }),
    async (scope, input) => ({ message: await readMessage(scope, input) })),
  parseAddresses: mailMethod(z.object({ value: z.string().max(32000) }),
    async (_root, input) => ({ addresses: parseEmailAddresses(input.value, true) })),
  listAccounts: mailMethod(z.object({}).optional(), async (scope) => {
      const central = await centralMailAccounts(scope)
      const local = (await readEmailAccounts(scope)).filter((a) => a.provider === 'pureemail')
      const decorated = await Promise.all(
        local.map(async (a) => ({ ...a, secretState: await scope.credentials.presence(credentialName(a.id), MAIL_CREDENTIAL_STORE) }))
      )
      // `{ accounts }`, like every other method here and like `EmailAccountsResult`
      // declares. A bare array put `accounts` at `data` itself, so every reader's
      // `data.accounts` was undefined and `accounts[0]` threw at vault open.
      return { accounts: [...central, ...decorated] }
    }),

  addSmtpAccount: mailMethod(z.object({
      address: z.string().email(),
      login: z.string().min(1).max(320).optional(),
      displayName: z.string().optional(),
      password: z.string().min(1),
      imap: hostSchema,
      smtp: hostSchema
    }), async (scope, payload) => {
      const p = payload
      const id = accountId('pureemail')
      const account: EmailAccount = {
        id,
        provider: 'pureemail',
        address: p.address,
        ...(p.login ? { login: p.login } : {}),
        displayName: p.displayName,
        imap: p.imap,
        smtp: p.smtp,
        createdAt: Date.now()
      }
      // Store the password first so both checks can read it, then roll back on failure.
      await scope.credentials.set(credentialName(id), p.password, [accountEndpoint(account, 'imap'), accountEndpoint(account, 'smtp')], MAIL_CREDENTIAL_STORE)
      try {
        await verifyImap(scope, account)
        await verifySmtp(scope, account).catch((error: unknown) => { throw new Error(`SMTP: ${mailDiagnostic(error)}`) })
      } catch (err) {
        await scope.credentials.delete(credentialName(id), MAIL_CREDENTIAL_STORE)
        throw err
      }
      await upsertAccount(scope, account)
      const central = await centralMailAccounts(scope)
      const local = (await readEmailAccounts(scope)).filter((a) => a.provider === 'pureemail')
      return { account, accounts: [...central, ...local] }
    }),

  updateSmtpAccount: mailMethod(z.object({ accountId: z.string().min(1), address: z.string().email(), login: z.string().min(1).max(320), password: z.string().min(1).max(65536) }).strict(), async (scope, payload) => {
      const previous = await getEmailAccount(scope, payload.accountId)
      if (!previous || previous.provider !== 'pureemail') throw new MailRefusal('ACCOUNT_NOT_FOUND', scope.t('email.backend.account'))
      const account = { ...previous, address: payload.address, login: payload.login }
      const endpoints = [accountEndpoint(account, 'imap'), accountEndpoint(account, 'smtp')]
      // Check both servers with the new password under a probe name, so a failed check keeps the saved account and password.
      const probe = { ...account, id: `${account.id}.verify` }
      await scope.credentials.set(credentialName(probe.id), payload.password, endpoints, MAIL_CREDENTIAL_STORE)
      try {
        await verifyImap(scope, probe)
        await verifySmtp(scope, probe).catch((error: unknown) => { throw new Error(`SMTP: ${mailDiagnostic(error)}`) })
      } finally {
        await scope.credentials.delete(credentialName(probe.id), MAIL_CREDENTIAL_STORE)
      }
      await scope.credentials.set(credentialName(account.id), payload.password, endpoints, MAIL_CREDENTIAL_STORE)
      await upsertAccount(scope, account)
      const central = await centralMailAccounts(scope)
      const local = (await readEmailAccounts(scope)).filter(item => item.provider === 'pureemail')
      return { account, accounts: [...central, ...local] }
    }),

  removeAccount: mailMethod(z.object({ accountId: z.string().min(1) }), async (scope, payload) => {
      const { accountId: id } = payload
      // Only locally stored (PureMail) accounts are removed here; centralized
      // Google/Microsoft accounts are managed in Settings → Accounts, so an id
      // without a local record is refused before any credential or cache change.
      if (!await getEmailAccount(scope, id)) throw new MailRefusal('ACCOUNT_NOT_FOUND', scope.t('email.backend.account'))
      // A stored password cannot be read back, so only a credential-less removal returns its exact restoreAccount input.
      const restore = await scope.credentials.presence(credentialName(id), MAIL_CREDENTIAL_STORE) === 'absent' ? await captureAccountRestore(scope, id) : null
      await scope.credentials.delete(credentialName(id), MAIL_CREDENTIAL_STORE)
      await removeAccountFiles(scope, id)
      const central = await centralMailAccounts(scope)
      const local = (await readEmailAccounts(scope)).filter((a) => a.provider === 'pureemail')
      return { accounts: [...central, ...local], restore }
    }),

  restoreAccount: mailMethod(z.object({ restore: z.object({
      index: z.number().int().nonnegative(),
      account: z.record(z.unknown()).refine((value) => restoredAccountSchema.safeParse(value).success, 'Invalid account record.'),
      folderMessages: z.array(z.record(z.unknown())).max(20000), messages: z.array(z.record(z.unknown())).max(20000)
    }).strict() }).strict(), async (scope, { restore }) => {
      const id = String(restore.account.id)
      if ([...restore.folderMessages, ...restore.messages].some((row) => row.accountId !== id)) throw new MailRefusal('INVALID_INPUT', scope.t('email.backend.account'))
      if (await scope.credentials.presence(credentialName(id), MAIL_CREDENTIAL_STORE) !== 'absent') throw new MailRefusal('ACCOUNT_EXISTS', scope.t('email.backend.accountsChanged'))
      const accounts = await restoreAccountFiles(scope, restore as unknown as Parameters<typeof restoreAccountFiles>[1])
      if (!accounts) throw new MailRefusal('ACCOUNT_EXISTS', scope.t('email.backend.accountsChanged'))
      const central = await centralMailAccounts(scope)
      return { account: restore.account as unknown as EmailAccount, accounts: [...central, ...accounts.filter((a) => a.provider === 'pureemail')] }
    }),

  testAccount: mailMethod(z.object({ accountId: z.string().min(1).max(4096) }).strict(), async (scope, payload) => {
      const account = await resolveAccount(scope, payload.accountId)
      if (!account) throw new MailRefusal('ACCOUNT_NOT_FOUND', scope.t('email.backend.account'))
      const test = async (action: () => Promise<void>) => { try { await action(); return { ok: true } } catch (error) { return { ok: false, error: mailDiagnostic(error) } } }
      const imap = await test(() => verifyImap(scope, account))
      const smtp = await test(() => verifySmtp(scope, account))
      return { checkedAt: new Date().toISOString(), imap, smtp }
    }),

  listFolders: mailMethod(z.object({ accountId: z.string().min(1) }), async (scope, payload) => {
      const account = await resolveAccount(scope, payload.accountId)
      if (!account) throw new MailRefusal('ACCOUNT_NOT_FOUND', scope.t('email.backend.account'))
      let listed
      let warning: string | undefined
      try {
        listed = await listFolders(scope, account)
        await cacheMailboxes(scope, payload.accountId, listed)
      } catch (error) {
        const cached = await cachedMailboxes(scope, payload.accountId)
        if (!cached.length) throw error
        warning = scope.t('email.backend.cachedFoldersWarning', { error: mailDiagnostic(error) })
        listed = cached.map((row) => ({ path: String(row.path), name: String(row.name),
          selectable: row.selectable === true, specialUse: typeof row.specialUse === 'string' ? row.specialUse : undefined }))
      }
      const counts = await folderCacheStats(scope, payload.accountId)
      const mailboxes = listed.map((mailbox) => {
        const stats = counts.get(mailbox.path) ?? { total: 0, unread: 0 }
        return { ...mailbox, cachedTotal: stats.total, cachedUnread: stats.unread }
      })
      return { folders: mailboxes.filter((mailbox) => mailbox.selectable).map((mailbox) => mailbox.path), mailboxes, ...(warning ? { warning } : {}) }
    }),

  syncFolder: mailMethod(z.object({
      accountId: z.string().min(1),
      folder: z.string().min(1).default('INBOX'),
      limit: z.number().int().positive().max(500).default(50)
    }), async (scope, payload) => {
      const p = payload
      const account = await resolveAccount(scope, p.accountId)
      if (!account) throw new MailRefusal('ACCOUNT_NOT_FOUND', scope.t('email.backend.account'))
      scope.rpc.emit('sync', { accountId: p.accountId, folder: p.folder, status: 'start' })
      try {
        const previous = await scope.data.dataset('sync_state').get({ accountId: p.accountId, folder: p.folder })
        const cursorKey = JSON.stringify([p.accountId, p.folder])
        let established: boolean | undefined
        // The folder's epoch is settled right after SELECT, before any batch is stored; a SELECT without UIDVALIDITY never wipes a known folder.
        const epoch = async (value: number | undefined): Promise<void> => {
          if (value === undefined && typeof previous?.uidValidity === 'number') throw new Error(scope.t('email.backend.uidValidityMissing'))
          established = await establishFolderEpoch(scope, p.accountId, p.folder, value)
        }
        const synced = await fetchFolder(scope, account, p.folder, p.limit, async (uids, value) => previous?.uidValidity === value ? cachedFolderHeaders(scope, p.accountId, p.folder, uids, value) : new Map(), {
          epoch, store: async (batch) => { await mergeFolder(scope, p.accountId, p.folder, batch) }, cachedUids: (value) => cachedFolderUids(scope, p.accountId, p.folder, value),
          reconcileFrom: (value) => { const cursor = scope.reconcileCursors?.get(cursorKey); return { after: cursor?.uidValidity === value ? cursor.after : 0, recheck: pendingRemoval(previous?.pendingRemoval, value) } }
        })
        const uidValidity = synced.uidValidity
        if (established === undefined) await epoch(uidValidity)
        if (synced.reconciledThrough !== undefined && uidValidity !== undefined) scope.reconcileCursors?.set(cursorKey, { uidValidity, after: synced.reconciledThrough })
        const messages = [...synced.messages, ...synced.stored ?? []]
        let count = await mergeFolder(scope, p.accountId, p.folder, synced.messages)
        const earlier = pendingRemoval(previous?.pendingRemoval, uidValidity)
        const confirmed = synced.removed && uidValidity !== undefined ? confirmedRemovals(earlier, synced.removed, synced.checked ?? 0) : { removing: [], pending: earlier }
        const removing = confirmed.removing
        const removed = (removing.length ? await removeFromFolder(scope, p.accountId, p.folder, removing) : 0) + await dropLocalCopies(scope, p.accountId, p.folder)
        if (removed) count = await scope.data.dataset('folder_messages').count({ accountId: p.accountId, folder: p.folder })
        const keepDays = Number(scope.settings?.get().cacheDays)
        if (Number.isSafeInteger(keepDays) && keepDays > 0 && await pruneFolder(scope, p.accountId, p.folder, messages.map(message => message.uid), keepDays)) count = await scope.data.dataset('folder_messages').count({ accountId: p.accountId, folder: p.folder })
        const arrived = established && p.folder.toUpperCase() === 'INBOX' ? messages.filter(message => message.uid > Number(previous?.cursor ?? 0) && !message.flags.includes('\\Seen') && message.receivedAt && Date.parse(message.receivedAt) >= Date.parse(String(previous?.lastSyncAt))).map(message => message.uid) : []
        const arrivedIds: string[] = []
        for (let offset = 0; offset < arrived.length; offset += 100) {
          const page = await scope.data.dataset('folder_messages').query({ where: { accountId: p.accountId, folder: p.folder, uid: { in: arrived.slice(offset, offset + 100) } }, select: ['messageId'], limit: 100 })
          arrivedIds.push(...page.rows.map(row => String(row.messageId)))
        }
        await scope.data.dataset('sync_state').upsert({ accountId: p.accountId, folder: p.folder, uidValidity: uidValidity ?? null, cursor: String(Math.max(established ? Number(previous?.cursor ?? 0) : 0, ...messages.map(message => message.uid))), lastSyncAt: new Date().toISOString(),
          ...(confirmed.pending && uidValidity !== undefined ? { pendingRemoval: { uidValidity, uids: confirmed.pending } } : previous?.pendingRemoval != null ? { pendingRemoval: null } : {}) })
        for (const message of messages.filter(message => arrived.includes(message.uid))) {
          await scope.services?.emit?.('workflow.provider', 'message.received', { accountId: p.accountId, folder: p.folder, uid: message.uid, ...(uidValidity ? { uidValidity } : {}), messageId: message.messageId, from: message.from, to: message.to, subject: message.subject, ...(message.automationHeaders ? { automationHeaders: message.automationHeaders } : {}), ...(message.automationHeaders?.inReplyTo?.[0] ? { inReplyTo: message.automationHeaders.inReplyTo[0] } : {}) })
          await scope.notifications?.notify('newMail', {
            sourceEventId: `${p.accountId}:${uidValidity}:${message.uid}`, key: `mail:${p.accountId}:${uidValidity}:${message.uid}`,
            targetItemId: JSON.stringify({ accountId: p.accountId, folder: p.folder, uid: message.uid, uidValidity }),
            title: message.subject || scope.t('notification.newMail'), body: message.from,
            actions: [
              { id: 'open', kind: 'open', label: scope.t('notification.open') },
              { id: 'read', kind: 'action', label: scope.t('notification.read') },
              { id: 'reply', kind: 'reply', label: scope.t('notification.reply'), placeholder: scope.t('notification.reply') }
            ]
          }).catch(() => false)
        }
        scope.rpc.emit('sync', {
          accountId: p.accountId,
          folder: p.folder,
          status: 'done',
          arrived: arrivedIds,
          fetched: messages.length,
          total: count,
          ...(synced.unavailable?.length ? { unavailable: synced.unavailable.length } : {}),
          ...(removed ? { removed } : {})
        })
        return { fetched: messages.length, total: count }
      } catch (err) {
        scope.rpc.emit('sync', {
          accountId: p.accountId,
          folder: p.folder,
          status: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
        throw err
      }
    }),

  restoreSyncState: mailMethod(z.object({ accountId: z.string().min(1), folder: z.string().min(1), expected: syncStateSchema.nullable(), previous: syncStateSchema.nullable() }).strict(), async (scope, input) => {
      if (!await resolveAccount(scope, input.accountId)) throw new MailRefusal('ACCOUNT_NOT_FOUND', scope.t('email.backend.account'))
      const key = { accountId: input.accountId, folder: input.folder }, current = await scope.data.dataset('sync_state').get(key)
      const state = (row: Record<string, unknown> | null | undefined) => row ? { uidValidity: typeof row.uidValidity === 'number' ? row.uidValidity : null, cursor: typeof row.cursor === 'string' ? row.cursor : null, lastSyncAt: typeof row.lastSyncAt === 'string' ? row.lastSyncAt : null } : null
      if (JSON.stringify(state(current)) !== JSON.stringify(state(input.expected))) throw new MailRefusal('REVISION_CONFLICT', scope.t('email.backend.mailboxChanged'))
      // A large removal waiting for its second sync was seen against the state being replaced, so it goes too.
      if (input.previous) await scope.data.dataset('sync_state').upsert({ ...key, ...state(input.previous), ...(current?.pendingRemoval != null ? { pendingRemoval: null } : {}) })
      else if (current) await scope.data.dataset('sync_state').delete(key)
      return { syncState: input.previous ? { ...key, ...state(input.previous) } : null }
    }),

  forgetCachedMessage: mailMethod(z.object({ accountId: z.string().min(1), folder: z.string().min(1), uid: z.number().int().nonnegative() }).strict(), async (scope, input) => {
      if (!await resolveAccount(scope, input.accountId)) throw new MailRefusal('ACCOUNT_NOT_FOUND', scope.t('email.backend.account'))
      const forgotten = await forgetCachedMessage(scope, input.accountId, input.folder, input.uid)
      if (!forgotten.removed) throw new MailRefusal('MESSAGE_NOT_FOUND', scope.t('email.selectionMissing'))
      return { accountId: input.accountId, folder: input.folder, uid: input.uid, messageRemoved: forgotten.message }
    }),

  readFolder: mailMethod(z.object({ accountId: z.string().min(1), folder: z.string().min(1).default('INBOX'), uid: z.number().int().positive().optional(), limit: z.number().int().min(1).max(1000).optional() }), async (scope, payload) => {
      const p = payload
      return { messages: await readFolder(scope, p.accountId, p.folder, { uid: p.uid, limit: p.limit }) }
    }),

  sendEmail: mailMethod(z.object({
      accountId: z.string().min(1),
      to: z.string().min(1),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      subject: z.string().default(''),
      text: z.string().optional(),
      html: z.string().optional(),
      inReplyTo: z.string().optional()
    }), async (scope, payload) => {
      const p = payload
      const account = await resolveAccount(scope, p.accountId)
      if (!account) throw new MailRefusal('ACCOUNT_NOT_FOUND', scope.t('email.backend.account'))
      const attempt = crypto.randomUUID()
      const automatic = await prepareAutomaticMail(scope, account, p)
      let messageId: string
      let mime: Uint8Array | undefined
      try { messageId = await sendMail(scope, account, p, automatic, bytes => { mime = bytes }) }
      catch (error) {
        const uncertain = !(error instanceof MailSendError && error.outcome === 'not-applied')
        if (!uncertain) await automatic?.release().catch(() => undefined)
        await scope.notifications?.notify('sendFailed', { sourceEventId: attempt, key: `send:${attempt}`, title: scope.t(uncertain ? 'notification.sendUncertain' : 'notification.sendFailed'), body: p.subject, targetItemId: p.accountId, actions: [{ id: 'open', kind: 'open', label: scope.t('notification.open') }] }).catch(() => false)
        throw error
      }
      // A generic IMAP server keeps only what the client stores: put the sent copy into its Sent folder. Provider accounts save it themselves.
      // A failure here never changes the send outcome; the local copy stays until a sync finds the server's copy.
      const stored = mime && account.provider === 'pureemail' ? await appendSentMessage(scope, account, mime).catch(() => undefined) : undefined
      const sent: CachedMessage = {
        automationHeaders: automationHeaders([...(automatic ? [{ key: 'Auto-Submitted', value: 'auto-generated' }, { key: 'X-Valley-Origin', value: automatic.origin }] : []), ...(p.inReplyTo ? [{ key: 'In-Reply-To', value: p.inReplyTo }, { key: 'References', value: p.inReplyTo }] : [])]),
        uid: stored?.uid ?? Date.now(),
        ...(stored?.uidValidity ? { uidValidity: stored.uidValidity } : {}),
        messageId,
        from: account.address,
        to: p.to,
        cc: p.cc,
        subject: p.subject,
        date: new Date().toISOString(),
        snippet: (p.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
        text: p.text,
        html: p.html,
        flags: ['\\Seen'],
        hasAttachments: false
      }
      try { await automatic?.complete(); await appendMessage(scope, p.accountId, stored?.folder ?? await cachedSentFolder(scope, p.accountId), sent) }
      catch { throw new RemoteMailCacheError(scope.t('email.backend.sentCacheFailed'), { messageId }) }
      return { messageId }
    }),

  applyMessageAction: mailMethod(z.object({
      accountId: z.string().min(1),
      folder: z.string().min(1),
      uid: z.number().int().positive(), uidValidity: z.number().int().positive().optional(),
      action: z.enum(['mark-read', 'mark-unread', 'flag', 'unflag', 'archive', 'trash', 'junk'])
    }), async (scope, payload) => {
      const account = await resolveAccount(scope, payload.accountId)
      if (!account) throw new MailRefusal('ACCOUNT_NOT_FOUND', scope.t('email.backend.account'))
      if (payload.uidValidity !== undefined && !(await readMessage(scope, payload))) throw new MailRefusal('MESSAGE_NOT_FOUND', scope.t('email.selectionMissing'))
      const remote = await applyRemoteMessageAction(scope, account, payload.folder, payload.uid, payload.action, payload.uidValidity)
      let messages: CachedMessage[]
      try {
        if (remote.destinationFolder) {
          messages = await moveCachedMessage(
            scope,
            payload.accountId,
            payload.folder,
            remote.destinationFolder,
            payload.uid,
            remote.destinationUid,
            remote.destinationUidValidity
          )
        } else {
          const add = payload.action === 'mark-read'
            ? ['\\Seen']
            : payload.action === 'flag'
              ? ['\\Flagged']
              : []
          const remove = payload.action === 'mark-unread'
            ? ['\\Seen']
            : payload.action === 'unflag'
              ? ['\\Flagged']
              : []
          messages = await updateMessageFlags(scope, payload.accountId, payload.folder, payload.uid, add, remove)
        }
      } catch {
        throw new RemoteMailCacheError(scope.t('email.backend.actionCacheFailed'), { action: payload.action, folder: payload.folder, destinationFolder: remote.destinationFolder })
      }
      return {
        action: payload.action,
        folder: payload.folder,
        messages,
        destinationFolder: remote.destinationFolder
      }
    })
}

/**
 * A removal of more than ten messages and more than a quarter of the checked cache (an emptied folder included) is applied only
 * for the UIDs that two consecutive consistent answers both reported missing; smaller removals apply at once. The first answer
 * waits in the folder's sync state, so a restart between the two syncs keeps it.
 */
function confirmedRemovals(earlier: number[] | null, removed: number[], checked: number): { removing: number[]; pending: number[] | null } {
  if (removed.length <= 10 || removed.length * 4 <= checked) return { removing: removed, pending: null }
  if (!earlier) return { removing: [], pending: removed }
  const seen = new Set(earlier)
  return { removing: removed.filter(uid => seen.has(uid)), pending: null }
}

/** The UIDs an earlier sync of the same folder epoch reported missing, or null. */
function pendingRemoval(value: unknown, uidValidity: number | undefined): number[] | null {
  if (uidValidity === undefined || !value || typeof value !== 'object') return null
  const { uidValidity: epoch, uids } = value as { uidValidity?: unknown; uids?: unknown }
  return epoch === uidValidity && Array.isArray(uids) && uids.every(uid => Number.isSafeInteger(uid)) ? uids as number[] : null
}

/** Characters of a body returned by one loadMessageContent reply. */
const BODY_SLICE_CHARACTERS = 512 * 1024
/** Characters of text and HTML the cache stores for one opened message (at most 3 MiB of UTF-8, under the host's 4 MiB data request); a larger body stays in memory for the open message only. */
const STORED_BODY_CHARACTERS = 1024 * 1024
const piecesLength = (pieces: string[] | undefined): number => pieces?.reduce((total, piece) => total + piece.length, 0) ?? 0
function slicePieces(pieces: string[], offset: number, length: number): { total: number; chunk: string } {
  const parts: string[] = []
  let total = 0
  for (const piece of pieces) {
    if (total + piece.length > offset && total < offset + length) parts.push(piece.slice(Math.max(0, offset - total), Math.min(piece.length, offset + length - total)))
    total += piece.length
  }
  return { total, chunk: parts.join('') }
}
const openedRef = { accountId: z.string().min(1), folder: z.string().min(1), uid: z.number().int().positive(), uidValidity: z.number().int().positive().optional() }

async function openedMembership(scope: MailBackendContext, input: { accountId: string; folder: string; uid: number; uidValidity?: number }) {
  const membership = await scope.data.dataset('folder_messages').get({ accountId: input.accountId, folder: input.folder, uid: input.uid })
  if (!membership || input.uidValidity !== undefined && membership.uidValidity !== input.uidValidity) throw new MailRefusal('MESSAGE_NOT_FOUND', scope.t('email.selectionMissing'))
  return membership
}

async function messageColumns(scope: MailBackendContext, id: string, columns: string[]): Promise<Record<string, unknown> | null> {
  return (await scope.data.dataset('messages').query({ where: { id }, select: ['id', ...columns], limit: 1 })).rows[0] ?? null
}

/** UI-only reads that reach the mail server for one opened message; they are not published as commands. */
const openedMail = {
  loadMessageContent: mailMethod(z.object({ ...openedRef, field: z.enum(['text', 'html']), offset: z.number().int().min(0) }).strict(), async (scope, input) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const membership = await openedMembership(scope, input)
      const id = String(membership.messageId)
      const row = await messageColumns(scope, id, ['structure', input.field])
      if (!row) throw new MailRefusal('MESSAGE_NOT_FOUND', scope.t('email.selectionMissing'))
      const structure = readStructure(row.structure)
      const key = JSON.stringify([input.accountId, input.folder, input.uid, membership.uidValidity ?? null, id])
      const held = structure?.failure ? undefined : scope.opened?.get(key)
      if (attempt === 2 || held || !structure?.failure && !structure?.deferred?.length) {
        const pieces = held ? held[input.field] ?? [] : typeof row[input.field] === 'string' ? [row[input.field] as string] : []
        return { field: input.field, offset: input.offset, ...slicePieces(pieces, input.offset, BODY_SLICE_CHARACTERS) }
      }
      const account = await resolveAccount(scope, input.accountId)
      if (!account) throw new MailRefusal('ACCOUNT_NOT_FOUND', scope.t('email.backend.account'))
      const epoch = typeof membership.uidValidity === 'number' ? membership.uidValidity : undefined
      const fetched = await fetchMessageContent(scope, account, input.folder, input.uid, epoch, structure.failure ? undefined : structure.deferred)
      if (!fetched.message) {
        if (piecesLength(fetched.text) + piecesLength(fetched.html) <= STORED_BODY_CHARACTERS) await storeOpenedBody(scope, id, { text: fetched.text?.join(''), html: fetched.html?.join('') }, structure)
        else { scope.opened?.clear(); scope.opened?.set(key, { text: fetched.text, html: fetched.html }) }
        continue
      }
      // A message stored as unavailable is replaced by the downloaded one; its placeholder row goes once nothing holds it.
      await mergeFolder(scope, input.accountId, input.folder, [fetched.message])
      if (!(await scope.data.dataset('folder_messages').count({ accountId: input.accountId, messageId: id }))) await scope.data.transaction([{ operation: 'delete', dataset: 'messages', key: { id } }])
    }
    throw new MailRefusal('MESSAGE_NOT_FOUND', scope.t('email.selectionMissing'))
  }),
  readAttachment: mailMethod(z.object({ ...openedRef, index: z.number().int().min(0).max(10000), offset: z.number().int().min(0) }).strict(), async (scope, input) => {
    const membership = await openedMembership(scope, input)
    const row = await messageColumns(scope, String(membership.messageId), ['structure'])
    const part = readStructure(row?.structure)?.attachments?.[input.index]
    if (!part) throw new MailRefusal('MESSAGE_NOT_FOUND', scope.t('email.selectionMissing'))
    const account = await resolveAccount(scope, input.accountId)
    if (!account) throw new MailRefusal('ACCOUNT_NOT_FOUND', scope.t('email.backend.account'))
    const bytes = input.offset >= part.encodedSize ? new Uint8Array() : await fetchAttachmentSlice(scope, account, input.folder, input.uid, typeof membership.uidValidity === 'number' ? membership.uidValidity : undefined, part.part, input.offset)
    return { filename: part.filename, mimeType: part.mimeType, encoding: part.encoding, encodedSize: part.encodedSize, offset: input.offset, data: encodeBytes(bytes) }
  })
}

export function register(api: MailBackendApi): () => Promise<void> {
  const backend = api as unknown as PluginBackendApi
  const workflow = backend.schema ? createWorkflowAdapter(backend, { readiness: async (nodeId, context) => {
    if (nodeId === 'listAccounts' || nodeId === 'parseAddresses') return { state: 'Available' }
    const owner = context?.api ?? backend
    const local = await readEmailAccounts(emailStoreContext(owner.data))
    const central = await owner.accounts.list()
    return local.length || central.some(account => account.capabilities.includes('mail')) ? { state: 'Available' } : { state: 'Unconfigured', reason: 'Add or reconnect an account in Email or Accounts settings.' }
  } }) : undefined
  setTranslator(api.i18n?.t)
  const t = createTranslator(api.i18n?.t)
  const work = createMailWorkQueue({ busy: () => t('email.backend.busy'), stopped: () => t('email.backend.stopped') })
  let disposed = false
  let draining: Promise<void> | undefined
  const scope: MailBackendContext = {
    ...emailStoreContext(api.data), network: api.network, credentials: api.credentials, accounts: api.accounts, services: api.services, t, notifications: api.notifications, settings: api.settings,
    rpc: { handle: api.rpc.handle, emit: (name, payload) => { if (!disposed) api.rpc.emit(name, payload) } }, opened: new Map(), reconcileCursors: new Map()
  }
  const off = [...Object.entries(methods), ...Object.entries(openedMail)].map(([name, method]) => {
    const handler = async (payload: unknown, operation?: PluginBackendOperationContext) => {
    const parsed = method.schema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: parsed.error.message, code: 'INVALID_INPUT', outcome: 'not-applied' as const }
    try {
      const input = parsed.data
      const accountIds = input && 'accountIds' in input && Array.isArray(input.accountIds) && input.accountIds.length
        ? input.accountIds.filter((id): id is string => typeof id === 'string')
        : input && 'accountId' in input && typeof input.accountId === 'string' ? [input.accountId] : []
      const keys = [...new Set(accountIds)].flatMap(id => CACHED_READS.has(name) ? [`cache:${id}`] : CACHE_REPLACING.has(name) ? [`account:${id}`, `cache:${id}`] : [`account:${id}`])
      if (name === 'restoreAccount' && input && 'restore' in input) keys.push(`account:${String((input.restore as { account: { id: unknown } }).account.id)}`)
      if (name === 'addSmtpAccount' || name === 'updateSmtpAccount' || name === 'removeAccount' || name === 'restoreAccount' || name === 'listAccounts') keys.push('account-registry')
      const bytes = new TextEncoder().encode(JSON.stringify(input ?? null)).length
      return { ok: true, data: await work.run(keys, bytes, async () => {
        operation?.cancellation.throwIfAborted()
        const context = operation ? { ...scope, ...emailStoreContext(operation.api.data), network: operation.api.network, credentials: operation.api.credentials, accounts: operation.api.accounts, services: operation.api.services } : scope
        return method.run(context, input)
      }) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? mailDiagnostic(error) : 'Mail operation failed.',
        ...(error instanceof RemoteMailCacheError ? { outcome: 'remote-complete' as const, data: error.result } : {}),
        ...(error instanceof MailSendError ? { code: error.outcome === 'unknown' ? 'SEND_OUTCOME_UNKNOWN' : 'SEND_FAILED', outcome: error.outcome } : {}),
        ...(error instanceof MailRefusal || error instanceof MailActionUncertain ? { code: error.code, outcome: error.outcome } : {}) }
    }
  }
    const operation = !(name in methods) ? undefined : workflow ? workflow.operation(`command.${name}`, handler) : api.rpc.handleOperation?.(`command.${name}`, handler)
    const existingOperation = name === 'queryMessages' ? api.rpc.handleOperation?.(name, handler) : undefined
    const rpc = name === 'queryMessages' && operation ? undefined : api.rpc.handle(name, handler)
    return () => { operation?.(); existingOperation?.(); rpc?.() }
  })
  off.push(api.rpc.handle('notifications.action', async payload => {
    const event = z.object({ action: z.enum(['read', 'reply']), targetItemId: z.string().max(256), input: z.string().max(16384).optional(), occurrenceId: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().parse(payload)
    const ref = z.object({ accountId: z.string(), folder: z.string(), uid: z.number().int().positive(), uidValidity: z.number().int().positive().optional() }).strict().parse(JSON.parse(event.targetItemId))
    return work.run([`account:${ref.accountId}`], event.input?.length ?? 0, async () => {
      const message = await readMessage(scope, ref)
      if (!message) return false
      if (event.action === 'read') return methods.applyMessageAction.run(scope, { ...ref, action: 'mark-read' })
      if (!event.input?.trim()) return false
      const draft = { accountId: ref.accountId, to: message.from, subject: /^Re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`, text: event.input, inReplyTo: message.messageId }
      const file = `notification-replies/${event.occurrenceId}.json`
      const existing = await api.data.files.readTextBaseline(file)
      if (existing) return false
      const saveReply = async (state: unknown): Promise<void> => {
        const current = await api.data.files.readTextBaseline(file)
        const result = await api.data.files.writeTextGuarded(file, JSON.stringify(state), current?.baseline ?? null)
        if (!result.ok) throw new Error('Could not persist reply outcome')
      }
      const reserved = await api.data.files.writeTextGuarded(file, JSON.stringify({ state: 'pending', draft }), null)
      if (!reserved.ok) return false
      const drafts = api.data.dataset('drafts')
      const compose = await drafts.read({ id: 'compose' })
      let retainedId: number | undefined
      if (!compose.value) {
        const id = Date.now()
        try {
          await drafts.insert({ id: 'compose', delivery: 'sending', draft: { ...draft, id, mode: 'reply', to: parseEmailAddresses(draft.to).map(({ name, address }) => ({ name, address })), cc: [], bcc: [], pending: { to: '', cc: '', bcc: '' }, dirty: true } }, { expected: [{ dataset: 'drafts', key: { id: 'compose' }, revision: compose.revision }], operationId: crypto.randomUUID() })
          retainedId = id
        } catch { /* The occurrence file remains recoverable if another draft wins. */ }
      }
      try {
        const result = await methods.sendEmail.run(scope, draft)
        await saveReply({ state: 'completed', messageId: result.messageId })
        if (retainedId !== undefined) {
          const current = await drafts.read({ id: 'compose' })
          if ((current.value?.draft as { id?: number } | undefined)?.id === retainedId) await drafts.delete({ id: 'compose' }, { expected: [{ dataset: 'drafts', key: { id: 'compose' }, revision: current.revision }], operationId: crypto.randomUUID() })
        }
        return true
      } catch (error) {
        await saveReply({ state: error instanceof MailSendError && error.outcome === 'not-applied' || error instanceof MailRefusal ? 'failed' : 'unknown', draft })
        throw error
      }
    })
  }))
  const failures = new Map<string, number>()
  let polling: Promise<void> | undefined
  const poll = (): void => {
    if (disposed || polling || !api.notifications) return
    polling = (async () => {
      const accounts = [...await centralMailAccounts(scope), ...await readEmailAccounts(scope)]
      for (const account of accounts) {
        if (disposed) return
        try {
          await work.run([`account:${account.id}`], 0, async () => methods.syncFolder.run(scope, { accountId: account.id, folder: 'INBOX', limit: Math.min(500, Number(api.settings?.get().syncLimit) || 50) }))
          failures.delete(account.id)
        } catch {
          const count = (failures.get(account.id) ?? 0) + 1
          failures.set(account.id, count)
          if (count === 3) {
            const last = await scope.data.dataset('sync_state').get({ accountId: account.id, folder: 'INBOX' })
            await api.notifications?.notify('syncFailed', { sourceEventId: `${account.id}:${last?.lastSyncAt ?? 'initial'}`, key: `sync:${account.id}`, title: t('notification.syncFailed'), body: account.address, targetItemId: account.id, actions: [{ id: 'open', kind: 'open', label: t('notification.open') }] })
          }
        }
      }
    })().catch(() => undefined).finally(() => { polling = undefined })
  }
  const timer = api.notifications ? setInterval(poll, 60_000) : undefined
  const offResume = api.lifecycle?.onResume(poll)
  let initialPoll: ReturnType<typeof setTimeout> | undefined
  const startPolling = () => { if (!disposed && api.notifications) initialPoll = setTimeout(poll, 0) }
  if (workflow) void workflow.ready.then(startPolling, startPolling)
  else startPolling()
  return () => {
    if (draining) return draining
    disposed = true
    workflow?.dispose()
    clearTimeout(initialPoll)
    clearInterval(timer)
    offResume?.()
    const accepted = work.dispose()
    const unregistering = off.map(dispose => { try { dispose(); return Promise.resolve() } catch (error) { return Promise.reject(error) } })
    draining = Promise.allSettled([accepted, ...unregistering]).then(results => {
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
    return draining
  }
}
