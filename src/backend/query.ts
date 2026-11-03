import { t } from './localization'
import { decodeText, encodeText } from './encoding'
import { addressParser } from 'postal-mime'
import type { EmailAddress, EmailMessageDetail, EmailMessageQuery, EmailMessageRef, EmailMessageSummary } from '../mailTypes'
import type { DatasetPage, DatasetRecord, DatasetWhere } from '@valley/plugin-sdk/datasets'
import { datasetRequest as request, ensureMembershipFlags, folderProjection, projectAssignments, queryAll, readStructure, removeFromFolder, type EmailStoreContext } from './cache'
import { readAutomationHeaders } from './automation'

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
    ...(readAutomationHeaders(row.automationHeaders) ? { automationHeaders: readAutomationHeaders(row.automationHeaders) } : {}),
    id: text('id'), accountId: text('accountId'), folder: String(primary.folder), uid: Number(primary.uid), ...(typeof primary.uidValidity === 'number' ? { uidValidity: primary.uidValidity } : {}),
    memberships: memberships.map((item) => ({ accountId: text('accountId'), folder: String(item.folder), uid: Number(item.uid), ...(typeof item.uidValidity === 'number' ? { uidValidity: item.uidValidity } : {}) })),
    messageId: text('messageId'), from: text('from'), to: text('to'), cc: text('cc'), replyTo: text('replyTo'),
    ...(typeof row.categoryId === 'string' ? { categoryId: row.categoryId } : {}), isVip: row.isVip === true, isSpam: row.isSpam === true, hasContact: row.hasContact === true,
    ...(typeof row.contentRevision === 'string' ? { contentRevision: row.contentRevision } : {}),
    subject: text('subject'), date: typeof row.sortDate === 'string' ? row.sortDate : text('date'), snippet: text('snippet'), hasAttachments: row.hasAttachments === true,
    flags: flags(primary),
    addresses: { from: parseEmailAddresses(text('from')), to: parseEmailAddresses(text('to')),
      cc: parseEmailAddresses(text('cc')), replyTo: parseEmailAddresses(text('replyTo')) }
  }
}

export async function ensureQueryProjections(scope: EmailStoreContext, accountIds: string[]): Promise<void> {
  for (const accountId of accountIds) {
    await ensureMembershipFlags(scope, accountId)
    let conflicts = 0
    for (;;) {
      const page = await scope.data.dataset(scope.datasets.messages).query({ where: { accountId, projectionVersion: 0 }, select: ['id', 'date'], limit: 500 })
      if (!page.rows.length) break
      const spam = await scope.data.dataset(scope.datasets.folderMessages).aggregate({ where: { accountId, messageId: { in: page.rows.map(row => String(row.id)) }, spam: true }, groupBy: ['messageId'], metrics: { count: { operation: 'count' } } })
      try {
        await scope.data.transaction(page.rows.map(row => ({ dataset: scope.datasets.messages, operation: 'update', key: { id: String(row.id) }, values: { sortDate: row.date, isSpam: spam.some(member => member.messageId === row.id), projectionVersion: 1 } })), { expected: [{ dataset: scope.datasets.messages, revision: page.revision }] })
        conflicts = 0
      } catch (reason) { if ((reason as { code?: string }).code !== 'conflict' || ++conflicts >= 3) throw reason }
    }
  }
}

export async function queryMessages(scope: EmailStoreContext, input: EmailMessageQuery): Promise<{ messages: EmailMessageSummary[]; cursor?: string; total: number }> {
  const accountIds = [...new Set((input.accountIds?.length ? input.accountIds : [input.accountId]).filter(Boolean))].sort()
  if (!accountIds.length) return { messages: [], total: 0 }
  await ensureQueryProjections(scope, accountIds)
  const filters = input.filters ?? {}
  const membership: DatasetWhere = {}
  if (input.view === 'folder') membership.folder = input.folder
  else if (filters.spam === 'spam') membership.spam = true
  else if (filters.spam === 'all') membership.or = [{ excluded: false }, { spam: true }]
  else membership.excluded = false
  if (input.view === 'unread' || input.view === 'flagged') membership[input.view] = true
  const conditions: DatasetWhere[] = [
    { accountId: { in: accountIds } },
    { exists: { dataset: scope.datasets.folderMessages, on: { id: 'messageId', accountId: 'accountId' }, where: membership } }
  ]
  if (filters.contact && filters.contact !== 'all') conditions.push({ hasContact: filters.contact === 'known' })
  if (filters.vip && filters.vip !== 'all') conditions.push({ isVip: filters.vip === 'vip' })
  if (filters.spam === 'spam' || filters.spam === 'not-spam') conditions.push({ isSpam: filters.spam === 'spam' })
  if (filters.categoryIds?.length) conditions.push({ categoryId: { in: filters.categoryIds } })
  else if (filters.categoryId) conditions.push({ categoryId: filters.categoryId === 'uncategorized' ? { isNull: true } : filters.categoryId })
  if (filters.categoryAccountId) conditions.push({ accountId: filters.categoryAccountId })
  if (input.query?.trim()) conditions.push({ or: ['from', 'to', 'cc', 'subject', 'snippet', 'text', 'html'].map(field => ({ [field]: { contains: input.query!.trim() } })) })
  const stamp = await scope.data.snapshot([
    { operation: 'query', dataset: scope.datasets.messages, query: { select: ['id'], limit: 1 } },
    { operation: 'query', dataset: scope.datasets.folderMessages, query: { select: ['uid'], limit: 1 } }
  ])
  const cursorScope = JSON.stringify([accountIds, input.view, input.folder ?? '', input.query ?? '', filters, stamp.values.map(value => (value as DatasetPage).revision)])
  let after: string | undefined
  if (input.cursor) {
    let cursor: { scope: string; after: string }
    try { cursor = JSON.parse(decodeText(input.cursor)) } catch { throw new Error(t('email.backend.cursor')) }
    if (cursor.scope !== cursorScope || typeof cursor.after !== 'string') throw new Error(t('email.backend.cursor'))
    after = cursor.after
  }
  const where = { and: conditions }
  const page = await scope.data.dataset(scope.datasets.messages).query({
    select: ['id', 'accountId', 'messageId', 'from', 'to', 'cc', 'replyTo', 'subject', 'date', 'sortDate', 'snippet', 'hasAttachments', 'categoryId', 'isVip', 'isSpam', 'hasContact', 'contentRevision'],
    where, orderBy: [{ field: 'sortDate', direction: 'desc' }, { field: 'id', direction: 'desc' }], limit: input.limit ?? 100, cursor: after
  })
  const members: DatasetRecord[] = []
  for (let index = 0; index < page.rows.length; index += 100) members.push(...await queryAll(scope, scope.datasets.folderMessages, { messageId: { in: page.rows.slice(index, index + 100).map(row => String(row.id)) } }))
  const matching = (row: DatasetRecord) => (input.view === 'folder' ? row.folder === input.folder : filters.spam === 'spam' ? row.spam === true : filters.spam === 'all' ? !row.excluded || row.spam === true : !row.excluded) && (input.view === 'unread' ? row.unread : input.view === 'flagged' ? row.flagged : true)
  const messages = page.rows.flatMap(row => {
    const locations = members.filter(member => member.messageId === row.id && member.accountId === row.accountId)
    locations.sort((a, b) => Number(Boolean(matching(b))) - Number(Boolean(matching(a))) || Number(String(b.folder).toUpperCase() === 'INBOX') - Number(String(a.folder).toUpperCase() === 'INBOX') || String(a.folder).localeCompare(String(b.folder)))
    return locations.length ? [summarize(row, locations)] : []
  })
  return { messages, total: await scope.data.dataset(scope.datasets.messages).count(where), ...(page.cursor ? { cursor: encodeText(JSON.stringify({ scope: cursorScope, after: page.cursor })) } : {}) }
}

export async function readMessage(scope: EmailStoreContext, ref: EmailMessageRef): Promise<EmailMessageDetail | null> {
  const membership = await request<DatasetRecord | null>(scope, { operation: 'get', dataset: scope.datasets.folderMessages, key: { accountId: ref.accountId, folder: ref.folder, uid: ref.uid } })
  if (!membership || ref.uidValidity !== undefined && membership.uidValidity !== ref.uidValidity) return null
  const row = await request<DatasetRecord | null>(scope, { operation: 'get', dataset: scope.datasets.messages, key: { id: String(membership.messageId) } })
  if (!row) return null
  const memberships = await queryAll(scope, scope.datasets.folderMessages, { accountId: ref.accountId, messageId: String(membership.messageId) })
  const others = memberships.filter((entry) => entry.folder !== ref.folder || entry.uid !== ref.uid)
  const structure = readStructure(row.structure)
  const text = typeof row.text === 'string' ? row.text : undefined, html = typeof row.html === 'string' ? row.html : undefined
  // A reply carries at most INLINE_BODY_CHARACTERS of body; a larger or not yet downloaded body is loaded in slices by the reader.
  const deferred = Boolean(structure?.deferred?.length || structure?.failure) || (text?.length ?? 0) + (html?.length ?? 0) > INLINE_BODY_CHARACTERS
  const attachments = (structure?.attachments ?? []).map((part, index) => ({ index, filename: part.filename, mimeType: part.mimeType, size: part.size, ...(part.inline ? { inline: true } : {}) }))
  return { ...summarize(row, [membership, ...others]), ...(!deferred && text !== undefined ? { text } : {}), ...(!deferred && html !== undefined ? { html } : {}),
    ...(attachments.length ? { attachments } : {}), ...(deferred ? { bodyDeferred: true } : {}), ...(structure?.failure ? { bodyError: structure.failure } : {}) }
}

/** Characters of text and HTML returned inline by readMessage; a command operation reply is bounded at 4 MiB of UTF-8. */
export const INLINE_BODY_CHARACTERS = 1024 * 1024

export async function cacheMailboxes(scope: EmailStoreContext, accountId: string, mailboxes: { path: string; name: string; specialUse?: string; delimiter?: string; selectable: boolean }[]): Promise<void> {
  if (!mailboxes.length) return
  const cached = new Map((await cachedMailboxes(scope, accountId)).map((row) => [String(row.path), row]))
  const rows = mailboxes.map((mailbox) => ({
    accountId, path: mailbox.path, name: mailbox.name, selectable: mailbox.selectable,
    specialUse: mailbox.specialUse ?? null, delimiter: mailbox.delimiter ?? null
  }))
  const changed = rows.filter((row) => { const previous = cached.get(row.path); return !previous || Object.entries(row).some(([column, value]) => previous[column] !== value) })
  if (changed.length) await request(scope, { operation: 'transaction', operations: changed.map((values) => ({ operation: 'upsert', dataset: scope.datasets.mailboxes, values })) })
  // A mailbox the server no longer lists (or a cached folder it never listed) takes its cached messages (once no other folder
  // holds them), its sync state and its row along. A listing without INBOX is not a whole listing and removes nothing.
  const listed = new Set(rows.map((row) => row.path))
  const whole = rows.some((row) => row.path.toUpperCase() === 'INBOX')
  const folders = whole ? (await scope.data.dataset(scope.datasets.folderMessages).aggregate({ where: { accountId }, groupBy: ['folder'], metrics: { total: { operation: 'count' } } })).map((row) => String(row.folder)) : []
  for (const path of whole ? [...new Set([...cached.keys(), ...folders])].filter((path) => !listed.has(path)) : []) {
    await removeFromFolder(scope, accountId, path, (await queryAll(scope, scope.datasets.folderMessages, { accountId, folder: path }, ['uid'])).map((row) => Number(row.uid)))
    await request(scope, { operation: 'transaction', operations: [
      { operation: 'delete', dataset: 'sync_state', key: { accountId, folder: path } },
      { operation: 'delete', dataset: scope.datasets.mailboxes, key: { accountId, path } }
    ] })
  }
  for (const mailbox of mailboxes) {
    const stale: DatasetWhere = (cached.get(mailbox.path)?.specialUse ?? null) === (mailbox.specialUse ?? null) ? { or: [{ projectionVersion: { isNull: true } }, { projectionVersion: { neq: 1 } }] } : {}
    let cursor: string | undefined
    do {
      const page = await scope.data.dataset(scope.datasets.folderMessages).query({ where: { accountId, folder: mailbox.path, ...stale }, select: ['uid', 'messageId', 'flags'], limit: 500, cursor })
      if (page.rows.length) await scope.data.transaction(page.rows.map(row => ({ operation: 'update', dataset: scope.datasets.folderMessages, key: { accountId, folder: mailbox.path, uid: Number(row.uid) }, values: folderProjection(mailbox.path, mailbox.specialUse, Array.isArray(row.flags) ? row.flags as string[] : []) })))
      if (page.rows.length) await projectAssignments(scope, [...new Set(page.rows.map(row => String(row.messageId)))])
      cursor = page.cursor
    } while (cursor)
  }
}

export async function cachedMailboxes(scope: EmailStoreContext, accountId: string): Promise<DatasetRecord[]> {
  return queryAll(scope, scope.datasets.mailboxes, { accountId })
}

/** The cached Sent mailbox of an account: its special-use \\Sent folder, else one named like it, else "Sent". */
export async function cachedSentFolder(scope: EmailStoreContext, accountId: string): Promise<string> {
  const mailboxes = (await cachedMailboxes(scope, accountId)).filter((row) => row.selectable !== false)
  const sent = mailboxes.find((row) => typeof row.specialUse === 'string' && row.specialUse.toLowerCase() === '\\sent')
    ?? mailboxes.find((row) => /^(?:sent|sent items|sent messages|sent mail)$/i.test(String(row.name)))
  return sent ? String(sent.path) : 'Sent'
}
