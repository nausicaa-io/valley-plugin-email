import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import * as React from 'react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_SURFACE_V1, type DatasetRecord, type PluginSurfaceProvider } from '@valley/plugin-sdk'
import type { EmailMessageDetail, EmailMessageRef } from '../src/mailTypes'
import { createMailMock } from './mailMock'
import { register } from '../src/index'
import { getStore } from '../src/store'
import { COMPOSE_TAB_SETTING, emailTabs } from '../src/tabs'
import { showsDraft } from '../src/Panel'
import type { EmailMailbox } from '../src/mailTypes'

const detail = (uid: number, subject: string): EmailMessageDetail => ({
  id: `msg-${uid}`, accountId: 'one', folder: 'INBOX', uid, messageId: `<msg-${uid}@example.com>`,
  from: 'heron@example.com', to: 'reader@example.com', subject, snippet: subject, text: `${subject} notes.`,
  date: '2026-08-30T09:00:00.000Z', flags: ['\\Seen'], hasAttachments: false,
  memberships: [{ accountId: 'one', folder: 'INBOX', uid }],
  addresses: { from: [{ name: '', address: 'heron@example.com' }], to: [{ name: '', address: 'reader@example.com' }], cc: [], replyTo: [] }
})
const messages = [detail(7, 'Canopy survey'), detail(8, 'Wetland census')]
const ref = (uid: number): EmailMessageRef => ({ accountId: 'one', folder: 'INBOX', uid })
const state = (uid: number) => ({ accountIds: [], view: 'folder', folder: 'INBOX', query: '', message: ref(uid) })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
type Saved = { rows: DatasetRecord[]; settings: Record<string, unknown> }

let dispose: (() => void | Promise<void>) | undefined
afterEach(async () => { cleanup(); await dispose?.(); dispose = undefined })

// One app run on the drafts dataset and plugin settings of the run before it (a reload or a restart). `active` is the Email
// tab in front (undefined: the Email tab without an instance); `tabs` are the Email tabs in the window's layout.
async function run(active: string | undefined, saved?: Saved, tabs: (string | undefined)[] = ['tab-a', 'tab-b']) {
  await dispose?.()
  dispose = undefined
  const mock = createMailMock({ manifest: { id: 'email' }, datasets: { 'email.drafts': structuredClone(saved?.rows ?? []) }, settings: structuredClone(saved?.settings ?? {}) })
  mock.mail.listAccounts = async () => ({ ok: true, data: { accounts: [{ id: 'one', provider: 'pureemail', address: 'one@example.com', displayName: 'one',
    imap: { host: 'example.com', port: 993, secure: true }, smtp: { host: 'example.com', port: 465, secure: true }, createdAt: 1 }] } })
  mock.mail.listFolders = async () => ({ ok: true, data: { folders: ['INBOX', 'Drafts'], mailboxes: [
    { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', selectable: true, cachedTotal: 2, cachedUnread: 0 },
    { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', selectable: true, cachedTotal: 0, cachedUnread: 0 }] } })
  mock.mail.queryMessages = vi.fn(async (query: { folder?: string }) => ({ ok: true, data: { messages: query.folder === 'Drafts' ? [] : messages } }))
  mock.mail.readMessage = vi.fn(async (input: EmailMessageRef) => ({ ok: true, data: { message: messages.find((message) => message.uid === input.uid) ?? null } }))
  let open = tabs
  const layout = vi.fn(() => ({ layout: { type: 'leaf', id: 'pane', activeTabId: null, tabs: open.map((tab, index) => ({ id: `t${index}`, folderPath: '', kind: 'plugin', pluginId: 'email', ...(tab ? { pluginInstanceId: tab } : {}) })) },
    leftSidebarWidth: 260, leftSidebarVisible: true }))
  mock.api.workspace.captureLayout = layout as unknown as typeof mock.api.workspace.captureLayout
  mock.emitState({ activePluginTab: { pluginId: 'email', instanceId: active } })
  dispose = register(mock.api)
  const main = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).map((entry) => entry.extension as PluginSurfaceProvider).find((entry) => entry.surface === 'main_workspace')!
  const activate = async (instanceId: string | undefined): Promise<void> => {
    mock.emitState({ activePluginTab: { pluginId: 'email', instanceId } })
    await waitFor(() => expect(emailTabs()!.instance()).toBe(instanceId))
    await getStore().flushDraft()
  }
  // The host closes or reopens Email tabs: the layout changes and the state listeners run.
  const setTabs = (next: (string | undefined)[]): void => { open = next; mock.emitState({ activePluginTab: mock.api.getState().activePluginTab }) }
  const shown = () => ({ uid: getStore().getSnapshot().selectedMessage?.uid ?? null, composing: getStore().getSnapshot().composing })
  const keep = async (): Promise<Saved> => {
    await getStore().flushDraft()
    await tick()
    return { rows: mock.datasets.get('email.drafts') ?? [], settings: structuredClone(mock.api.settings.get()) }
  }
  const panel = (): ComponentType => (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls.find(([id]) => id === 'email.panel')![1]
  await getStore().whenReady
  return { mock, main, activate, setTabs, shown, keep, panel }
}

describe('Email 2.1.2: the saved local draft in the Drafts mailbox', () => {
  it('lists the draft first in its account’s Drafts mailbox and opens it in the current tab, which then owns it', async () => {
    const app = await run('tab-a')
    await app.main.restore(state(7), 'tab-a', { background: true })
    await app.main.restore(state(8), 'tab-b', { background: true })
    const before = Date.now()
    await getStore().startCompose()
    getStore().updateDraft({ to: [{ name: '', address: 'wren@wetland.example' }], subject: 'Marsh count', text: '\nTwo herons at dawn.\nMore later.' })
    expect(await getStore().saveDraft()).toBe(true)
    await app.activate('tab-b')
    expect(app.shown()).toEqual({ uid: 8, composing: false })

    let view = render(React.createElement(app.panel()))
    await waitFor(() => expect(view.container.querySelector('.email-message-row')).not.toBeNull())
    expect(view.container.querySelector('.email-draft-entry')).toBeNull()
    view.unmount()
    await getStore().selectFolder('Drafts')
    view = render(React.createElement(app.panel()))
    const entry = await waitFor(() => { const found = view.container.querySelector<HTMLElement>('.email-draft-entry'); expect(found).not.toBeNull(); return found! })
    expect(entry.querySelector('.email-message-subject')?.textContent).toBe('Marsh count')
    expect(entry.querySelector('.email-message-top strong')?.textContent).toBe('wren@wetland.example')
    expect(entry.querySelector('.email-draft-label')?.textContent).toBe('Draft')
    expect(entry.querySelector('.email-message-snippet')?.textContent).toBe('Two herons at dawn.')
    expect(entry.querySelector('time')?.getAttribute('title')).toMatch(/^\d{2}\D\d{2}\D\d{4} · \d/)
    expect(view.container.querySelector('.email-empty')).toBeNull()
    // The draft's date is when it was started: its id.
    expect(getStore().getSnapshot().compose!.id).toBeGreaterThanOrEqual(before)
    fireEvent.click(entry.querySelector('button')!)
    await waitFor(() => expect(getStore().getSnapshot().composing).toBe(true))
    await waitFor(() => expect(entry.classList.contains('active')).toBe(true))
    view.unmount()

    expect(emailTabs()!.instance()).toBe('tab-b')
    expect((await app.keep()).settings[COMPOSE_TAB_SETTING]).toEqual({ draft: getStore().getSnapshot().compose!.id, tab: 'tab-b' })
    await app.activate('tab-a')
    expect(app.shown()).toEqual({ uid: 7, composing: false })
    await app.activate('tab-b')
    expect(app.shown().composing).toBe(true)

    await getStore().selectView('recent')
    view = render(React.createElement(app.panel()))
    await waitFor(() => expect(view.container.querySelector('.email-selector[title="Recent"]')).not.toBeNull())
    expect(view.container.querySelector('.email-draft-entry')).toBeNull()
  })
})

describe('Email 2.1.5: a draft of an account without a Drafts mailbox', () => {
  it('lists the draft first in that account’s Inbox, and only in the Drafts mailbox when the account has one', () => {
    const inbox: EmailMailbox = { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', selectable: true, cachedTotal: 0, cachedUnread: 0 }
    const drafts: EmailMailbox = { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', selectable: true, cachedTotal: 0, cachedUnread: 0 }
    const compose = { id: 1, accountId: 'one', mode: 'new' as const, to: [], cc: [], bcc: [], pending: { to: '', cc: '', bcc: '' }, subject: 'Marsh count', text: '', dirty: false }
    const snap = (folder: string, mailboxes: EmailMailbox[]) => ({ compose, view: 'folder' as const, group: null, selectedFolder: folder, selectedAccountIds: [], query: '',
      accounts: [{ id: 'one', provider: 'pureemail' as const, address: 'one@example.com', imap: { host: 'example.com', port: 993, secure: true }, smtp: { host: 'example.com', port: 465, secure: true }, createdAt: 1 }],
      mailboxesByAccount: { one: mailboxes } })
    expect(showsDraft(snap('INBOX', [inbox]))).toBe(true)
    expect(showsDraft(snap('INBOX', [inbox, drafts]))).toBe(false)
    expect(showsDraft(snap('Drafts', [inbox, drafts]))).toBe(true)
    expect(showsDraft(snap('INBOX', []))).toBe(false)
  })
})

describe('Email 2.1.2: tab titles, release and stale owners', () => {
  it('gives a background Email tab without an instance its last title after a reload, before it is visited', async () => {
    let app = await run(undefined, undefined, [undefined, 'tab-b'])
    await app.main.restore(state(7), undefined, { background: true })
    await waitFor(() => expect(app.shown().uid).toBe(7))
    await app.main.restore(state(8), 'tab-b', { background: true })
    await app.activate('tab-b')
    const saved = await app.keep()

    app = await run('tab-b', saved, [undefined, 'tab-b'])
    await app.main.restore(state(8), 'tab-b', { background: true })
    await waitFor(() => expect(app.shown().uid).toBe(8))
    const setTitle = vi.mocked(app.mock.api.workspace.setMainTabTitle)
    const plain = setTitle.mock.calls.filter(([, instanceId]) => instanceId === undefined).map(([title]) => title)
    expect(plain).toEqual(['Canopy survey'])
    expect(setTitle).toHaveBeenCalledWith('Wetland census', 'tab-b')
  })

  for (const action of ['Save draft', 'Close'] as const) {
    it(`releases the draft when ${action} runs during a tab switch, so the next start never reopens it`, async () => {
      let app = await run('tab-a')
      await app.main.restore(state(7), 'tab-a', { background: true })
      await app.main.restore(state(8), 'tab-b', { background: true })
      await app.activate('tab-b')
      await getStore().startCompose()
      getStore().updateDraft({ text: `Left by ${action}` })
      await getStore().flushDraft()
      let unblock!: () => void
      const gate = new Promise<void>((resolve) => { unblock = resolve })
      const read = app.mock.mail.readMessage
      app.mock.mail.readMessage = vi.fn(async (input: EmailMessageRef) => { await gate; return read(input) })
      app.mock.emitState({ activePluginTab: { pluginId: 'email', instanceId: 'tab-a' } })
      await waitFor(() => expect(app.mock.mail.readMessage).toHaveBeenCalled())
      expect(getStore().getSnapshot().composing).toBe(true)
      if (action === 'Save draft') expect(await getStore().saveDraft()).toBe(true)
      else expect(await getStore().closeCompose()).toEqual({ discarded: false })
      unblock()
      await waitFor(() => expect(app.shown()).toEqual({ uid: 7, composing: false }))
      const saved = await app.keep()
      expect(saved.settings[COMPOSE_TAB_SETTING]).toBeNull()

      app = await run('tab-b', saved)
      await app.main.restore(state(8), 'tab-b', { background: true })
      await tick()
      expect(app.shown()).toEqual({ uid: 8, composing: false })
      expect(getStore().getSnapshot().compose?.text).toBe(`Left by ${action}`)
      await app.activate('tab-a')
      await app.activate('tab-b')
      expect(app.shown().composing).toBe(false)
    })
  }

  it('clears a saved owner whose draft no longer exists', async () => {
    const app = await run('tab-a', { rows: [], settings: { [COMPOSE_TAB_SETTING]: { draft: 123, tab: 'tab-a' } } })
    await app.main.restore(state(7), 'tab-a', { background: true })
    expect((await app.keep()).settings[COMPOSE_TAB_SETTING]).toBeNull()
  })

  it('clears the saved owner when the owner tab closes, and gives the draft back when that tab reopens', async () => {
    let app = await run('tab-a')
    await app.main.restore(state(7), 'tab-a', { background: true })
    await app.main.restore(state(8), 'tab-b', { background: true })
    await app.activate('tab-b')
    await getStore().startCompose()
    getStore().updateDraft({ text: 'Owned by tab b' })
    const draft = getStore().getSnapshot().compose!.id
    expect((await app.keep()).settings[COMPOSE_TAB_SETTING]).toEqual({ draft, tab: 'tab-b' })
    app.setTabs(['tab-a'])
    await app.activate('tab-a')
    expect((await app.keep()).settings[COMPOSE_TAB_SETTING]).toBeNull()
    app.setTabs(['tab-a', 'tab-b'])
    expect((await app.keep()).settings[COMPOSE_TAB_SETTING]).toEqual({ draft, tab: 'tab-b' })
    await app.activate('tab-b')
    await waitFor(() => expect(app.shown().composing).toBe(true))

    app.setTabs(['tab-a'])
    await app.activate('tab-a')
    const saved = await app.keep()
    expect(saved.settings[COMPOSE_TAB_SETTING]).toBeNull()
    app = await run('tab-a', saved, ['tab-a'])
    await app.main.restore(state(7), 'tab-a', { background: true })
    expect(app.shown()).toEqual({ uid: 7, composing: false })
    expect((await app.keep()).settings[COMPOSE_TAB_SETTING]).toBeNull()
    expect(getStore().getSnapshot().compose?.text).toBe('Owned by tab b')
  })
})
