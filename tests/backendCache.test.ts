import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import config from '../config.json'
import { appendMessage, emailStoreContext, folderCacheStats, mergeFolder, moveCachedMessage, readAccounts, readFolder, updateMessageFlags, upsertAccount } from '../src/backend/cache'
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
    expect(transaction).toHaveBeenCalledWith([{ dataset: 'folder_messages', operation: 'upsert', values: { accountId: 'station', folder: 'INBOX', uid: 7, messageId: encodeText(JSON.stringify(['station', message.messageId])), flags: ['\\Seen'] } }])
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
})
