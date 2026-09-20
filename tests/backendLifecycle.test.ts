import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import config from '../config.json'
import { register, type MailBackendApi } from '../src/backend'
import { emailStoreContext, mergeFolder, readFolder, upsertAccount } from '../src/backend/cache'
import { MAIL_WORK_LIMITS } from '../src/backend/workQueue'
import * as transport from '../src/backend/transport'
import { encodeBytes } from '../src/backend/encoding'
import type { CachedMessage, EmailAccount } from '../src/mailTypes'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const message: CachedMessage = { uid: 1, messageId: '<survey@example.test>', from: 'sender@example.test', to: 'reader@example.test', subject: 'Survey', date: '2026-09-19T10:00:00Z', snippet: 'Forest', text: 'Forest', flags: [], hasAttachments: false }
const account = (id: string): EmailAccount => ({ id, provider: 'pureemail', address: `${id}@example.test`, createdAt: 0,
  imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true } })

async function fixture(ids = ['a', 'b'], i18n?: MailBackendApi['i18n']) {
  const mock = createMockValleyApi({ manifest: { id: 'email', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
  const scope = emailStoreContext(mock.api.data)
  for (const id of ids) await upsertAccount(scope, account(id))
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
  const api: MailBackendApi = {
    i18n,
    data: mock.api.data,
    accounts: { list: vi.fn(async () => []), authorize: vi.fn() },
    credentials: { state: vi.fn(async () => 'ok' as const), set: vi.fn(), delete: vi.fn(), handle: vi.fn(), write: vi.fn() },
    network: { fetch: vi.fn(), open: vi.fn(), read: vi.fn(), write: vi.fn(), startTls: vi.fn(), close: vi.fn(async () => {}) },
    rpc: { handle: (name, handler) => { handlers.set(name, handler); return () => { handlers.delete(name) } }, emit: vi.fn() }
  }
  const dispose = register(api)
  const call = (name: string, payload: unknown) => handlers.get(name)!(payload)
  return { mock, scope, api, handlers, dispose, call }
}

afterEach(() => vi.restoreAllMocks())

describe('backend account work ownership', () => {
  it('keeps admission and accepted-operation messages bound to their registration', async () => {
    const first = await fixture(['a'], { t: key => `first:${key}` })
    const held = deferred()
    const send = vi.spyOn(transport, 'sendMail').mockImplementation(async () => { await held.promise; return '<sent@example.test>' })
    vi.spyOn(first.api.data, 'transaction').mockRejectedValueOnce(new Error('Cache unavailable'))
    const accepted = first.call('sendEmail', { accountId: 'a', to: 'reader@example.test', text: 'Hello' })
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    const stale = first.handlers.get('sendEmail')!
    const second = await fixture(['a'], { t: key => `second:${key}` })
    const stopped = first.dispose()
    expect(await stale({ accountId: 'a', to: 'reader@example.test' })).toEqual({ ok: false, error: 'first:email.backend.stopped' })
    held.resolve()
    expect(await accepted).toEqual({ ok: false, error: 'first:email.backend.sentCacheFailed', outcome: 'remote-complete', data: { messageId: '<sent@example.test>' } })
    await stopped
    expect(await second.call('syncFolder', { accountId: 'missing' })).toEqual({ ok: false, error: 'second:email.backend.account' })
    await second.dispose()
  })

  it('orders sync, cache writes, reads and removal for one account while another account progresses', async () => {
    const host = await fixture()
    const remote = deferred(), cache = deferred()
    const fetch = vi.spyOn(transport, 'fetchFolder').mockImplementation(async (_scope, owner) => {
      if (owner.id === 'a') await remote.promise
      return [{ ...message, messageId: `<${owner.id}@example.test>` }]
    })
    const syncing = host.call('syncFolder', { accountId: 'a' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    const beforeRemoval = host.call('readFolder', { accountId: 'a' })
    const removing = host.call('removeAccount', { accountId: 'a' })
    const afterRemoval = host.call('readFolder', { accountId: 'a' })
    const staleSync = host.call('syncFolder', { accountId: 'a' })
    expect(await host.call('syncFolder', { accountId: 'b' })).toMatchObject({ ok: true, data: { total: 1 } })
    expect(host.api.credentials.delete).not.toHaveBeenCalled()
    const write = host.api.data.transaction
    const transaction = vi.spyOn(host.api.data, 'transaction').mockImplementationOnce(async (...args) => { await cache.promise; return write(...args) })
    remote.resolve()
    await vi.waitFor(() => expect(transaction).toHaveBeenCalledOnce())
    expect(host.api.credentials.delete).not.toHaveBeenCalled()
    cache.resolve()
    expect(await syncing).toMatchObject({ ok: true, data: { total: 1 } })
    expect(await beforeRemoval).toMatchObject({ ok: true, data: { messages: [expect.objectContaining({ messageId: '<a@example.test>' })] } })
    expect(await removing).toMatchObject({ ok: true, data: { accounts: [expect.objectContaining({ id: 'b' })] } })
    expect(await afterRemoval).toEqual({ ok: true, data: { messages: [] } })
    expect(await staleSync).toMatchObject({ ok: false, error: expect.any(String) })
    expect(fetch.mock.calls.filter(([, owner]) => owner.id === 'a')).toHaveLength(1)
    expect(await readFolder(host.scope, 'a', 'INBOX')).toEqual([])
    expect(await readFolder(host.scope, 'b', 'INBOX')).toHaveLength(1)
    await host.dispose()
  })

  it('preserves complete multi-account selection and orders overlapping queries before removal', async () => {
    const ids = Array.from({ length: 65 }, (_, index) => `account-${index}`)
    const host = await fixture(ids)
    await mergeFolder(host.scope, ids[64], 'INBOX', [message])
    const held = deferred()
    const dataset = host.api.data.dataset.bind(host.api.data)
    let started = false
    vi.spyOn(host.api.data, 'dataset').mockImplementation(id => {
      const value = dataset(id)
      if (id !== 'mailboxes') return value
      const query = value.query.bind(value)
      return { ...value, query: async (...args) => { if (!started) { started = true; await held.promise }; return query(...args) } }
    })
    const query = host.call('queryMessages', { accountId: ids[0], accountIds: [...ids, ids[64]], view: 'recent' })
    await vi.waitFor(() => expect(started).toBe(true))
    const removal = host.call('removeAccount', { accountId: ids[64] })
    expect(host.api.credentials.delete).not.toHaveBeenCalled()
    held.resolve()
    expect(await query).toMatchObject({ ok: true, data: { messages: [expect.objectContaining({ accountId: ids[64] })] } })
    expect(await removal).toMatchObject({ ok: true })
    expect(await readFolder(host.scope, ids[64], 'INBOX')).toEqual([])
    await host.dispose()
  })

  it.each(['listFolders', 'sendEmail', 'applyMessageAction'] as const)('lets an accepted %s finish before removal', async name => {
    const host = await fixture()
    const held = deferred()
    const remote = name === 'listFolders' ? vi.spyOn(transport, 'listFolders').mockImplementation(async () => { await held.promise; return [] })
      : name === 'sendEmail' ? vi.spyOn(transport, 'sendMail').mockImplementation(async () => { await held.promise; return '<sent@example.test>' })
        : vi.spyOn(transport, 'applyMessageAction').mockImplementation(async () => { await held.promise; return {} })
    const input = name === 'sendEmail' ? { accountId: 'a', to: 'reader@example.test', text: 'Hello' }
      : name === 'applyMessageAction' ? { accountId: 'a', folder: 'INBOX', uid: 1, action: 'mark-read' } : { accountId: 'a' }
    const accepted = host.call(name, input)
    await vi.waitFor(() => expect(remote).toHaveBeenCalledOnce())
    const removing = host.call('removeAccount', { accountId: 'a' })
    expect(host.api.credentials.delete).not.toHaveBeenCalled()
    held.resolve()
    expect(await accepted).toMatchObject({ ok: true })
    expect(await removing).toMatchObject({ ok: true })
    expect(await readFolder(host.scope, 'a', 'Sent')).toEqual([])
    await host.dispose()
  })

  it('bounds queued account work and lets unrelated accounts use a released slot', async () => {
    const host = await fixture(['a', 'b', 'c', 'd', 'e'])
    const gates = new Map(['a', 'b', 'c', 'd'].map(id => [id, deferred()]))
    const started: string[] = []
    let active = 0, maximum = 0
    vi.spyOn(transport, 'fetchFolder').mockImplementation(async (_scope, owner) => {
      started.push(owner.id); maximum = Math.max(maximum, ++active)
      await gates.get(owner.id)?.promise
      active--
      return []
    })
    const accepted = ['a', 'b', 'c', 'd'].map(accountId => host.call('syncFolder', { accountId }))
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c', 'd']))
    const queued = Array.from({ length: MAIL_WORK_LIMITS.queuedPerAccount }, () => host.call('syncFolder', { accountId: 'a' }))
    expect(await host.call('syncFolder', { accountId: 'a' })).toMatchObject({ ok: false, error: expect.stringContaining('busy') })
    const independent = host.call('syncFolder', { accountId: 'e' })
    gates.get('b')!.resolve()
    expect(await independent).toMatchObject({ ok: true })
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(maximum).toBe(MAIL_WORK_LIMITS.active)
    for (const gate of gates.values()) gate.resolve()
    expect((await Promise.all([...accepted, ...queued])).every(result => (result as { ok: boolean }).ok)).toBe(true)
    await host.dispose()
  })

  it('bounds the global queue, releases failed account work and stops queued and stale calls on disposal', async () => {
    const host = await fixture(['a', 'b', 'c', 'd'])
    const gate = deferred()
    const remote = vi.spyOn(transport, 'fetchFolder').mockImplementation(async () => { await gate.promise; throw new Error('Remote outcome unknown') })
    const accepted = ['a', 'b', 'c', 'd'].map(accountId => host.call('syncFolder', { accountId }))
    await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(4))
    const queued = Array.from({ length: MAIL_WORK_LIMITS.queued }, () => host.call('parseAddresses', { value: 'reader@example.test' }))
    expect(await host.call('parseAddresses', { value: 'reader@example.test' })).toMatchObject({ ok: false, error: expect.stringContaining('busy') })
    expect(await host.call('syncFolder', { accountId: 'a', limit: -1 })).toMatchObject({ ok: false, error: expect.not.stringContaining('busy') })
    const stale = host.handlers.get('sendEmail')!
    let finished = false
    const dispose = host.dispose()
    expect(host.dispose()).toBe(dispose)
    void dispose.then(() => { finished = true })
    expect(host.handlers.size).toBe(0)
    expect((await Promise.all(queued)).every(result => !(result as { ok: boolean }).ok)).toBe(true)
    expect(await stale({ accountId: 'a', to: 'reader@example.test', text: 'Do not send' })).toMatchObject({ ok: false, error: expect.stringContaining('stopped') })
    expect(finished).toBe(false)
    gate.resolve()
    expect(await Promise.all(accepted)).toEqual(Array.from({ length: 4 }, () => ({ ok: false, error: 'Remote outcome unknown' })))
    await dispose
    expect(remote).toHaveBeenCalledTimes(4)
    expect(finished).toBe(true)
  })

  it('serializes account registration and removal without blocking another account sync', async () => {
    const host = await fixture(['a', 'b', 'c'])
    const held = deferred()
    const verify = vi.spyOn(transport, 'verifyImap').mockImplementation(async () => { await held.promise })
    vi.spyOn(transport, 'fetchFolder').mockResolvedValue([])
    const adding = host.call('addSmtpAccount', { address: 'new@example.test', password: 'fixture-secret', imap: account('new').imap, smtp: account('new').smtp })
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce())
    const removing = host.call('removeAccount', { accountId: 'b' })
    expect(await host.call('syncFolder', { accountId: 'c' })).toMatchObject({ ok: true })
    expect(host.api.credentials.delete).not.toHaveBeenCalled()
    held.resolve()
    expect(await adding).toMatchObject({ ok: true, data: { account: { address: 'new@example.test' } } })
    expect(await removing).toMatchObject({ ok: true, data: { accounts: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'c' }), expect.objectContaining({ address: 'new@example.test' })] } })
    await host.dispose()
  })

  it.each(['sendEmail', 'applyMessageAction'] as const)('reports a known remote %s success when the accepted cache write fails, without replay', async name => {
    const host = await fixture()
    await mergeFolder(host.scope, 'a', 'INBOX', [message])
    const remote = name === 'sendEmail' ? vi.spyOn(transport, 'sendMail').mockResolvedValue('<sent@example.test>')
      : vi.spyOn(transport, 'applyMessageAction').mockResolvedValue({})
    const held = deferred()
    const cache = vi.spyOn(host.api.data, 'transaction').mockImplementationOnce(async () => { await held.promise; throw new Error('Cache unavailable') })
    const input = name === 'sendEmail' ? { accountId: 'a', to: 'reader@example.test', text: 'Hello' }
      : { accountId: 'a', folder: 'INBOX', uid: 1, action: 'mark-read' }
    const accepted = host.call(name, input)
    await vi.waitFor(() => expect(cache).toHaveBeenCalledOnce())
    let finished = false
    const disposing = host.dispose().then(() => { finished = true })
    expect(finished).toBe(false)
    held.resolve()
    expect(await accepted).toMatchObject({ ok: false, outcome: 'remote-complete',
      data: name === 'sendEmail' ? { messageId: '<sent@example.test>' } : { action: 'mark-read', folder: 'INBOX' },
      error: expect.stringContaining(name === 'sendEmail' ? 'Do not resend' : 'server accepted') })
    await disposing
    expect(remote).toHaveBeenCalledOnce()
    expect(cache).toHaveBeenCalledOnce()
  })

  it('releases counted input and account locks after failure without replaying an uncertain send', async () => {
    const host = await fixture()
    const held = deferred()
    const remote = vi.spyOn(transport, 'sendMail').mockImplementationOnce(async () => { await held.promise; throw new Error('SMTP outcome unknown') }).mockResolvedValue('<next@example.test>')
    const text = 'x'.repeat(5 * 1024 * 1024)
    const input = { accountId: 'a', to: 'reader@example.test', text }
    const accepted = host.call('sendEmail', input)
    await vi.waitFor(() => expect(remote).toHaveBeenCalledOnce())
    expect(await host.call('sendEmail', { ...input, accountId: 'b' })).toMatchObject({ ok: false, error: expect.stringContaining('busy') })
    expect(await host.call('syncFolder', { accountId: 'a', limit: -1 })).toMatchObject({ ok: false })
    held.resolve()
    expect(await accepted).toEqual({ ok: false, error: 'SMTP outcome unknown' })
    expect(remote).toHaveBeenCalledOnce()
    expect(await host.call('sendEmail', input)).toEqual({ ok: true, data: { messageId: '<next@example.test>' } })
    expect(remote).toHaveBeenCalledTimes(2)
    await host.dispose()
  })

  it('joins actual socket closure and the accepted cache commit after disposal', async () => {
    const host = await fixture()
    const closing = deferred(), writing = deferred()
    const bytes = new TextEncoder().encode('* OK ready\r\n* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\nV1 OK caps\r\n+ \r\nV2 OK authenticated\r\n* LIST () "/" "INBOX"\r\nV3 OK listed\r\n')
    vi.mocked(host.api.network.open).mockResolvedValue('physical-socket')
    vi.mocked(host.api.network.read).mockResolvedValue({ base64: encodeBytes(bytes), done: false })
    vi.mocked(host.api.network.close).mockImplementation(async () => { await closing.promise })
    const transaction = host.api.data.transaction
    const save = vi.spyOn(host.api.data, 'transaction').mockImplementationOnce(async (...args) => { await writing.promise; return transaction(...args) })
    const accepted = host.call('listFolders', { accountId: 'a' })
    await vi.waitFor(() => expect(host.api.network.close).toHaveBeenCalledWith('physical-socket'))
    let finished = false
    const disposing = host.dispose().then(() => { finished = true })
    expect(finished).toBe(false)
    expect(save).not.toHaveBeenCalled()
    closing.resolve()
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(finished).toBe(false)
    writing.resolve()
    expect(await accepted).toMatchObject({ ok: true, data: { folders: ['INBOX'] } })
    await disposing
    expect(finished).toBe(true)
    expect(host.api.network.open).toHaveBeenCalledOnce()
    expect(host.api.network.close).toHaveBeenCalledOnce()
  })
})
