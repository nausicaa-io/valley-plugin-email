import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1, type PluginSurfaceProvider } from '@valley/plugin-sdk'
import type { EmailMessageDetail, EmailMessageRef } from '../src/mailTypes'
import { createMailMock } from './mailMock'
import { register } from '../src/index'
import { getStore } from '../src/store'
import { emailTabs } from '../src/tabs'
import { accountFolderLabel } from '../src/localization'

const detail = (uid: number, subject: string, folder = 'INBOX'): EmailMessageDetail => ({
  id: `msg-${uid}`, accountId: 'one', folder, uid, messageId: `<msg-${uid}@example.com>`,
  from: 'heron@example.com', to: 'reader@example.com', subject, snippet: subject, text: `${subject} notes.`,
  date: '2026-08-30T09:00:00.000Z', flags: ['\\Seen'], hasAttachments: false,
  memberships: [{ accountId: 'one', folder, uid }],
  addresses: { from: [{ name: '', address: 'heron@example.com' }], to: [{ name: '', address: 'reader@example.com' }], cc: [], replyTo: [] }
})
const messages = [detail(7, 'Canopy survey'), detail(8, 'Wetland census'), detail(9, 'Dune transect', 'Archive')]
const ref = (uid: number, folder = 'INBOX'): EmailMessageRef => ({ accountId: 'one', folder, uid })
const state = (uid: number, folder = 'INBOX') => ({ accountIds: [], view: 'folder', folder, query: '', message: ref(uid, folder) })

let dispose: (() => void | Promise<void>) | undefined
afterEach(async () => { cleanup(); await dispose?.(); dispose = undefined })

function setup(activeInstance?: string | null) {
  const mock = createMailMock({ manifest: { id: 'email' } })
  mock.mail.listAccounts = async () => ({ ok: true, data: { accounts: [{ id: 'one', provider: 'pureemail', address: 'one@example.com', displayName: 'one',
    imap: { host: 'example.com', port: 993, secure: true }, smtp: { host: 'example.com', port: 465, secure: true }, createdAt: 1 }] } })
  mock.mail.listFolders = async () => ({ ok: true, data: { folders: ['INBOX', 'Archive'], mailboxes: [
    { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', selectable: true, cachedTotal: 2, cachedUnread: 0 },
    { path: 'Archive', name: 'Archive', specialUse: '\\Archive', selectable: true, cachedTotal: 1, cachedUnread: 0 }
  ] } })
  mock.mail.queryMessages = vi.fn(async (input) => ({ ok: true, data: { messages: messages.filter((message) => input.view !== 'folder' || message.folder === input.folder) } }))
  mock.mail.readMessage = vi.fn(async (input: EmailMessageRef) => ({ ok: true, data: { message: messages.find((message) => message.uid === input.uid && message.folder === input.folder) ?? null } }))
  if (activeInstance !== undefined) mock.emitState({ activePluginTab: activeInstance === null ? null : { pluginId: 'email', ...(activeInstance ? { instanceId: activeInstance } : {}) } })
  dispose = register(mock.api)
  const main = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).map((entry) => entry.extension as PluginSurfaceProvider).find((entry) => entry.surface === 'main_workspace')!
  const activate = (instanceId?: string): void => mock.emitState({ activePluginTab: { pluginId: 'email', ...(instanceId ? { instanceId } : {}) } })
  const shown = () => getStore().getSnapshot().selectedMessage?.uid ?? null
  const kept = (instanceId?: string) => (main.getSnapshot(instanceId).item?.state.message as EmailMessageRef | undefined)?.uid ?? null
  return { mock, main, activate, shown, kept }
}

describe('Email tabs', () => {
  it('names a mailbox of another account from that account, in the Properties Folder row and for parked tab titles', async () => {
    const { mock } = setup('tab-a')
    await getStore().whenReady
    await mock.api.data.dataset('mailboxes').insert([{ accountId: 'two', path: 'Gesendet', name: 'Gesendet', specialUse: '\\Sent', selectable: true }, { accountId: 'two', path: 'Projekte', name: 'Projekte', selectable: true }])
    const overview = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1).find((entry) => entry.extension.id === 'email.properties')!.extension
    const folderRow = async (accountIds: string[], folder: string) => (await overview.inspect!({ relPath: '', kind: 'unsupported', subject: { view: { accountIds, view: 'folder', folder, query: '' } } } as never)).find((field) => field.id === 'folder')?.value
    expect(await folderRow(['two'], 'Gesendet')).toBe('Sent')
    expect(await folderRow(['two'], 'Projekte')).toBe('Projekte')
    await waitFor(() => expect(getStore().getSnapshot().mailboxesByAccount.one).toHaveLength(2))
    expect(await folderRow(['one'], 'Archive')).toBe('Archive')
    expect(await accountFolderLabel(mock.api, getStore().getSnapshot().mailboxesByAccount, ['two'], 'Gesendet')).toBe('Sent')
    expect(await accountFolderLabel(mock.api, {}, ['three'], 'Gesendet')).toBe('Gesendet')
  })

  it('keeps each Email tab on its own message while the user switches between them', async () => {
    const { mock, activate, shown, kept } = setup('tab-a')
    await getStore().whenReady
    getStore().openMessage(ref(7))
    await waitFor(() => expect(shown()).toBe(7))
    emailTabs()!.openNew({ accountIds: [], view: 'folder', folder: 'INBOX', message: ref(8) }, 'Wetland census')
    const opened = vi.mocked(mock.api.workspace.openMainTab).mock.calls.at(-1)![0]!
    expect(opened).toEqual({ instanceId: expect.stringMatching(/^mail-/), newTab: true, title: 'Wetland census' })
    expect(shown()).toBe(7)
    expect(kept(opened.instanceId)).toBe(8)
    activate(opened.instanceId)
    await waitFor(() => expect(shown()).toBe(8))
    expect(kept('tab-a')).toBe(7)
    expect(mock.api.workspace.setMainTabTitle).toHaveBeenLastCalledWith('Wetland census', opened.instanceId)
    activate('tab-a')
    await waitFor(() => expect(shown()).toBe(7))
    expect(kept(opened.instanceId)).toBe(8)
    expect(mock.api.workspace.setMainTabTitle).toHaveBeenLastCalledWith('Canopy survey', 'tab-a')
  })

  it('brings two tabs back from their saved states after a reload, each with its own message', async () => {
    const { main, activate, shown, kept } = setup('tab-a')
    await Promise.all([main.restore(state(7), 'tab-a', { background: true }), main.restore(state(8), 'tab-b', { background: true })])
    expect(shown()).toBe(7)
    expect(kept('tab-b')).toBe(8)
    activate('tab-b')
    await waitFor(() => expect(shown()).toBe(8))
    activate('tab-a')
    await waitFor(() => expect(shown()).toBe(7))
  })

  it('brings a tab whose message no longer exists back to that folder without an error', async () => {
    const { main, activate, shown } = setup('tab-a')
    await main.restore(state(40, 'Archive'), 'tab-a', { background: true })
    expect(getStore().getSnapshot()).toMatchObject({ selectedFolder: 'Archive', selectedMessage: null, error: null })
    await main.restore(state(41), 'tab-b', { background: true })
    activate('tab-b')
    await waitFor(() => expect(getStore().getSnapshot()).toMatchObject({ selectedFolder: 'INBOX', selectedMessage: null, error: null }))
    expect(shown()).toBeNull()
  })

  it('keeps back and forward history per tab', async () => {
    const { mock, activate, shown } = setup('tab-a')
    await getStore().whenReady
    getStore().openMessage(ref(7))
    await waitFor(() => expect(shown()).toBe(7))
    getStore().openMessage(ref(8))
    await waitFor(() => expect(shown()).toBe(8))
    expect(getStore().getSnapshot().canGoBack).toBe(true)
    emailTabs()!.openNew({ accountIds: [], view: 'folder', folder: 'Archive', message: ref(9, 'Archive') }, 'Dune transect')
    const tabB = vi.mocked(mock.api.workspace.openMainTab).mock.calls.at(-1)![0]!.instanceId!
    activate(tabB)
    await waitFor(() => expect(shown()).toBe(9))
    expect(getStore().getSnapshot()).toMatchObject({ canGoBack: false, canGoForward: false })
    activate('tab-a')
    await waitFor(() => expect(shown()).toBe(8))
    expect(getStore().getSnapshot().canGoBack).toBe(true)
    expect(await getStore().goBack()).toBe(true)
    expect(shown()).toBe(7)
    expect(getStore().getSnapshot().canGoForward).toBe(true)
  })

  it('keeps an open draft over a restored tab and brings the tab back to its message when the draft closes', async () => {
    const { main, shown, kept } = setup('tab-a')
    await getStore().whenReady
    await getStore().startCompose()
    getStore().updateDraft({ text: 'Unsaved heron notes' })
    await main.restore(state(8), 'tab-a', { background: true })
    expect(getStore().getSnapshot()).toMatchObject({ composing: true, compose: { text: 'Unsaved heron notes', dirty: true } })
    expect(kept('tab-a')).toBe(8)
    await getStore().closeCompose()
    await waitFor(() => expect(shown()).toBe(8))
    expect(getStore().getSnapshot().compose).toMatchObject({ text: 'Unsaved heron notes' })
  })

  it('keeps the single saved state of a tab opened without an instance', async () => {
    const { main, shown, kept } = setup('')
    await main.restore(state(8), undefined, { background: true })
    expect(shown()).toBe(8)
    expect(kept(undefined)).toBe(8)
    expect(emailTabs()!.instance()).toBeUndefined()
  })

  it('reveals the tab that shows the live mailbox, or lets the host pick one when that tab is gone', async () => {
    const { mock, activate } = setup('tab-a')
    await getStore().whenReady
    const open = vi.mocked(mock.api.workspace.openMainTab)
    open.mockClear()
    emailTabs()!.reveal()
    expect(open).not.toHaveBeenCalled()
    mock.emitState({ activePluginTab: null })
    vi.spyOn(mock.api.workspace, 'getOpenMainTabs').mockReturnValue(['tab-a'])
    emailTabs()!.reveal()
    expect(open).toHaveBeenLastCalledWith({ instanceId: 'tab-a' })
    vi.spyOn(mock.api.workspace, 'getOpenMainTabs').mockReturnValue(['tab-c'])
    getStore().openMessage(ref(8))
    await waitFor(() => expect(getStore().getSnapshot().selectedMessage?.uid).toBe(8))
    emailTabs()!.reveal()
    expect(open).toHaveBeenLastCalledWith()
    activate('tab-c')
    await waitFor(() => expect(emailTabs()!.instance()).toBe('tab-c'))
    expect(getStore().getSnapshot().selectedMessage?.uid).toBe(8)
  })
})
