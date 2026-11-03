import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import config from '../config.json'
import { register, type MailBackendApi } from '../src/backend'
import { appendMessage, emailStoreContext, upsertAccount } from '../src/backend/cache'
import * as transport from '../src/backend/transport'
import { MAIL_SYNC_LIMITS } from '../src/backend/transport'
import type { EmailAccount } from '../src/mailTypes'
import { attachmentBytes } from '../src/Attachments'
import { assertCommandOutput } from './commandContracts'
import { fakeMessage, filePart, imapFolderFake, textPart, type FakeFolder, type FakeModes } from './imapFolderFake'

// Real-size fixtures (cursor page boundaries, a body above the part limit): a few seconds alone, far longer at a high load average.
const HEAVY_TEST_MS = 60_000

const account: EmailAccount = { id: 'pureemail-fixture', provider: 'pureemail', address: 'hoopoe@birds.example', createdAt: 0,
  imap: { host: 'imap.birds.example', port: 993, secure: true }, smtp: { host: 'smtp.birds.example', port: 465, secure: true } }
const ref = (uid: number, folder = 'INBOX') => ({ accountId: account.id, folder, uid })
const bytes = (length: number, seed = 7) => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 255)
const small = (uid: number) => fakeMessage(uid, `Census ${uid}`, [textPart(`Census sheet ${uid}: Grünspecht über der Wiese äöüß.`)])

async function backend(folders: Record<string, FakeFolder>, modes: FakeModes = {}) {
  const server = imapFolderFake(folders, modes)
  const mock = createMockValleyApi({ manifest: { id: 'email', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
  const scope = emailStoreContext(mock.api.data)
  await upsertAccount(scope, account)
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
  const operations = new Map<string, (payload: unknown, operation: unknown) => Promise<unknown>>()
  const emit = vi.fn()
  // The host refuses a data request above 4 MiB; the mock does not, so the limit is enforced here.
  const data = Object.assign(Object.create(mock.api.data) as typeof mock.api.data, { transaction: async (...args: Parameters<typeof mock.api.data.transaction>) => {
    if (Buffer.byteLength(JSON.stringify(args[0])) > 4 * 1024 * 1024 - 4096) throw new Error('Backend operation value exceeds the byte limit')
    return mock.api.data.transaction(...args)
  } })
  const api: MailBackendApi = { data, ...server.api, rpc: { handle: (name, handler) => { handlers.set(name, handler); return () => { handlers.delete(name) } }, emit,
    handleOperation: ((name: string, handler: (payload: unknown, operation: unknown) => Promise<unknown>) => { operations.set(name, handler); return () => { operations.delete(name) } }) as never } }
  let disposeBackend = register(api)
  const dispose = () => disposeBackend()
  // A restart: the backend stops and registers again on the same plugin data.
  const restart = async () => { await disposeBackend(); disposeBackend = register(api) }
  const call = async <T = Record<string, unknown>>(name: string, payload: unknown) => assertCommandOutput(name, payload, await handlers.get(name)!(payload)) as { ok: boolean; error?: string; data?: T }
  const sync = (folder = 'INBOX', limit = 100) => call<{ fetched: number; total: number }>('syncFolder', { accountId: account.id, folder, limit })
  // A command operation brings its own data API object on every call, as the CLI and Workflow paths do.
  const syncOperation = async (folder = 'INBOX') => operations.get('command.syncFolder')!({ accountId: account.id, folder, limit: 100 }, { id: crypto.randomUUID(), cancellation: new AbortController().signal, api: { ...server.api, data: { ...mock.api.data } } }) as Promise<{ ok: boolean }>
  const uids = async (folder = 'INBOX') => (await mock.api.data.dataset('folder_messages').query({ where: { accountId: account.id, folder }, select: ['uid'], limit: 1000 })).rows.map(row => Number(row.uid)).sort((a, b) => a - b)
  const read = async (uid: number, folder = 'INBOX') => (await call<{ message: Record<string, unknown> | null }>('readMessage', ref(uid, folder))).data?.message ?? null
  return { server, mock, scope, call, sync, syncOperation, uids, read, emit, dispose, restart }
}

afterEach(() => { vi.restoreAllMocks() })

describe('large messages never block their folder (F2)', () => {
  it('caches every small message beside a large one and lists its attachment without downloading it', async () => {
    const attachment = bytes(MAIL_SYNC_LIMITS.wholeMessageBytes + 512 * 1024)
    const large = fakeMessage(31, 'Survey archive', [textPart('The survey archive is attached. Grüße'), textPart('<p>Archive attached.</p>', 'html'), filePart('survey-archive.bin', attachment)])
    const mail = await backend({ INBOX: { uidValidity: 7, messages: [...Array.from({ length: 30 }, (_, index) => small(index + 1)), large] } })
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.uids()).toEqual(Array.from({ length: 31 }, (_, index) => index + 1))
    expect(mail.server.commands.filter(command => /BODY\.PEEK\[\]/.test(command) && /\b31\b/.test(command.split(' (')[0]))).toEqual([])
    expect(mail.server.bodies.filter(body => body.uid === 31).map(body => body.section)).toEqual(['BODY[HEADER]<0>', 'BODY[1]', 'BODY[2]'])
    const message = await mail.read(31)
    expect(message).toMatchObject({ subject: 'Survey archive', text: expect.stringContaining('The survey archive is attached. Grüße'), html: expect.stringContaining('<p>Archive attached.</p>'), hasAttachments: true,
      attachments: [{ index: 0, filename: 'survey-archive.bin', mimeType: 'application/octet-stream', size: expect.any(Number) }] })
    expect(message).not.toHaveProperty('bodyDeferred')
    expect(await mail.read(5)).toMatchObject({ subject: 'Census 5', text: expect.stringContaining('Grünspecht über der Wiese äöüß') })
    mail.server.reset()
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(mail.server.bodies).toEqual([])
    const saved = await attachmentBytes({ readAttachment: async input => mail.call('readAttachment', input) as never }, ref(31), 0)
    expect(saved.filename).toBe('survey-archive.bin')
    expect(saved.bytes).toEqual(attachment)
    expect(mail.server.bodies.every(body => body.section.startsWith('BODY[3]<') && body.bytes <= MAIL_SYNC_LIMITS.attachmentSliceBytes)).toBe(true)
    await mail.dispose()
  }, HEAVY_TEST_MS)

  it('keeps a message that fails once as unavailable, caches the rest, never refetches it on later syncs, and downloads it when opened', async () => {
    const mail = await backend({ INBOX: { uidValidity: 7, messages: [small(1), small(2), small(3)] } }, { failUids: [2] })
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.uids()).toEqual([1, 2, 3])
    expect(mail.emit).toHaveBeenCalledWith('sync', expect.objectContaining({ status: 'done', unavailable: 1 }))
    expect(await mail.read(2)).toMatchObject({ subject: 'Message could not be downloaded', bodyDeferred: true, bodyError: expect.stringContaining('synthetic failure') })
    for (let cycle = 0; cycle < 3; cycle++) {
      mail.server.reset()
      expect(await mail.sync()).toMatchObject({ ok: true })
      expect(mail.server.bodies).toEqual([])
    }
    mail.server.modes.failUids = []
    const opened = await mail.call<{ chunk: string; total: number }>('loadMessageContent', { ...ref(2), field: 'text', offset: 0 })
    expect(opened.data?.chunk).toContain('Census sheet 2')
    expect(await mail.read(2)).toMatchObject({ subject: 'Census 2', text: expect.stringContaining('Census sheet 2') })
    expect(await mail.mock.api.data.dataset('messages').count({ accountId: account.id })).toBe(3)
    await mail.dispose()
  })

  it('defers a text body above the part limit and returns it whole in slices when opened', async () => {
    const text = `${'Schilfrohrsänger Abschnitt äöüß '.repeat(32)}\n`.repeat(Math.ceil(MAIL_SYNC_LIMITS.bodyBytes * 2.5 / 1056))
    const mail = await backend({ INBOX: { uidValidity: 7, messages: [fakeMessage(1, 'Zählbogen', [textPart(text)]), small(2)] } })
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.uids()).toEqual([1, 2])
    expect(mail.server.bodies.filter(body => body.uid === 1).map(body => body.section)).toEqual(['BODY[HEADER]<0>'])
    const message = await mail.read(1)
    expect(message).toMatchObject({ subject: 'Zählbogen', bodyDeferred: true })
    expect(message).not.toHaveProperty('text')
    let loaded = ''
    for (let offset = 0, total = 1; offset < total;) {
      const slice = await mail.call<{ chunk: string; total: number }>('loadMessageContent', { ...ref(1), field: 'text', offset })
      total = slice.data!.total; loaded += slice.data!.chunk; offset += slice.data!.chunk.length
      expect(slice.data!.chunk.length).toBeLessThanOrEqual(1024 * 1024)
    }
    expect(loaded).toBe(text.replace(/\r?\n/g, '\n'))
    expect(mail.server.bodies.filter(body => body.uid === 1 && body.section === 'BODY[1]')).toHaveLength(1)
    await mail.dispose()
 }, HEAVY_TEST_MS)

  it('serves an opened body too large for the cache from memory, whole, without a second download', async () => {
    const text = `${'Schilfrohrsänger Abschnitt äöüß '.repeat(32)}\n`.repeat(4400)
    const mail = await backend({ INBOX: { uidValidity: 7, messages: [fakeMessage(1, 'Zählbogen', [textPart(text)]), small(2)] } })
    expect(await mail.sync()).toMatchObject({ ok: true })
    const load = async () => {
      let loaded = ''
      for (let offset = 0, total = 1; offset < total;) {
        const slice = await mail.call<{ chunk: string; total: number }>('loadMessageContent', { ...ref(1), field: 'text', offset })
        expect(slice).toMatchObject({ ok: true })
        total = slice.data!.total; loaded += slice.data!.chunk; offset += slice.data!.chunk.length
      }
      return loaded
    }
    expect(await load()).toBe(text)
    expect(await load()).toBe(text)
    expect(mail.server.bodies.filter(body => body.uid === 1 && body.section === 'BODY[1]')).toHaveLength(1)
    expect(await mail.read(1)).toMatchObject({ bodyDeferred: true })
    await mail.dispose()
  })

  it('drains a literal above the command limit and keeps the connection in step', async () => {
    const big = fakeMessage(1, 'Understated size', [textPart('Short body.'), filePart('blob.bin', bytes(3 * MAIL_SYNC_LIMITS.wholeMessageBytes))])
    const mail = await backend({ INBOX: { uidValidity: 7, messages: [big, small(2)] } }, { sizeLie: [1] })
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.read(1)).toMatchObject({ subject: 'Understated size', text: expect.stringContaining('Short body.'), attachments: [{ filename: 'blob.bin' }] })
    expect(await mail.read(2)).toMatchObject({ subject: 'Census 2' })
    await mail.dispose()
  })
})

describe('sync reconciles deleted mail (F3)', () => {
  it('removes messages deleted on the server in one sync and keeps the local Sent copy', async () => {
    const folders = { INBOX: { uidValidity: 7, messages: [1, 2, 3, 4, 5].map(small) }, Sent: { uidValidity: 8, messages: [small(1), small(2)] } }
    const mail = await backend(folders)
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.sync('Sent')).toMatchObject({ ok: true })
    const local = Date.now()
    await appendMessage(mail.scope, account.id, 'Sent', { uid: local, messageId: '<local@birds.example>', from: account.address, to: 'heron@birds.example', subject: 'Local copy', date: new Date().toISOString(), snippet: '', text: 'Sent from Valley', flags: ['\\Seen'], hasAttachments: false })
    folders.INBOX.messages = folders.INBOX.messages.filter(message => message.uid !== 2 && message.uid !== 4)
    folders.Sent.messages = [folders.Sent.messages[1]]
    expect(await mail.sync()).toMatchObject({ ok: true, data: { total: 3 } })
    expect(await mail.uids()).toEqual([1, 3, 5])
    expect(mail.emit).toHaveBeenCalledWith('sync', expect.objectContaining({ folder: 'INBOX', status: 'done', removed: 2 }))
    expect(await mail.read(2)).toBeNull()
    expect(await mail.sync('Sent')).toMatchObject({ ok: true })
    expect(await mail.uids('Sent')).toEqual([2, local])
    expect(await mail.read(local, 'Sent')).toMatchObject({ subject: 'Local copy' })
    await mail.dispose()
  })

  it.each([
    ['a refused search', { search: 'no' }],
    ['a search that omits listed messages', { search: 'empty' }],
    ['an empty listing for a non-empty folder', { listing: 'empty' }]
  ] as const)('removes nothing after %s', async (_label, modes) => {
    const folders = { INBOX: { uidValidity: 7, messages: Array.from({ length: 20 }, (_, index) => small(index + 1)) } }
    const mail = await backend(folders)
    expect(await mail.sync()).toMatchObject({ ok: true })
    Object.assign(mail.server.modes, modes)
    // Older messages (below the window of the five newest) are the ones only UID SEARCH can confirm gone.
    folders.INBOX.messages = folders.INBOX.messages.filter(message => message.uid !== 2 && message.uid !== 3)
    for (let cycle = 0; cycle < 3; cycle++) await mail.sync('INBOX', 5)
    expect(await mail.uids()).toHaveLength(20)
    await mail.dispose()
  })

  it('confirms messages gone inside the listed window without UID SEARCH, and searches only older ones, a bounded slice per sync', async () => {
    const folders = { INBOX: { uidValidity: 7, messages: Array.from({ length: 30 }, (_, index) => small(index + 1)) } }
    const mail = await backend(folders)
    expect(await mail.sync()).toMatchObject({ ok: true })
    folders.INBOX.messages = folders.INBOX.messages.filter(message => message.uid !== 29)
    mail.server.reset()
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.uids()).not.toContain(29)
    expect(mail.server.commands.filter(command => command.startsWith('UID SEARCH'))).toEqual([])
    const slice = MAIL_SYNC_LIMITS.reconcileUids
    Object.assign(MAIL_SYNC_LIMITS, { reconcileUids: 8 })
    try {
      folders.INBOX.messages = folders.INBOX.messages.filter(message => message.uid !== 3 && message.uid !== 15 && message.uid !== 27)
      mail.server.reset()
      for (let cycle = 0; cycle < 3; cycle++) expect(await mail.sync('INBOX', 5)).toMatchObject({ ok: true })
      // The window holds UIDs 24-30 (27 gone at once); 1-23 are checked eight at a time, each search with the lowest listed UID as a canary.
      expect(mail.server.commands.filter(command => command.startsWith('UID SEARCH'))).toEqual(['UID SEARCH UID 1:8,24', 'UID SEARCH UID 9:16,24', 'UID SEARCH UID 17:24'])
      expect(await mail.uids()).toEqual(Array.from({ length: 30 }, (_, index) => index + 1).filter(uid => ![3, 15, 27, 29].includes(uid)))
      mail.server.reset()
      expect(await mail.sync('INBOX', 5)).toMatchObject({ ok: true })
      expect(mail.server.commands.filter(command => command.startsWith('UID SEARCH'))).toEqual(['UID SEARCH UID 1:2,4:9,24'])
    } finally { Object.assign(MAIL_SYNC_LIMITS, { reconcileUids: slice }) }
    await mail.dispose()
  })

  it('confirms a large removal of older messages by searching the same UIDs again', async () => {
    const folders = { INBOX: { uidValidity: 7, messages: Array.from({ length: 40 }, (_, index) => small(index + 1)) } }
    const mail = await backend(folders)
    expect(await mail.sync()).toMatchObject({ ok: true })
    const slice = MAIL_SYNC_LIMITS.reconcileUids
    Object.assign(MAIL_SYNC_LIMITS, { reconcileUids: 20 })
    try {
      folders.INBOX.messages = folders.INBOX.messages.filter(message => message.uid > 15)
      mail.server.reset()
      expect(await mail.sync('INBOX', 5)).toMatchObject({ ok: true })
      expect(await mail.uids()).toHaveLength(40)
      expect(await mail.sync('INBOX', 5)).toMatchObject({ ok: true })
      expect(mail.server.commands.filter(command => command.startsWith('UID SEARCH'))).toEqual(['UID SEARCH UID 1:20,36', 'UID SEARCH UID 1:15,36'])
      expect(await mail.uids()).toEqual(Array.from({ length: 25 }, (_, index) => index + 16))
    } finally { Object.assign(MAIL_SYNC_LIMITS, { reconcileUids: slice }) }
    await mail.dispose()
  })

  it('removes a folder emptied on the server only after a second consistent sync', async () => {
    const folders = { INBOX: { uidValidity: 7, messages: Array.from({ length: 15 }, (_, index) => small(index + 1)) } }
    const mail = await backend(folders)
    expect(await mail.sync()).toMatchObject({ ok: true })
    folders.INBOX.messages = []
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.uids()).toHaveLength(15)
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.uids()).toEqual([])
    expect(await mail.mock.api.data.dataset('messages').count({ accountId: account.id })).toBe(0)
    await mail.dispose()
  })

  it('confirms a large removal across two command operations, each with its own data API', async () => {
    const folders = { INBOX: { uidValidity: 7, messages: Array.from({ length: 15 }, (_, index) => small(index + 1)) } }
    const mail = await backend(folders)
    expect(await mail.syncOperation()).toMatchObject({ ok: true })
    folders.INBOX.messages = []
    expect(await mail.syncOperation()).toMatchObject({ ok: true })
    expect(await mail.uids()).toHaveLength(15)
    expect(await mail.syncOperation()).toMatchObject({ ok: true })
    expect(await mail.uids()).toEqual([])
    await mail.dispose()
  })

  it('keeps a pending large removal across a backend restart and applies it on the next consistent sync', async () => {
    const folders = { INBOX: { uidValidity: 7, messages: Array.from({ length: 15 }, (_, index) => small(index + 1)) } }
    const mail = await backend(folders)
    expect(await mail.sync()).toMatchObject({ ok: true })
    folders.INBOX.messages = folders.INBOX.messages.slice(0, 2)
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.uids()).toHaveLength(15)
    expect(await mail.mock.api.data.dataset('sync_state').get({ accountId: account.id, folder: 'INBOX' })).toMatchObject({ pendingRemoval: { uidValidity: 7, uids: Array.from({ length: 13 }, (_, index) => index + 3) } })
    await mail.restart()
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.uids()).toEqual([1, 2])
    expect(await mail.mock.api.data.dataset('sync_state').get({ accountId: account.id, folder: 'INBOX' })).toMatchObject({ pendingRemoval: null })
    await mail.dispose()
  })

  it('rebuilds a folder whose UIDVALIDITY changed and leaves it untouched when the server omits UIDVALIDITY', async () => {
    const folders = { INBOX: { uidValidity: 7, messages: [1, 2, 3].map(small) } }
    const mail = await backend(folders)
    expect(await mail.sync()).toMatchObject({ ok: true })
    mail.server.modes.select = 'no-uidvalidity'
    expect(await mail.sync()).toMatchObject({ ok: false, error: expect.stringContaining('UIDVALIDITY') })
    expect(await mail.uids()).toEqual([1, 2, 3])
    mail.server.modes.select = 'ok'
    folders.INBOX = { uidValidity: 9, messages: [small(11), small(12)] }
    expect(await mail.sync()).toMatchObject({ ok: true, data: { total: 2 } })
    expect(await mail.uids()).toEqual([11, 12])
    expect(await mail.read(11)).toMatchObject({ uidValidity: 9, subject: 'Census 11' })
    await mail.dispose()
  })

  it('keeps a message the user moved where Valley put it and does not download it again', async () => {
    const folders = { INBOX: { uidValidity: 7, messages: [1, 2].map(small) }, Trash: { uidValidity: 8, messages: [small(1)] } }
    const mail = await backend(folders)
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.sync('Trash')).toMatchObject({ ok: true })
    expect(await mail.call('applyMessageAction', { ...ref(2), action: 'trash' })).toMatchObject({ ok: true, data: { destinationFolder: 'Trash' } })
    expect(await mail.uids('Trash')).toEqual([1, 2])
    mail.server.reset()
    expect(await mail.sync('Trash')).toMatchObject({ ok: true })
    expect(await mail.sync()).toMatchObject({ ok: true })
    expect(await mail.uids('Trash')).toEqual([1, 2])
    expect(await mail.uids()).toEqual([1])
    expect(mail.server.bodies).toEqual([])
    await mail.dispose()
  })
})

describe('sent mail is kept on the server and locally (F15)', () => {
  const send = (mail: Awaited<ReturnType<typeof backend>>) => mail.call<{ messageId: string }>('sendEmail', { accountId: account.id, to: 'heron@birds.example', subject: 'Reiher gesichtet', text: 'Zwölf Graureiher.' })
  it('stores the sent copy under the server UID from APPENDUID', async () => {
    const mail = await backend({ INBOX: { uidValidity: 7, messages: [] }, Sent: { uidValidity: 8, messages: [] } })
    vi.spyOn(transport, 'sendMail').mockImplementation(async (_api, _account, _input, _automatic, accepted) => { accepted?.(new TextEncoder().encode('Subject: x\r\n\r\nbody\r\n')); return '<sent-1@birds.example>' })
    const append = vi.spyOn(transport, 'appendSentMessage').mockResolvedValue({ folder: 'Sent', uid: 12, uidValidity: 8 })
    expect(await send(mail)).toMatchObject({ ok: true, data: { messageId: '<sent-1@birds.example>' } })
    expect(append).toHaveBeenCalledOnce()
    expect(await mail.uids('Sent')).toEqual([12])
    expect(await mail.read(12, 'Sent')).toMatchObject({ uidValidity: 8, subject: 'Reiher gesichtet' })
    await mail.dispose()
  })
  it('keeps the local copy when the server refuses the copy, and replaces it once a sync finds the server copy', async () => {
    const folders = { INBOX: { uidValidity: 7, messages: [] as ReturnType<typeof small>[] }, Sent: { uidValidity: 8, messages: [] as ReturnType<typeof small>[] } }
    const mail = await backend(folders)
    vi.spyOn(transport, 'sendMail').mockImplementation(async (_api, _account, _input, _automatic, accepted) => { accepted?.(new TextEncoder().encode('Subject: x\r\n\r\nbody\r\n')); return '<m5@birds.example>' })
    vi.spyOn(transport, 'appendSentMessage').mockRejectedValue(new Error('NO [OVERQUOTA] mailbox full'))
    expect(await send(mail)).toMatchObject({ ok: true })
    const [local] = await mail.uids('Sent')
    expect(local).toBeGreaterThan(0xffffffff)
    expect(await mail.sync('Sent')).toMatchObject({ ok: true })
    expect(await mail.uids('Sent')).toEqual([local])
    folders.Sent.messages.push(small(5))
    expect(await mail.sync('Sent')).toMatchObject({ ok: true })
    expect(await mail.uids('Sent')).toEqual([5])
    await mail.dispose()
  })
  it('keeps the local copy in the special-use Sent mailbox whatever its name, so its sync replaces it', async () => {
    const folders = { INBOX: { uidValidity: 7, messages: [] as ReturnType<typeof small>[] }, Gesendet: { uidValidity: 8, messages: [] as ReturnType<typeof small>[], specialUse: '\\Sent' } }
    const mail = await backend(folders)
    expect(await mail.call('listFolders', { accountId: account.id })).toMatchObject({ ok: true })
    vi.spyOn(transport, 'sendMail').mockImplementation(async (_api, _account, _input, _automatic, accepted) => { accepted?.(new TextEncoder().encode('Subject: x\r\n\r\nbody\r\n')); return '<m5@birds.example>' })
    vi.spyOn(transport, 'appendSentMessage').mockRejectedValue(new Error('NO [OVERQUOTA] mailbox full'))
    expect(await send(mail)).toMatchObject({ ok: true })
    expect(await mail.uids('Sent')).toEqual([])
    const [local] = await mail.uids('Gesendet')
    expect(local).toBeGreaterThan(0xffffffff)
    folders.Gesendet.messages.push(small(5))
    expect(await mail.sync('Gesendet')).toMatchObject({ ok: true })
    expect(await mail.uids('Gesendet')).toEqual([5])
    await mail.dispose()
  })
  it.each([
    ['a refused APPEND', () => new transport.ImapRefusal('NO [OVERQUOTA] mailbox full')],
    ['an APPEND without an answer', () => new transport.MailActionUncertain('Mail server closed the connection.')]
  ])('never reports %s as a failed or uncertain send', async (_case, failure) => {
    const mail = await backend({ INBOX: { uidValidity: 7, messages: [] }, Sent: { uidValidity: 8, messages: [] } })
    vi.spyOn(transport, 'sendMail').mockImplementation(async (_api, _account, _input, _automatic, accepted) => { accepted?.(new TextEncoder().encode('Subject: x\r\n\r\nbody\r\n')); return '<m6@birds.example>' })
    vi.spyOn(transport, 'appendSentMessage').mockRejectedValue(failure())
    const result = await send(mail)
    expect(result).toMatchObject({ ok: true })
    expect(result).not.toHaveProperty('outcome')
    expect(result).not.toHaveProperty('code')
    expect(await mail.uids('Sent')).toHaveLength(1)
    await mail.dispose()
  })
})
