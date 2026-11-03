import { assertCommandOutput } from './commandContracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { PluginServiceCausation } from '@valley/plugin-sdk/pluginServices'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import config from '../config.json'
import { register, type MailBackendApi } from '../src/backend'
import { establishFolderEpoch, emailStoreContext, mergeFolder, readFolder, upsertAccount } from '../src/backend/cache'
import { MAIL_WORK_LIMITS } from '../src/backend/workQueue'
import * as transport from '../src/backend/transport'
import { MailRefusal } from '../src/backend/automation'
import { executeWorkflowOperation } from '../src/backend/workflow'
import { encodeBytes } from '../src/backend/encoding'
import { cacheMailboxes } from '../src/backend/query'
import type { CachedMessage, EmailAccount } from '../src/mailTypes'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
type Causation = PluginServiceCausation
function causationHost() {
  const current = new AsyncLocalStorage<Causation>()
  const receipts = new Map<string, Causation>()
  const events: Array<{ serviceId: string; event: string; payload: unknown; causation: Causation | null }> = []
  const copy = (value: Causation | undefined) => value ? { ...value } : null
  const services = {
    captureCausation: vi.fn(async () => { const origin = current.getStore(); if (!origin) return undefined; const receipt = crypto.randomUUID(); receipts.set(receipt, { ...origin }); return receipt }),
    inspectCausation: vi.fn(async (receipt?: string) => copy(receipt === undefined ? current.getStore() : receipts.get(receipt))),
    emit: vi.fn(async (serviceId: string, event: string, payload: unknown) => { events.push({ serviceId, event, payload: structuredClone(payload), causation: copy(current.getStore()) }) })
  }
  const withCausation = <T>(run: () => Promise<T>) => current.run({ rootId: crypto.randomUUID(), runId: crypto.randomUUID(), originPlugin: 'email', depth: 0 }, run)
  return { services, events, withCausation }
}
const message: CachedMessage = { uid: 1, messageId: '<survey@example.test>', from: 'sender@example.test', to: 'reader@example.test', subject: 'Survey', date: '2026-09-19T10:00:00Z', snippet: 'Forest', text: 'Forest', flags: [], hasAttachments: false }
const account = (id: string): EmailAccount => ({ id, provider: 'pureemail', address: `${id}@example.test`, createdAt: 0,
  imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true } })

async function fixture(ids = ['a', 'b'], i18n?: MailBackendApi['i18n'], services?: MailBackendApi['services'], notifications?: MailBackendApi['notifications'], captureOperations = false) {
  const mock = createMockValleyApi({ manifest: { id: 'email', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
  const scope = emailStoreContext(mock.api.data)
  for (const id of ids) await upsertAccount(scope, account(id))
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
  const operations = new Map<string, Parameters<PluginBackendApi['rpc']['handleOperation']>[1]>()
  const handleOperation: PluginBackendApi['rpc']['handleOperation'] = (name, handler) => { operations.set(name, handler); return () => { operations.delete(name) } }
  const api: MailBackendApi = {
    i18n,
    services,
    notifications,
    data: mock.api.data,
    accounts: { list: vi.fn(async () => []), authorize: vi.fn() },
    credentials: { presence: vi.fn(async () => 'stored' as const), state: vi.fn(async () => 'ok' as const), set: vi.fn(), delete: vi.fn(), handle: vi.fn(), write: vi.fn() },
    network: { fetch: vi.fn(), open: vi.fn(), read: vi.fn(), write: vi.fn(), startTls: vi.fn(), close: vi.fn(async () => {}) },
    rpc: { handle: (name, handler) => { handlers.set(name, handler); return () => { handlers.delete(name) } }, emit: vi.fn(), ...(captureOperations ? { handleOperation } : {}) }
  }
  const dispose = register(api)
  const call = async (name: string, payload: unknown) => assertCommandOutput(name, payload, await handlers.get(name)!(payload))
  return { mock, scope, api, handlers, operations, dispose, call }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('backend account work ownership', () => {
  it('starts automatic sync in a later turn and cancels that startup when disposed', async () => {
    vi.useFakeTimers()
    const fetch = vi.spyOn(transport, 'fetchFolder').mockResolvedValue({ messages: [], uidValidity: 1 })
    const notifications = { notify: vi.fn() } as unknown as MailBackendApi['notifications']
    const host = await fixture(['a'], undefined, undefined, notifications)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledOnce()
    await host.dispose()
    fetch.mockClear()
    const stopped = await fixture(['a'], undefined, undefined, notifications)
    await stopped.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('tests both saved transports independently and exposes cached folder failures', async () => {
    const host = await fixture(['a'])
    const imap = vi.spyOn(transport, 'verifyImap').mockRejectedValue(new Error('[AUTHENTICATIONFAILED] Login denied'))
    const smtp = vi.spyOn(transport, 'verifySmtp').mockResolvedValue(undefined)
    expect(await host.call('testAccount', { accountId: 'a' })).toMatchObject({ ok: true, data: { imap: { ok: false, error: '[AUTHENTICATIONFAILED] Login denied' }, smtp: { ok: true } } })
    expect(imap).toHaveBeenCalledOnce(); expect(smtp).toHaveBeenCalledOnce(); expect(host.api.credentials.set).not.toHaveBeenCalled()
    await cacheMailboxes(host.scope, 'a', [{ path: 'INBOX', name: 'INBOX', selectable: true }])
    vi.spyOn(transport, 'listFolders').mockRejectedValue(new Error('Authentication failed password=hidden'))
    const folders = await host.call('listFolders', { accountId: 'a' })
    expect(folders).toMatchObject({ ok: true, data: { folders: ['INBOX'], warning: expect.stringContaining('cached folders') } })
    expect(JSON.stringify(folders)).not.toContain('hidden'); expect(JSON.stringify(folders)).toContain('[redacted]')
    await host.dispose()
  })
  it('reports unknown accounts, missing messages and rejected input as known no-effect refusals', async () => {
    const host = await fixture(['a'])
    const remote = [vi.spyOn(transport, 'verifyImap'), vi.spyOn(transport, 'verifySmtp'), vi.spyOn(transport, 'sendMail'), vi.spyOn(transport, 'applyMessageAction')]
    const missing = { ok: false, error: 'Unknown account.', code: 'ACCOUNT_NOT_FOUND', outcome: 'not-applied' }
    expect(await host.call('testAccount', { accountId: 'missing' })).toEqual(missing)
    expect(await host.call('listFolders', { accountId: 'missing' })).toEqual(missing)
    expect(await host.call('syncFolder', { accountId: 'missing' })).toEqual(missing)
    expect(await host.call('sendEmail', { accountId: 'missing', to: 'reader@example.test', text: 'Hello' })).toEqual(missing)
    expect(await host.call('applyMessageAction', { accountId: 'missing', folder: 'INBOX', uid: 1, action: 'flag' })).toEqual(missing)
    expect(await host.call('updateSmtpAccount', { accountId: 'missing', address: 'x@example.test', login: 'x', password: 'secret' })).toEqual(missing)
    expect(await host.call('applyMessageAction', { accountId: 'a', folder: 'INBOX', uid: 9, uidValidity: 1, action: 'flag' })).toMatchObject({ ok: false, code: 'MESSAGE_NOT_FOUND', outcome: 'not-applied' })
    expect(await host.call('applyMessageAction', { accountId: 'a', folder: 'INBOX', uid: 1, action: 'explode' })).toMatchObject({ ok: false, error: expect.any(String), code: 'INVALID_INPUT', outcome: 'not-applied' })
    expect(await host.call('syncFolder', {})).toMatchObject({ ok: false, code: 'INVALID_INPUT', outcome: 'not-applied' })
    for (const spy of remote) expect(spy).not.toHaveBeenCalled()
    expect(host.api.credentials.set).not.toHaveBeenCalled()
    expect(vi.mocked(host.api.rpc.emit).mock.calls.filter(([, payload]) => (payload as { accountId?: string }).accountId === 'missing')).toEqual([])
    await host.dispose()
  })
  it('reports a refused automatic reply as a known no-effect refusal', async () => {
    const causal = causationHost()
    const notify = vi.fn(async () => true)
    const host = await fixture(['a'], undefined, causal.services, { notify } as unknown as MailBackendApi['notifications'])
    const send = vi.spyOn(transport, 'sendMail')
    const refused = await causal.withCausation(() => host.call('sendEmail', { accountId: 'a', to: 'reader@example.test', text: 'Hello', inReplyTo: '<missing@example.test>' }))
    expect(refused).toMatchObject({ ok: false, code: 'AUTOMATIC_INCOMING_UNAVAILABLE', outcome: 'not-applied' })
    expect(send).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(await host.mock.api.data.files.list('automatic-mail')).toEqual([])
    await host.dispose()
  })
  it('publishes incoming Workflow events only after cache and sync cursor commits', async () => {
    const emit = vi.fn(async (_service: string, _event: string, payload: unknown) => {
      const value = payload as { uid: number }
      expect(Number((await host.scope.data.dataset('sync_state').get({ accountId: 'a', folder: 'INBOX' }))?.cursor)).toBe(value.uid)
      expect((await readFolder(host.scope, 'a', 'INBOX')).some(message => message.uid === value.uid)).toBe(true)
    })
    const host = await fixture(['a'], undefined, { emit } as unknown as MailBackendApi['services'])
    const fetch = vi.spyOn(transport, 'fetchFolder').mockResolvedValueOnce({ messages: [{ ...message, uidValidity: 1 }], uidValidity: 1 })
    expect(await host.call('syncFolder', { accountId: 'a' })).toMatchObject({ ok: true }); expect(emit).not.toHaveBeenCalled()
    const incoming = { ...message, uid: 2, uidValidity: 1, receivedAt: new Date(Date.now() + 1000).toISOString(), automationHeaders: { observed: true as const, autoSubmitted: [], precedence: [], listId: [], suppress: [], origin: [], inReplyTo: ['<request@example.test>'] } }
    fetch.mockResolvedValue({ messages: [incoming], uidValidity: 1 })
    expect(await host.call('syncFolder', { accountId: 'a' })).toMatchObject({ ok: true })
    expect(emit).toHaveBeenCalledWith('workflow.provider', 'message.received', expect.objectContaining({ accountId: 'a', uid: 2, inReplyTo: '<request@example.test>' }))
    await host.call('syncFolder', { accountId: 'a' }); expect(emit).toHaveBeenCalledOnce()
    await host.dispose()
  })
  it('keeps host-issued event causation through a deferred cache commit without trusting incoming headers', async () => {
    const host = causationHost()
    const rootEmit = vi.fn()
    const mail = await fixture(['a'], undefined, { ...host.services, emit: rootEmit } as MailBackendApi['services'], undefined, true)
    const fetch = vi.spyOn(transport, 'fetchFolder').mockResolvedValueOnce({ messages: [{ ...message, uidValidity: 1 }], uidValidity: 1 })
    expect(await mail.call('syncFolder', { accountId: 'a' })).toMatchObject({ ok: true })
    const forgedOrigin = crypto.randomUUID()
    fetch.mockResolvedValue({ messages: [{ ...message, uid: 2, uidValidity: 1, receivedAt: new Date(Date.now() + 1000).toISOString(), automationHeaders: { observed: true, autoSubmitted: [], precedence: [], listId: [], suppress: [], origin: [forgedOrigin] } }], uidValidity: 1 })
    const entered = deferred(), commit = deferred()
    const transaction = mail.api.data.transaction
    vi.spyOn(mail.api.data, 'transaction').mockImplementationOnce(async (...args) => { entered.resolve(); await commit.promise; return transaction(...args) })
    const operation: PluginBackendOperationContext = { id: crypto.randomUUID(), cancellation: new AbortController().signal, api: { ...mail.api, services: host.services } as unknown as PluginBackendOperationContext['api'] }
    const captured = await host.withCausation(async () => ({ receipt: await host.services.captureCausation(), origin: await host.services.inspectCausation(), pending: mail.operations.get('command.syncFolder')!({ accountId: 'a' }, operation) }))
    expect(captured.receipt).toEqual(expect.any(String))
    expect(captured.origin).not.toBeNull()
    await entered.promise
    expect(host.events).toEqual([])
    expect(rootEmit).not.toHaveBeenCalled()
    expect((await readFolder(mail.scope, 'a', 'INBOX')).some(value => value.uid === 2)).toBe(false)
    const inspection = await host.services.inspectCausation(captured.receipt!)
    inspection!.originPlugin = 'caller-forgery'
    commit.resolve()
    expect(await captured.pending).toMatchObject({ ok: true })
    expect(Number((await mail.scope.data.dataset('sync_state').get({ accountId: 'a', folder: 'INBOX' }))?.cursor)).toBe(2)
    expect((await readFolder(mail.scope, 'a', 'INBOX')).some(value => value.uid === 2)).toBe(true)
    expect(host.events).toHaveLength(1)
    expect(host.events[0]).toMatchObject({ serviceId: 'workflow.provider', event: 'message.received', causation: captured.origin, payload: { uid: 2, automationHeaders: { origin: [forgedOrigin] } } })
    expect(await host.services.inspectCausation(forgedOrigin)).toBeNull()
    expect(await host.services.inspectCausation(captured.receipt!)).toEqual(captured.origin)
    expect(rootEmit).not.toHaveBeenCalled()
    await mail.dispose()
  })

  it('updates credentials through host storage without replacing the account or message cache', async () => {
    const host = await fixture(['a'])
    await establishFolderEpoch(host.scope, 'a', 'INBOX', 1)
    await mergeFolder(host.scope, 'a', 'INBOX', [{ ...message, uidValidity: 1 }])
    const verify = vi.spyOn(transport, 'verifyImap').mockResolvedValue(undefined)
    const result = await host.call('updateSmtpAccount', { accountId: 'a', address: 'updated@example.test', login: 'login-user', password: 'replacement' })
    expect(result).toMatchObject({ ok: true, data: { account: { id: 'a', login: 'login-user', address: 'updated@example.test' } } })
    expect(host.api.credentials.set).toHaveBeenCalledWith('a', 'replacement', expect.any(Array), transport.MAIL_CREDENTIAL_STORE)
    expect(verify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'a', login: 'login-user' }))
    expect(await readFolder(host.scope, 'a', 'INBOX')).toHaveLength(1)
    expect(await host.api.data.files.readText('accounts.json')).not.toContain('replacement')
    expect(host.api.credentials.delete).not.toHaveBeenCalled()
    await host.dispose()
  })

  it('submits an inline reply once and retains an uncertain reply for recovery', async () => {
    const host = await fixture(['a'])
    await establishFolderEpoch(host.scope, 'a', 'INBOX', 1)
    await mergeFolder(host.scope, 'a', 'INBOX', [{ ...message, uidValidity: 1 }])
    const send = vi.spyOn(transport, 'sendMail').mockRejectedValue(new Error('SMTP outcome unknown'))
    const event = { action: 'reply', occurrenceId: 'a'.repeat(64), targetItemId: JSON.stringify({ accountId: 'a', folder: 'INBOX', uid: message.uid, uidValidity: 1 }), input: 'The fern survey is ready.' }
    await expect(host.call('notifications.action', event)).rejects.toThrow('SMTP outcome unknown')
    expect(await host.call('notifications.action', event)).toBe(false)
    expect(send).toHaveBeenCalledOnce()
    expect(JSON.parse((await host.api.data.files.readText(`notification-replies/${event.occurrenceId}.json`))!)).toMatchObject({ state: 'unknown', draft: { text: event.input } })
    expect((await host.api.data.dataset('drafts').read({ id: 'compose' })).value).toMatchObject({ delivery: 'sending', draft: { text: event.input, mode: 'reply' } })
    await host.dispose()
  })

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
    expect(await second.call('syncFolder', { accountId: 'missing' })).toEqual({ ok: false, error: 'second:email.backend.account', code: 'ACCOUNT_NOT_FOUND', outcome: 'not-applied' })
    await second.dispose()
  })

  it('orders sync, cache writes, reads and removal for one account while another account progresses', async () => {
    const host = await fixture()
    const remote = deferred(), cache = deferred()
    const fetch = vi.spyOn(transport, 'fetchFolder').mockImplementation(async (_scope, owner) => {
      if (owner.id === 'a') await remote.promise
      return { messages: [{ ...message, messageId: `<${owner.id}@example.test>` }], uidValidity: 1 }
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

  it('refuses removeAccount for an id without a local account before deleting credentials or cached mail', async () => {
    const host = await fixture()
    vi.mocked(host.api.accounts.list).mockResolvedValue([{ id: 'google-1', provider: 'google', address: 'g@example.test', capabilities: ['mail'] } as never])
    await mergeFolder(host.scope, 'google-1', 'INBOX', [message])
    const before = await readFolder(host.scope, 'google-1', 'INBOX')
    for (const accountId of ['google-1', 'missing']) {
      expect(await host.call('removeAccount', { accountId })).toEqual({ ok: false, error: 'Unknown account.', code: 'ACCOUNT_NOT_FOUND', outcome: 'not-applied' })
    }
    expect(host.api.credentials.delete).not.toHaveBeenCalled()
    expect(await readFolder(host.scope, 'google-1', 'INBOX')).toEqual(before)
    expect(before).toHaveLength(1)
    expect(await host.call('removeAccount', { accountId: 'a' })).toMatchObject({ ok: true, data: { accounts: [expect.objectContaining({ id: 'google-1' }), expect.objectContaining({ id: 'b' })] } })
    expect(host.api.credentials.delete).toHaveBeenCalledOnce()
    await host.dispose()
  })

  it('answers cached reads while the same account waits on its server', async () => {
    const host = await fixture(['a'], undefined, undefined, undefined, true)
    await mergeFolder(host.scope, 'a', 'INBOX', [message])
    const remote = deferred()
    const fetch = vi.spyOn(transport, 'fetchFolder').mockImplementation(async () => { await remote.promise; return { messages: [message], uidValidity: 1 } })
    const folders = vi.spyOn(transport, 'listFolders').mockImplementation(async () => { await remote.promise; return [] })
    const syncing = host.call('syncFolder', { accountId: 'a' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    const listing = host.call('listFolders', { accountId: 'a' })
    const within = <T,>(promise: Promise<T>): Promise<T> => Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('waited for the server')), 1000))])
    const query = host.operations.get('queryMessages')!
    expect(await within(Promise.resolve(query({ accountId: 'a', view: 'recent' }, { id: 'query', cancellation: new AbortController().signal, api: host.api } as unknown as PluginBackendOperationContext))))
      .toMatchObject({ ok: true, data: { messages: [expect.objectContaining({ subject: 'Survey' })] } })
    expect(host.operations.has('readMessage')).toBe(false)
    expect(await within(host.call('readMessage', { accountId: 'a', folder: 'INBOX', uid: 1 }))).toMatchObject({ ok: true, data: { message: { subject: 'Survey' } } })
    remote.resolve()
    expect(await syncing).toMatchObject({ ok: true })
    expect(await listing).toMatchObject({ ok: true })
    expect(folders).toHaveBeenCalledOnce()
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
      if (id !== 'messages') return value
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
      return { messages: [], uidValidity: 1 }
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

  it('reports a refused message change as not applied and a lost answer as unknown, also to command callers', async () => {
    const host = await fixture(['a'])
    const remote = vi.spyOn(transport, 'applyMessageAction')
    remote.mockRejectedValueOnce(new MailRefusal('ACTION_NOT_APPLIED', 'Not applied. The message was not changed: [READ-ONLY] mailbox is read-only'))
    const refused = await host.call('applyMessageAction', { accountId: 'a', folder: 'INBOX', uid: 1, action: 'flag' })
    expect(refused).toEqual({ ok: false, error: 'Not applied. The message was not changed: [READ-ONLY] mailbox is read-only', code: 'ACTION_NOT_APPLIED', outcome: 'not-applied' })
    remote.mockRejectedValueOnce(new transport.MailActionUncertain('Outcome unknown. The change may have been applied on the server: Mail server closed the connection.'))
    const lost = await host.call('applyMessageAction', { accountId: 'a', folder: 'INBOX', uid: 1, action: 'flag' })
    expect(lost).toMatchObject({ ok: false, code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' })
    const binding = { method: 'command.applyMessageAction', result: 'driver', wrap: false, effect: 'execute' } as Parameters<typeof executeWorkflowOperation>[0]
    const context = { cancellation: new AbortController().signal } as unknown as PluginBackendOperationContext
    const request = { parameters: {}, items: [] } as unknown as Parameters<typeof executeWorkflowOperation>[2]
    const notApplied = await executeWorkflowOperation(binding, async () => refused, request, context).catch((error: unknown) => error)
    expect(notApplied).toMatchObject({ code: 'ACTION_NOT_APPLIED' })
    expect(notApplied).not.toHaveProperty('outcome', 'unknown')
    expect(await executeWorkflowOperation(binding, async () => lost, request, context).catch((error: unknown) => error)).toMatchObject({ code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' })
    await host.dispose()
  })

  it('serializes account registration and removal without blocking another account sync', async () => {
    const host = await fixture(['a', 'b', 'c'])
    const held = deferred()
    const verify = vi.spyOn(transport, 'verifyImap').mockImplementation(async () => { await held.promise })
    vi.spyOn(transport, 'verifySmtp').mockResolvedValue()
    vi.spyOn(transport, 'fetchFolder').mockResolvedValue({ messages: [], uidValidity: 1 })
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

  it('reads one cached message or only the newest ones of a folder instead of every body', async () => {
    const host = await fixture(['a'])
    await mergeFolder(host.scope, 'a', 'INBOX', [message, { ...message, uid: 2, messageId: '<later@example.test>', subject: 'Later', date: '2026-09-20T10:00:00Z' }, { ...message, uid: 3, messageId: '<earliest@example.test>', subject: 'Earliest', date: '2026-09-18T10:00:00Z' }])
    expect((await host.call('readFolder', { accountId: 'a', folder: 'INBOX' }) as { data: { messages: CachedMessage[] } }).data.messages.map(item => item.uid)).toEqual([2, 1, 3])
    expect((await host.call('readFolder', { accountId: 'a', folder: 'INBOX', uid: 1 }) as { data: { messages: CachedMessage[] } }).data.messages.map(item => item.subject)).toEqual(['Survey'])
    expect((await host.call('readFolder', { accountId: 'a', folder: 'INBOX', limit: 2 }) as { data: { messages: CachedMessage[] } }).data.messages.map(item => item.uid)).toEqual([2, 1])
    await host.dispose()
  })

  it('checks SMTP as well as IMAP before adding an account and keeps nothing when SMTP fails', async () => {
    const host = await fixture(['a'])
    vi.spyOn(transport, 'verifyImap').mockResolvedValue()
    const smtp = vi.spyOn(transport, 'verifySmtp').mockRejectedValue(new Error('535 Authentication failed'))
    const added = await host.call('addSmtpAccount', { address: 'new@example.test', password: 'fixture-secret', imap: account('new').imap, smtp: account('new').smtp })
    expect(smtp).toHaveBeenCalledOnce()
    expect(added).toMatchObject({ ok: false, error: expect.stringContaining('535') })
    expect(host.api.credentials.delete).toHaveBeenCalledOnce()
    expect(await host.call('listAccounts', {})).toMatchObject({ ok: true, data: { accounts: [expect.objectContaining({ id: 'a' })] } })
    expect((await host.call('listAccounts', {}) as { data: { accounts: unknown[] } }).data.accounts).toHaveLength(1)
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

  it.each([['not-applied', 'SEND_FAILED', 'Email could not be sent'], ['unknown', 'SEND_OUTCOME_UNKNOWN', 'Email may have been sent']] as const)('reports a %s send with its code, a matching notification and a redacted error', async (outcome, code, title) => {
    const notify = vi.fn(async () => true)
    const host = await fixture(['a'], undefined, undefined, { notify } as unknown as MailBackendApi['notifications'])
    vi.spyOn(transport, 'sendMail').mockRejectedValueOnce(new transport.MailSendError('535 rejected Bearer ya29.secret-token', outcome))
    const result = await host.call('sendEmail', { accountId: 'a', to: 'reader@example.test', text: 'Hello' }) as { error: string }
    expect(result).toMatchObject({ ok: false, code, outcome })
    expect(result.error).not.toContain('ya29.secret-token')
    expect(notify).toHaveBeenCalledWith('sendFailed', expect.objectContaining({ title }))
    expect(await readFolder(host.scope, 'a', 'Sent')).toEqual([])
    await host.dispose()
  })

  it('redacts credentials from generic operation errors', async () => {
    const host = await fixture(['a'])
    vi.spyOn(transport, 'fetchFolder').mockRejectedValueOnce(new Error('LOGIN failed password=hunter2 for https://user:pa55@imap.example.test/'))
    const result = await host.call('syncFolder', { accountId: 'a' }) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).not.toMatch(/hunter2|pa55/)
    await host.dispose()
  })

  it.each([['not-applied', 1], ['unknown', 0]] as const)('lets the same automatic send try again only after a %s failure', async (outcome, retries) => {
    const causal = causationHost()
    const host = await fixture(['a'], undefined, causal.services)
    const send = vi.spyOn(transport, 'sendMail').mockRejectedValueOnce(new transport.MailSendError('SMTP failed', outcome)).mockResolvedValue('<retry@example.test>')
    const input = { accountId: 'a', to: 'reader@example.test', text: 'Hello' }
    await causal.withCausation(async () => {
      expect(await host.call('sendEmail', input)).toMatchObject({ ok: false, outcome })
      const second = await host.call('sendEmail', input)
      if (retries) expect(second).toMatchObject({ ok: true })
      else expect(second).toMatchObject({ ok: false, code: 'AUTOMATIC_ALREADY_ACCEPTED', outcome: 'not-applied' })
    })
    expect(send).toHaveBeenCalledTimes(1 + retries)
    const [file] = await host.api.data.files.list('automatic-mail')
    expect(JSON.parse((await host.api.data.files.readText(`automatic-mail/${file.name}`))!)).toMatchObject({ state: retries ? 'sent' : 'unknown' })
    await host.dispose()
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

it('establishes a baseline for 2000 historical messages and suppresses epoch-reset arrivals', async () => {
  const host = await fixture(['forest'])
  const history = Array.from({ length: 2000 }, (_, index) => ({ ...message, uid: index + 1, uidValidity: 7, messageId: `<fern-${index}@example.test>`, receivedAt: '2020-01-01T00:00:00.000Z' }))
  const fetch = vi.spyOn(transport, 'fetchFolder')
  for (let offset = 0; offset < history.length; offset += 500) {
    fetch.mockResolvedValueOnce({ messages: history.slice(offset, offset + 500), uidValidity: 7 })
    expect(await host.call('syncFolder', { accountId: 'forest', folder: 'INBOX', limit: 500 })).toMatchObject({ ok: true })
  }
  const done = () => vi.mocked(host.api.rpc.emit).mock.calls.filter(([name, value]) => name === 'sync' && (value as { status: string }).status === 'done').map(([, value]) => value as { arrived: string[] })
  expect(done()).toHaveLength(4)
  expect(done().every(event => event.arrived.length === 0)).toBe(true)
  fetch.mockResolvedValueOnce({ messages: [{ ...history[0], uid: 2001, receivedAt: new Date(Date.now() + 1000).toISOString() }], uidValidity: 7 })
  await host.call('syncFolder', { accountId: 'forest', folder: 'INBOX' })
  expect(done().at(-1)?.arrived).toHaveLength(1)
  fetch.mockResolvedValueOnce({ messages: [{ ...history[0], uid: 2002, uidValidity: 8, receivedAt: new Date(Date.now() + 1000).toISOString() }], uidValidity: 8 })
  await host.call('syncFolder', { accountId: 'forest', folder: 'INBOX' })
  expect(done().at(-1)?.arrived).toHaveLength(0)
  await host.dispose()
}, 20000)
