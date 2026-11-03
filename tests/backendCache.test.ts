import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import type { DatasetQuery, DatasetTransactionOperation } from '@valley/plugin-sdk/datasets'
import config from '../config.json'
import { appendMessage, cachedFolderHeaders, emailStoreContext, folderCacheStats, mergeFolder, moveCachedMessage, pruneFolder, readAccounts, readFolder, removeAccountFiles, updateMessageFlags, upsertAccount } from '../src/backend/cache'
import { cacheMailboxes, cachedMailboxes, parseEmailAddresses, queryMessages, readMessage } from '../src/backend/query'
import { register, type MailBackendApi } from '../src/backend'
import type { CachedMessage, EmailAccount } from '../src/mailTypes'
import { encodeText } from '../src/backend/encoding'
import { commandContracts } from './commandContracts'
import { identifyMessage } from '../src/backend/identity'

// Real-size fixtures (cursor page boundaries, a body above the part limit): a few seconds alone, far longer at a high load average.
const HEAVY_TEST_MS = 60_000

const message: CachedMessage = { uid: 7, messageId: '<canopy@example.test>', from: 'Canopy <canopy@example.test>', to: 'reader@example.test', subject: 'Canopy survey', date: '2026-09-09T10:00:00.000Z', snippet: 'Forest', text: 'Rare forest orchid', flags: [], hasAttachments: false }
const account: EmailAccount = { id: 'station', provider: 'pureemail', address: 'station@example.test', imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true }, createdAt: 1 }
const createCache = (id = 'renamed-mail') => createMockValleyApi({ manifest: { id, datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
let mock: ReturnType<typeof createCache>
let scope: ReturnType<typeof emailStoreContext>
beforeEach(() => { mock = createCache(); scope = emailStoreContext(mock.api.data) })

describe('package-owned mail data and RPC', () => {
  it('bounds projection conflicts and permits a later retry without losing cached messages', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [message])
    const rows = await scope.data.dataset('messages').query({ limit: 1 })
    await scope.data.dataset('messages').update({ id: String(rows.rows[0].id) }, { projectionVersion: 0, sortDate: null })
    const conflict = Object.assign(new Error('Dataset revision changed'), { code: 'conflict' })
    const writing = vi.spyOn(scope.data, 'transaction').mockRejectedValue(conflict)
    await expect(queryMessages(scope, { accountId: 'station', view: 'recent' })).rejects.toBe(conflict)
    expect(writing).toHaveBeenCalledTimes(3)
    writing.mockRestore()
    const page = await queryMessages(scope, { accountId: 'station', view: 'recent' })
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0].date).toBe(message.date)
    expect((await scope.data.dataset('messages').query({ limit: 1 })).rows[0].projectionVersion).toBe(1)
  })

  it('returns JSON-safe summaries and details when optional metadata is absent', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [message])
    const page = await queryMessages(scope, { accountId: 'station', view: 'recent' })
    expect(page.messages).toHaveLength(1)
    const detail = await readMessage(scope, { accountId: 'station', folder: 'INBOX', uid: message.uid })
    expect(page).toStrictEqual(JSON.parse(JSON.stringify(page)))
    expect(detail).toStrictEqual(JSON.parse(JSON.stringify(detail)))
    expect(detail).not.toHaveProperty('html')
    expect(detail).not.toHaveProperty('categoryId')
  })

  it('searches HTML-only mail and copy recipients through the mailbox API', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [{ ...message, text: undefined, html: `<p>${'Canopy survey. '.repeat(500)}Rare orchid habitat.</p>`, cc: 'moss@example.test' }])
    for (const query of ['orchid', 'moss@example.test']) {
      const result = await queryMessages(scope, { accountId: 'station', view: 'recent', query })
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].messageId).toBe(message.messageId)
      expect(result.messages[0]).not.toHaveProperty('html')
    }
  })

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
    expect(transaction).toHaveBeenCalledWith([{ dataset: 'folder_messages', operation: 'update', key: { accountId: 'station', folder: 'INBOX', uid: 7 }, values: { flags: ['\\Seen'], unread: false, flagged: false } }])
    transaction.mockClear()
    await updateMessageFlags(scope, 'station', 'INBOX', 7, ['\\Seen'])
    expect(transaction).not.toHaveBeenCalled()
    await moveCachedMessage(scope, 'station', 'INBOX', 'Archive', 7, 100)
    expect((await readFolder(scope, 'station', 'Archive')).map((entry) => entry.uid).sort((a, b) => a - b)).toEqual([80, 81, 100])
    expect((await readFolder(scope, 'station', 'INBOX')).map((entry) => entry.uid)).toEqual([8])
    expect(await readFolder(scope, 'other', 'INBOX')).toMatchObject([message])
  })

  it('returns applyMessageAction messages in the published output schema', async () => {
    const contract = commandContracts.find(entry => entry.command.id === 'applyMessageAction')!
    const valid = (messages: CachedMessage[], destinationFolder?: string) => contract.output(JSON.parse(JSON.stringify({ action: 'flag', folder: 'INBOX', messages, destinationFolder })))
    await mergeFolder(scope, 'station', 'INBOX', [message, { ...message, uid: 8, messageId: '<moss@example.test>' }])
    const flagged = await updateMessageFlags(scope, 'station', 'INBOX', 7, ['\\Flagged'])
    expect(valid(flagged), JSON.stringify(contract.output.errors)).toBe(true)
    expect(flagged).toEqual(await readFolder(scope, 'station', 'INBOX').then(rows => rows.filter(row => row.uid === 7)))
    expect(flagged[0].flags).toEqual(['\\Flagged'])
    const moved = await moveCachedMessage(scope, 'station', 'INBOX', 'Archive', 7, 100)
    expect(valid(moved, 'Archive'), JSON.stringify(contract.output.errors)).toBe(true)
  })

  it('counts only live memberships and appends without rereading existing mail', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [message, { ...message, uid: 8, messageId: '<moss@example.test>', flags: ['\\Seen'] }])
    await mergeFolder(scope, 'station', 'Archive', [{ ...message, uid: 80 }])
    await mock.api.data.dataset('folder_messages').insert({ accountId: 'station', folder: 'INBOX', uid: 9, messageId: 'missing', flags: [] })
    expect(await folderCacheStats(scope, 'station')).toEqual(new Map([['INBOX', { total: 2, unread: 1 }], ['Archive', { total: 1, unread: 1 }]]))
    const reads = vi.spyOn(mock.api.data, 'dataset')
    const writes = vi.spyOn(mock.api.data, 'transaction')
    await appendMessage(scope, 'station', 'Sent', message)
    expect(reads.mock.calls.every(([name]) => name !== 'attachments')).toBe(true)
    expect(writes).toHaveBeenCalledTimes(2)
  })

  it('searches text while omitting bodies from summaries and joins all paginated memberships', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [message, { ...message, messageId: '<moss@example.test>', uid: 8, text: 'Moss' }])
    const id = (await identifyMessage('station', 'INBOX', message)).logicalId!
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
      credentials: { presence: vi.fn(async () => 'stored' as const), state: vi.fn(async () => 'ok' as const), set: vi.fn(), delete: vi.fn(), handle: vi.fn(), write: vi.fn() },
      network: { fetch: vi.fn(), open: vi.fn(), read: vi.fn(), write: vi.fn(), startTls: vi.fn(), close: vi.fn() },
      rpc: { handle: (name, handler) => { handlers.set(name, handler); return () => { handlers.delete(name) } }, emit: vi.fn() }
    }
    const dispose = register(api)
    await upsertAccount(scope, account)
    expect(await handlers.get('listAccounts')!({})).toMatchObject({ ok: true, data: { accounts: [{ ...account, secretState: 'stored' }] } })
    expect(await handlers.get('applyMessageAction')!({ accountId: 'station', folder: 'INBOX', uid: 1.5, action: 'trash' })).toMatchObject({ ok: false })
    expect(api.credentials.state).not.toHaveBeenCalled()
    expect(api.credentials.presence).toHaveBeenCalledWith(account.id, expect.any(Object))
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
        expect(reads.reduce((total, read) => total + read.rows, 0)).toBeLessThanOrEqual(4)
        const fetched = reads.filter(read => read.dataset === 'messages')
        const summary = fetched.find(read => read.rows > 0 && read.query.select?.includes('subject'))!
        expect(fetched.filter(read => read.query.select?.includes('subject'))).toHaveLength(1)
        expect(summary.query.where).toMatchObject({ and: [{ accountId: { in: ['station'] } }, { exists: { dataset: 'folder_messages', on: { id: 'messageId', accountId: 'accountId' } } }] })
        expect(summary.query.select).not.toContain('text')
        expect(summary.query.select).not.toContain('html')
        const eligible = reads.find(read => read.dataset === 'folder_messages' && read.rows === 1 && read.query.where?.messageId)!
        expect(eligible.query.where).toEqual({ messageId: { in: [result.messages[0].id] } })
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
    expect(ids).toEqual(await Promise.all([...source].reverse().map(async row => (await identifyMessage('station', 'INBOX', row)).logicalId!)))
    expect(new Set(ids).size).toBe(count)
  }, HEAVY_TEST_MS)

  it('keeps date ties in id order across pages and rejects cursors from another filter', async () => {
    const source = ['<ddd@example.test>', '<bbb@example.test>', '<aaa@example.test>', '<ccc@example.test>'].map((messageId, uid) => ({ ...message, uid, messageId }))
    await mergeFolder(scope, 'station', 'INBOX', source)
    await mergeFolder(scope, 'station', 'Archive', source)
    const query = { accountId: 'station', view: 'recent' as const, limit: 2 }
    const first = await queryMessages(scope, query)
    const second = await queryMessages(scope, { ...query, cursor: first.cursor })
    expect([...first.messages, ...second.messages].map(row => row.id)).toEqual((await Promise.all(source.map(async row => (await identifyMessage('station', 'INBOX', row)).logicalId!))).sort().reverse())
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
    const id = (await identifyMessage('station', 'INBOX', message)).logicalId!
    await mock.api.data.dataset('folder_messages').insert(Array.from({ length: 1001 }, (_, index) => ({ accountId: 'station', folder: 'Archive', uid: index, messageId: id,
      flags: index % 2 ? ['\\Seen'] : ['\\Flagged'], unread: null, flagged: null, excluded: false, spam: false, projectionVersion: 1 })))
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
        } else if (step.index && typeof step.index !== 'string') {
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

it('restores the exact cached membership bytes when a flag change is inverted', async () => {
  await mergeFolder(scope, 'station', 'INBOX', [{ ...message, flags: ['\\Seen', '\\Flagged'] }])
  const key = { accountId: 'station', folder: 'INBOX', uid: 7 }
  const memberships = scope.data.dataset('folder_messages')
  const before = JSON.stringify(await memberships.get(key))
  expect(JSON.parse(before).flags).toEqual(['\\Flagged', '\\Seen'])
  await updateMessageFlags(scope, 'station', 'INBOX', 7, [], ['\\Seen'])
  expect((await memberships.get(key))?.flags).toEqual(['\\Flagged'])
  await updateMessageFlags(scope, 'station', 'INBOX', 7, ['\\Seen'])
  expect(JSON.stringify(await memberships.get(key))).toBe(before)
  await mergeFolder(scope, 'station', 'INBOX', [{ ...message, flags: ['\\Seen', '\\Flagged'] }])
  expect(JSON.stringify(await memberships.get(key))).toBe(before)
})

describe('incremental folder sync', () => {
  const written = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.flatMap(([operations]) => operations as DatasetTransactionOperation[])
  const fetched: CachedMessage[] = [{ ...message, uidValidity: 3 }, { ...message, uid: 8, uidValidity: 3, messageId: '<moss@example.test>', cc: 'fern@example.test', flags: ['\\Seen'] }]

  it('writes nothing when an unchanged folder is merged again, with or without bodies', async () => {
    await mergeFolder(scope, 'station', 'INBOX', fetched)
    const transaction = vi.spyOn(scope.data, 'transaction')
    expect(await mergeFolder(scope, 'station', 'INBOX', fetched)).toBe(2)
    const headers = await cachedFolderHeaders(scope, 'station', 'INBOX', [7, 8, 9], 3)
    expect([...headers.keys()].sort()).toEqual([7, 8])
    expect([...headers.values()].every(entry => entry.text === undefined && entry.html === undefined && Boolean(entry.logicalId))).toBe(true)
    expect(await mergeFolder(scope, 'station', 'INBOX', [...headers.values()])).toBe(2)
    expect(transaction).not.toHaveBeenCalled()
    expect(await cachedFolderHeaders(scope, 'station', 'INBOX', [7, 8], 4)).toEqual(new Map())
    expect(await cachedFolderHeaders(scope, 'station', 'INBOX', [7, 8], undefined)).toEqual(new Map())
  })

  it('updates only the membership row for a flag-only change and keeps the cached body', async () => {
    await mergeFolder(scope, 'station', 'INBOX', fetched)
    const [cached] = (await cachedFolderHeaders(scope, 'station', 'INBOX', [7], 3)).values()
    const transaction = vi.spyOn(scope.data, 'transaction')
    await mergeFolder(scope, 'station', 'INBOX', [{ ...cached, flags: ['\\Seen', '\\Flagged'] }])
    expect(written(transaction)).toEqual([{ dataset: 'folder_messages', operation: 'upsert', values: expect.objectContaining({ accountId: 'station', folder: 'INBOX', uid: 7, flags: ['\\Flagged', '\\Seen'], unread: false, flagged: true }) }])
    expect((await readMessage(scope, { accountId: 'station', folder: 'INBOX', uid: 7 }))?.text).toBe(message.text)
  })

  it('stores a changed body as new content with its recipients and membership', async () => {
    await mergeFolder(scope, 'station', 'INBOX', fetched)
    const transaction = vi.spyOn(scope.data, 'transaction')
    await mergeFolder(scope, 'station', 'INBOX', [{ ...fetched[0], text: 'Moss survey' }])
    const operations = written(transaction)
    expect(operations.filter(operation => operation.dataset === 'messages' && operation.operation === 'upsert')).toEqual([expect.objectContaining({ values: expect.objectContaining({ text: 'Moss survey' }) })])
    expect(operations.filter(operation => operation.dataset === 'recipients')).toHaveLength(1)
    expect(operations.filter(operation => operation.dataset === 'folder_messages')).toEqual([expect.objectContaining({ operation: 'upsert', values: expect.objectContaining({ uid: 7 }) })])
    expect((await readMessage(scope, { accountId: 'station', folder: 'INBOX', uid: 7 }))?.text).toBe('Moss survey')
  })

  it('re-projects only stale membership rows unless the special use changed', async () => {
    await mergeFolder(scope, 'station', 'Deleted', [{ ...message, uid: 1 }, { ...message, uid: 2, messageId: '<moss@example.test>' }])
    const mailbox = { path: 'Deleted', name: 'Deleted', selectable: true, specialUse: '\\Trash' }
    await cacheMailboxes(scope, 'station', [mailbox])
    expect(mock.datasets.get('renamed-mail.folder_messages')!.map(row => row.excluded)).toEqual([true, true])
    const transaction = vi.spyOn(scope.data, 'transaction')
    await cacheMailboxes(scope, 'station', [mailbox])
    expect(transaction).not.toHaveBeenCalled()
    await scope.data.dataset('folder_messages').update({ accountId: 'station', folder: 'Deleted', uid: 2 }, { projectionVersion: 0, excluded: false })
    await cacheMailboxes(scope, 'station', [mailbox])
    const operations = written(transaction)
    expect(operations.filter(operation => operation.dataset !== 'messages')).toEqual([{ operation: 'update', dataset: 'folder_messages', key: { accountId: 'station', folder: 'Deleted', uid: 2 }, values: { spam: false, excluded: true, projectionVersion: 1 } }])
    transaction.mockClear()
    await cacheMailboxes(scope, 'station', [{ ...mailbox, specialUse: undefined }])
    expect(written(transaction).filter(operation => operation.dataset === 'folder_messages')).toHaveLength(2)
    expect(mock.datasets.get('renamed-mail.folder_messages')!.map(row => row.excluded)).toEqual([false, false])
  })
})

describe('cached mail retention', () => {
  const now = Date.parse('2026-10-13T00:00:00.000Z')
  const old: CachedMessage = { ...message, uid: 1, messageId: '<old@example.test>', date: '2026-01-01T00:00:00.000Z', cc: 'fern@example.test' }
  const undated: CachedMessage = { ...message, uid: 2, messageId: '<undated@example.test>', date: '' }
  const recent: CachedMessage = { ...message, uid: 3, messageId: '<recent@example.test>', date: '2026-09-30T00:00:00.000Z' }
  const synced: CachedMessage = { ...old, uid: 4, messageId: '<synced@example.test>' }

  it('forgets messages older than the window with their recipients, keeping undated and just-synced mail', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [old, undated, recent, synced])
    const recipients = (await scope.data.dataset('recipients').query({ limit: 100 })).rows.length
    expect(await pruneFolder(scope, 'station', 'INBOX', [4], 180, now)).toBe(1)
    expect((await readFolder(scope, 'station', 'INBOX')).map(entry => entry.uid).sort()).toEqual([2, 3, 4])
    expect((await scope.data.dataset('messages').query({ limit: 100 })).rows).toHaveLength(3)
    expect((await scope.data.dataset('recipients').query({ limit: 100 })).rows).toHaveLength(recipients - 2)
    expect(await pruneFolder(scope, 'station', 'INBOX', [4], 180, now)).toBe(0)
    expect(await pruneFolder(scope, 'station', 'INBOX', [], 365, now)).toBe(0)
  })

  it('keeps an old message another folder still holds and only drops this membership', async () => {
    await mergeFolder(scope, 'station', 'INBOX', [old])
    await mergeFolder(scope, 'station', 'Archive', [{ ...old, uid: 10 }])
    expect(await pruneFolder(scope, 'station', 'INBOX', [], 180, now)).toBe(1)
    expect(await readFolder(scope, 'station', 'INBOX')).toEqual([])
    expect((await readFolder(scope, 'station', 'Archive')).map(entry => entry.uid)).toEqual([10])
  })

  it('declares retention on cached messages only and no write-less attachment stores', () => {
    const datasets = config.datasets as Array<{ id: string; store: string; retention?: unknown }>
    expect(datasets.filter(dataset => dataset.retention).map(dataset => [dataset.id, dataset.store, dataset.retention])).toEqual([['messages', 'cache', { column: 'date' }]])
    expect(datasets.some(dataset => dataset.id === 'attachments')).toBe(false)
    expect(JSON.stringify(config)).not.toContain('attachment-files')
    expect(config.settingsSchema.fields.find(field => field.key === 'cacheDays')).toMatchObject({ default: 180, schema: { minimum: 1, maximum: 3650 } })
  })
})
