import { t } from './localization'
import type { PluginDataApi } from '@valley/plugin-sdk'
import type { CachedMessage, EmailAccount, MailStructure } from '../mailTypes'
import type { DatasetPage, DatasetRecord, DatasetRequest, DatasetTransactionOperation, DatasetWhere } from '@valley/plugin-sdk/datasets'
import { identifyMessage } from './identity'
import { readAutomationHeaders } from './automation'

export interface EmailStoreContext {
  data: PluginDataApi
  datasets: { messages: string; mailboxes: string; folderMessages: string; recipients: string }
}

export function emailStoreContext(data: PluginDataApi): EmailStoreContext {
  return { data, datasets: { messages: 'messages', mailboxes: 'mailboxes', folderMessages: 'folder_messages', recipients: 'recipients' } }
}

export async function datasetRequest<T>(scope: EmailStoreContext, request: DatasetRequest): Promise<T> {
  if (request.operation === 'transaction') return await scope.data.transaction(request.operations) as T
  if (request.operation === 'query') return await scope.data.dataset(request.dataset).query(request.query) as T
  if (request.operation === 'get') return await scope.data.dataset(request.dataset).get(request.key) as T
  throw new Error(t('email.backend.operation'))
}

export async function queryAll(scope: EmailStoreContext, dataset: string, where?: DatasetWhere, select?: string[]): Promise<DatasetRecord[]> {
  const rows: DatasetRecord[] = []
  let cursor: string | undefined
  do {
    const page = await datasetRequest<DatasetPage>(scope, {
      operation: 'query', dataset, query: { where, select, limit: 1000, cursor }
    })
    rows.push(...page.rows)
    cursor = page.cursor
  } while (cursor)
  return rows
}

const canonicalFlags = (flags: readonly unknown[]): string[] => [...new Set(flags.filter((flag): flag is string => typeof flag === 'string'))].sort()
const sameFlags = (left: unknown, right: unknown): boolean => JSON.stringify(canonicalFlags(Array.isArray(left) ? left : [])) === JSON.stringify(canonicalFlags(Array.isArray(right) ? right : []))

function flagProjection(flags: readonly string[]) {
  return { unread: !flags.includes('\\Seen'), flagged: flags.includes('\\Flagged') }
}

const projecting = new WeakMap<PluginDataApi, Map<string, Promise<void>>>()

export async function ensureMembershipFlags(scope: EmailStoreContext, accountId: string): Promise<void> {
  let pending = projecting.get(scope.data)
  if (!pending) { pending = new Map(); projecting.set(scope.data, pending) }
  const existing = pending.get(accountId)
  if (existing) return existing
  const missing = (column: 'unread' | 'flagged') => scope.data.dataset(scope.datasets.folderMessages).query({
    where: { accountId, or: [{ [column]: { isNull: true } }, { projectionVersion: 0 }] },
    select: ['accountId', 'folder', 'uid', 'flags'], limit: 1000
  })
  const rebuild = async () => {
    let conflicts = 0
    while (true) {
      let page = await missing('unread')
      if (!page.rows.length) page = await missing('flagged')
      if (!page.rows.length) return
      const mailboxes = await queryAll(scope, scope.datasets.mailboxes, { accountId }, ['path', 'specialUse'])
      try {
        await scope.data.transaction(page.rows.map(row => ({
          operation: 'update', dataset: scope.datasets.folderMessages,
          key: { accountId, folder: String(row.folder), uid: Number(row.uid) },
          values: { ...flagProjection(Array.isArray(row.flags) ? row.flags.filter((flag): flag is string => typeof flag === 'string') : []), ...folderProjection(String(row.folder), mailboxes.find(mailbox => mailbox.path === row.folder)?.specialUse as string | undefined, Array.isArray(row.flags) ? row.flags as string[] : []) }
        })), { expected: [{ dataset: scope.datasets.folderMessages, revision: page.revision }] })
        conflicts = 0
      } catch (error) {
        if (!error || (error as { code?: string }).code !== 'conflict' || ++conflicts >= 3) throw error
      }
    }
  }
  const task = rebuild().finally(() => { if (pending.get(accountId) === task) pending.delete(accountId) })
  pending.set(accountId, task)
  return task
}

function messageRow(accountId: string, message: CachedMessage): DatasetRecord {
  return {
    id: message.logicalId!, accountId, messageId: message.messageId,
    contentRevision: message.contentRevision ?? null, complete: message.complete === true, originalDate: message.originalDate === undefined ? message.date || null : message.originalDate,
    automationHeaders: message.automationHeaders ? { ...message.automationHeaders } : null,
    sortDate: message.date || '', projectionVersion: 1,
    from: message.from, replyTo: message.replyTo ?? null, to: message.to, cc: message.cc ?? null,
    subject: message.subject, date: message.date || '1970-01-01T00:00:00.000Z', snippet: message.snippet,
    text: message.text ?? null, html: message.html ?? null, hasAttachments: message.hasAttachments,
    structure: structureValue(message.structure)
  }
}

/** The structure record as a stored JSON value (it holds only JSON data). */
const structureValue = (structure: MailStructure | undefined): DatasetRecord[string] => structure ? JSON.parse(JSON.stringify(structure)) as DatasetRecord[string] : null

/** UIDs above 32 bits are local items (the Sent copy that sendEmail appends); the server never reports them, so sync never removes them. */
export const isLocalUid = (uid: number): boolean => uid > 0xffffffff
export function readStructure(value: unknown): MailStructure | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MailStructure : undefined
}

const withoutBody = (row: DatasetRecord): DatasetRecord => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'text' && column !== 'html'))
const HEADER_COLUMNS = ['id', 'accountId', 'messageId', 'contentRevision', 'complete', 'originalDate', 'automationHeaders', 'sortDate', 'from', 'replyTo', 'to', 'cc', 'subject', 'date', 'snippet', 'hasAttachments']

function folderOperations(
  scope: EmailStoreContext,
  accountId: string,
  folder: string,
  previous: CachedMessage[],
  messages: CachedMessage[],
  stored: CachedMessage[] = previous
): DatasetTransactionOperation[] {
  const before = new Map(previous.map((message) => [message.uid, message]))
  const after = new Map(messages.map((message) => [message.uid, message]))
  const existingMessages = new Map(stored.map((message) => [message.logicalId, message]))
  return [
    ...[...before.keys()].filter((uid) => !after.has(uid)).map((uid) => ({ dataset: scope.datasets.folderMessages, operation: 'delete' as const, key: { accountId, folder, uid } })),
    ...[...new Map(messages.map((message) => [message.logicalId, message])).values()].flatMap((message) => {
      const existing = existingMessages.get(message.logicalId)
      if (existing === message) return []
      const values = messageRow(accountId, message)
      if (existing && JSON.stringify(withoutBody(messageRow(accountId, existing))) === JSON.stringify(withoutBody(values))) return []
      const id = message.logicalId!
      const recipients = [
        ...message.to.split(',').map((address) => address.trim()).filter(Boolean).map((address, position) => ({ dataset: scope.datasets.recipients, operation: 'upsert' as const, values: { messageId: id, kind: 'to', position, address } })),
        ...(message.cc ?? '').split(',').map((address) => address.trim()).filter(Boolean).map((address, position) => ({ dataset: scope.datasets.recipients, operation: 'upsert' as const, values: { messageId: id, kind: 'cc', position, address } }))
      ]
      return [
        { dataset: scope.datasets.messages, operation: 'upsert' as const, values: existing ? withoutBody(values) : values },
        ...recipients
      ]
    }),
    ...[...after.values()].filter((message) => {
      const existing = before.get(message.uid)
      return !existing || existing.logicalId !== message.logicalId || !sameFlags(existing.flags, message.flags) || (existing.uidValidity ?? null) !== (message.uidValidity ?? null)
    }).map((message) => { const flags = canonicalFlags(message.flags); return { dataset: scope.datasets.folderMessages, operation: 'upsert' as const, values: { accountId, folder, uid: message.uid, messageId: message.logicalId!, uidValidity: message.uidValidity ?? null, flags, ...flagProjection(flags), ...folderProjection(folder, undefined, flags) } } })
  ]
}

/** Characters of serialised operations per transaction: the host refuses a data request above 4 MiB, and a character takes at most 3 UTF-8 bytes here. */
const TRANSACTION_CHARACTERS = 1024 * 1024

async function writeOperations(scope: EmailStoreContext, operations: DatasetTransactionOperation[]): Promise<void> {
  let batch: DatasetTransactionOperation[] = [], characters = 0
  const flush = async (): Promise<void> => { if (batch.length) await datasetRequest(scope, { operation: 'transaction', operations: batch }); batch = []; characters = 0 }
  for (const operation of operations) {
    const size = JSON.stringify(operation).length
    if (batch.length && (batch.length >= 1000 || characters + size > TRANSACTION_CHARACTERS)) await flush()
    batch.push(operation); characters += size
  }
  await flush()
}

/** Delete the message rows (with their recipients) of these ids that no folder of any account holds any more. */
async function dropUnreferenced(scope: EmailStoreContext, ids: string[]): Promise<void> {
  for (let index = 0; index < ids.length; index += 100) {
    const slice = [...new Set(ids.slice(index, index + 100))]
    const held = new Set((await queryAll(scope, scope.datasets.folderMessages, { messageId: { in: slice } }, ['messageId'])).map(row => String(row.messageId)))
    const orphaned = slice.filter(id => !held.has(id))
    if (!orphaned.length) continue
    const recipients = await queryAll(scope, scope.datasets.recipients, { messageId: { in: orphaned } }, ['messageId', 'kind', 'position'])
    await writeOperations(scope, [
      ...orphaned.map(id => ({ dataset: scope.datasets.messages, operation: 'delete' as const, key: { id } })),
      ...recipients.map(row => ({ dataset: scope.datasets.recipients, operation: 'delete' as const, key: { messageId: String(row.messageId), kind: String(row.kind), position: Number(row.position) } }))
    ])
  }
}

/** The recipient rows folderOperations writes for one stored message row. */
function recipientRows(row: DatasetRecord): DatasetRecord[] {
  const split = (value: unknown) => typeof value === 'string' ? value.split(',').map(address => address.trim()).filter(Boolean) : []
  return [...split(row.to).map((address, position) => ({ messageId: String(row.id), kind: 'to', position, address })), ...split(row.cc).map((address, position) => ({ messageId: String(row.id), kind: 'cc', position, address }))]
}

export async function readAccounts(scope: EmailStoreContext): Promise<EmailAccount[]> {
  const text = await scope.data.files.readText('accounts.json')
  if (text === null) return []
  const accounts: unknown = JSON.parse(text)
  if (!Array.isArray(accounts)) throw new Error(t('email.backend.accountsInvalid'))
  return accounts as EmailAccount[]
}

export async function writeAccounts(scope: EmailStoreContext, accounts: EmailAccount[]): Promise<void> {
  const current = await scope.data.files.readTextBaseline('accounts.json')
  const result = await scope.data.files.writeTextGuarded('accounts.json', JSON.stringify(accounts, null, 2), current?.baseline ?? null)
  if (!result.ok) throw new Error(t('email.backend.accountsChanged'))
}

export async function upsertAccount(scope: EmailStoreContext, account: EmailAccount): Promise<EmailAccount[]> {
  const accounts = await readAccounts(scope)
  const idx = accounts.findIndex((a) => a.id === account.id)
  if (idx >= 0) accounts[idx] = account
  else accounts.push(account)
  await writeAccounts(scope, accounts)
  return accounts
}

export async function getAccount(scope: EmailStoreContext, accountId: string): Promise<EmailAccount | null> {
  const accounts = await readAccounts(scope)
  return accounts.find((a) => a.id === accountId) ?? null
}

export async function removeAccountFiles(scope: EmailStoreContext, accountId: string): Promise<EmailAccount[]> {
  const accounts = (await readAccounts(scope)).filter((a) => a.id !== accountId)
  await writeAccounts(scope, accounts)
  const [memberships, messages, mailboxes] = await Promise.all([
    queryAll(scope, scope.datasets.folderMessages, { accountId }, ['folder', 'uid']),
    queryAll(scope, scope.datasets.messages, { accountId }, ['id']),
    queryAll(scope, scope.datasets.mailboxes, { accountId }, ['path'])
  ])
  const ids = messages.map((entry) => String(entry.id))
  const recipients: DatasetRecord[] = []
  for (let index = 0; index < ids.length; index += 100) recipients.push(...await queryAll(scope, scope.datasets.recipients, { messageId: { in: ids.slice(index, index + 100) } }, ['messageId', 'kind', 'position']))
  // Sync states stay: a restored account keeps its cache only while its folders' epochs are still known.
  const operations = [
    ...memberships.map((entry) => ({ dataset: scope.datasets.folderMessages, operation: 'delete' as const, key: { accountId, folder: String(entry.folder), uid: Number(entry.uid) } })),
    ...ids.map((id) => ({ dataset: scope.datasets.messages, operation: 'delete' as const, key: { id } })),
    ...recipients.map((row) => ({ dataset: scope.datasets.recipients, operation: 'delete' as const, key: { messageId: String(row.messageId), kind: String(row.kind), position: Number(row.position) } })),
    ...mailboxes.map((row) => ({ dataset: scope.datasets.mailboxes, operation: 'delete' as const, key: { accountId, path: String(row.path) } }))
  ]
  await writeOperations(scope, operations)
  return accounts
}

export interface AccountRestore { index: number; account: EmailAccount; folderMessages: DatasetRecord[]; messages: DatasetRecord[] }
export const ACCOUNT_RESTORE_LIMIT = 256 * 1024

/** Capture what removeAccountFiles deletes, or null when it is too large to return. */
export async function captureAccountRestore(scope: EmailStoreContext, accountId: string): Promise<AccountRestore | null> {
  const accounts = await readAccounts(scope), index = accounts.findIndex((a) => a.id === accountId)
  if (index < 0) return null
  const [folderMessages, messages] = await Promise.all([queryAll(scope, scope.datasets.folderMessages, { accountId }), queryAll(scope, scope.datasets.messages, { accountId })])
  const restore = { index, account: accounts[index], folderMessages, messages }
  return new TextEncoder().encode(JSON.stringify(restore)).length <= ACCOUNT_RESTORE_LIMIT ? restore : null
}

/** Re-insert a captured account and its cached rows; returns null (nothing written) when any of them exists again. */
export async function restoreAccountFiles(scope: EmailStoreContext, restore: AccountRestore): Promise<EmailAccount[] | null> {
  const accounts = await readAccounts(scope), id = restore.account.id
  if (accounts.some((a) => a.id === id)) return null
  for (const row of restore.folderMessages) if (await scope.data.dataset(scope.datasets.folderMessages).get({ accountId: id, folder: String(row.folder), uid: Number(row.uid) })) return null
  for (const row of restore.messages) if (await scope.data.dataset(scope.datasets.messages).get({ id: String(row.id) })) return null
  accounts.splice(Math.min(restore.index, accounts.length), 0, restore.account)
  await writeAccounts(scope, accounts)
  await writeOperations(scope, [
    ...restore.messages.map((values) => ({ dataset: scope.datasets.messages, operation: 'insert' as const, values })),
    ...restore.messages.flatMap(recipientRows).map((values) => ({ dataset: scope.datasets.recipients, operation: 'upsert' as const, values })),
    ...restore.folderMessages.map((values) => ({ dataset: scope.datasets.folderMessages, operation: 'insert' as const, values }))
  ])
  return accounts
}

/** Drop one cached folder membership, and the message with its recipients once no membership is left. */
export async function forgetCachedMessage(scope: EmailStoreContext, accountId: string, folder: string, uid: number): Promise<{ removed: boolean; message: boolean }> {
  const membership = await scope.data.dataset(scope.datasets.folderMessages).get({ accountId, folder, uid })
  if (!membership) return { removed: false, message: false }
  const messageId = String(membership.messageId)
  const others = (await queryAll(scope, scope.datasets.folderMessages, { messageId }, ['accountId', 'folder', 'uid'])).filter((row) => !(row.accountId === accountId && row.folder === folder && Number(row.uid) === uid))
  const recipients = others.length ? [] : await queryAll(scope, scope.datasets.recipients, { messageId }, ['kind', 'position'])
  await writeOperations(scope, [
    { dataset: scope.datasets.folderMessages, operation: 'delete', key: { accountId, folder, uid } },
    ...others.length ? [] : [
      { dataset: scope.datasets.messages, operation: 'delete' as const, key: { id: messageId } },
      ...recipients.map((row) => ({ dataset: scope.datasets.recipients, operation: 'delete' as const, key: { messageId, kind: String(row.kind), position: Number(row.position) } }))
    ]
  ])
  if (others.length) await projectAssignments(scope, [messageId])
  return { removed: true, message: !others.length }
}

/** The public cached-message shape of one stored message row and its folder membership. */
function cachedMessage(message: DatasetRecord, membership: DatasetRecord): CachedMessage {
  return {
    complete: message.complete === true, logicalId: String(message.id), contentRevision: typeof message.contentRevision === 'string' ? message.contentRevision : undefined,
    ...(readAutomationHeaders(message.automationHeaders) ? { automationHeaders: readAutomationHeaders(message.automationHeaders) } : {}),
    uidValidity: typeof membership.uidValidity === 'number' ? membership.uidValidity : undefined,
    originalDate: typeof message.originalDate === 'string' ? message.originalDate : null,
    uid: Number(membership.uid), messageId: String(message.messageId), from: String(message.from),
    replyTo: typeof message.replyTo === 'string' ? message.replyTo : undefined,
    to: String(message.to), cc: typeof message.cc === 'string' ? message.cc : undefined,
    subject: String(message.subject), date: typeof message.sortDate === 'string' ? message.sortDate : String(message.date), snippet: String(message.snippet),
    text: typeof message.text === 'string' ? message.text : undefined,
    html: typeof message.html === 'string' ? message.html : undefined,
    flags: Array.isArray(membership.flags) ? membership.flags.filter((flag): flag is string => typeof flag === 'string') : [],
    hasAttachments: message.hasAttachments === true
  }
}

/** Read every cached message for one folder. */
export async function readFolder(scope: EmailStoreContext, accountId: string, folder: string, only: { uid?: number; limit?: number } = {}): Promise<CachedMessage[]> {
  try {
    let memberships = await queryAll(scope, scope.datasets.folderMessages, { accountId, folder, ...(only.uid === undefined ? {} : { uid: only.uid }) })
    // Only the newest `limit` memberships need their message rows (and bodies).
    if (only.limit !== undefined && memberships.length > only.limit) {
      const ids = [...new Set(memberships.map((membership) => String(membership.messageId)))]
      const dates = new Map<string, string>()
      for (let index = 0; index < ids.length; index += 100) {
        for (const row of await queryAll(scope, scope.datasets.messages, { accountId, id: { in: ids.slice(index, index + 100) } }, ['id', 'date'])) dates.set(String(row.id), String(row.date ?? ''))
      }
      memberships = memberships.sort((a, b) => (dates.get(String(a.messageId)) ?? '') < (dates.get(String(b.messageId)) ?? '') ? 1 : -1).slice(0, only.limit)
    }
    const ids = [...new Set(memberships.map((membership) => String(membership.messageId)))]
    const messages: DatasetRecord[] = []
    for (let index = 0; index < ids.length; index += 100) {
      messages.push(...await queryAll(scope, scope.datasets.messages, { accountId, id: { in: ids.slice(index, index + 100) } }))
    }
    const byId = new Map(messages.map((message) => [String(message.id), message]))
    return memberships.flatMap((membership): CachedMessage[] => {
      const message = byId.get(String(membership.messageId))
      return message ? [cachedMessage(message, membership)] : []
    }).sort((a, b) => (a.date < b.date ? 1 : -1))
  } catch {
    return []
  }
}

async function storedMemberships(scope: EmailStoreContext, accountId: string, folder: string, uids: number[]): Promise<DatasetRecord[]> {
  const rows: DatasetRecord[] = []
  const unique = [...new Set(uids)]
  for (let index = 0; index < unique.length; index += 100) rows.push(...await queryAll(scope, scope.datasets.folderMessages, { accountId, folder, uid: { in: unique.slice(index, index + 100) } }, ['uid', 'messageId', 'uidValidity', 'flags', 'spam']))
  return rows
}

async function storedMessages(scope: EmailStoreContext, accountId: string, ids: string[]): Promise<DatasetRecord[]> {
  const rows: DatasetRecord[] = []
  const unique = [...new Set(ids)]
  for (let index = 0; index < unique.length; index += 100) rows.push(...await queryAll(scope, scope.datasets.messages, { accountId, id: { in: unique.slice(index, index + 100) } }, HEADER_COLUMNS))
  return rows
}

/** Cached messages without bodies for the folder's UIDs in one UIDVALIDITY epoch, keyed by UID. */
export async function cachedFolderHeaders(scope: EmailStoreContext, accountId: string, folder: string, uids: number[], uidValidity: number | undefined): Promise<Map<number, CachedMessage>> {
  if (uidValidity === undefined) return new Map()
  const memberships = (await storedMemberships(scope, accountId, folder, uids)).filter(row => row.uidValidity === uidValidity)
  const rows = new Map((await storedMessages(scope, accountId, memberships.map(row => String(row.messageId)))).map(row => [String(row.id), row]))
  return new Map(memberships.flatMap((membership): Array<[number, CachedMessage]> => {
    const row = rows.get(String(membership.messageId))
    return row && typeof row.contentRevision === 'string' ? [[Number(membership.uid), cachedMessage(row, membership)]] : []
  }))
}

/** Forget up to 500 cached messages of a folder dated before the retention window, keeping the UIDs just synced. */
export async function pruneFolder(scope: EmailStoreContext, accountId: string, folder: string, keep: number[], keepDays: number, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - keepDays * 86_400_000).toISOString()
  const old = await datasetRequest<DatasetPage>(scope, { operation: 'query', dataset: scope.datasets.messages, query: { where: { accountId, and: [{ sortDate: { lt: cutoff } }, { sortDate: { gt: '' } }] }, select: ['id'], limit: 500 } })
  if (!old.rows.length) return 0
  const kept = new Set(keep)
  const memberships = (await queryAll(scope, scope.datasets.folderMessages, { accountId, folder, messageId: { in: old.rows.map(row => String(row.id)) } }, ['uid'])).filter(row => !kept.has(Number(row.uid)))
  let removed = 0
  for (const membership of memberships) if ((await forgetCachedMessage(scope, accountId, folder, Number(membership.uid))).removed) removed++
  return removed
}

/** Merge fetched messages into a folder's cache, de-duped by uid, newest first. */
export async function mergeFolder(
  scope: EmailStoreContext,
  accountId: string,
  folder: string,
  messages: CachedMessage[]
): Promise<number> {
  const identified: CachedMessage[] = []
  for (const message of messages) identified.push(await identifyMessage(accountId, folder, message))
  const mailbox = await scope.data.dataset(scope.datasets.mailboxes).get({ accountId, path: folder })
  const memberships = await storedMemberships(scope, accountId, folder, identified.map(message => message.uid))
  const rows = new Map((await storedMessages(scope, accountId, [...identified.map(message => message.logicalId!), ...memberships.map(row => String(row.messageId))])).map(row => [String(row.id), row]))
  const previous = memberships.flatMap(membership => { const row = rows.get(String(membership.messageId)); return row ? [cachedMessage(row, membership)] : [] })
  const operations = folderOperations(scope, accountId, folder, previous, identified, [...rows.values()].map(row => cachedMessage(row, {})))
  for (const operation of operations) if (operation.dataset === scope.datasets.folderMessages && operation.values && !Array.isArray(operation.values)) Object.assign(operation.values, folderProjection(folder, typeof mailbox?.specialUse === 'string' ? mailbox.specialUse : undefined, operation.values.flags as string[]))
  await writeOperations(scope, operations)
  const stored = new Map(memberships.map(row => [Number(row.uid), row]))
  // A UID whose content changed points at a new message row; the old row goes once nothing holds it.
  const now = new Map(identified.map(message => [message.uid, message.logicalId]))
  await dropUnreferenced(scope, memberships.filter(row => now.has(Number(row.uid)) && now.get(Number(row.uid)) !== String(row.messageId)).map(row => String(row.messageId)))
  await projectAssignments(scope, [...new Set(operations.flatMap(({ dataset, operation, values }) => {
    if (operation !== 'upsert' || !values || Array.isArray(values)) return []
    if (dataset === scope.datasets.messages) return [String(values.id)]
    const membership = stored.get(Number(values.uid))
    if (dataset !== scope.datasets.folderMessages || membership && membership.messageId === values.messageId && membership.spam === values.spam) return []
    return [String(values.messageId), ...membership ? [String(membership.messageId)] : []]
  }))])
  return scope.data.dataset(scope.datasets.folderMessages).count({ accountId, folder })
}

export async function folderCacheStats(
  scope: EmailStoreContext,
  accountId: string
): Promise<Map<string, { total: number; unread: number }>> {
  await ensureMembershipFlags(scope, accountId)
  const live = { accountId, exists: { dataset: scope.datasets.messages, on: { messageId: 'id', accountId: 'accountId' } } }
  const rows = await scope.data.dataset(scope.datasets.folderMessages).aggregate({ where: live, groupBy: ['folder'], metrics: { total: { operation: 'count' } } })
  const unread = await scope.data.dataset(scope.datasets.folderMessages).aggregate({ where: { ...live, unread: true }, groupBy: ['folder'], metrics: { unread: { operation: 'count' } } })
  return new Map(rows.map(row => [String(row.folder), { total: Number(row.total), unread: Number(unread.find(item => item.folder === row.folder)?.unread ?? 0) }]))
}

export async function updateMessageFlags(
  scope: EmailStoreContext,
  accountId: string,
  folder: string,
  uid: number,
  add: string[] = [],
  remove: string[] = []
): Promise<CachedMessage[]> {
  const membership = await scope.data.dataset(scope.datasets.folderMessages).get({ accountId, folder, uid })
  if (!membership) return []
  const stored = Array.isArray(membership.flags) ? membership.flags as string[] : []
  const next = new Set(stored)
  add.forEach(flag => next.add(flag)); remove.forEach(flag => next.delete(flag))
  const changed = !sameFlags(stored, [...next])
  const flags = changed ? canonicalFlags([...next]) : stored
  if (changed) await scope.data.transaction([{ operation: 'update', dataset: scope.datasets.folderMessages, key: { accountId, folder, uid }, values: { flags, ...flagProjection(flags) } }])
  const row = await scope.data.dataset(scope.datasets.messages).get({ id: String(membership.messageId) })
  if (!row) return []
  return [cachedMessage(row, { ...membership, uid, flags: [...flags] })]

}

export async function moveCachedMessage(
  scope: EmailStoreContext,
  accountId: string,
  sourceFolder: string,
  destinationFolder: string,
  uid: number,
  destinationUid?: number,
  destinationUidValidity?: number
): Promise<CachedMessage[]> {
  const source = await readFolder(scope, accountId, sourceFolder)
  const message = source.find((candidate) => candidate.uid === uid)
  const remaining = source.filter((candidate) => candidate.uid !== uid)
  const operations = folderOperations(scope, accountId, sourceFolder, source, remaining)
  if (message && destinationUid !== undefined) {
    const destination = destinationFolder === sourceFolder ? remaining : await readFolder(scope, accountId, destinationFolder)
    const moved = { ...message, uid: destinationUid, uidValidity: destinationUidValidity ?? message.uidValidity }
    const merged = [moved, ...destination.filter((candidate) => candidate.uid !== destinationUid)]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
    operations.push(...folderOperations(scope, accountId, destinationFolder, destination, merged))
  }
  await writeOperations(scope, operations)
  if (message?.logicalId) await dropUnreferenced(scope, [message.logicalId])
  return remaining
}

/** Append a single sent message to the Sent folder cache. */
export async function appendMessage(
  scope: EmailStoreContext,
  accountId: string,
  folder: string,
  message: CachedMessage
): Promise<void> {
  await mergeFolder(scope, accountId, folder, [message])
}

export function folderProjection(folder: string, specialUse?: string, flags: readonly string[] = []): { excluded: boolean; spam: boolean; projectionVersion: number } {
  const keywords = flags.map(flag => flag.toLowerCase())
  const spam = specialUse?.toLowerCase() === '\\junk' || /(^|[/.])(junk|spam)$/i.test(folder) || (keywords.includes('$junk') || keywords.includes('junk')) && !keywords.includes('$notjunk')
  return { spam, projectionVersion: 1, excluded: spam || ['\\Trash', '\\Drafts'].includes(specialUse ?? '') || /(^|[/.])(trash|drafts|deleted items|deleted messages)$/i.test(folder) }
}

export async function projectAssignments(scope: EmailStoreContext, ids: string[]): Promise<void> {
  for (let index = 0; index < ids.length; index += 100) {
    const selected = ids.slice(index, index + 100)
    const assignments = await scope.data.dataset('assignments').query({ where: { id: { in: selected } }, limit: 100 })
    const memberships = await scope.data.dataset(scope.datasets.folderMessages).aggregate({ where: { messageId: { in: selected }, spam: true }, groupBy: ['messageId'], metrics: { count: { operation: 'count' } } })
    await scope.data.transaction(selected.map(id => ({ operation: 'update', dataset: scope.datasets.messages, key: { id }, values: {
      categoryId: assignments.rows.find(row => row.id === id)?.categoryId ?? null,
      isSpam: memberships.some(row => row.messageId === id)
    } })))
  }
}

export async function establishFolderEpoch(scope: EmailStoreContext, accountId: string, folder: string, uidValidity: number | undefined): Promise<boolean> {
  const previous = await scope.data.dataset('sync_state').get({ accountId, folder })
  const reset = (previous?.uidValidity ?? null) !== (uidValidity ?? null)
  if (reset) {
    const uids = (await queryAll(scope, scope.datasets.folderMessages, { accountId, folder }, ['uid'])).map(row => Number(row.uid)).filter(uid => !isLocalUid(uid))
    await removeFromFolder(scope, accountId, folder, uids)
  }
  return Boolean(previous?.lastSyncAt && !reset && uidValidity !== undefined)
}

/** Cached server UIDs of a folder in one UIDVALIDITY epoch (local items excluded). */
export async function cachedFolderUids(scope: EmailStoreContext, accountId: string, folder: string, uidValidity: number): Promise<number[]> {
  return (await queryAll(scope, scope.datasets.folderMessages, { accountId, folder, uidValidity }, ['uid'])).map(row => Number(row.uid)).filter(uid => Number.isSafeInteger(uid) && !isLocalUid(uid))
}

/** Remove folder memberships; a message row (with its recipients) goes too once no folder of any account holds it. */
export async function removeFromFolder(scope: EmailStoreContext, accountId: string, folder: string, uids: number[]): Promise<number> {
  let removed = 0
  for (let index = 0; index < uids.length; index += 100) {
    const slice = [...new Set(uids.slice(index, index + 100))]
    const memberships = await queryAll(scope, scope.datasets.folderMessages, { accountId, folder, uid: { in: slice } }, ['uid', 'messageId'])
    if (!memberships.length) continue
    const ids = [...new Set(memberships.map(row => String(row.messageId)))]
    const leaving = new Set(memberships.map(row => Number(row.uid)))
    const others = (await queryAll(scope, scope.datasets.folderMessages, { accountId, messageId: { in: ids } }, ['accountId', 'folder', 'uid', 'messageId']))
      .filter(row => !(row.accountId === accountId && row.folder === folder && leaving.has(Number(row.uid))))
    const kept = new Set(others.map(row => String(row.messageId)))
    const orphaned = ids.filter(id => !kept.has(id))
    const recipients = orphaned.length ? await queryAll(scope, scope.datasets.recipients, { messageId: { in: orphaned } }, ['messageId', 'kind', 'position']) : []
    await writeOperations(scope, [
      ...memberships.map(row => ({ dataset: scope.datasets.folderMessages, operation: 'delete' as const, key: { accountId, folder, uid: Number(row.uid) } })),
      ...orphaned.map(id => ({ dataset: scope.datasets.messages, operation: 'delete' as const, key: { id } })),
      ...recipients.map(row => ({ dataset: scope.datasets.recipients, operation: 'delete' as const, key: { messageId: String(row.messageId), kind: String(row.kind), position: Number(row.position) } }))
    ])
    await projectAssignments(scope, ids.filter(id => kept.has(id)))
    removed += memberships.length
  }
  return removed
}

/** Remove local copies (the Sent copy kept before the server had one) once the folder holds the server's message with the same Message-ID. */
export async function dropLocalCopies(scope: EmailStoreContext, accountId: string, folder: string): Promise<number> {
  const local = await queryAll(scope, scope.datasets.folderMessages, { accountId, folder, uid: { gt: 0xffffffff } }, ['uid', 'messageId'])
  if (!local.length) return 0
  const replaced: number[] = []
  for (const membership of local) {
    const row = await scope.data.dataset(scope.datasets.messages).get({ id: String(membership.messageId) })
    const messageId = typeof row?.messageId === 'string' ? row.messageId : ''
    if (!messageId) continue
    const same = await queryAll(scope, scope.datasets.messages, { accountId, messageId }, ['id'])
    const held = same.length ? await queryAll(scope, scope.datasets.folderMessages, { accountId, folder, messageId: { in: same.map(entry => String(entry.id)) } }, ['uid']) : []
    if (held.some(entry => !isLocalUid(Number(entry.uid)))) replaced.push(Number(membership.uid))
  }
  return replaced.length ? removeFromFolder(scope, accountId, folder, replaced) : 0
}

/** Store a body downloaded on demand into the cached message row, leaving its identity unchanged. */
export async function storeOpenedBody(scope: EmailStoreContext, id: string, body: { text?: string; html?: string }, structure: MailStructure | undefined): Promise<void> {
  const rest = structure ? { ...structure } : undefined
  if (rest) delete rest.deferred
  await scope.data.transaction([{ operation: 'update', dataset: scope.datasets.messages, key: { id }, values: {
    ...(body.text !== undefined ? { text: body.text, snippet: body.text.slice(0, 4000).replace(/\s+/g, ' ').trim().slice(0, 200) } : {}),
    ...(body.html !== undefined ? { html: body.html } : {}),
    structure: structureValue(rest)
  } }])
}
