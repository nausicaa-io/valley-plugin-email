import { t, setTranslator } from './localization'
import { z } from 'zod'
import type { PluginDataApi } from '@valley/plugin-sdk'
import type { EmailAccount, CachedMessage } from '../mailTypes'
import { cacheMailboxes, cachedMailboxes, parseEmailAddresses, queryMessages, readMessage } from './query'
import { readAccounts as readEmailAccounts, upsertAccount, getAccount as getEmailAccount, removeAccountFiles, readFolder, mergeFolder, appendMessage, folderCacheStats, updateMessageFlags, moveCachedMessage, emailStoreContext, type EmailStoreContext } from './cache'
import { accountEndpoint, credentialName, MAIL_CREDENTIAL_STORE, verifyImap, listFolders, fetchFolder, sendMail, applyMessageAction as applyRemoteMessageAction, type MailTransportApi } from './transport'

interface MailRpc {
  handle(name: string, handler: (payload: unknown) => Promise<unknown>): () => void
  emit(name: string, payload: unknown): void
}

export interface MailBackendApi extends MailTransportApi { data: PluginDataApi; rpc: MailRpc; i18n?: { t(key: string, params?: Record<string, string | number>): string } }
interface MailBackendContext extends EmailStoreContext, MailTransportApi { rpc: MailRpc }

const hostSchema = z.object({ host: z.string().min(1), port: z.number().int().positive(), secure: z.boolean() })

const accountId = (provider: string): string => `${provider}-${crypto.randomUUID()}`

async function centralMailAccounts(scope: MailBackendContext): Promise<EmailAccount[]> {
  const hosts = {
    google: { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
    microsoft: { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } }
  }
  return (await scope.accounts.list()).flatMap((account): EmailAccount[] => {
    const endpoints = hosts[account.provider as keyof typeof hosts]
    return account.capabilities.includes('mail') && account.address && endpoints
      ? [{ id: account.id, provider: account.provider, address: account.address, displayName: account.displayName, createdAt: 0, ...endpoints }]
      : []
  })
}

async function resolveAccount(scope: MailBackendContext, id: string): Promise<EmailAccount | null> {
  return (await centralMailAccounts(scope)).find((account) => account.id === id) ?? await getEmailAccount(scope, id)
}

function mailMethod<Schema extends z.ZodTypeAny, Result>(schema: Schema, run: (scope: MailBackendContext, payload: z.output<Schema>) => Promise<Result> | Result) {
  return { schema, run: (scope: MailBackendContext, payload: unknown) => run(scope, schema.parse(payload)) }
}

const methods = {
  queryMessages: mailMethod(z.object({
    accountId: z.string().min(1), view: z.enum(['recent', 'unread', 'flagged', 'folder']),
    accountIds: z.array(z.string().min(1)).optional(),
    folder: z.string().min(1).optional(), query: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(200).optional(), cursor: z.string().max(10000).optional()
  }).refine((value) => value.view !== 'folder' || Boolean(value.folder), 'A folder is required.'),
  async (scope, input) => queryMessages(scope, input)),
  readMessage: mailMethod(z.object({ accountId: z.string().min(1), folder: z.string().min(1), uid: z.number().int().nonnegative() }),
    async (scope, input) => ({ message: await readMessage(scope, input) })),
  parseAddresses: mailMethod(z.object({ value: z.string().max(32000) }),
    async (_root, input) => ({ addresses: parseEmailAddresses(input.value, true) })),
  listAccounts: mailMethod(z.object({}).optional(), async (scope) => {
      const central = await centralMailAccounts(scope)
      const local = (await readEmailAccounts(scope)).filter((a) => a.provider === 'pureemail')
      // Surface password health so the settings pane can prompt a re-entry
      // after a keychain reset instead of failing silently at sync time.
      const decorated = await Promise.all(
        local.map(async (a) => ({ ...a, secretState: await scope.credentials.state(credentialName(a.id), MAIL_CREDENTIAL_STORE) }))
      )
      // `{ accounts }`, like every other method here and like `EmailAccountsResult`
      // declares. A bare array put `accounts` at `data` itself, so every reader's
      // `data.accounts` was undefined and `accounts[0]` threw at vault open.
      return { accounts: [...central, ...decorated] }
    }),

  addSmtpAccount: mailMethod(z.object({
      address: z.string().email(),
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
        displayName: p.displayName,
        imap: p.imap,
        smtp: p.smtp,
        createdAt: Date.now()
      }
      // Store the password first so verifyImap can read it, then roll back on failure.
      await scope.credentials.set(credentialName(id), p.password, [accountEndpoint(account, 'imap'), accountEndpoint(account, 'smtp')], MAIL_CREDENTIAL_STORE)
      try {
        await verifyImap(scope, account)
      } catch (err) {
        await scope.credentials.delete(credentialName(id), MAIL_CREDENTIAL_STORE)
        throw err
      }
      await upsertAccount(scope, account)
      const central = await centralMailAccounts(scope)
      const local = (await readEmailAccounts(scope)).filter((a) => a.provider === 'pureemail')
      return { account, accounts: [...central, ...local] }
    }),

  removeAccount: mailMethod(z.object({ accountId: z.string().min(1) }), async (scope, payload) => {
      const { accountId: id } = payload
      // Only PureMail accounts are removed here; centralized Google/Microsoft
      // accounts are managed in Settings → Accounts. We still drop any cached
      // messages for the id either way.
      await scope.credentials.delete(credentialName(id), MAIL_CREDENTIAL_STORE)
      await removeAccountFiles(scope, id)
      const central = await centralMailAccounts(scope)
      const local = (await readEmailAccounts(scope)).filter((a) => a.provider === 'pureemail')
      return { accounts: [...central, ...local] }
    }),

  listFolders: mailMethod(z.object({ accountId: z.string().min(1) }), async (scope, payload) => {
      const account = await resolveAccount(scope, payload.accountId)
      if (!account) throw new Error(t('email.backend.account'))
      let listed
      try {
        listed = await listFolders(scope, account)
        await cacheMailboxes(scope, payload.accountId, listed)
      } catch (error) {
        const cached = await cachedMailboxes(scope, payload.accountId)
        if (!cached.length) throw error
        listed = cached.map((row) => ({ path: String(row.path), name: String(row.name),
          selectable: row.selectable === true, specialUse: typeof row.specialUse === 'string' ? row.specialUse : undefined }))
      }
      const counts = await folderCacheStats(scope, payload.accountId)
      const mailboxes = listed.map((mailbox) => {
        const stats = counts.get(mailbox.path) ?? { total: 0, unread: 0 }
        return { ...mailbox, cachedTotal: stats.total, cachedUnread: stats.unread }
      })
      return { folders: mailboxes.filter((mailbox) => mailbox.selectable).map((mailbox) => mailbox.path), mailboxes }
    }),

  syncFolder: mailMethod(z.object({
      accountId: z.string().min(1),
      folder: z.string().min(1).default('INBOX'),
      limit: z.number().int().positive().max(500).default(50)
    }), async (scope, payload) => {
      const p = payload
      const account = await resolveAccount(scope, p.accountId)
      if (!account) throw new Error(t('email.backend.account'))
      scope.rpc.emit('sync', { accountId: p.accountId, folder: p.folder, status: 'start' })
      try {
        const messages = await fetchFolder(scope, account, p.folder, p.limit)
        const count = await mergeFolder(scope, p.accountId, p.folder, messages)
        scope.rpc.emit('sync', {
          accountId: p.accountId,
          folder: p.folder,
          status: 'done',
          fetched: messages.length,
          total: count
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

  readFolder: mailMethod(z.object({ accountId: z.string().min(1), folder: z.string().min(1).default('INBOX') }), async (scope, payload) => {
      const p = payload
      return { messages: await readFolder(scope, p.accountId, p.folder) }
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
      if (!account) throw new Error(t('email.backend.account'))
      const messageId = await sendMail(scope, account, p)
      const sent: CachedMessage = {
        uid: Date.now(),
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
      await appendMessage(scope, p.accountId, 'Sent', sent)
      return { messageId }
    }),

  applyMessageAction: mailMethod(z.object({
      accountId: z.string().min(1),
      folder: z.string().min(1),
      uid: z.number().int().positive(),
      action: z.enum(['mark-read', 'mark-unread', 'flag', 'unflag', 'archive', 'trash', 'junk'])
    }), async (scope, payload) => {
      const account = await resolveAccount(scope, payload.accountId)
      if (!account) throw new Error(t('email.backend.account'))
      const remote = await applyRemoteMessageAction(scope, account, payload.folder, payload.uid, payload.action)
      let messages: CachedMessage[]
      if (remote.destinationFolder) {
        messages = await moveCachedMessage(
          scope,
          payload.accountId,
          payload.folder,
          remote.destinationFolder,
          payload.uid,
          remote.destinationUid
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
      return {
        action: payload.action,
        folder: payload.folder,
        messages,
        destinationFolder: remote.destinationFolder
      }
    })
}

export function register(api: MailBackendApi): () => void {
  setTranslator(api.i18n?.t)
  const scope: MailBackendContext = { ...emailStoreContext(api.data), network: api.network, credentials: api.credentials, accounts: api.accounts, rpc: api.rpc }
  let mutation = Promise.resolve()
  const off = Object.entries(methods).map(([name, method]) => api.rpc.handle(name, async (payload) => {
    const execute = async () => {
      try { return { ok: true, data: await method.run(scope, payload) } }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Mail operation failed.' } }
    }
    if (name !== 'addSmtpAccount' && name !== 'removeAccount') return execute()
    const pending = mutation.then(execute)
    mutation = pending.then(() => undefined, () => undefined)
    return pending
  }))
  return () => { for (const dispose of off) dispose() }
}
