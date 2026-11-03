import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTACTS_DIRECTORY_V1, CONTACTS_DIRECTORY_REVISION_V1, METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1, SEARCH_RESULT_ACTION_V1 } from '@valley/plugin-sdk'
import type { EmailMessageDetail } from '../src/mailTypes'
import { createMailMock as createMockValleyApi } from './mailMock'
import { register } from '../src/index'
import { MailboxControls, Panel } from '../src/Panel'
import { Page } from '../src/Page'
import { Preview } from '../src/Preview'
import { emailDisplaySettingsKey } from '../src/hooks'
import { disposeStore, formatEmailTimestamp, getStore } from '../src/store'
import { emailDocument, MessageBody } from '../src/MessageBody'
import { Person } from '../src/People'

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
  it('does not claim a search result was opened when its message is unavailable', async () => {
    const mock = setup()
    await getStore().whenReady
    await mock.api.data.dataset('folder_messages').insert({ accountId: 'one', messageId: message.id, folder: 'INBOX', uid: 7, flags: [] })
    mock.mail.readMessage = vi.fn(async () => ({ ok: true, data: { message: null } }))
    const open = vi.spyOn(mock.api.workspace, 'openMainTab')
    const card = mock.api.interop.extensions.providers(SEARCH_RESULT_ACTION_V1)[0].extension
    await expect(card.open({ id: message.id, accountId: 'one' }, {})).rejects.toThrow('The email message no longer exists.')
    expect(open).not.toHaveBeenCalled()
  })

  it('opens a content-search result in its owning account and prefers its Inbox membership', async () => {
    const mock = setup()
    await getStore().whenReady
    await mock.api.data.dataset('folder_messages').insert([
      { accountId: 'one', messageId: message.id, folder: 'Archive', uid: 90, flags: [] },
      { accountId: 'one', messageId: message.id, folder: 'INBOX', uid: 7, flags: [] },
      { accountId: 'two', messageId: message.id, folder: 'INBOX', uid: 8, flags: [] }
    ])
    await getStore().selectAccount('two')
    const card = mock.api.interop.extensions.providers(SEARCH_RESULT_ACTION_V1)[0].extension
    const open = vi.spyOn(mock.api.workspace, 'openMainTab')
    expect(card).not.toHaveProperty('render')
    expect(await card.open({ id: message.id, accountId: 'one' }, { newTab: true })).toBe(true)
    expect(mock.mail.readMessage).toHaveBeenLastCalledWith({ accountId: 'one', folder: 'INBOX', uid: 7 })
    expect(open).toHaveBeenCalledWith({ instanceId: expect.stringMatching(/^mail-/), newTab: true, title: message.subject })
    expect(getStore().getSnapshot().selectedAccountIds).toEqual(['two'])
    mock.emitState({ activePluginTab: { pluginId: 'email', instanceId: open.mock.calls[0][0]!.instanceId } })
    await waitFor(() => expect(getStore().getSnapshot()).toMatchObject({ selectedAccountIds: ['one'], selectedFolder: 'INBOX', selectedUid: 7, selectedMessage: { id: message.id } }))
    await dispose?.()
    dispose = undefined
    expect(mock.api.interop.extensions.providers(SEARCH_RESULT_ACTION_V1)).toEqual([])
  })

  it('resolves moved search results from current folder membership and ignores stale results', async () => {
    const mock = setup(Promise.resolve(), { folder: 'Archive', uid: 90 })
    await getStore().whenReady
    await mock.api.data.dataset('folder_messages').insert({ accountId: 'one', messageId: message.id, folder: 'Archive', uid: 90, flags: [] })
    const card = mock.api.interop.extensions.providers(SEARCH_RESULT_ACTION_V1)[0].extension
    const open = vi.spyOn(mock.api.workspace, 'openMainTab')
    expect(await card.open({ id: message.id, accountId: 'one' }, {})).toBe(true)
    expect(mock.mail.readMessage).toHaveBeenLastCalledWith({ accountId: 'one', folder: 'Archive', uid: 90 })
    expect(getStore().getSnapshot()).toMatchObject({ selectedFolder: 'Archive', selectedUid: 90 })
    open.mockClear()
    expect(await card.open({ id: 'missing', accountId: 'one' }, {})).toBe(false)
    expect(await card.open({ id: message.id }, {})).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('shows the shared loader until the selected message body is ready', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    mock.mail.readMessage = vi.fn(async () => { await pending; return { ok: true, data: { message } } })
    act(() => store.openMessage(message))
    render(<Page navigation={{ setController: vi.fn() }} />)
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument()
    expect(screen.queryByText(message.text!)).not.toBeInTheDocument()
    await act(async () => { release() })
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByText(message.text!)).toBeInTheDocument()
  })

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
    await expect(store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'Projects' })).rejects.toThrow('Could not load the saved mailbox')
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

  it('shows sender names without quotes and the translated mailbox name in an embedded list', async () => {
    const mock = setup(Promise.resolve(), { from: '"Canopy Team" <canopy@example.com>', addresses: { ...message.addresses, from: [{ name: 'Canopy Team', address: 'canopy@example.com' }] } })
    const store = getStore()
    await store.whenReady
    await waitFor(() => expect(store.getSnapshot().mailboxes.length).toBeGreaterThan(0))
    const element = document.createElement('div')
    document.body.append(element)
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(element)
    vi.spyOn(mock.api.ui, 'renderReact').mockImplementation((_target, node) => { root.render(node as React.ReactElement); return () => {} })
    act(() => { mock.codeBlockRenderers.get('email')?.('limit: 5', element, { path: null, meta: null }) })
    await waitFor(() => expect(element.querySelector('.email-fence-row .from')?.textContent).toBe('Canopy Team'))
    expect(element.querySelector('.email-fence-head .t')?.textContent).toBe('Email · Inbox')
    act(() => root.unmount())
    element.remove()
  })

  it('retries the failed sync from Try again and clears the notice once it succeeds', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    let fail = true
    mock.mail.syncFolder = vi.fn(async () => fail ? { ok: false, error: 'Connection refused' } : { ok: true })
    await store.sync()
    render(<Page navigation={{ setController: vi.fn() }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('one@example.com: Connection refused')
    const calls = vi.mocked(mock.mail.syncFolder).mock.calls.length
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(vi.mocked(mock.mail.syncFolder).mock.calls.length).toBeGreaterThan(calls))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('clears a sync notice when a later sync of every failed folder succeeds, but keeps other errors', async () => {
    let onSync!: Parameters<ReturnType<typeof createMockValleyApi>['mail']['onSync']>[0]
    const mock = setup(Promise.resolve(), {}, (mock) => {
      mock.mail.onSync = (listener) => { onSync = listener; return () => {} }
    })
    const store = getStore()
    await store.whenReady
    mock.mail.syncFolder = vi.fn(async (accountId) => accountId === 'one' ? { ok: false, error: 'Connection refused' } : { ok: true })
    await store.sync()
    expect(store.getSnapshot().error).toBe('one@example.com: Connection refused')
    act(() => onSync({ accountId: 'two', folder: 'INBOX', status: 'done', fetched: 0, total: 0 }))
    expect(store.getSnapshot().error).toBe('one@example.com: Connection refused')
    act(() => onSync({ accountId: 'one', folder: 'Archive', status: 'done', fetched: 0, total: 0 }))
    expect(store.getSnapshot().error).toBe('one@example.com: Connection refused')
    act(() => onSync({ accountId: 'one', folder: 'INBOX', status: 'done', fetched: 0, total: 0 }))
    expect(store.getSnapshot().error).toBeNull()
    mock.mail.applyMessageAction = vi.fn(async () => ({ ok: false, error: 'Mailbox is read-only' }))
    await store.act(message, 'flag')
    expect(store.getSnapshot().error).toContain('Mailbox is read-only')
    act(() => onSync({ accountId: 'one', folder: 'INBOX', status: 'done', fetched: 0, total: 0 }))
    expect(store.getSnapshot().error).toContain('Mailbox is read-only')
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
    expect(container.querySelector('.email-reader-identity')?.textContent).not.toContain('INBOX')
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
    expect(doc.querySelector('a[data-content-href]')?.getAttribute('data-content-href')).toBe('https://example.com/survey')
    expect(safe.blockedImages).toBe(true)
    const { container, rerender } = render(<MessageBody message={{ ...message, html }} remoteImages={false} />)
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain('img-src data:;')
    expect(screen.getByText('Remote images are blocked.')).toBeInTheDocument()
    rerender(<MessageBody message={{ ...message, html }} plain />)
    expect(screen.getByText(message.text!)).toBeTruthy()
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
    expect(screen.getByRole('button', { name: 'Mailboxes' })).toHaveAttribute('aria-expanded', 'true')
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

  it('reports one sync error line per account when every folder fails the same way', async () => {
    const mock = setup()
    await getStore().whenReady
    const blocked = 'Plugin network access is disabled in VALLEY_TEST_MODE'
    mock.mail.syncFolder = vi.fn(async () => ({ ok: false, error: blocked }))
    await getStore().selectView('recent')
    await getStore().sync()
    expect(mock.mail.syncFolder).toHaveBeenCalledWith('one', 'Archive', 50)
    expect(getStore().getSnapshot().error).toBe(`one@example.com: ${blocked}\ntwo@example.com: ${blocked}`)
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
    expect(store.getSnapshot().error).toBe('SMTP unavailable. Sending may have completed. Check Sent before intentionally sending this draft again.')
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
    // The draft (this account has no Drafts mailbox) is the Inbox's first entry; the message row below it falls back to initials.
    expect(document.querySelector('.email-swipe-row:not(.email-draft-entry) .email-message-avatar .email-avatar-initials')?.textContent).toBe('C')
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


it('reads a cached message with one direct request and drops a superseded read', async () => {
  const mock = setup()
  const store = getStore()
  await store.whenReady
  const operations = vi.spyOn(mock.api.backend, 'callOperation')
  const calls = vi.spyOn(mock.api.backend, 'call')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const original = mock.mail.readMessage
  mock.mail.readMessage = async input => { if (input.uid === message.uid) await held; return original(input) }
  store.openMessage(message)
  await waitFor(() => expect(calls).toHaveBeenCalledWith('readMessage', expect.objectContaining({ uid: message.uid })))
  expect(operations.mock.calls.filter(([method]) => method === 'readMessage')).toEqual([])
  store.openMessage(null)
  release()
  await held
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(store.getSnapshot()).toMatchObject({ selectedMessage: null, selectedUid: null })
})

it('closes an email:compose draft through the public close-compose inverse without discarding edits', async () => {
  const mock = setup()
  const store = getStore()
  await store.whenReady
  const confirm = vi.spyOn(mock.api.ui, 'confirm')
  const command = (id: string) => mock.api.commands.list().find((entry) => entry.id === `email:${id}`)
  expect([command('compose')?.sideEffect, command('close-compose')?.sideEffect]).toEqual(['write', 'execute'])
  expect(store.getSnapshot()).toMatchObject({ compose: null, composing: false })
  expect(await mock.api.commands.executeOwn('compose')).toEqual({ ok: true, value: null })
  expect(store.getSnapshot()).toMatchObject({ composing: true, compose: { mode: 'new', dirty: false, accountId: 'one' } })
  expect(await mock.api.commands.executeOwn('close-compose')).toEqual({ ok: true, value: { discarded: true } })
  expect(store.getSnapshot()).toMatchObject({ compose: null, composing: false })
  expect((await mock.api.data.dataset('drafts').read({ id: 'compose' })).value).toBeNull()
  await expect(store.closeCompose()).rejects.toMatchObject({ code: 'COMPOSE_NOT_OPEN', outcome: 'not-applied' })
  expect(await mock.api.commands.executeOwn('close-compose')).toMatchObject({ ok: false })

  expect(await mock.api.commands.executeOwn('compose')).toMatchObject({ ok: true })
  store.updateDraft({ text: 'Canopy field notes' })
  await store.flushDraft()
  const saved = await mock.api.data.dataset('drafts').read({ id: 'compose' })
  expect(await mock.api.commands.executeOwn('close-compose')).toEqual({ ok: true, value: { discarded: false } })
  expect(store.getSnapshot()).toMatchObject({ composing: false, compose: { text: 'Canopy field notes', dirty: true } })
  expect(await mock.api.data.dataset('drafts').read({ id: 'compose' })).toEqual(saved)
  expect(await mock.api.commands.executeOwn('compose')).toMatchObject({ ok: true })
  expect(store.getSnapshot()).toMatchObject({ composing: true, compose: { text: 'Canopy field notes' } })
  expect(confirm).not.toHaveBeenCalled()
})

it('undoes email:compose to the exact compose, composing and error fields it replaced', async () => {
  const mock = setup()
  const store = getStore()
  await store.whenReady
  const main = () => { const snapshot = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find(({ extension }) => extension.surface === 'main_workspace')!.extension.getSnapshot() as unknown as Record<string, unknown>; return { composing: snapshot.composing, error: snapshot.error } }
  mock.mail.applyMessageAction = vi.fn(async () => ({ ok: false, error: 'Mail server unavailable' }))
  await store.act(message, 'flag')
  const before = { compose: store.getSnapshot().compose, composing: store.getSnapshot().composing, error: store.getSnapshot().error }
  expect(before.error).toEqual(expect.any(String))
  const baseline = main()
  expect(baseline).toEqual({ composing: before.composing, error: before.error })
  expect(await mock.api.commands.executeOwn('compose')).toEqual({ ok: true, value: null })
  expect(store.getSnapshot()).toMatchObject({ composing: true, compose: { mode: 'new' }, error: null })
  expect(mock.busUndo).toHaveLength(1)
  await mock.busUndo[0].undo()
  expect({ compose: store.getSnapshot().compose, composing: store.getSnapshot().composing, error: store.getSnapshot().error }).toEqual(before)
  expect(main()).toEqual(baseline)
  expect((await mock.api.data.dataset('drafts').read({ id: 'compose' })).value).toBeNull()

  expect(await mock.api.commands.executeOwn('compose')).toMatchObject({ ok: true })
  store.updateDraft({ text: 'Typed after compose' })
  await store.flushDraft()
  expect((await mock.api.data.dataset('drafts').read({ id: 'compose' })).value).not.toBeNull()
  await mock.busUndo[1].undo()
  expect(store.getSnapshot()).toMatchObject({ compose: null, composing: false })
  expect((await mock.api.data.dataset('drafts').read({ id: 'compose' })).value).toBeNull()

  expect(await mock.api.commands.executeOwn('compose')).toMatchObject({ ok: true })
  await store.cancelCompose()
  expect(await mock.api.commands.executeOwn('compose')).toMatchObject({ ok: true })
  await expect(mock.busUndo[2].undo()).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
  expect(store.getSnapshot().composing).toBe(true)
})

it('undoes email:open-selection to the exact previous selection and navigation history', async () => {
  const mock = setup()
  const store = getStore()
  await store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'Archive' })
  await store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX', message: { accountId: 'one', folder: 'INBOX', uid: 7 } })
  expect(await store.goBack()).toBe(true)
  const surface = () => { const { navigation, actions: _actions, bookmark: _bookmark, bookmarkView: _view, ...rest } = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find(({ extension }) => extension.surface === 'main_workspace')!.extension.getSnapshot() as unknown as Record<string, any>; return { ...rest, canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward } }
  const before = surface()
  expect(before).toMatchObject({ view: { folder: 'Archive' }, canGoForward: true })
  expect(mock.api.commands.list().find((entry) => entry.id === 'email:open-selection')?.sideEffect).toBe('write')
  expect(await mock.api.commands.executeOwn('open-selection', { accountIds: ['two'], view: 'unread', folder: 'INBOX' })).toMatchObject({ ok: true, value: { accountIds: ['two'], view: 'unread' } })
  expect(surface()).toMatchObject({ view: { accountIds: ['two'], view: 'unread' }, canGoForward: false })
  await mock.busUndo[0].undo()
  expect(surface()).toEqual(before)
  expect(await store.goForward()).toBe(true)
  expect(store.getSnapshot()).toMatchObject({ selectedFolder: 'INBOX', selectedUid: 7 })
})

it('refuses email:compose as not applied when no account can send', async () => {
  const mock = setup()
  mock.mail.listAccounts = async () => ({ ok: true, data: { accounts: [] } })
  await getStore().refreshAccounts()
  expect(getStore().getSnapshot().selectedAccountId).toBeNull()
  const run = vi.spyOn(mock.api.workspace, 'openMainTab')
  expect(await mock.api.commands.executeOwn('compose')).toMatchObject({ ok: false, error: { message: 'No email account is available for composing.' } })
  expect(getStore().getSnapshot()).toMatchObject({ compose: null, composing: false })
  expect(run).not.toHaveBeenCalled()
})

it('undoes an update-properties flag edit exactly through its registered revert', async () => {
  let flags: string[] = ['\\Flagged']
  const mock = setup(Promise.resolve(), {}, (configured) => {
    configured.mail.readMessage = vi.fn(async () => ({ ok: true, data: { message: { ...message, flags: [...flags] } } }))
    configured.mail.applyMessageAction = vi.fn(async (input) => {
      const flag = input.action === 'flag' || input.action === 'unflag' ? '\\Flagged' : '\\Seen'
      flags = input.action === 'mark-read' || input.action === 'flag' ? [...new Set([...flags, flag])].sort() : flags.filter((entry) => entry !== flag)
      return { ok: true, data: { action: input.action, folder: input.folder, messages: [{ ...message, flags: [...flags] }] } }
    })
  })
  const store = getStore()
  await store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX', message: { accountId: 'one', folder: 'INBOX', uid: 7 } })
  const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension.getSnapshot()!
  const subject = { pluginId: 'email', surface: 'main_workspace' as const, view: surface.view, item: surface.item }
  vi.mocked(mock.mail.applyMessageAction).mockClear()
  expect(await mock.api.commands.executeOwn('update-properties', { subject, values: { read: true, flagged: true } })).toMatchObject({ ok: true })
  expect(flags).toEqual(['\\Flagged', '\\Seen'])
  expect(mock.busUndo).toHaveLength(1)
  await mock.busUndo[0].undo()
  expect(flags).toEqual(['\\Flagged'])
  expect(vi.mocked(mock.mail.applyMessageAction).mock.calls.map(([input]) => input.action)).toEqual(['mark-read', 'flag', 'mark-unread'])
  await mock.busUndo[0].redo!()
  expect(flags).toEqual(['\\Flagged', '\\Seen'])
  flags = []
  await expect(mock.busUndo[0].undo()).rejects.toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
  expect(vi.mocked(mock.mail.applyMessageAction)).toHaveBeenCalledTimes(4)
})

it('opens a cached Inbox message while the server folder list is still loading', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const mock = setup(Promise.resolve(), {}, (mock) => {
    mock.mail.listFolders = vi.fn(async () => { await held; return { ok: true, data: { folders: ['INBOX'], mailboxes: [] } } })
  })
  const within = <T,>(promise: Promise<T>): Promise<T> => Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('waited for the server folder list')), 1000))])
  const store = getStore()
  await within(store.whenReady)
  expect(await within(store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX', message: { accountId: 'one', folder: 'INBOX', uid: 7 } }))).toBe(true)
  expect(store.getSnapshot()).toMatchObject({ selectedUid: 7, selectedMessage: { id: 'canopy' }, loadingMessage: false })
  expect(mock.mail.listFolders).toHaveBeenCalled()
  release()
})

it('syncs a folder on open only when it was not synced within the last minute', async () => {
  let onSync!: Parameters<ReturnType<typeof createMockValleyApi>['mail']['onSync']>[0]
  const mock = setup(Promise.resolve(), {}, (mock) => {
    mock.mail.onSync = (listener) => { onSync = listener; return () => {} }
    mock.mail.syncFolder = vi.fn(async () => ({ ok: true }))
  })
  const store = getStore()
  await store.whenReady
  let now = 1_000_000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    await store.syncIfStale()
    const perPass = vi.mocked(mock.mail.syncFolder).mock.calls.length
    expect(perPass).toBe(2)
    now += 30_000
    await store.syncIfStale()
    expect(mock.mail.syncFolder).toHaveBeenCalledTimes(perPass)
    await store.sync()
    expect(mock.mail.syncFolder).toHaveBeenCalledTimes(2 * perPass)
    now += 61_000
    await store.syncIfStale()
    expect(mock.mail.syncFolder).toHaveBeenCalledTimes(3 * perPass)
    now += 61_000
    onSync({ accountId: 'one', folder: 'INBOX', status: 'done', fetched: 0, total: 1 })
    onSync({ accountId: 'two', folder: 'INBOX', status: 'done', fetched: 0, total: 0 })
    await store.syncIfStale()
    expect(mock.mail.syncFolder).toHaveBeenCalledTimes(3 * perPass)
  } finally { clock.mockRestore() }
})

it('loads a deferred body when a selection opens a message (open-selection, history, search results)', async () => {
  const text = 'Schilfrohrsänger äöüß '.repeat(60_000)
  const mock = setup(undefined, { text: undefined, bodyDeferred: true })
  mock.mail.loadMessageContent = vi.fn(async (input) => ({ ok: true, data: { field: input.field, offset: input.offset, total: input.field === 'text' ? text.length : 0, chunk: input.field === 'text' ? text.slice(input.offset, input.offset + 1024 * 1024) : '' } }))
  const store = getStore()
  await store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX', message: { accountId: 'one', folder: 'INBOX', uid: 7 } })
  expect(store.getSnapshot().selectedMessage).toMatchObject({ uid: 7, text: text.slice(0, 512 * 1024), bodyDeferred: false, bodyTruncated: { shown: 512 * 1024, total: text.length } })
  expect(vi.mocked(mock.mail.loadMessageContent).mock.calls.filter(([input]) => input.field === 'text').map(([input]) => input.offset)).toEqual([0, 1024 * 1024])
})

describe('Email message actions', () => {
  const held = () => { let release!: (value: Awaited<ReturnType<ReturnType<typeof createMockValleyApi>['mail']['applyMessageAction']>>) => void; const promise = new Promise<Awaited<ReturnType<ReturnType<typeof createMockValleyApi>['mail']['applyMessageAction']>>>((resolve) => { release = resolve }); return { promise, release } }
  const listed = () => getStore().getSnapshot().messages.find((entry) => entry.uid === 7)!

  it('removes the unread mark on the first open at once, also while another action is in flight', async () => {
    const mock = setup()
    const store = getStore()
    await store.whenReady
    await act(async () => { await store.selectAccount('one') })
    await waitFor(() => expect(listed()).toBeDefined())
    const flag = held(), read = held()
    vi.mocked(mock.mail.applyMessageAction).mockImplementationOnce(() => flag.promise).mockImplementationOnce(() => read.promise)
    let flagged!: Promise<boolean>
    act(() => { flagged = store.act(message, 'flag') })
    expect(listed().flags).toContain('\\Flagged')
    act(() => store.openMessage(message))
    expect(listed().flags).toContain('\\Seen')
    expect(mock.mail.applyMessageAction).toHaveBeenCalledTimes(1)
    await act(async () => { flag.release({ ok: true, data: { action: 'flag', folder: 'INBOX', messages: [{ ...message, flags: ['\\Flagged'] } as never] } }); await flagged })
    await waitFor(() => expect(mock.mail.applyMessageAction).toHaveBeenCalledTimes(2))
    expect(mock.mail.applyMessageAction).toHaveBeenLastCalledWith({ accountId: 'one', folder: 'INBOX', uid: 7, action: 'mark-read' })
    expect(listed().flags).toContain('\\Seen')
    await act(async () => { read.release({ ok: true, data: { action: 'mark-read', folder: 'INBOX', messages: [] } }) })
  })

  it('removes the unread mark at once when a message opens in a new tab while another action is in flight', async () => {
    const mock = setup()
    const store = getStore()
    const { container } = render(<Panel />)
    await waitFor(() => expect(container.querySelector('.email-swipe-content')).not.toBeNull())
    await waitFor(() => expect(listed()).toBeDefined())
    const flag = held(), read = held()
    vi.mocked(mock.mail.applyMessageAction).mockImplementationOnce(() => flag.promise).mockImplementationOnce(() => read.promise)
    let flagged!: Promise<boolean>
    act(() => { flagged = store.act(message, 'flag') })
    act(() => { fireEvent.click(container.querySelector('.email-swipe-content')!, { metaKey: true }) })
    expect(listed().flags).toContain('\\Seen')
    expect(mock.mail.applyMessageAction).toHaveBeenCalledTimes(1)
    await act(async () => { flag.release({ ok: true, data: { action: 'flag', folder: 'INBOX', messages: [{ ...message, flags: ['\\Flagged'] } as never] } }); await flagged })
    await waitFor(() => expect(mock.mail.applyMessageAction).toHaveBeenCalledTimes(2))
    expect(mock.mail.applyMessageAction).toHaveBeenLastCalledWith({ accountId: 'one', folder: 'INBOX', uid: 7, action: 'mark-read' })
    await act(async () => { read.release({ ok: true, data: { action: 'mark-read', folder: 'INBOX', messages: [] } }) })
  })

  it.each([
    ['not-applied', 'Not applied. The message was not changed: [READ-ONLY] mailbox is read-only'],
    ['unknown', 'Outcome unknown. The change may have been applied on the server: Mail server closed the connection.']
  ] as const)('shows a flag change at once and reverts it when the outcome is %s', async (outcome, error) => {
    const mock = setup(Promise.resolve(), { flags: ['\\Seen'] })
    const store = getStore()
    await store.whenReady
    await act(async () => { await store.selectAccount('one') })
    await waitFor(() => expect(listed()).toBeDefined())
    const answer = held()
    vi.mocked(mock.mail.applyMessageAction).mockImplementationOnce(() => answer.promise)
    let failures: string[] = []
    let done!: Promise<boolean>
    act(() => { done = store.act(message, 'flag', { onFailure: (value) => { failures = [...failures, value] } }) })
    expect(listed().flags).toEqual(['\\Seen', '\\Flagged'])
    await act(async () => { answer.release({ ok: false, error, code: outcome === 'unknown' ? 'ACTION_OUTCOME_UNKNOWN' : 'ACTION_NOT_APPLIED', outcome }) })
    expect(await done).toBe(false)
    expect(listed().flags).toEqual(['\\Seen'])
    expect(failures).toEqual([outcome])
    expect(store.getSnapshot().error).toBe(error)
  })

  it('marks a property edit refused by the server as not applied for its command caller', async () => {
    const registered: Array<{ id: string; input?: { parse(raw: unknown): unknown }; run(input: unknown): Promise<unknown> }> = []
    const mock = setup(Promise.resolve(), { flags: ['\\Seen'] }, (current) => {
      const register = current.api.commands.register
      vi.spyOn(current.api.commands, 'register').mockImplementation((command) => { registered.push(command as unknown as typeof registered[number]); return register(command) })
    })
    const store = getStore()
    await store.restoreSelection({ accountIds: ['one'], view: 'folder', folder: 'INBOX', message: { accountId: 'one', folder: 'INBOX', uid: 7 } })
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension.getSnapshot()!
    const subject = { pluginId: 'email', surface: 'main_workspace' as const, view: surface.view, item: surface.item }
    const command = registered.find((entry) => entry.id === 'update-properties')!
    vi.mocked(mock.mail.applyMessageAction).mockResolvedValueOnce({ ok: false, error: 'Not applied. The message was not changed: [READ-ONLY] mailbox is read-only', code: 'ACTION_NOT_APPLIED', outcome: 'not-applied' })
    await act(async () => { await expect(command.run(command.input!.parse({ subject, values: { flagged: true } }))).rejects.toMatchObject({ outcome: 'not-applied' }) })
    vi.mocked(mock.mail.applyMessageAction).mockResolvedValueOnce({ ok: false, error: 'Outcome unknown. The change may have been applied on the server: Mail server closed the connection.', code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' })
    await act(async () => { await expect(command.run(command.input!.parse({ subject, values: { flagged: true } }))).rejects.toMatchObject({ outcome: 'unknown' }) })
  })

  it('shows no focus ring on a row focused by a pointer press and keeps it for keyboard focus', async () => {
    const mock = setup()
    mock.mail.queryMessages = async () => ({ ok: true, data: { messages: [message, { ...message, id: 'moss', uid: 8, subject: 'Moss survey' }] } })
    const { container } = render(<Panel />)
    await screen.findByText('Moss survey')
    const rows = [...container.querySelectorAll<HTMLElement>('.email-swipe-content')]
    fireEvent.keyDown(rows[1], { key: 'Tab' })
    fireEvent.pointerDown(rows[0], { button: 0, clientX: 20, clientY: 20 })
    act(() => rows[0].focus())
    expect(rows[0].dataset.focusSource).toBe('pointer')
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' })
    expect(rows[0].dataset.focusSource).toBeUndefined()
    act(() => rows[1].focus())
    expect(rows[1].dataset.focusSource).toBeUndefined()
    fireEvent.pointerDown(rows[1], { button: 0, clientX: 20, clientY: 120 })
    expect(rows[1].dataset.focusSource).toBe('pointer')
    const css = [...document.querySelectorAll('style')].map((style) => style.textContent).join('\n')
    expect(css).toContain('.email-swipe-content[data-focus-source="pointer"]:focus-visible { outline:none; }')
    expect(css).toContain('.email-swipe-content:focus-visible { outline:2px solid var(--accent-color); outline-offset:-2px; }')
  })
})

describe('plain click opens in the same tab, Mod or middle click in a new tab', () => {
  const auxClick = (element: Element) => fireEvent(element, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))

  it('passes the intent with a plain-text link click, Mod-click, middle click and Enter', async () => {
    const mock = setup()
    await getStore().whenReady
    const open = vi.mocked(mock.api.links.open)
    open.mockClear()
    render(<MessageBody message={{ ...message, text: 'Census notes at https://example.com/survey today.' }} plain />)
    const link = screen.getByRole('link', { name: 'https://example.com/survey' })
    fireEvent.click(link)
    fireEvent.click(link, { metaKey: true })
    auxClick(link)
    fireEvent.keyDown(link, { key: 'Enter' })
    fireEvent.keyDown(link, { key: 'Enter', metaKey: true })
    fireEvent.click(link, { shiftKey: true })
    expect(open.mock.calls.map(([target, options]) => [(target as { value: string }).value, options])).toEqual([
      ['https://example.com/survey', { newTab: false }],
      ['https://example.com/survey', { newTab: true }],
      ['https://example.com/survey', { newTab: true }],
      ['https://example.com/survey', { newTab: false }],
      ['https://example.com/survey', { newTab: true }]
    ])
  })

  it('forwards the host intent of an HTML link to the external URL route', async () => {
    const mock = setup()
    await getStore().whenReady
    let onLink: ((url: string, options: { newTab: boolean }) => void) | undefined
    mock.api.ui.HtmlContent = (props) => { onLink = props.onLink; return null }
    const external = vi.spyOn(mock.api.files, 'openExternalUrl')
    render(<MessageBody message={{ ...message, html: '<a href="https://example.com/survey">Survey</a>' }} plain={false} />)
    onLink!('https://example.com/survey', { newTab: false })
    onLink!('https://example.com/survey', { newTab: true })
    expect(external.mock.calls).toEqual([['https://example.com/survey', { newTab: false }], ['https://example.com/survey', { newTab: true }]])
  })

  it('opens a message row in a new tab on middle click and in place on a plain click', async () => {
    const mock = setup()
    const { container } = render(<Panel />)
    await waitFor(() => expect(container.querySelector('.email-swipe-content')).not.toBeNull())
    const openMainTab = vi.spyOn(mock.api.workspace, 'openMainTab')
    await act(async () => { auxClick(container.querySelector('.email-swipe-content')!) })
    expect(openMainTab).toHaveBeenCalledTimes(1)
    expect(openMainTab.mock.calls[0][0]).toMatchObject({ newTab: true })
    await waitFor(() => expect(mock.mail.applyMessageAction).toHaveBeenCalledWith({ accountId: 'one', folder: 'INBOX', uid: 7, action: 'mark-read' }))
    openMainTab.mockClear()
    await act(async () => { fireEvent.click(container.querySelector('.email-swipe-content')!) })
    await waitFor(() => expect(getStore().getSnapshot().loadingMessage).toBe(false))
    expect(openMainTab.mock.calls.every(([options]) => !options?.newTab)).toBe(true)
  })

  it('opens a matched contact in the same tab on a plain click and in a new tab on Mod or middle click', async () => {
    const mock = setup()
    const opened: unknown[][] = []
    mock.provideInterop(CONTACTS_DIRECTORY_V1, {
      search: async () => [],
      resolveEmails: async (addresses) => addresses.map((address) => ({ address, contacts: [{ id: 'canopy-contact', displayName: 'Canopy Research', emails: [{ address }] }] })),
      open: async (...args) => { opened.push(args) }
    }, 'contacts')
    render(<><Panel /><Person address={{ name: '', address: 'canopy@example.com' }} /></>)
    const person = await screen.findByRole('button', { name: 'Canopy Research' })
    const choose = (click: (option: Element) => void) => {
      fireEvent.click(person)
      const { unmount } = render(<>{mock.popovers.at(-1)!.node}</>)
      click(document.querySelector('.email-contact-card .email-account-option')!)
      unmount()
    }
    choose((option) => fireEvent.click(option))
    choose((option) => fireEvent.click(option, { metaKey: true }))
    choose((option) => auxClick(option))
    await waitFor(() => expect(opened).toHaveLength(3))
    expect(opened).toEqual([['canopy-contact', { newTab: false }], ['canopy-contact', { newTab: true }], ['canopy-contact', { newTab: true }]])
  })
})
