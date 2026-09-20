import { t } from './localization'
import { decodeText, encodeText } from './encoding'
import { addressParser } from 'postal-mime'
import type { EmailAddress, EmailMessageDetail, EmailMessageQuery, EmailMessageRef, EmailMessageSummary } from '../mailTypes'
import type { DatasetPage, DatasetRecord, DatasetWhere } from '@valley/plugin-sdk/datasets'
import { datasetRequest as request, ensureMembershipFlags, queryAll, type EmailStoreContext } from './cache'

export function parseEmailAddresses(value: string, strict = false): EmailAddress[] {
  const parsed = addressParser(value, { flatten: true })
  if (strict && parsed.some((entry) => !/^[^\s@<>]+@[^\s@<>]+$/.test(entry.address ?? ''))) throw new Error(t('email.backend.address'))
  return parsed.filter((entry) => /^[^\s@<>]+@[^\s@<>]+$/.test((entry.address ?? '')))
    .map((entry) => ({ name: entry.name || '', address: entry.address!.trim() }))
}

function flags(row: DatasetRecord): string[] {
  return Array.isArray(row.flags) ? row.flags.filter((flag): flag is string => typeof flag === 'string') : []
}

function summarize(row: DatasetRecord, memberships: DatasetRecord[]): EmailMessageSummary {
  const primary = memberships[0]
  const text = (key: string): string => typeof row[key] === 'string' ? row[key] as string : ''
  return {
    id: text('id'), accountId: text('accountId'), folder: String(primary.folder), uid: Number(primary.uid),
    memberships: memberships.map((item) => ({ accountId: text('accountId'), folder: String(item.folder), uid: Number(item.uid) })),
    messageId: text('messageId'), from: text('from'), to: text('to'), cc: text('cc'), replyTo: text('replyTo'),
    subject: text('subject'), date: text('date'), snippet: text('snippet'), hasAttachments: row.hasAttachments === true,
    flags: flags(primary),
    addresses: { from: parseEmailAddresses(text('from')), to: parseEmailAddresses(text('to')),
      cc: parseEmailAddresses(text('cc')), replyTo: parseEmailAddresses(text('replyTo')) }
  }
}

const excludedFolderName = (folder: string): boolean => /(^|[/.])(trash|junk|spam|drafts|deleted items|deleted messages)$/i.test(folder)
const membershipKey = (row: DatasetRecord): string => JSON.stringify([row.accountId, row.messageId])
const messageOrder = (a: DatasetRecord, b: DatasetRecord): number => a.date === b.date
  ? String(a.id) < String(b.id) ? -1 : String(a.id) === String(b.id) ? 0 : 1
  : String(a.date) > String(b.date) ? -1 : 1

export async function queryMessages(scope: EmailStoreContext, input: EmailMessageQuery): Promise<{ messages: EmailMessageSummary[]; cursor?: string }> {
  const accountIds = [...new Set((input.accountIds?.length ? input.accountIds : [input.accountId]).filter(Boolean))].sort()
  if (!accountIds.length) return { messages: [] }
  const cursorScope = JSON.stringify([accountIds, input.view, input.folder ?? '', input.query ?? ''])
  const conditions: DatasetWhere[] = []
  if (input.query?.trim()) conditions.push({ or: ['from', 'to', 'subject', 'snippet', 'text'].map((field) => ({ [field]: { contains: input.query!.trim() } })) })
  if (input.cursor) {
    let cursor: { scope: string; date: string; id: string }
    try { cursor = JSON.parse(decodeText(input.cursor)) } catch { throw new Error(t('email.backend.cursor')) }
    if (cursor.scope !== cursorScope || typeof cursor.date !== 'string' || typeof cursor.id !== 'string') throw new Error(t('email.backend.cursor'))
    conditions.push({ or: [{ date: { lt: cursor.date } }, { and: [{ date: cursor.date }, { id: { gt: cursor.id } }] }] })
  }
  const limit = input.limit ?? 100
  const candidates: DatasetRecord[] = []
  const excludedByAccount = new Map<string, Set<string>>()
  for (const accountId of accountIds) {
    const mailboxes = input.view === 'folder' ? [] : await queryAll(scope, scope.datasets.mailboxes, { accountId }, ['path', 'specialUse'])
    const excluded = new Set(mailboxes.filter(row => ['\\Trash', '\\Junk', '\\Drafts'].includes(String(row.specialUse)) || excludedFolderName(String(row.path))).map(row => String(row.path)))
    excludedByAccount.set(accountId, excluded)
    if (input.view === 'unread' || input.view === 'flagged') await ensureMembershipFlags(scope, accountId)
    const where: DatasetWhere = { accountId }
    if (input.view === 'folder') where.folder = input.folder
    else if (excluded.size) where.folder = { notIn: [...excluded].slice(0, 100) }
    if (input.view === 'unread' || input.view === 'flagged') where[input.view] = true
    const eligible = await queryAll(scope, scope.datasets.folderMessages, where, ['accountId', 'folder', 'messageId'])
    const ids = [...new Set(eligible.filter(row => input.view === 'folder' || (!excluded.has(String(row.folder)) && !excludedFolderName(String(row.folder)))).map(row => String(row.messageId)))]
    for (let index = 0; index < ids.length; index += 100) {
      const page = await request<DatasetPage>(scope, { operation: 'query', dataset: scope.datasets.messages, query: {
        select: ['id', 'accountId', 'messageId', 'from', 'to', 'cc', 'replyTo', 'subject', 'date', 'snippet', 'hasAttachments'],
        where: { and: [{ accountId, id: { in: ids.slice(index, index + 100) } }, ...conditions] },
        orderBy: [{ field: 'date', direction: 'desc' }, { field: 'id', direction: 'asc' }], limit: Math.min(100, limit + 1)
      } })
      candidates.push(...page.rows)
      candidates.sort(messageOrder)
      candidates.length = Math.min(candidates.length, limit + 1)
    }
  }
  const byId = new Map<string, DatasetRecord[]>()
  for (const accountId of accountIds) {
    const ids = candidates.filter(row => row.accountId === accountId).map(row => String(row.id))
    for (let index = 0; index < ids.length; index += 100) {
      const memberships = await queryAll(scope, scope.datasets.folderMessages, { accountId, messageId: { in: ids.slice(index, index + 100) } })
      for (const row of memberships) {
        const key = membershipKey(row)
        const list = byId.get(key) ?? []
        list.push(row)
        byId.set(key, list)
      }
    }
  }
  const messages: EmailMessageSummary[] = []
  for (const row of candidates) {
    const members = byId.get(JSON.stringify([row.accountId, row.id]))
    if (!members) continue
    const excluded = excludedByAccount.get(String(row.accountId))!
    const matching = new Set(members.filter(member => (input.view === 'folder' ? member.folder === input.folder
      : !excluded.has(String(member.folder)) && !excludedFolderName(String(member.folder))) && (input.view === 'unread' ? !flags(member).includes('\\Seen')
      : input.view === 'flagged' ? flags(member).includes('\\Flagged') : true)))
    if (!matching.size) continue
    members.sort((a, b) => Number(matching.has(b)) - Number(matching.has(a)) ||
      Number(String(b.folder).toUpperCase() === 'INBOX') - Number(String(a.folder).toUpperCase() === 'INBOX') || String(a.folder).localeCompare(String(b.folder)))
    messages.push(summarize(row, members))
  }
  const hasMore = messages.length > limit
  const selected = messages.slice(0, limit)
  const last = selected.at(-1)
  return { messages: selected, ...(hasMore && last ? { cursor: encodeText(JSON.stringify({ scope: cursorScope, date: last.date, id: last.id })) } : {}) }
}

export async function readMessage(scope: EmailStoreContext, ref: EmailMessageRef): Promise<EmailMessageDetail | null> {
  const membership = await request<DatasetRecord | null>(scope, { operation: 'get', dataset: scope.datasets.folderMessages, key: { accountId: ref.accountId, folder: ref.folder, uid: ref.uid } })
  if (!membership) return null
  const row = await request<DatasetRecord | null>(scope, { operation: 'get', dataset: scope.datasets.messages, key: { id: String(membership.messageId) } })
  if (!row) return null
  const memberships = await queryAll(scope, scope.datasets.folderMessages, { accountId: ref.accountId, messageId: String(membership.messageId) })
  const others = memberships.filter((entry) => entry.folder !== ref.folder || entry.uid !== ref.uid)
  return { ...summarize(row, [membership, ...others]), text: typeof row.text === 'string' ? row.text : undefined, html: typeof row.html === 'string' ? row.html : undefined }
}

export async function cacheMailboxes(scope: EmailStoreContext, accountId: string, mailboxes: { path: string; name: string; specialUse?: string; delimiter?: string; selectable: boolean }[]): Promise<void> {
  if (!mailboxes.length) return
  await request(scope, { operation: 'transaction', operations: mailboxes.map((mailbox) => ({
    operation: 'upsert', dataset: scope.datasets.mailboxes, values: {
      accountId, path: mailbox.path, name: mailbox.name, selectable: mailbox.selectable,
      specialUse: mailbox.specialUse ?? null, delimiter: mailbox.delimiter ?? null
    }
  })) })
}

export async function cachedMailboxes(scope: EmailStoreContext, accountId: string): Promise<DatasetRecord[]> {
  return queryAll(scope, scope.datasets.mailboxes, { accountId })
}
