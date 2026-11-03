import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_SURFACE_V1, type PluginSurfaceProvider } from '@valley/plugin-sdk'
import type { EmailMessageQuery } from '../src/mailTypes'
import { createMailMock } from './mailMock'
import { register } from '../src/index'
import { getStore } from '../src/store'
import { emailTabs } from '../src/tabs'
import { SMART_GROUPS_FILE } from '../src/smartGroups'

const groups = { version: 1, enabled: true, provider: null, dailyLimit: 100, accounts: { one: { groups: [
  { id: 'receipts', name: 'Receipts', decision: 'Bills', threshold: 60, rules: [], children: [{ id: 'billing', name: 'Billing', decision: 'Power bills', threshold: 60, rules: [], children: [] }] },
  { id: 'family', name: 'Family', decision: 'Family mail', threshold: 60, rules: [], children: [] }
] } } }
const inbox = { accountIds: [], view: 'folder', folder: 'INBOX', query: '' }

let dispose: (() => void | Promise<void>) | undefined
afterEach(async () => { cleanup(); await dispose?.(); dispose = undefined })

async function setup(activeInstance: string, filters?: Record<string, unknown>) {
  const mock = createMailMock({ manifest: { id: 'email' } })
  if (filters) await mock.api.settings.set('filters', filters)
  mock.mail.listAccounts = async () => ({ ok: true, data: { accounts: [{ id: 'one', provider: 'pureemail', address: 'one@example.com', displayName: 'one',
    imap: { host: 'example.com', port: 993, secure: true }, smtp: { host: 'example.com', port: 465, secure: true }, createdAt: 1 }] } })
  mock.mail.listFolders = async () => ({ ok: true, data: { folders: ['INBOX'], mailboxes: [{ path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', selectable: true, cachedTotal: 0, cachedUnread: 0 }] } })
  mock.mail.queryMessages = vi.fn(async () => ({ ok: true, data: { messages: [] } }))
  await mock.api.data.files.writeTextGuarded(SMART_GROUPS_FILE, JSON.stringify(groups), null)
  mock.emitState({ activePluginTab: { pluginId: 'email', instanceId: activeInstance } })
  dispose = register(mock.api)
  const main = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).map((entry) => entry.extension as PluginSurfaceProvider).find((entry) => entry.surface === 'main_workspace')!
  const activate = (instanceId: string): void => mock.emitState({ activePluginTab: { pluginId: 'email', instanceId } })
  const lastQuery = () => vi.mocked(mock.mail.queryMessages).mock.calls.at(-1)![0] as EmailMessageQuery
  await getStore().whenReady; await getStore().smartGroups.ready
  return { mock, main, activate, lastQuery }
}

describe('saved group filters', () => {
  it.each([
    ['a stale subtree of a group that still exists', { spam: 'all', categoryId: 'receipts', categoryIds: ['receipts'], categoryAccountId: 'one' }, { spam: 'all', categoryId: 'receipts', categoryIds: ['receipts', 'billing'], categoryAccountId: 'one' }],
    ['a removed group', { spam: 'all', categoryId: 'gone', categoryIds: ['gone'], categoryAccountId: 'one' }, { spam: 'all' }],
    ['a subtree saved without a group by the older picker', { spam: 'all', categoryIds: ['receipts'], categoryAccountId: 'one' }, { spam: 'all' }]
  ])('replaces %s once the groups are loaded', async (_case, saved, expected) => {
    const { mock, lastQuery } = await setup('tab-a', saved)
    await waitFor(() => expect(mock.api.settings.get().filters).toEqual(expected))
    expect(getStore().getSnapshot().filters).toEqual(expected)
    await waitFor(() => expect(lastQuery().filters).toEqual(expected))
  })
})

describe('Smart groups per Email tab', () => {
  it('keeps each tab on its own group, out of the global filters, and brings both back after a reload', async () => {
    const first = await setup('tab-a')
    await first.main.restore(inbox, 'tab-a', { background: true })
    await getStore().selectGroup('one', 'receipts')
    expect(getStore().getSnapshot()).toMatchObject({ view: 'recent', group: { accountId: 'one', groupId: 'receipts' } })
    await waitFor(() => expect(first.lastQuery().filters).toMatchObject({ categoryIds: ['receipts', 'billing'], categoryAccountId: 'one' }))

    emailTabs()!.openNew(inbox as never)
    const tabB = vi.mocked(first.mock.api.workspace.openMainTab).mock.calls.at(-1)![0]!.instanceId!
    first.activate(tabB)
    await waitFor(() => expect(getStore().getSnapshot()).toMatchObject({ view: 'folder', group: null }))
    await waitFor(() => expect(first.lastQuery().filters?.categoryIds).toBeUndefined())
    await getStore().selectGroup('one', 'family')
    await waitFor(() => expect(first.lastQuery().filters).toMatchObject({ categoryIds: ['family'], categoryAccountId: 'one' }))

    first.activate('tab-a')
    await waitFor(() => expect(getStore().getSnapshot().group).toEqual({ accountId: 'one', groupId: 'receipts' }))
    await waitFor(() => expect(first.lastQuery().filters).toMatchObject({ categoryIds: ['receipts', 'billing'] }))
    first.activate(tabB)
    await waitFor(() => expect(getStore().getSnapshot().group).toEqual({ accountId: 'one', groupId: 'family' }))
    const saved = { a: first.main.getSnapshot('tab-a').view, b: first.main.getSnapshot(tabB).view }
    expect(saved).toEqual({ a: expect.objectContaining({ view: 'recent', group: { accountId: 'one', groupId: 'receipts' } }), b: expect.objectContaining({ view: 'recent', group: { accountId: 'one', groupId: 'family' } }) })
    const filters = first.mock.api.settings.get().filters as Record<string, unknown> | undefined
    expect(filters?.categoryIds).toBeUndefined()
    expect(filters?.categoryAccountId).toBeUndefined()
    await dispose?.(); dispose = undefined; cleanup()

    const second = await setup('tab-a')
    await Promise.all([second.main.restore(saved.a, 'tab-a', { background: true }), second.main.restore(saved.b, tabB, { background: true })])
    expect(getStore().getSnapshot().group).toEqual({ accountId: 'one', groupId: 'receipts' })
    expect(second.main.getSnapshot(tabB).view).toMatchObject({ group: { accountId: 'one', groupId: 'family' } })
    second.activate(tabB)
    await waitFor(() => expect(getStore().getSnapshot().group).toEqual({ accountId: 'one', groupId: 'family' }))
    await waitFor(() => expect(second.lastQuery().filters).toMatchObject({ categoryIds: ['family'], categoryAccountId: 'one' }))
  })

  it('leaves the group when the tab opens a folder or another view', async () => {
    const { main } = await setup('tab-a')
    await main.restore(inbox, 'tab-a', { background: true })
    await getStore().selectGroup('one', 'family')
    await getStore().selectFolder('INBOX')
    expect(getStore().getSnapshot()).toMatchObject({ view: 'folder', group: null })
    await getStore().selectGroup('one', 'family')
    await getStore().selectView('unread')
    expect(getStore().getSnapshot()).toMatchObject({ view: 'unread', group: null })
    expect(main.getSnapshot('tab-a').view).not.toHaveProperty('group')
  })
})
