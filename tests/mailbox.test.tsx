import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTACTS_DIRECTORY_V1, CONTACTS_DIRECTORY_REVISION_V1, METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import type { EmailMessageDetail } from '../src/mailTypes'
import { createMailMock as createMockValleyApi } from './mailMock'
import { register } from '../src/index'
import { MailboxControls, Panel } from '../src/Panel'
import { Page } from '../src/Page'
import { Preview } from '../src/Preview'
import { emailDisplaySettingsKey } from '../src/hooks'
import { disposeStore, formatEmailTimestamp, getStore } from '../src/store'
import { emailDocument, MessageBody } from '../src/MessageBody'

const message: EmailMessageDetail = {
  id: 'canopy', accountId: 'one', folder: 'INBOX', uid: 7, messageId: '<canopy@example.com>',
  from: 'canopy@example.com', to: 'reader@example.com', subject: 'Canopy survey', snippet: 'Forest canopy', text: 'The forest supports biodiversity.',
  date: '2026-08-30T09:00:00.000Z', flags: [], hasAttachments: true,
  memberships: [{ accountId: 'one', folder: 'INBOX', uid: 7 }],
  addresses: { from: [{ name: '', address: 'canopy@example.com' }], to: [{ name: '', address: 'reader@example.com' }], cc: [], replyTo: [] }
}
let dispose: (() => void | Promise<void>) | undefined
function setup(accountsReady: Promise<void> = Promise.resolve(), details: Partial<EmailMessageDetail> = {}, configure?: (mock: ReturnType<typeof createMockValleyApi>) => void) {
  const mock = createMockValleyApi({ manifest: { id: 'email' } })
  let current = { ...message, ...details }
  mock.mail.listAccounts = async () => { await accountsReady; return { ok: true, data: { accounts: ['one', 'two'].map((id) => ({ id, provider: 'pureemail', address: `${id}@example.com`, displayName: id,
    imap: { host: 'example.com', port: 993, secure: true }, smtp: { host: 'example.com', port: 465, secure: true }, createdAt: 1 })) } } }
  mock.mail.listFolders = async () => ({ ok: true, data: { folders: ['INBOX', 'Archive', 'Trash'], mailboxes: [
    { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', selectable: true, cachedTotal: 1, cachedUnread: 1 },
    { path: 'Archive', name: 'Archive', specialUse: '\\Archive', selectable: true, cachedTotal: 0, cachedUnread: 0 },
    { path: 'Trash', name: 'Trash', specialUse: '\\Trash', selectable: true, cachedTotal: 0, cachedUnread: 0 }
  ] } })
  mock.mail.queryMessages = vi.fn(async (input) => ({ ok: true, data: { messages: input.accountId === 'one' && !(input.view === 'unread' && current.flags.includes('\\Seen')) ? [current] : [] } }))
  mock.mail.readMessage = vi.fn(async () => ({ ok: true, data: { message: current } }))
  mock.mail.applyMessageAction = vi.fn(async (input) => {
    current = { ...current, flags: input.action === 'mark-read' ? ['\\Seen'] : current.flags }
    return { ok: true, data: { action: input.action, folder: input.folder, messages: [current] } }
  })
  configure?.(mock)
  dispose = register(mock.api)
  return mock
}
afterEach(async () => { cleanup(); await dispose?.(); dispose = undefined })

describe('Email mailbox', () => {
  it('keeps mailbox filtering in the shared search frame without replacing its input', async () => {
    const mock = setup()
    render(<Panel />)
    const input = await screen.findByRole('textbox', { name: 'Search mail' })
    const frame = input.parentElement!
    expect(frame).toHaveClass('search-field')
    expect(input).toHaveClass('search-field-input')
    expect(frame.querySelector('.search-field-icon')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'canopy' } })
    expect(getStore().getSnapshot().query).toBe('canopy')
    await waitFor(() => expect(mock.mail.queryMessages).toHaveBeenCalledWith(expect.objectContaining({ query: 'canopy' })))
    fireEvent.change(input, { target: { value: '' } })
    expect(getStore().getSnapshot().query).toBe('')
    expect(screen.getByRole('textbox', { name: 'Search mail' })).toBe(input)
    expect(input.parentElement).toBe(frame)
  })

  it('reuses validated mailbox results without replacing the selection when validation fails', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    const folders = vi.spyOn(mock.mail, 'listFolders')
    await store.restoreSelection({ accountIds: ['one', 'two'], view: 'folder', folder: 'Archive' })
    expect(folders.mock.calls).toEqual([['one'], ['two']])
    expect(store.getSnapshot().mailboxesByAccount).toHaveProperty('two')
    folders.mockResolvedValueOnce({ ok: false, error: 'Offline' })
    await expect(store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX' })).rejects.toThrow('Could not load the saved mailbox')
    expect(store.getSnapshot()).toMatchObject({ selectedAccountIds: ['one', 'two'], selectedFolder: 'Archive' })
  })

  it('reuses the last own-sync refresh and still reloads for later external sync events', async () => {
    let onSync!: Parameters<ReturnType<typeof createMockValleyApi>['mail']['onSync']>[0]
    const mock = setup(Promise.resolve(), {}, (mock) => {
      mock.mail.onSync = (listener) => { onSync = listener; return () => {} }
    })
    const store = getStore()
    await store.whenReady
    vi.mocked(mock.mail.queryMessages).mockClear()
    mock.mail.syncFolder = vi.fn(async (accountId, folder) => {
      onSync({ accountId, folder, status: 'done', fetched: 1, total: 1 })
      await Promise.resolve()
      return { ok: true }
    })
    await store.sync()
    expect(mock.mail.queryMessages).toHaveBeenCalledTimes(2)
    onSync({ accountId: 'one', folder: 'INBOX', status: 'done', fetched: 1, total: 1 })
    await waitFor(() => expect(mock.mail.queryMessages).toHaveBeenCalledTimes(3))
  })

  it('joins every sync caller through the final coalesced pass with one active folder request', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let active = 0
    let maximum = 0
    mock.mail.syncFolder = vi.fn(async () => {
      active++
      maximum = Math.max(maximum, active)
      await held
      active--
      return { ok: true }
    })
    const first = store.sync()
    await waitFor(() => expect(mock.mail.syncFolder).toHaveBeenCalledTimes(1))
    const repeated = Array.from({ length: 20 }, () => store.sync())
    expect(repeated.every((promise) => promise === first)).toBe(true)
    let completed = false
    void repeated[0].then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    release()
    await Promise.all([first, ...repeated])
    expect(maximum).toBe(1)
    expect(mock.mail.syncFolder).toHaveBeenCalledTimes(4)
    expect(store.getSnapshot().syncing).toBe(false)
  })

  it('drains an accepted sync on disposal and stops its next account and queued rerun', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mock.mail.syncFolder = vi.fn(async () => { await held; return { ok: true } })
    const first = store.sync()
    await waitFor(() => expect(mock.mail.syncFolder).toHaveBeenCalledTimes(1))
    const repeated = store.sync()
    const publish = vi.fn()
    store.subscribe(publish)
    let completed = false
    const draining = store.dispose().then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    release()
    await Promise.all([first, repeated, draining, store.sync()])
    expect(mock.mail.syncFolder).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalled()
  })

  it('keeps a delayed old registration on its captured API and disposes only its own store', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const first = setup(held)
    const oldStore = getStore()
    const oldDispose = dispose!
    const second = setup()
    const currentStore = getStore()
    await currentStore.whenReady
    vi.mocked(second.mail.queryMessages).mockClear()
    release()
    await oldStore.whenReady
    expect(first.mail.queryMessages).toHaveBeenCalledTimes(1)
    expect(second.mail.queryMessages).not.toHaveBeenCalled()
    await oldDispose()
    expect(getStore()).toBe(currentStore)
    await currentStore.selectAccount('two')
    expect(second.mail.queryMessages).toHaveBeenCalledTimes(1)
  })

  it('shares identical in-flight lists without adopting a late result after the view changes', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mock.mail.queryMessages = vi.fn(async (input) => {
      if (input.view === 'recent') await held
      return { ok: true, data: { messages: [{ ...message, id: input.view }] } }
    })
    const first = store.selectView('recent')
    const second = store.selectView('recent')
    expect(mock.mail.queryMessages).toHaveBeenCalledTimes(1)
    await store.selectView('unread')
    expect(store.getSnapshot().messages[0].id).toBe('unread')
    release()
    await Promise.all([first, second])
    expect(store.getSnapshot().messages[0].id).toBe('unread')
    expect(mock.mail.queryMessages).toHaveBeenCalledTimes(2)
  })

  it('parses outgoing reply-all recipients once and does not parse unused forwarding addresses', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    const parse = vi.fn(async (value: string) => ({ ok: true, data: { addresses: value.split(',').filter(Boolean).map((address) => ({ name: '', address: address.trim() })) } }))
    mock.mail.parseAddresses = parse
    const outgoing = { ...message, from: 'one@example.com', to: 'canopy@example.com', cc: 'habitat@example.com' }
    await store.startCompose('reply-all', outgoing)
    expect(parse.mock.calls).toEqual([['one@example.com'], ['canopy@example.com'], ['habitat@example.com']])
    expect(store.getSnapshot().compose).toMatchObject({ to: [{ address: 'canopy@example.com' }], cc: [{ address: 'habitat@example.com' }] })
    await store.cancelCompose()
    parse.mockClear()
    await store.startCompose('forward', outgoing)
    expect(parse).not.toHaveBeenCalled()
    expect(store.getSnapshot().compose).toMatchObject({ mode: 'forward', to: [], cc: [], subject: 'Fwd: Canopy survey' })
  })

  it('presents address details in Properties and edits flags through the same domain action as its command', async () => {
    const mock = setup(Promise.resolve(), {
      from: '"Canopy Team" <canopy@example.com>', replyTo: 'survey@example.com', cc: 'habitat@example.com',
      addresses: { ...message.addresses, from: [{ name: 'Canopy Team', address: 'canopy@example.com' }], cc: [{ name: '', address: 'habitat@example.com' }], replyTo: [{ name: 'Survey team', address: 'survey@example.com' }] }
    })
    const store = getStore()
    await store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX', message: { accountId: 'one', folder: 'INBOX', uid: 7 } })
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension.getSnapshot()!
    const subject = { pluginId: 'email', surface: 'main_workspace' as const, view: surface.view, item: surface.item }
    const properties = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1).find((entry) => entry.extension.id === 'email.message')!.extension
    const readLabel = (await properties.inspect!({ relPath: '', kind: 'unsupported', subject })).find((field) => field.id === 'read')!.label
    const dispatch = vi.spyOn(mock.api.commands, 'executeOwn')
    const execute = vi.spyOn(mock.api.commands, 'execute')
    const { container } = render(<>{properties.render({ relPath: '', kind: 'unsupported', tab: { pluginId: 'email' } })}<Page navigation={{ setController: vi.fn() }} /></>)
    const toggle = await screen.findByRole('switch', { name: readLabel })
    expect(screen.getByText('Canopy survey', { selector: 'dd' })).toHaveClass('props-info-value')
    expect(container.querySelectorAll('.props-info-row')).toHaveLength(9)
    const sender = screen.getAllByText('Canopy Team').find((element) => element.closest('.email-properties'))!.closest('.email-property-person')!
    expect(sender.querySelector('small')?.textContent).toBe('canopy@example.com')
    expect(sender.textContent).not.toMatch(/["<>]/)
    expect(container.querySelector('.email-properties')?.textContent).toContain('Reply-To')
    expect(container.querySelector('.email-properties')?.textContent).toContain('survey@example.com')
    expect(container.querySelector('.email-reader-header')?.textContent).not.toContain('Reply-To')
    const headerSender = container.querySelector('.email-reader-addresses .email-property-person')!
    expect(headerSender.querySelector('.email-property-name')).toHaveTextContent('Canopy Team')
    expect(headerSender.querySelector('small')).toHaveTextContent('canopy@example.com')
    expect(container.querySelector('.email-reader-location')).toBeNull()
    expect(container.querySelector('.email-reader-context')?.textContent).not.toContain('INBOX')
    expect(container.querySelector('.email-properties')?.textContent).not.toContain('Account')
    expect((await properties.inspect!({ relPath: '', kind: 'unsupported', subject })).map((field) => field.id)).toContain('replyTo')
    expect((await properties.inspect!({ relPath: '', kind: 'unsupported', subject })).map((field) => field.id)).not.toContain('accountId')
    expect(container.querySelector('input[disabled], .settings-row')).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(toggle) })
    await waitFor(() => expect(toggle).toBeChecked())
    expect(mock.mail.applyMessageAction).toHaveBeenCalledWith({ accountId: 'one', folder: 'INBOX', uid: 7, action: 'mark-read' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    await act(async () => { expect(await mock.api.commands.executeOwn('update-properties', { subject, values: { read: false } })).toMatchObject({ ok: true }) })
    expect(mock.mail.applyMessageAction).toHaveBeenLastCalledWith({ accountId: 'one', folder: 'INBOX', uid: 7, action: 'mark-unread' })
    expect(mock.api.commands.list().find((command) => command.id === 'email:update-properties')?.sideEffect).toBe('write')
  })

  it('keeps the overview read-only and shows a separate message segment only while selected', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    const segments = () => mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1).map((entry) => entry.extension)
    expect(segments().map((segment) => segment.id)).toEqual(['email.properties'])
    const overview = segments()[0]
    expect(overview.editCommand).toBeUndefined()
    const subject = { pluginId: 'email', surface: 'main_workspace' as const, view: { accountIds: ['one'], view: 'folder', folder: 'INBOX', query: 'forest' } }
    const { container, rerender } = render(<>{overview.render({ relPath: '', kind: 'unsupported', subject })}</>)
    expect(container.textContent).toContain('one@example.com')
    expect(container.textContent).toContain('two@example.com')
    expect(screen.getByText('forest')).toHaveClass('props-info-value')
    expect(screen.getByText('Cached mail').nextElementSibling).toHaveTextContent('1')
    expect(container.querySelector('input, select, button, [role="switch"]')).toBeNull()
    expect((await overview.inspect!({ relPath: '', kind: 'unsupported', subject })).every((field) => field.readOnly)).toBe(true)
    expect(await mock.api.commands.executeOwn('update-properties', { subject, values: { query: 'other' } })).toMatchObject({ ok: false })
    await act(async () => { await store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX', message: { accountId: 'one', folder: 'INBOX', uid: 7 } }) })
    expect(segments().map((segment) => segment.id)).toEqual(['email.properties', 'email.message'])
    expect(segments()[1].icon).not.toBe(overview.icon)
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension.getSnapshot()!
    const selected = { ...subject, view: surface.view, item: surface.item }
    rerender(<>{overview.render({ relPath: '', kind: 'unsupported', subject: selected })}</>)
    expect(container.textContent).not.toContain('Canopy survey')
    expect(container.textContent).toContain('Cached mail')
    expect((await overview.inspect!({ relPath: '', kind: 'unsupported', subject: selected })).map((field) => field.id)).not.toContain('subject')
    vi.mocked(mock.mail.queryMessages).mockResolvedValueOnce({ ok: true, data: { messages: [], cursor: undefined } })
    await act(async () => { await store.selectView('unread') })
    expect(segments().map((segment) => segment.id)).toEqual(['email.properties'])
    expect(screen.getByText('Cached mail').nextElementSibling).toHaveTextContent('0')
    dispose?.(); dispose = undefined
    expect(segments()).toEqual([])
  })

  it('awaits history navigation and keeps the current mailbox and history position when its message is missing', async () => {
    const mock = setup()
    const store = getStore()
    await store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX', message: { accountId: 'one', folder: 'INBOX', uid: 7 } })
    await store.selectView('recent')
    vi.mocked(mock.mail.readMessage).mockResolvedValueOnce({ ok: true, data: { message: null } })
    await expect(store.goBack()).rejects.toThrow('no longer exists')
    expect(store.getSnapshot()).toMatchObject({ view: 'recent', selectedMessage: null, canGoBack: true, canGoForward: false })
    await expect(store.goBack()).resolves.toBe(true)
    expect(store.getSnapshot()).toMatchObject({ view: 'folder', selectedMessage: { uid: 7 }, canGoForward: true })
    await expect(store.goForward()).resolves.toBe(true)
    expect(store.getSnapshot()).toMatchObject({ view: 'recent', selectedMessage: null })
  })

  it('renders rich mail in a script-free isolated frame and preserves the plain-text fallback', async () => {
    setup()
    const html = '<style>td{padding:12px}</style><h2>Meadow survey</h2><table><tr><td>Bees</td><td>12</td></tr></table><script>parent.compromised=true</script><img src="https://tracking.invalid/pixel" onerror="alert(1)"><a href="javascript:alert(1)">Bad</a><a href="https://example.com/survey">Survey</a><form action="https://tracking.invalid"><input autofocus></form><meta http-equiv="refresh" content="0;url=https://tracking.invalid">'
    const safe = emailDocument(html, false)
    const doc = new DOMParser().parseFromString(safe.document, 'text/html')
    expect(doc.querySelector('table')?.textContent).toBe('Bees12')
    expect(doc.querySelector('script,form,input,iframe,[onerror],[href],meta[http-equiv="refresh"]')).toBeNull()
    expect(doc.querySelector('img')?.getAttribute('src')).toBeNull()
    expect(doc.querySelector('a[data-email-href]')?.getAttribute('data-email-href')).toBe('https://example.com/survey')
    expect(safe.blockedImages).toBe(true)
    const { container, rerender } = render(<MessageBody message={{ ...message, html }} remoteImages={false} />)
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain('img-src data:;')
    expect(screen.getByText('Remote images are blocked.')).toBeInTheDocument()
    rerender(<MessageBody message={{ ...message, html }} plain />)
    expect(screen.getByText(message.text!)).toBeTruthy()
  })

  it('sizes parsed HTML before remote images finish and follows later layout changes', () => {
    setup()
    let scheduled: FrameRequestCallback | undefined
    let resized: ResizeObserverCallback | undefined
    const cancelled = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const animation = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { scheduled = callback; return 1 })
    const disconnect = vi.fn()
    const controllerObserver = vi.fn(function () { return { observe() {}, disconnect() {} } })
    vi.stubGlobal('ResizeObserver', controllerObserver)
    class FrameObserver {
      constructor(callback: ResizeObserverCallback) { resized = callback }
      observe = vi.fn()
      disconnect = disconnect
    }
    try {
      const { container, rerender, unmount } = render(<MessageBody message={{ ...message, html: '<p>Long survey</p><img src="https://example.com/slow.png">' }} />)
      const frame = container.querySelector('iframe')!
      const doc = frame.contentDocument!
      Object.defineProperty(doc.defaultView, 'ResizeObserver', { value: FrameObserver })
      Object.defineProperty(doc, 'URL', { configurable: true, value: 'about:srcdoc' })
      Object.defineProperty(doc, 'readyState', { configurable: true, value: 'interactive' })
      doc.body.style.margin = '0'
      let bodyHeight = 1800
      vi.spyOn(doc.body, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, height: bodyHeight }) as DOMRect)
      act(() => { scheduled!(0) })
      expect(frame.style.height).toBe('1800px')
      expect(controllerObserver).not.toHaveBeenCalled()
      bodyHeight = 2400
      act(() => { resized!([], {} as ResizeObserver); scheduled!(0) })
      expect(frame.style.height).toBe('2400px')
      bodyHeight = 600
      act(() => { resized!([], {} as ResizeObserver); scheduled!(0) })
      expect(frame.style.height).toBe('600px')
      rerender(<MessageBody message={{ ...message, html: '<p>Short survey</p>' }} />)
      expect(disconnect).toHaveBeenCalledOnce()
      expect(container.querySelector('iframe')).not.toBe(frame)
      unmount()
      expect(cancelled).toHaveBeenCalled()
    } finally {
      animation.mockRestore()
      cancelled.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('allows only web and embedded images when remote images are enabled and can block them again', () => {
    setup()
    const embedded = 'data:image/png;base64,iVBORw0KGgo='
    const html = `<img src="https://example.com/fern.png" referrerpolicy="unsafe-url" onerror="alert(1)"><img src="//example.com/moss.png"><img src="http://example.com/bees.png"><img src="${embedded}"><img src="file:///private/fern.png"><img src="data:image/svg+xml;base64,PHN2Zy8+"><img src="javascript:alert(1)"><script>alert(1)</script>`
    const allowed = emailDocument(html)
    const doc = new DOMParser().parseFromString(allowed.document, 'text/html')
    expect([...doc.querySelectorAll('img[src]')].map((image) => image.getAttribute('src'))).toEqual([
      'https://example.com/fern.png', 'https://example.com/moss.png', 'http://example.com/bees.png', embedded
    ])
    expect(doc.querySelector('script, [onerror], [referrerpolicy="unsafe-url"]')).toBeNull()
    expect(doc.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer')
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("script-src 'none';")
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain('img-src data: https: http:;')
    expect(allowed.blockedImages).toBe(false)
    const { container, rerender } = render(<MessageBody message={{ ...message, html }} />)
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('https://example.com/fern.png')
    rerender(<MessageBody message={{ ...message, html }} remoteImages={false} />)
    const blocked = new DOMParser().parseFromString(container.querySelector('iframe')!.getAttribute('srcdoc')!, 'text/html')
    expect([...blocked.querySelectorAll('img[src]')].map((image) => image.getAttribute('src'))).toEqual([embedded])
  })

  it('keeps HTML/plain text in the shared menu and exposes the requested toolbar actions', async () => {
    const mock = setup(Promise.resolve(), { html: '<p>Forest canopy</p>' })
    const store = getStore()
    await store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX', message })
    const { container } = render(<Page navigation={{ setController: vi.fn() }} />)
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'main_workspace')!.extension
    expect([...container.querySelectorAll('.email-message-actions button')].map((button) => button.getAttribute('aria-label'))).toEqual([
      'Reply', 'Reply all', 'Forward', 'Flag', 'Move to Junk', 'Move to Trash'
    ])
    expect(screen.queryByRole('button', { name: 'Show plain text' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Move to Junk' })).toBeDisabled()
    await act(async () => { await surface.getSnapshot()!.actions!.find((item) => item.id === 'body-format')!.onSelect!() })
    expect(container.querySelector('iframe')).toBeNull()
    expect(surface.getSnapshot()!.actions!.find((item) => item.id === 'body-format')!.label).toBe('Show HTML')
    expect(formatEmailTimestamp(message.date, 'dd.mm.yyyy', '12h', 'en', true)).toBe('30.08.2026 · 11:00 AM')
  })

  it('toggles Flag directly and requires explicit modal confirmation before moving a message to Trash', async () => {
    const mock = setup(Promise.resolve(), { flags: ['\\Seen'] })
    const store = getStore()
    await store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX', message })
    mock.mail.applyMessageAction = vi.fn(async (input) => ({ ok: true, data: {
      action: input.action, folder: input.folder, messages: [{ ...message, flags: input.action === 'flag' ? ['\\Seen', '\\Flagged'] : ['\\Seen'] }]
    } }))
    const menu = vi.spyOn(mock.api.ui, 'openMenu')
    render(<Page navigation={{ setController: vi.fn() }} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Flag' })) })
    expect(screen.getByRole('button', { name: 'Unflag' })).toHaveAttribute('aria-pressed', 'true')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unflag' })) })
    expect(screen.getByRole('button', { name: 'Flag' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: 'Flag options' })).toBeNull()
    expect(menu).not.toHaveBeenCalled()
    vi.mocked(mock.mail.applyMessageAction).mockClear()
    let confirm!: (choice: string) => void
    mock.api.ui.confirm = vi.fn(() => new Promise<string | null>((resolve) => { confirm = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))
    expect(mock.api.ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Move message to Trash?', message: 'Canopy survey', actions: [
      { label: 'Cancel', value: 'cancel', variant: 'ghost' }, { label: 'Move to Trash', value: 'trash', variant: 'danger' }
    ] }))
    expect(mock.mail.applyMessageAction).not.toHaveBeenCalled()
    await act(async () => confirm('cancel'))
    expect(mock.mail.applyMessageAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))
    await act(async () => confirm('trash'))
    expect(mock.mail.applyMessageAction).toHaveBeenCalledTimes(1)
    expect(mock.mail.applyMessageAction).toHaveBeenCalledWith({ accountId: 'one', folder: 'INBOX', uid: 7, action: 'trash' })
    expect(store.getSnapshot().selectedMessage).toBeNull()
  })

  it('reloads incoming messages from every selected account while keeping the reader open', async () => {
    const mock = setup(Promise.resolve(), { flags: ['\\Seen'] })
    const store = getStore()
    await store.restoreSelection({ accountIds: [], view: 'folder', folder: 'INBOX', message })
    const incoming = { ...message, id: 'new-habitat', accountId: 'two', uid: 8, subject: 'New habitat observations' }
    let arrived = false
    let finish!: () => void
    mock.mail.syncFolder = vi.fn(async (id) => {
      if (id === 'one') await new Promise<void>((resolve) => { finish = resolve })
      if (id === 'two') arrived = true
      return { ok: true }
    })
    mock.mail.queryMessages = vi.fn(async () => ({ ok: true, data: { messages: arrived ? [incoming, message] : [message] } }))
    render(<MailboxControls />)
    const reload = screen.getByRole('button', { name: 'Reload' })
    fireEvent.click(reload)
    await waitFor(() => expect(mock.mail.syncFolder).toHaveBeenCalledWith('one', 'INBOX', 50))
    expect(reload).toBeDisabled()
    expect(reload).toHaveAttribute('aria-busy', 'true')
    expect(reload).toHaveAttribute('title', 'Checking for new mail…')
    await act(async () => finish())
    await waitFor(() => expect(reload).toBeEnabled())
    expect(mock.mail.syncFolder).toHaveBeenCalledWith('two', 'INBOX', 50)
    expect(store.getSnapshot().messages.map((item) => item.id)).toEqual(['new-habitat', 'canopy'])
    expect(store.getSnapshot().selectedMessage?.id).toBe('canopy')
    expect(reload).toHaveAttribute('aria-busy', 'false')
  })

  it('replies to all recipients once, excludes connected accounts, and preserves Cc and threading', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    mock.mail.parseAddresses = async (value) => ({ ok: true, data: { addresses: value.split(',').filter(Boolean).map((address) => ({ name: '', address: address.trim() })) } })
    const incoming = { ...message, accountId: 'two', replyTo: 'reply@example.com',
      to: 'two@example.com, field@example.com, REPLY@example.com, one@example.com', cc: 'field@example.com, habitat@example.com, TWO@example.com' }
    await store.startCompose('reply-all', incoming)
    expect(store.getSnapshot().compose).toMatchObject({ mode: 'reply-all', accountId: 'two', subject: 'Re: Canopy survey', inReplyTo: message.messageId,
      to: [{ address: 'reply@example.com' }, { address: 'field@example.com' }], cc: [{ address: 'habitat@example.com' }], bcc: [] })
    expect(store.getSnapshot().sending).toBe(false)
  })

  it('applies each account’s display preferences live to the reader and preview without leaking message overrides', async () => {
    const mock = setup()
    const rich = { ...message, html: '<h2>Forest canopy</h2><img src="https://example.com/fern.png">' }
    vi.mocked(mock.mail.readMessage).mockImplementation(async (ref) => ({ ok: true, data: { message: { ...rich, ...ref } } }))
    const store = getStore()
    await store.restoreSelection({ accountIds: [], view: 'recent', folder: 'INBOX', message })
    const { container } = render(<><Page navigation={{ setController: vi.fn() }} /><Preview /></>)
    expect(container.querySelectorAll('iframe')).toHaveLength(2)
    expect(container.querySelector('.email-reader')).toHaveClass('html')
    await act(async () => { await mock.api.settings.set(emailDisplaySettingsKey('one'), { htmlContent: false, remoteImages: false }) })
    expect(container.querySelectorAll('iframe')).toHaveLength(0)
    expect(screen.getAllByText(message.text!)).toHaveLength(2)
    expect(container.querySelector('.email-reader')).not.toHaveClass('html')
    await act(async () => { await mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension.getSnapshot()!.actions!.find((item) => item.id === 'body-format')!.onSelect!() })
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).not.toContain('https://example.com/fern.png')
    expect(mock.api.settings.get()[emailDisplaySettingsKey('one')]).toEqual({ htmlContent: false, remoteImages: false })
    await act(async () => { await mock.api.settings.set(emailDisplaySettingsKey('one'), { htmlContent: true, remoteImages: false }) })
    expect(container.querySelectorAll('iframe')).toHaveLength(2)
    expect(container.querySelector('.email-preview iframe')?.getAttribute('srcdoc')).not.toContain('https://example.com/fern.png')
    await act(async () => { await mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension.getSnapshot()!.actions!.find((item) => item.id === 'body-format')!.onSelect!() })
    await act(async () => { await store.restoreSelection({ accountIds: [], view: 'recent', folder: 'INBOX', message: { ...message, accountId: 'two' } }) })
    expect(container.querySelectorAll('iframe')).toHaveLength(2)
    for (const frame of container.querySelectorAll('iframe')) expect(frame.getAttribute('srcdoc')).toContain('https://example.com/fern.png')
  })

  it('restores the saved message after account loading without focusing or marking it read', async () => {
    let ready!: () => void
    const mock = setup(new Promise<void>((resolve) => { ready = resolve }))
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'main_workspace')!.extension
    const state = { accountIds: ['one'], view: 'folder', folder: 'INBOX', query: 'canopy', message: { accountId: 'one', folder: 'INBOX', uid: 7 } }
    const restored = surface.restore(state, undefined, { background: true })
    expect(mock.mail.readMessage).not.toHaveBeenCalled()
    ready()
    await restored
    expect(getStore().getSnapshot()).toMatchObject({ selectedMessage: { uid: 7 }, query: 'canopy', selectedAccountIds: ['one'] })
    expect(surface.getSnapshot()?.item?.state).toEqual(state)
    expect(mock.mail.applyMessageAction).not.toHaveBeenCalled()
    expect(mock.api.workspace.openMainTab).not.toHaveBeenCalled()
    vi.mocked(mock.mail.readMessage).mockResolvedValueOnce({ ok: true, data: { message: null } })
    await expect(surface.restore({ ...state, message: { ...state.message, uid: 99 } })).rejects.toThrow('no longer exists')
    expect(getStore().getSnapshot().selectedMessage?.uid).toBe(7)
    await getStore().startCompose()
    getStore().updateDraft({ text: 'Unsaved field report' })
    await surface.restore(state, undefined, { background: true })
    expect(getStore().getSnapshot().compose).toMatchObject({ text: 'Unsaved field report', dirty: true })
    expect(getStore().getSnapshot().composing).toBe(true)
  })

  it('keeps mailbox controls in the sidebar and the main header content-only', async () => {
    const mock = setup()
    const { container } = render(<><Panel /><Page navigation={{ setController: vi.fn() }} /></>)
    await screen.findByText('Canopy survey')
    expect(container.querySelectorAll('.email-message-list')).toHaveLength(1)
    expect(container.querySelector('.email-page .email-message-list')).toBeNull()
    expect(container.querySelector('.email-page .email-mailbox-controls')).toBeNull()
    expect(container.querySelector('.email-page .email-reveal-sidebar')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Mailboxes' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Mailboxes' }))
    render(<>{mock.popovers.at(-1)!.node}</>)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Unread' }))
    await waitFor(() => expect(container.querySelectorAll('.email-selector[title="Unread"]')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /Canopy survey/ }))
    await screen.findByText('The forest supports biodiversity.')
    expect(container.querySelector('.email-reader-header')).toBeTruthy()
    expect(container.querySelector('.email-reader-avatar .email-avatar-initials')?.textContent).toBe('C')
    expect(container.querySelector('.email-reader-location')).toBeNull()
    await waitFor(() => expect(mock.mail.applyMessageAction).toHaveBeenCalledWith({ accountId: 'one', folder: 'INBOX', uid: 7, action: 'mark-read' }))
    await waitFor(() => expect(container.querySelectorAll('.email-message-row')).toHaveLength(0))
    expect(screen.getByText('The forest supports biodiversity.')).toBeTruthy()
    await act(async () => getStore().selectView('flagged'))
    expect(screen.queryByText('The forest supports biodiversity.')).toBeNull()
  })

  it('presents an intentional empty reader state when no message is selected', async () => {
    setup()
    const { container } = render(<Page navigation={{ setController: vi.fn() }} />)
    await waitFor(() => expect(getStore().getSnapshot().selectedAccountId).toBe('one'))
    const placeholder = container.querySelector('.email-placeholder-content')
    expect(placeholder).toBeTruthy()
    expect(placeholder?.querySelector('.email-placeholder-icon')).toBeTruthy()
    expect(placeholder?.querySelector('.email-placeholder-title')?.tagName).toBe('P')
    expect(screen.getByRole('button', { name: 'Show message list' })).toHaveClass('email-placeholder-action')
    expect(screen.getByRole('button', { name: 'Show message list' })).not.toHaveClass('primary')
  })

  it('shows both selected accounts, narrows the list, and opens mail from either account', async () => {
    const mock = setup()
    const second = { ...message, id: 'moss', accountId: 'two', subject: 'Moss survey', text: 'Moss retains water.',
      from: 'two@example.com', addresses: { ...message.addresses, from: [{ name: '', address: 'two@example.com' }] } }
    const cached = new Set<string>()
    mock.mail.syncFolder = vi.fn(async (accountId) => { cached.add(accountId); return { ok: true } })
    mock.mail.queryMessages = vi.fn(async (input) => ({ ok: true, data: {
      messages: [message, second].filter((item) => cached.has(item.accountId) && (input.accountIds ?? [input.accountId]).includes(item.accountId))
    } }))
    mock.mail.readMessage = vi.fn(async (ref) => ({ ok: true, data: { message: ref.accountId === 'two' ? second : message } }))
    render(<><Panel /><Page navigation={{ setController: vi.fn() }} /></>)
    await screen.findByText('Canopy survey')
    await screen.findByText('Moss survey')
    expect(mock.mail.syncFolder).toHaveBeenCalledWith('one', 'INBOX', 50)
    expect(mock.mail.syncFolder).toHaveBeenCalledWith('two', 'INBOX', 50)
    expect(screen.getByRole('button', { name: /Moss survey/ }).textContent).toContain('reader')
    fireEvent.click(screen.getByRole('button', { name: 'Email account' }))
    render(<>{mock.popovers.at(-1)!.node}</>)
    expect(getStore().getSnapshot().selectedAccountIds).toEqual([])
    expect(screen.queryByRole('button', { name: 'Manage accounts' })).toBeNull()
    const one = screen.getByRole('button', { name: /one@example.com/ })
    const two = screen.getByRole('button', { name: /two/ })
    expect(one).toHaveAttribute('aria-pressed', 'true')
    expect(two).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Select all' })).toBeDisabled()
    fireEvent.click(one)
    await waitFor(() => expect(getStore().getSnapshot().selectedAccountIds).toEqual(['two']))
    await waitFor(() => expect(screen.queryByText('Canopy survey')).toBeNull())
    await screen.findByText('Moss survey')
    expect(two).toHaveClass('active', 'selection-run-start', 'selection-run-end')
    expect(two).toBeDisabled()
    fireEvent.click(one)
    await screen.findByText('Canopy survey')
    expect(one).toHaveAttribute('aria-pressed', 'true')
    expect(two).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(two)
    await waitFor(() => expect(screen.queryByText('Moss survey')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    await screen.findByText('Moss survey')
    expect(getStore().getSnapshot().selectedAccountIds).toEqual([])
    expect(two).toHaveClass('active')
    fireEvent.click(screen.getByRole('button', { name: /Moss survey/ }))
    await screen.findByText('Moss retains water.')
    expect(mock.mail.readMessage).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'two', folder: 'INBOX', uid: 7 }))
    fireEvent.click(screen.getByRole('button', { name: /Canopy survey/ }))
    await screen.findByText('The forest supports biodiversity.')
    expect(mock.mail.readMessage).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'one', folder: 'INBOX', uid: 7 }))
  })

  it('syncs the second account and preserves its mailboxes when the first account fails', async () => {
    const mock = setup()
    await getStore().whenReady
    const folders = mock.mail.listFolders
    mock.mail.listFolders = async (id) => id === 'one' ? { ok: false, error: 'Offline' } : folders(id)
    mock.mail.syncFolder = vi.fn(async (id) => id === 'one' ? { ok: false, error: 'Offline' } : { ok: true })
    mock.mail.queryMessages = vi.fn(async () => ({ ok: true, data: { messages: [{ ...message, accountId: 'two' }] } }))
    await getStore().sync()
    expect(mock.mail.syncFolder).toHaveBeenCalledWith('two', 'INBOX', 50)
    expect(getStore().getSnapshot()).toMatchObject({ syncing: false, messages: [{ accountId: 'two' }], error: 'one@example.com: Offline' })
    expect(getStore().getSnapshot().mailboxesByAccount.two).toHaveLength(3)
  })

  it('syncs the latest account selection after an in-flight sync finishes', async () => {
    const mock = setup()
    await getStore().whenReady
    let finish!: () => void
    mock.mail.syncFolder = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true })
    })).mockResolvedValue({ ok: true })
    render(<Panel />)
    await waitFor(() => expect(mock.mail.syncFolder).toHaveBeenCalledWith('one', 'INBOX', 50))
    await act(async () => getStore().selectAccount('two'))
    await act(async () => finish())
    await waitFor(() => expect(getStore().getSnapshot().syncing).toBe(false))
    expect(mock.mail.syncFolder).toHaveBeenCalledTimes(2)
    expect(mock.mail.syncFolder).toHaveBeenLastCalledWith('two', 'INBOX', 50)
    expect(mock.mail.queryMessages).toHaveBeenLastCalledWith(expect.objectContaining({ accountIds: ['two'] }))
  })

  it('ignores stale list and reader responses after changing accounts', async () => {
    const mock = setup()
    await waitFor(() => expect(getStore().getSnapshot().messages).toHaveLength(1))
    let resolveList!: (value: { ok: true; data: { messages: EmailMessageDetail[] } }) => void
    const delayed = new Promise<{ ok: true; data: { messages: EmailMessageDetail[] } }>((resolve) => { resolveList = resolve })
    mock.mail.queryMessages = vi.fn((input) => input.accountId === 'one' ? delayed : Promise.resolve({ ok: true, data: { messages: [] } }))
    let resolveDetail!: (value: { ok: true; data: { message: EmailMessageDetail } }) => void
    mock.mail.readMessage = () => new Promise((resolve) => { resolveDetail = resolve })
    getStore().openMessage(message)
    const previous = getStore().selectView('recent')
    await getStore().selectAccount('two')
    resolveList({ ok: true, data: { messages: [message] } }); resolveDetail({ ok: true, data: { message } })
    await previous
    expect(getStore().getSnapshot()).toMatchObject({ selectedAccountId: 'two', messages: [], selectedMessage: null })
  })

  it('preserves edited recipients, pending text, sender and body through navigation and failed sending', async () => {
    const mock = setup()
    await waitFor(() => expect(getStore().getSnapshot().selectedAccountId).toBe('one'))
    const store = getStore()
    await store.startCompose()
    store.updateDraft({ to: [{ name: 'Canopy', address: 'canopy@example.com' }], text: 'Biodiversity survey', pending: { to: '', cc: 'moss@', bcc: '' } })
    await store.saveDraft()
    expect(store.getSnapshot()).toMatchObject({ composing: false, compose: { text: 'Biodiversity survey' } })
    await store.startCompose()
    expect(store.getSnapshot().composing).toBe(true)
    await store.selectAccount('two')
    expect(store.getSnapshot().compose).toMatchObject({ accountId: 'one', text: 'Biodiversity survey', pending: { cc: 'moss@' } })
    expect(await store.send()).toBe(false)
    store.updateDraft({ pending: { to: '', cc: '', bcc: '' } })
    mock.mail.sendEmail = vi.fn(async () => ({ ok: false, error: 'SMTP unavailable' }))
    expect(await store.send()).toBe(false)
    expect(store.getSnapshot().compose?.text).toBe('Biodiversity survey')
    expect(store.getSnapshot().error).toBe('SMTP unavailable')
    mock.api.ui.confirm = vi.fn(async () => 'cancel')
    await store.cancelCompose()
    expect(store.getSnapshot().compose).not.toBeNull()
    expect(mock.api.ui.confirm).toHaveBeenCalled()
  })

  it.each([true, false])('joins an accepted send on disposal and restores only unsent drafts (sent=%s)', async (sent) => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    await store.startCompose()
    store.updateDraft({ to: [{ name: '', address: 'canopy@example.com' }], text: 'Unsent field report' })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mock.mail.sendEmail = vi.fn(async () => { await held; return sent ? { ok: true } : { ok: false, error: 'SMTP unavailable' } })
    const sending = store.send()
    await waitFor(() => expect(mock.mail.sendEmail).toHaveBeenCalledTimes(1))
    vi.mocked(mock.mail.queryMessages).mockClear()
    vi.mocked(mock.api.workspace.setMainTabTitle).mockClear()
    const draining = disposeStore(mock.api)
    expect(store.dispose()).toBe(draining)
    expect(getStore(mock.api)).toBe(store)
    let complete = false
    void draining.then(() => { complete = true })
    await Promise.resolve()
    expect(complete).toBe(false)
    expect(await store.send()).toBe(false)
    release()
    expect(await sending).toBe(sent)
    await draining
    expect(mock.mail.queryMessages).not.toHaveBeenCalled()
    expect(mock.api.workspace.setMainTabTitle).not.toHaveBeenCalled()
    const replacement = getStore(mock.api)
    await replacement.whenReady
    expect(replacement).not.toBe(store)
    expect(replacement.getSnapshot().compose?.text ?? null).toBe(sent ? null : 'Unsent field report')
    expect(mock.mail.sendEmail).toHaveBeenCalledTimes(1)
  })

  it('invalidates an unresolved discard dialog without waiting for user input on disposal', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    await store.startCompose()
    store.updateDraft({ text: 'Keep the draft' })
    let answer!: (choice: string) => void
    mock.api.ui.confirm = vi.fn(() => new Promise<string>((resolve) => { answer = resolve }))
    const cancelling = store.cancelCompose()
    expect(mock.api.ui.confirm).toHaveBeenCalledTimes(1)
    await disposeStore(mock.api)
    await cancelling
    const replacement = getStore(mock.api)
    await replacement.whenReady
    replacement.updateDraft({ text: 'New owner continues the draft' })
    vi.mocked(mock.api.workspace.setMainTabTitle).mockClear()
    answer('discard')
    await Promise.resolve()
    expect(replacement.getSnapshot().compose?.text).toBe('New owner continues the draft')
    expect(mock.api.workspace.setMainTabTitle).not.toHaveBeenCalled()
  })

  it('retains edits made while an older discard dialog is pending', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    await store.startCompose()
    store.updateDraft({ text: 'Initial draft' })
    let answer!: (choice: string) => void
    mock.api.ui.confirm = vi.fn(() => new Promise<string>((resolve) => { answer = resolve }))
    const cancelling = store.cancelCompose()
    store.updateDraft({ text: 'Newer edits' })
    answer('discard')
    await cancelling
    expect(store.getSnapshot().compose?.text).toBe('Newer edits')
  })

  it('drains accepted reply parsing and stops subsequent recipient reads after disposal', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mock.mail.parseAddresses = vi.fn(async () => { await held; return { ok: true, data: { addresses: [] } } })
    const starting = store.startCompose('reply-all', message)
    await waitFor(() => expect(mock.mail.parseAddresses).toHaveBeenCalledTimes(1))
    let complete = false
    const draining = disposeStore(mock.api)
    void draining.then(() => { complete = true })
    await Promise.resolve()
    expect(complete).toBe(false)
    release()
    await Promise.all([starting, draining])
    expect(mock.mail.parseAddresses).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().compose).toBeNull()
  })

  it('does not replace a newer compose request when an older reply parse finishes', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    mock.mail.parseAddresses = vi.fn(async () => { await held; return { ok: true, data: { addresses: [] } } })
    const starting = store.startCompose('reply-all', message)
    await waitFor(() => expect(mock.mail.parseAddresses).toHaveBeenCalledTimes(1))
    await store.startCompose('forward', { ...message, subject: 'Newer message' })
    release()
    await starting
    expect(mock.mail.parseAddresses).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().compose).toMatchObject({ mode: 'forward', subject: 'Fwd: Newer message' })
  })

  it('reports failed reply parsing while leaving the current draft intact', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    await store.startCompose()
    store.updateDraft({ text: 'Existing draft' })
    mock.api.ui.confirm = vi.fn(async () => 'discard')
    mock.mail.parseAddresses = vi.fn(async () => { throw new Error('Address parsing unavailable') })
    await store.startCompose('reply-all', message)
    expect(store.getSnapshot()).toMatchObject({ error: 'Address parsing unavailable', compose: { text: 'Existing draft' } })
  })

  it.each(['accounts', 'folders', 'list', 'reader', 'action', 'restore', 'remove'] as const)('drains accepted %s work and rejects further dispatch from a disposed store', async (scenario) => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const calls = vi.spyOn(mock.api.backend, 'call')
    let work: Promise<unknown> | undefined
    if (scenario === 'accounts') {
      const original = mock.mail.listAccounts
      mock.mail.listAccounts = async () => { await held; return original() }
      work = store.refreshAccounts()
    } else if (scenario === 'folders') {
      const original = mock.mail.listFolders
      mock.mail.listFolders = async (accountId) => { await held; return original(accountId) }
      work = store.selectAccount('two')
    } else if (scenario === 'list') {
      const original = mock.mail.queryMessages
      mock.mail.queryMessages = async (input) => { await held; return original(input) }
      work = store.selectView('recent')
    } else if (scenario === 'reader' || scenario === 'restore') {
      const original = mock.mail.readMessage
      mock.mail.readMessage = async (input) => { await held; return original(input) }
      if (scenario === 'reader') store.openMessage(message)
      else work = store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX', message })
    } else if (scenario === 'action') {
      const original = mock.mail.applyMessageAction
      mock.mail.applyMessageAction = async (input) => { await held; return original(input) }
      work = store.act(message, 'trash')
    } else {
      const original = mock.mail.removeAccount
      mock.mail.removeAccount = async (accountId) => { await held; return original(accountId) }
      work = store.removeAccount('one')
    }
    await waitFor(() => expect(calls).toHaveBeenCalled())
    const acceptedCalls = calls.mock.calls.length
    const publish = vi.fn()
    store.subscribe(publish)
    vi.mocked(mock.api.workspace.setMainTabTitle).mockClear()
    let complete = false
    const draining = disposeStore(mock.api)
    void draining.then(() => { complete = true })
    await Promise.resolve()
    expect(complete).toBe(false)
    store.openMessage(message)
    store.setQuery('late query')
    await Promise.all([store.selectAccount('one'), store.selectFolder('Archive'), store.refreshAccounts(), store.removeAccount('one'), store.act(message, 'flag')])
    expect(calls).toHaveBeenCalledTimes(acceptedCalls)
    release()
    await Promise.all([work, draining])
    expect(calls).toHaveBeenCalledTimes(acceptedCalls)
    expect(publish).not.toHaveBeenCalled()
    expect(mock.api.workspace.setMainTabTitle).not.toHaveBeenCalled()
  })

  it('keeps the reader and rows unchanged when a folder-qualified action fails', async () => {
    const mock = setup()
    await waitFor(() => expect(getStore().getSnapshot().messages).toHaveLength(1))
    mock.mail.readMessage = async () => ({ ok: true, data: { message: { ...message, flags: ['\\Seen'] } } })
    getStore().openMessage(message)
    await waitFor(() => expect(getStore().getSnapshot().loadingMessage).toBe(false))
    mock.mail.applyMessageAction = vi.fn(async () => ({ ok: false, error: 'Offline' }))
    expect(await getStore().act({ accountId: 'one', folder: 'Archive', uid: 7 }, 'trash')).toBe(false)
    expect(mock.mail.applyMessageAction).toHaveBeenCalledWith({ accountId: 'one', folder: 'Archive', uid: 7, action: 'trash' })
    expect(getStore().getSnapshot()).toMatchObject({ selectedMessage: { folder: 'INBOX', uid: 7 }, error: 'Offline', actionUid: null })
    expect(getStore().getSnapshot().messages).toHaveLength(1)
  })

  it('matches contacts live, falls back after unload, and supports keyboard recipient suggestions', async () => {
    const mock = setup()
    let name = 'Canopy Research'
    const off = mock.provideInterop(CONTACTS_DIRECTORY_V1, {
      search: async () => [{ id: 'canopy-contact', displayName: name, avatarUrl: 'contacts://canopy-avatar', emails: [{ address: 'canopy@example.com' }, { address: 'canopy+field@example.com', label: 'Field' }] }],
      resolveEmails: async (addresses) => addresses.map((address) => ({ address, contacts: address === 'canopy@example.com' ? [{ id: 'canopy-contact', displayName: name, avatarUrl: 'contacts://canopy-avatar', emails: [{ address }] }] : [] })),
      open: async () => {}
    }, 'contacts')
    render(<><Panel /><Page navigation={{ setController: vi.fn() }} /></>)
    await screen.findByText('Canopy Research')
    expect(document.querySelector('.email-message-avatar img')?.getAttribute('src')).toBe('contacts://canopy-avatar')
    name = 'Canopy Observatory'
    act(() => mock.api.interop.state.publish(CONTACTS_DIRECTORY_REVISION_V1, 1))
    await screen.findByText('Canopy Observatory')
    await act(async () => getStore().startCompose())
    fireEvent.click(screen.getByRole('button', { name: 'Add recipient To' }))
    render(<>{mock.popovers.at(-1)!.node}</>)
    const input = screen.getByRole('combobox', { name: 'Name or email address' })
    expect(input).toHaveClass('search-field-input')
    expect(input.parentElement).toHaveClass('search-field')
    fireEvent.change(input, { target: { value: 'Canopy' } })
    await screen.findAllByRole('option', { name: /Canopy Observatory/ })
    fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'Enter' })
    expect(getStore().getSnapshot().compose?.to).toEqual([{ name: 'Canopy Observatory', address: 'canopy+field@example.com' }])
    act(() => off())
    await waitFor(() => expect(getStore().getSnapshot().contacts).toEqual({}))
    expect(document.querySelector('.email-message-avatar .email-avatar-initials')?.textContent).toBe('C')
  })

  it('keeps hidden swipe actions out of focus, closes the previous row, and preserves vertical wheel scrolling', async () => {
    const mock = setup()
    mock.mail.queryMessages = async () => ({ ok: true, data: { messages: [message, { ...message, id: 'moss', uid: 8, subject: 'Moss survey' }] } })
    const { container } = render(<Panel />)
    await screen.findByText('Moss survey')
    const rows = container.querySelectorAll<HTMLElement>('.email-swipe-row')
    expect(rows[0].dataset.side).toBe('closed')
    expect(rows[0].querySelector('.email-swipe-tray button')?.getAttribute('tabindex')).toBe('-1')
    fireEvent.wheel(rows[0], { deltaX: 90, deltaY: 0 })
    expect(rows[0].dataset.side).toBe('trailing')
    expect([...rows[0].querySelectorAll('.email-swipe-tray.trailing button')].map((button) => button.className)).toEqual([
      'email-swipe-flag', 'danger'
    ])
    fireEvent.wheel(rows[1], { deltaX: -90, deltaY: 0 })
    expect(rows[0].dataset.side).toBe('closed')
    expect(rows[1].dataset.side).toBe('leading')
    expect([...rows[1].querySelectorAll('.email-swipe-tray.leading button')].map((button) => button.className)).toEqual([
      'email-swipe-read', 'email-swipe-archive'
    ])
    const scroll = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true })
    rows[1].dispatchEvent(scroll)
    expect(scroll.defaultPrevented).toBe(false)
    fireEvent.keyDown(rows[1].querySelector('.email-swipe-content')!, { key: 'Escape' })
    expect(rows[1].dataset.side).toBe('closed')
    const content = rows[0].querySelector('.email-swipe-content')!
    fireEvent(content, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 120, clientY: 30 }))
    fireEvent(content, new MouseEvent('pointermove', { bubbles: true, clientX: 200, clientY: 30 }))
    fireEvent(content, new MouseEvent('pointercancel', { bubbles: true }))
    expect(rows[0].dataset.side).toBe('closed')
    fireEvent.click(content)
    await waitFor(() => expect(mock.mail.readMessage).toHaveBeenCalled())
  })
})
