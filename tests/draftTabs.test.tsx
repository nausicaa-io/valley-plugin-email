import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_SURFACE_V1, type DatasetRecord, type PluginSurfaceProvider } from '@valley/plugin-sdk'
import type { EmailMessageDetail, EmailMessageRef } from '../src/mailTypes'
import { createMailMock } from './mailMock'
import { register } from '../src/index'
import { getStore } from '../src/store'
import { COMPOSE_TAB_SETTING, emailTabs } from '../src/tabs'

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

let dispose: (() => void | Promise<void>) | undefined
afterEach(async () => { cleanup(); await dispose?.(); dispose = undefined })

// One app run: the same drafts dataset and plugin settings as the run before it (a reload or a restart), Email tab
// `active` in front.
async function run(active: string, saved?: { rows: DatasetRecord[]; settings: Record<string, unknown> }) {
  await dispose?.()
  dispose = undefined
  const mock = createMailMock({ manifest: { id: 'email' }, datasets: { 'email.drafts': structuredClone(saved?.rows ?? []) }, settings: structuredClone(saved?.settings ?? {}) })
  mock.mail.listAccounts = async () => ({ ok: true, data: { accounts: [{ id: 'one', provider: 'pureemail', address: 'one@example.com', displayName: 'one',
    imap: { host: 'example.com', port: 993, secure: true }, smtp: { host: 'example.com', port: 465, secure: true }, createdAt: 1 }] } })
  mock.mail.listFolders = async () => ({ ok: true, data: { folders: ['INBOX'], mailboxes: [{ path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', selectable: true, cachedTotal: 2, cachedUnread: 0 }] } })
  mock.mail.queryMessages = vi.fn(async () => ({ ok: true, data: { messages } }))
  mock.mail.readMessage = vi.fn(async (input: EmailMessageRef) => ({ ok: true, data: { message: messages.find((message) => message.uid === input.uid) ?? null } }))
  mock.emitState({ activePluginTab: { pluginId: 'email', instanceId: active } })
  dispose = register(mock.api)
  const main = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).map((entry) => entry.extension as PluginSurfaceProvider).find((entry) => entry.surface === 'main_workspace')!
  const activate = async (instanceId: string): Promise<void> => {
    mock.emitState({ activePluginTab: { pluginId: 'email', instanceId } })
    await waitFor(() => expect(emailTabs()!.instance()).toBe(instanceId))
    await getStore().flushDraft()
  }
  const shown = () => ({ uid: getStore().getSnapshot().selectedMessage?.uid ?? null, composing: getStore().getSnapshot().composing })
  // What the host keeps per tab and what survives in the plugin's own storage.
  const keep = async () => {
    await getStore().flushDraft()
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { rows: mock.datasets.get('email.drafts') ?? [], settings: structuredClone(mock.api.settings.get()) }
  }
  await getStore().whenReady
  return { mock, main, activate, shown, keep }
}

describe('Email drafts and tabs (F19)', () => {
  it('opens a Mod-clicked mailto link as compose in a new Email tab and leaves the current tab as it was', async () => {
    const app = await run('tab-a')
    await app.main.restore(state(7), 'tab-a', { background: true })
    await waitFor(() => expect(app.shown()).toEqual({ uid: 7, composing: false }))
    const openMainTab = vi.spyOn(app.mock.api.workspace, 'openMainTab').mockImplementation((options) => {
      if (options?.instanceId) app.mock.emitState({ activePluginTab: { pluginId: 'email', instanceId: options.instanceId } })
    })
    const handler = vi.mocked(app.mock.api.links.register).mock.calls[0][0]
    expect(await handler.open({ category: 'email', value: 'mailto:fern@example.test?subject=Canopy' }, { newTab: true })).toEqual({ status: 'opened' })
    const opened = openMainTab.mock.calls.at(-1)![0]!
    expect(opened).toMatchObject({ newTab: true, instanceId: expect.stringMatching(/^mail-/) })
    expect(emailTabs()!.instance()).toBe(opened.instanceId)
    expect(app.shown().composing).toBe(true)
    expect(getStore().getSnapshot().compose).toMatchObject({ subject: 'Canopy', to: [{ address: 'fern@example.test' }] })
    await app.activate('tab-a')
    await waitFor(() => expect(app.shown()).toEqual({ uid: 7, composing: false }))
    expect((await app.keep()).settings[COMPOSE_TAB_SETTING]).toEqual({ draft: getStore().getSnapshot().compose!.id, tab: opened.instanceId })
  })

  it('reports a Mod-clicked mailto whose new tab the host never activates as not opened, and that tab does not compose later', async () => {
    const app = await run('tab-a')
    await app.main.restore(state(7), 'tab-a', { background: true })
    await waitFor(() => expect(app.shown()).toEqual({ uid: 7, composing: false }))
    const openMainTab = vi.spyOn(app.mock.api.workspace, 'openMainTab').mockImplementation(() => undefined)
    const handler = vi.mocked(app.mock.api.links.register).mock.calls[0][0]
    const started = Date.now()
    expect(await handler.open({ category: 'email', value: 'mailto:fern@example.test?subject=Canopy' }, { newTab: true })).toEqual({ status: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(getStore().getSnapshot().compose).toBeNull()
    await app.activate(openMainTab.mock.calls.at(-1)![0]!.instanceId!)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(getStore().getSnapshot().compose).toBeNull()
  })

  it('opens an unsaved draft again only in the tab that showed it, after a reload, a restart, or reopening that tab', async () => {
    let app = await run('tab-a')
    await app.main.restore(state(7), 'tab-a', { background: true })
    await app.main.restore(state(8), 'tab-b', { background: true })
    await app.activate('tab-b')
    await getStore().startCompose()
    getStore().updateDraft({ text: 'Unsaved heron notes' })
    await app.activate('tab-a')
    expect(app.shown()).toEqual({ uid: 7, composing: false })
    const saved = await app.keep()
    expect(saved.settings[COMPOSE_TAB_SETTING]).toEqual({ draft: getStore().getSnapshot().compose!.id, tab: 'tab-b' })

    app = await run('tab-a', saved)
    await Promise.all([app.main.restore(state(7), 'tab-a', { background: true }), app.main.restore(state(8), 'tab-b', { background: true })])
    expect(app.shown()).toEqual({ uid: 7, composing: false })
    expect(getStore().getSnapshot().compose).toMatchObject({ text: 'Unsaved heron notes', dirty: true })
    await app.activate('tab-b')
    await waitFor(() => expect(app.shown()).toEqual({ uid: 8, composing: true }))
    await app.activate('tab-a')
    await waitFor(() => expect(app.shown()).toEqual({ uid: 7, composing: false }))

    app = await run('tab-b', await app.keep())
    await app.main.restore(state(8), 'tab-b', { background: true })
    await waitFor(() => expect(app.shown()).toEqual({ uid: 8, composing: true }))
    expect(getStore().getSnapshot().compose?.text).toBe('Unsaved heron notes')
  })

  it('keeps a draft closed by Save draft out of every tab after a reload; Compose opens it again', async () => {
    let app = await run('tab-a')
    await app.main.restore(state(7), 'tab-a', { background: true })
    await getStore().startCompose()
    getStore().updateDraft({ text: 'Hoopoe sighting draft' })
    expect(await getStore().saveDraft()).toBe(true)
    await waitFor(() => expect(app.shown()).toEqual({ uid: 7, composing: false }))
    const saved = await app.keep()
    expect(saved.settings[COMPOSE_TAB_SETTING]).toBeNull()

    for (const tab of ['tab-a', 'tab-b']) {
      app = await run(tab, saved)
      await app.main.restore(state(tab === 'tab-a' ? 7 : 8), tab, { background: true })
      expect(app.shown()).toEqual({ uid: tab === 'tab-a' ? 7 : 8, composing: false })
      expect(getStore().getSnapshot().compose).toMatchObject({ text: 'Hoopoe sighting draft' })
    }
    await getStore().startCompose()
    expect(getStore().getSnapshot()).toMatchObject({ composing: true, compose: { text: 'Hoopoe sighting draft' } })
  })

  it('releases a draft left by opening mail in its tab, and never shows a released draft over the focused message', async () => {
    let app = await run('tab-a')
    await app.main.restore(state(7), 'tab-a', { background: true })
    await getStore().startCompose()
    getStore().updateDraft({ text: 'Left in the background' })
    getStore().openMessage(ref(8))
    await waitFor(() => expect(app.shown()).toEqual({ uid: 8, composing: false }))
    app = await run('tab-a', await app.keep())
    await app.main.restore(state(8), 'tab-a', { background: true })
    expect(app.shown()).toEqual({ uid: 8, composing: false })
    expect(emailTabs()!.parked('tab-a')).toBeNull()
    expect(getStore().getSnapshot().compose?.text).toBe('Left in the background')
  })

  it('moves the draft to the tab that opens it with Compose', async () => {
    const app = await run('tab-a')
    await app.main.restore(state(7), 'tab-a', { background: true })
    await app.main.restore(state(8), 'tab-b', { background: true })
    await getStore().startCompose()
    getStore().updateDraft({ text: 'Moves along' })
    await app.activate('tab-b')
    expect(app.shown()).toEqual({ uid: 8, composing: false })
    await getStore().startCompose()
    await app.activate('tab-a')
    expect(app.shown()).toEqual({ uid: 7, composing: false })
    await app.activate('tab-b')
    expect(app.shown()).toEqual({ uid: 8, composing: true })
    expect((await app.keep()).settings[COMPOSE_TAB_SETTING]).toMatchObject({ tab: 'tab-b' })
  })
  it('retitles the background tab the draft moved away from instead of leaving it on Compose', async () => {
    const app = await run('tab-a')
    await app.main.restore(state(7), 'tab-a', { background: true })
    await app.main.restore(state(8), 'tab-b', { background: true })
    await getStore().startCompose()
    getStore().updateDraft({ text: 'Moves along' })
    const titles = vi.mocked(app.mock.api.workspace.setMainTabTitle)
    expect(titles).toHaveBeenLastCalledWith('Compose', 'tab-a')
    await app.activate('tab-b')
    titles.mockClear()
    await getStore().startCompose()
    await waitFor(() => expect(titles).toHaveBeenCalledWith('Canopy survey', 'tab-a'))
    expect(titles).toHaveBeenLastCalledWith('Compose', 'tab-b')
  })
})
