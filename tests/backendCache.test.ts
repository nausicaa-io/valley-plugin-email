import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import type { DatasetQuery } from '@valley/plugin-sdk/datasets'
import config from '../config.json'
import { appendMessage, emailStoreContext, folderCacheStats, mergeFolder, moveCachedMessage, readAccounts, readFolder, removeAccountFiles, updateMessageFlags, upsertAccount } from '../src/backend/cache'
import { cacheMailboxes, cachedMailboxes, parseEmailAddresses, queryMessages, readMessage } from '../src/backend/query'
import { register, type MailBackendApi } from '../src/backend'
import type { CachedMessage, EmailAccount } from '../src/mailTypes'
import { encodeText } from '../src/backend/encoding'

const message: CachedMessage = { uid: 7, messageId: '<canopy@example.test>', from: 'Canopy <canopy@example.test>', to: 'reader@example.test', subject: 'Canopy survey', date: '2026-09-09T10:00:00.000Z', snippet: 'Forest', text: 'Rare forest orchid', flags: [], hasAttachments: false }
const account: EmailAccount = { id: 'station', provider: 'pureemail', address: 'station@example.test', imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true }, createdAt: 1 }
const createCache = (id = 'renamed-mail') => createMockValleyApi({ manifest: { id, datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
let mock: ReturnType<typeof createCache>
let scope: ReturnType<typeof emailStoreContext>
beforeEach(() => { mock = createCache(); scope = emailStoreContext(mock.api.data) })

describe('package-owned mail data and RPC', () => {
  it('works with arbitrary package identities and keeps accounts and messages in each owner', async () => {
    for (const id of ['canopy-client', 'meadow-client']) {
      const fixture = createCache(id)
      const owned = emailStoreContext(fixture.api.data)
      await upsertAccount(owned, { ...account, address: `${id}@example.test` })
      await mergeFolder(owned, account.id, 'INBOX', [{ ...message, subject: id }])
      expect((await readAccounts(owned))[0].address).toBe(`${id}@example.test`)
      expect((await queryMessages(owned, { accountId: account.id, view: 'recent' })).messages[0].subject).toBe(id)
      expect([...fixture.datasets.keys()].every((key) => key.startsWith(`${id}.`))).toBe(true)
    }
    expect(await readAccounts(scope)).toEqual([])
  })

  it('deduplicates account-wide memberships while preserving cross-account selection and stable cursors', async () => {
    await mergeFolder(scope, 'canopy', 'INBOX', [message])
    await mergeFolder(scope, 'canopy', 'Archive', [{ ...message, uid: 90 }])
    await mergeFolder(scope, 'meadow', 'INBOX', [{ ...message, subject: 'Meadow', date: '2026-09-10T10:00:00.000Z' }])
    await mergeFolder(scope, 'excluded', 'INBOX', [message])
    const query = { accountId: 'canopy', accountIds: ['canopy', 'meadow'], view: 'recent' as const, limit: 1 }
    const first = await queryMessages(scope, query)
    const second = await queryMessages(scope, { ...query, cursor: first.cursor })
    expect(first.messages[0].accountId).toBe('meadow')
    expect(first.cursor).toBeTruthy()
    expect(second.cursor).toBeUndefined()
    expect(second.messages[0]).toMatchObject({ folder: 'INBOX', uid: 7, memberships: [{ accountId: 'canopy', folder: 'INBOX', uid: 7 }, { accountId: 'canopy', folder: 'Archive', uid: 90 }] })
    expect(new Set([...first.messages, ...second.messages].map((entry) => entry.id)).size).toBe(2)
    expect((await readMessage(scope, { accountId: 'canopy', folder: 'Archive', uid: 90 }))?.text).toBe(message.text)
    await expect(queryMessages(scope, { ...query, accountIds: ['meadow'], cursor: first.cursor })).rejects.toThrow('Invalid mail cursor')
  })

  it('filters unread, flagged and special folders and parses quoted recipient aliases', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [{ ...message, flags: ['\\Flagged'] }])
    await mergeFolder(scope, 'station', 'Deleted', [{ ...message, messageId: '<deleted@example.test>', uid: 8 }])
    const mailbox = { path: 'Deleted', name: 'Deleted', selectable: true, specialUse: '\\Trash', cachedTotal: 12, cachedUnread: 3 }
    await cacheMailboxes(scope, 'station', [mailbox])
    expect(await cachedMailboxes(scope, 'station')).toEqual([{ accountId: 'station', path: 'Deleted', name: 'Deleted', selectable: true, specialUse: '\\Trash', delimiter: null }])
    for (const view of ['recent', 'unread', 'flagged'] as const) expect((await queryMessages(scope, { accountId: 'station', view })).messages).toHaveLength(1)
    await updateMessageFlags(scope, 'station', 'INBOX', 7, ['\\Seen'])
    expect((await queryMessages(scope, { accountId: 'station', view: 'unread' })).messages).toEqual([])
    expect((await queryMessages(scope, { accountId: 'station', view: 'folder', folder: 'Deleted' })).messages).toHaveLength(1)
    expect(parseEmailAddresses('"Fern, Forest" <fern+survey@example.test>; moss@example.test', true)).toEqual([{ name: 'Fern, Forest', address: 'fern+survey@example.test' }, { name: '', address: 'moss@example.test' }])
    expect(() => parseEmailAddresses('valid@example.test, invalid', true)).toThrow('Invalid email address')
  })

  it('updates one keyed flag transaction and preserves both accounts while moving duplicate destinations', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [message, { ...message, uid: 8, messageId: '<moss@example.test>' }])
    await mergeFolder(scope, 'station', 'Archive', [{ ...message, uid: 80 }, { ...message, uid: 81 }])
    await mergeFolder(scope, 'other', 'INBOX', [message])
    const transaction = vi.spyOn(mock.api.data, 'transaction')
    await updateMessageFlags(scope, 'station', 'INBOX', 7, ['\\Seen'])
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(transaction).toHaveBeenCalledWith([{ dataset: 'folder_messages', operation: 'upsert', values: { accountId: 'station', folder: 'INBOX', uid: 7, messageId: encodeText(JSON.stringify(['station', message.messageId])), flags: ['\\Seen'], unread: false, flagged: false } }])
    transaction.mockClear()
    await updateMessageFlags(scope, 'station', 'INBOX', 7, ['\\Seen'])
    expect(transaction).not.toHaveBeenCalled()
    await moveCachedMessage(scope, 'station', 'INBOX', 'Archive', 7, 100)
    expect((await readFolder(scope, 'station', 'Archive')).map((entry) => entry.uid)).toEqual([100])
    expect((await readFolder(scope, 'station', 'INBOX')).map((entry) => entry.uid)).toEqual([8])
    expect(await readFolder(scope, 'other', 'INBOX')).toEqual([message])
  })

  it('counts only live memberships and appends without rereading existing mail', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [message, { ...message, uid: 8, messageId: '<moss@example.test>', flags: ['\\Seen'] }])
    await mergeFolder(scope, 'station', 'Archive', [{ ...message, uid: 80 }])
    await mock.api.data.dataset('folder_messages').insert({ accountId: 'station', folder: 'INBOX', uid: 9, messageId: 'missing', flags: [] })
    expect(await folderCacheStats(scope, 'station')).toEqual(new Map([['INBOX', { total: 2, unread: 1 }], ['Archive', { total: 1, unread: 1 }]]))
    const reads = vi.spyOn(mock.api.data, 'dataset')
    const writes = vi.spyOn(mock.api.data, 'transaction')
    await appendMessage(scope, 'station', 'Sent', message)
    expect(reads).not.toHaveBeenCalled()
    expect(writes).toHaveBeenCalledTimes(1)
  })

  it('searches text while omitting bodies from summaries and joins all paginated memberships', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [message, { ...message, messageId: '<moss@example.test>', uid: 8, text: 'Moss' }])
    const id = encodeText(JSON.stringify(['station', message.messageId]))
    await mock.api.data.dataset('folder_messages').insert(Array.from({ length: 1004 }, (_, index) => ({ accountId: 'station', folder: `Archive-${index}`, uid: 90, messageId: id, flags: [] })))
    const result = await queryMessages(scope, { accountId: 'station', view: 'folder', folder: 'INBOX', query: 'orchid' })
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].memberships).toHaveLength(1005)
    expect(result.messages[0]).not.toHaveProperty('text')
    expect(result.messages[0]).not.toHaveProperty('html')
  })

  it('registers owner-local RPC handlers, validates payloads, and returns account objects', async () => {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
    const api: MailBackendApi = { data: mock.api.data,
      accounts: { list: vi.fn(async () => []), authorize: vi.fn() },
      credentials: { state: vi.fn(async () => 'ok' as const), set: vi.fn(), delete: vi.fn(), handle: vi.fn(), write: vi.fn() },
      network: { fetch: vi.fn(), open: vi.fn(), read: vi.fn(), write: vi.fn(), startTls: vi.fn(), close: vi.fn() },
      rpc: { handle: (name, handler) => { handlers.set(name, handler); return () => { handlers.delete(name) } }, emit: vi.fn() }
    }
    const dispose = register(api)
    await upsertAccount(scope, account)
    expect(await handlers.get('listAccounts')!({})).toMatchObject({ ok: true, data: { accounts: [{ ...account, secretState: 'ok' }] } })
    expect(await handlers.get('applyMessageAction')!({ accountId: 'station', folder: 'INBOX', uid: 1.5, action: 'trash' })).toMatchObject({ ok: false })
    expect(api.network.open).not.toHaveBeenCalled()
    dispose()
    expect(handlers.size).toBe(0)
  })

  it.each([1001, 10000])('reads only sparse folder/unread/flagged candidates beside %i unrelated messages', async count => {
    await mergeFolder(scope, 'station', 'Needle', [{ ...message, flags: ['\\Flagged'] }])
    const background = Array.from({ length: count }, (_, index) => ({ id: encodeText(JSON.stringify(['station', `<background-${index}>`])), uid: index }))
    const messages = mock.datasets.get('renamed-mail.messages')!
    const memberships = mock.datasets.get('renamed-mail.folder_messages')!
    messages.push(...background.map(row => ({ ...messages[0], id: row.id, messageId: `<background-${row.uid}>` })))
    memberships.push(...background.map(row => ({ ...memberships[0], folder: 'Archive', uid: row.uid, messageId: row.id, flags: ['\\Seen'], unread: false, flagged: false })))
    const reads: { dataset: string; query: DatasetQuery; rows: number }[] = []
    const dataset = mock.api.data.dataset.bind(mock.api.data)
    const observed = vi.spyOn(mock.api.data, 'dataset').mockImplementation(((name: string) => {
      const owner = dataset(name)
      return { ...owner, query: async (query: DatasetQuery = {}) => {
        const page = await owner.query(query)
        reads.push({ dataset: name, query, rows: page.rows.length })
        return page
      } }
    }) as typeof mock.api.data.dataset)
    try {
      for (const view of ['folder', 'unread', 'flagged'] as const) {
        reads.length = 0
        const result = await queryMessages(scope, { accountId: 'station', view, folder: 'Needle' })
        expect(result.messages.map(row => row.messageId)).toEqual([message.messageId])
        expect(reads.reduce((total, read) => total + read.rows, 0)).toBe(3)
        const fetched = reads.filter(read => read.dataset === 'messages')
        expect(fetched).toHaveLength(1)
        expect(fetched[0].query.where).toMatchObject({ and: [{ accountId: 'station', id: { in: [result.messages[0].id] } }] })
        expect(fetched[0].query.select).not.toContain('text')
        expect(fetched[0].query.select).not.toContain('html')
        const eligible = reads.find(read => read.dataset === 'folder_messages' && read.rows === 1)!
        expect(eligible.query.where).toEqual(view === 'folder' ? { accountId: 'station', folder: 'Needle' } : { accountId: 'station', [view]: true })
      }
    } finally { observed.mockRestore() }
  })

  it.each([999, 1000, 1001])('keeps globally ordered date/id cursors and deduplicated memberships across %i eligible rows', async count => {
    const source = Array.from({ length: count }, (_, index) => ({ ...message, uid: index, messageId: `<ordered-${index}>`, date: new Date(Date.parse(message.date) + index * 1000).toISOString() }))
    await mergeFolder(scope, 'station', 'INBOX', source)
    await mergeFolder(scope, 'station', 'Archive', source.slice(0, 4))
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = await queryMessages(scope, { accountId: 'station', accountIds: ['station', 'station'], view: 'recent', limit: 200, cursor })
      ids.push(...page.messages.map(row => row.id))
      cursor = page.cursor
    } while (cursor)
    expect(ids).toEqual([...source].reverse().map(row => encodeText(JSON.stringify(['station', row.messageId]))))
    expect(new Set(ids).size).toBe(count)
  })

  it('keeps date ties in id order across pages and rejects cursors from another filter', async () => {
    const source = ['<ddd>', '<bbb>', '<aaa>', '<ccc>'].map((messageId, uid) => ({ ...message, uid, messageId }))
    await mergeFolder(scope, 'station', 'INBOX', source)
    await mergeFolder(scope, 'station', 'Archive', source)
    const query = { accountId: 'station', view: 'recent' as const, limit: 2 }
    const first = await queryMessages(scope, query)
    const second = await queryMessages(scope, { ...query, cursor: first.cursor })
    expect([...first.messages, ...second.messages].map(row => row.id)).toEqual(source.map(row => encodeText(JSON.stringify(['station', row.messageId]))).sort())
    expect(second.cursor).toBeUndefined()
    expect([...first.messages, ...second.messages].every(row => row.memberships.length === 2)).toBe(true)
    await expect(queryMessages(scope, { ...query, query: 'Forest', cursor: first.cursor })).rejects.toThrow('Invalid mail cursor')
    await expect(queryMessages(scope, { ...query, view: 'unread', cursor: first.cursor })).rejects.toThrow('Invalid mail cursor')
  })

  it('isolates special-use folders with identical names in different accounts and reflects reclassification', async () => {
    await mergeFolder(scope, 'station', 'Special', [{ ...message, flags: ['\\Flagged'] }])
    await mergeFolder(scope, 'other', 'Special', [{ ...message, flags: ['\\Flagged'] }])
    await cacheMailboxes(scope, 'station', [{ path: 'Special', name: 'Special', selectable: true, specialUse: '\\Trash' }])
    await cacheMailboxes(scope, 'other', [{ path: 'Special', name: 'Special', selectable: true }])
    for (const view of ['recent', 'unread', 'flagged'] as const) {
      const result = await queryMessages(scope, { accountId: 'station', accountIds: ['station', 'other', 'other'], view })
      expect(result.messages.map(row => row.accountId)).toEqual(['other'])
    }
    await cacheMailboxes(scope, 'station', [{ path: 'Special', name: 'Special', selectable: true }])
    expect((await queryMessages(scope, { accountId: 'station', accountIds: ['station', 'other'], view: 'unread' })).messages).toHaveLength(2)
  })

  it('backfills null flag projections in guarded pages and coalesces simultaneous queries', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [message])
    const id = encodeText(JSON.stringify(['station', message.messageId]))
    await mock.api.data.dataset('folder_messages').insert(Array.from({ length: 1001 }, (_, index) => ({ accountId: 'station', folder: 'Archive', uid: index, messageId: id,
      flags: index % 2 ? ['\\Seen'] : ['\\Flagged'], unread: null, flagged: null })))
    const transaction = vi.spyOn(mock.api.data, 'transaction')
    const results = await Promise.all([queryMessages(scope, { accountId: 'station', view: 'unread' }), queryMessages(scope, { accountId: 'station', view: 'flagged' })])
    expect(results.every(result => result.messages.length === 1)).toBe(true)
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(transaction.mock.calls.map(([operations]) => operations.length)).toEqual([1000, 1])
    for (const [, options] of transaction.mock.calls) expect(options?.expected).toEqual([{ dataset: 'folder_messages', revision: expect.any(Number) }])
    const rows = mock.datasets.get('renamed-mail.folder_messages')!
    expect(rows.every(row => row.unread === !(row.flags as string[]).includes('\\Seen') && row.flagged === (row.flags as string[]).includes('\\Flagged'))).toBe(true)
  })

  it('does not overwrite a flag change racing projection backfill or replay uncertain mutations', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [message])
    const memberships = mock.api.data.dataset('folder_messages')
    const key = { accountId: 'station', folder: 'INBOX', uid: message.uid }
    await memberships.update(key, { unread: null, flagged: null })
    const transaction = mock.api.data.transaction.bind(mock.api.data)
    const writing = vi.spyOn(mock.api.data, 'transaction').mockImplementationOnce(async (operations, options) => {
      await memberships.update(key, { flags: ['\\Seen'], unread: false, flagged: false })
      return transaction(operations, options)
    })
    expect((await queryMessages(scope, { accountId: 'station', view: 'unread' })).messages).toEqual([])
    expect(await memberships.get(key)).toMatchObject({ flags: ['\\Seen'], unread: false, flagged: false })
    expect(writing).toHaveBeenCalledTimes(1)
    await memberships.update(key, { unread: null, flagged: null })
    writing.mockClear().mockRejectedValueOnce(new Error('unknown transport outcome'))
    await expect(queryMessages(scope, { accountId: 'station', view: 'unread' })).rejects.toThrow('unknown transport outcome')
    expect(writing).toHaveBeenCalledTimes(1)
    writing.mockRestore()
    expect(await memberships.get(key)).toMatchObject({ flags: ['\\Seen'], unread: null, flagged: null })
  })

  it('keeps flag projections atomic through updates, moves, membership removal and reconciliation', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [message])
    await updateMessageFlags(scope, 'station', 'INBOX', message.uid, ['\\Flagged', '\\Seen'])
    await moveCachedMessage(scope, 'station', 'INBOX', 'Archive', message.uid, 80)
    expect((await queryMessages(scope, { accountId: 'station', view: 'folder', folder: 'INBOX' })).messages).toEqual([])
    expect((await queryMessages(scope, { accountId: 'station', view: 'flagged' })).messages[0]).toMatchObject({ folder: 'Archive', uid: 80 })
    await mergeFolder(scope, 'station', 'Archive', [{ ...message, uid: 80 }])
    expect((await queryMessages(scope, { accountId: 'station', view: 'flagged' })).messages).toEqual([])
    expect((await queryMessages(scope, { accountId: 'station', view: 'unread' })).messages).toHaveLength(1)
    const before = await mock.api.data.dataset('folder_messages').get({ accountId: 'station', folder: 'Archive', uid: 80 })
    const transaction = vi.spyOn(mock.api.data, 'transaction').mockRejectedValueOnce(new Error('rejected'))
    await expect(updateMessageFlags(scope, 'station', 'Archive', 80, ['\\Seen'])).rejects.toThrow('rejected')
    expect(await mock.api.data.dataset('folder_messages').get({ accountId: 'station', folder: 'Archive', uid: 80 })).toEqual(before)
    transaction.mockRestore()
    await moveCachedMessage(scope, 'station', 'Archive', 'Remote trash', 80)
    expect((await queryMessages(scope, { accountId: 'station', view: 'recent' })).messages).toEqual([])
  })

  it('removes account projections without removing identical messages and memberships in another account', async () => {
    for (const accountId of ['station', 'other']) {
      await upsertAccount(scope, { ...account, id: accountId })
      await mergeFolder(scope, accountId, 'INBOX', [{ ...message, flags: ['\\Flagged'] }])
    }
    expect((await removeAccountFiles(scope, 'station')).map(row => row.id)).toEqual(['other'])
    for (const view of ['recent', 'unread', 'flagged'] as const) {
      const result = await queryMessages(scope, { accountId: 'station', accountIds: ['station', 'other'], view })
      expect(result.messages.map(row => row.accountId)).toEqual(['other'])
    }
    expect(mock.datasets.get('renamed-mail.folder_messages')).toEqual([expect.objectContaining({ accountId: 'other', unread: true, flagged: true })])
  })

  it('applies the declared projection DDL to v1 rows and uses flag indexes with the SDK primary-key order', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE folder_messages (accountId TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, messageId TEXT NOT NULL, flags TEXT NOT NULL, PRIMARY KEY(accountId,folder,uid))')
      db.prepare('INSERT INTO folder_messages VALUES (?,?,?,?,?)').run('station', 'INBOX', 7, 'message', '["\\\\Flagged"]')
      for (const step of config.datasetMigrations[0].steps) {
        if (step.operation === 'add-column') {
          expect(step.definition).toEqual({ type: 'boolean', nullable: true })
          db.exec(`ALTER TABLE folder_messages ADD COLUMN "${step.column}" INTEGER`)
        } else if (step.index) {
          db.exec(`CREATE INDEX "${step.index.id}" ON folder_messages (${step.index.columns.map(column => `"${column}"`).join(',')})`)
        }
      }
      expect(db.prepare('SELECT flags,unread,flagged FROM folder_messages').get()).toEqual({ flags: '["\\\\Flagged"]', unread: null, flagged: null })
      for (const field of ['unread', 'flagged']) {
        for (const predicate of ['IS NULL', '=1']) {
          const projection = predicate === 'IS NULL' ? 'accountId,folder,uid,flags' : 'accountId,folder,messageId'
          const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT ${projection} FROM folder_messages WHERE accountId=? AND ${field} ${predicate} ORDER BY accountId,folder,uid LIMIT 1000`).all('station')
          expect(plan).toEqual([expect.objectContaining({ detail: expect.stringContaining(`INDEX ${field}_query (accountId=? AND ${field}=?)`) })])
        }
      }
      db.exec('UPDATE folder_messages SET unread=1,flagged=1')
      expect(db.prepare('SELECT messageId FROM folder_messages WHERE accountId=? AND unread=1 ORDER BY accountId,folder,uid LIMIT 1000').all('station')).toEqual([{ messageId: 'message' }])
    } finally { db.close() }
  })
})
