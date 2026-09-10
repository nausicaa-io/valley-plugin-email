import { t } from './localization'
import { decodeText, encodeText } from './encoding'
import { addressParser } from 'postal-mime'
import type { EmailAddress, EmailMessageDetail, EmailMessageQuery, EmailMessageRef, EmailMessageSummary } from '../mailTypes'
import type { DatasetPage, DatasetRecord, DatasetWhere } from '@valley/plugin-sdk/datasets'
import { datasetRequest as request, queryAll, type EmailStoreContext } from './cache'

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

export async function queryMessages(scope: EmailStoreContext, input: EmailMessageQuery): Promise<{ messages: EmailMessageSummary[]; cursor?: string }> {
  const accountIds = [...new Set((input.accountIds?.length ? input.accountIds : [input.accountId]).filter(Boolean))]
  if (!accountIds.length) return { messages: [] }
  const accounts = { in: accountIds }
  const mailboxes = input.view === 'folder' ? []
    : await queryAll(scope, scope.datasets.mailboxes, { accountId: accounts }, ['path', 'specialUse'])
  const excluded = new Set(mailboxes.filter((row) => ['\\Trash', '\\Junk', '\\Drafts'].includes(String(row.specialUse))).map((row) => String(row.path)))
  const usable = (row: DatasetRecord): boolean => input.view === 'folder' ? row.folder === input.folder
    : !excluded.has(String(row.folder)) && !/(^|[/.])(trash|junk|spam|drafts|deleted items|deleted messages)$/i.test(String(row.folder))
  const cursorScope = JSON.stringify([accountIds.sort(), input.view, input.folder ?? '', input.query ?? ''])
  const conditions: DatasetWhere[] = [{ accountId: accounts }]
  if (input.query?.trim()) conditions.push({ or: ['from', 'to', 'subject', 'snippet', 'text'].map((field) => ({ [field]: { contains: input.query!.trim() } })) })
  if (input.cursor) {
    let cursor: { scope: string; date: string; id: string }
    try { cursor = JSON.parse(decodeText(input.cursor)) } catch { throw new Error(t('email.backend.cursor')) }
    if (cursor.scope !== cursorScope || typeof cursor.date !== 'string' || typeof cursor.id !== 'string') throw new Error(t('email.backend.cursor'))
    conditions.push({ or: [{ date: { lt: cursor.date } }, { and: [{ date: cursor.date }, { id: { gt: cursor.id } }] }] })
  }
  const messages: EmailMessageSummary[] = []
  const limit = input.limit ?? 100
  let pageCursor: string | undefined
  do {
    const page = await request<DatasetPage>(scope, { operation: 'query', dataset: scope.datasets.messages, query: {
      select: ['id', 'accountId', 'messageId', 'from', 'to', 'cc', 'replyTo', 'subject', 'date', 'snippet', 'hasAttachments'],
      where: { and: conditions }, orderBy: [{ field: 'date', direction: 'desc' }, { field: 'id', direction: 'asc' }], limit: 100, cursor: pageCursor
    } })
    const memberships = page.rows.length ? await queryAll(scope, scope.datasets.folderMessages, {
      accountId: accounts, messageId: { in: page.rows.map((row) => String(row.id)) }
    }) : []
    const byId = new Map<string, DatasetRecord[]>()
    for (const row of memberships) {
      const list = byId.get(String(row.messageId)) ?? []
      list.push(row)
      byId.set(String(row.messageId), list)
    }
    for (const row of page.rows) {
      const members = byId.get(String(row.id))
      if (!members) continue
      const matching = new Set(members.filter((member) => usable(member) && (input.view === 'unread' ? !flags(member).includes('\\Seen')
        : input.view === 'flagged' ? flags(member).includes('\\Flagged') : true)))
      if (!matching.size) continue
      members.sort((a, b) => Number(matching.has(b)) - Number(matching.has(a)) ||
        Number(String(b.folder).toUpperCase() === 'INBOX') - Number(String(a.folder).toUpperCase() === 'INBOX') || String(a.folder).localeCompare(String(b.folder)))
      messages.push(summarize(row, members))
      if (messages.length > limit) break
    }
    pageCursor = page.cursor
  } while (pageCursor && messages.length <= limit)
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
