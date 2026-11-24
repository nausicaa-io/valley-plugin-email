import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiConnectionStatus, AiModelInfo } from '@valley/plugin-sdk/ai'
import { createMailMock } from './mailMock'
import { register } from '../src/index'
import { Settings } from '../src/Settings'
import { MailboxControls } from '../src/Panel'
import { MessageOrganization } from '../src/Organization'
import { getStore } from '../src/store'
import { emailStoreContext, mergeFolder } from '../src/backend/cache'
import { SMART_GROUPS_FILE } from '../src/smartGroups'
import type { EmailMessageDetail } from '../src/mailTypes'

let dispose: (() => void | Promise<void>) | undefined
afterEach(async () => { cleanup(); await dispose?.(); dispose = undefined })

const accounts = ['forest', 'wetland'].map(id => ({ id, provider: 'pureemail' as const, address: `${id}@example.test`, displayName: id, imap: { host: 'example.test', port: 993, secure: true }, smtp: { host: 'example.test', port: 465, secure: true }, createdAt: 1 }))
const seeded = { version: 1, enabled: true, provider: null, dailyLimit: 100, accounts: { forest: { enabled: true, groups: [
  { id: 'receipts', name: 'Receipts', decision: 'Bills and subscriptions', threshold: 60, icon: 'receipt', color: 'palette:green', rules: [], children: [{ id: 'billing', name: 'Billing', decision: 'Electricity and other bills', threshold: 60, icon: 'credit-card', color: 'palette:gold', rules: [], children: [] }] },
  { id: 'family', name: 'Family', decision: '', threshold: 60, icon: 'users', color: 'palette:pink', rules: [{ kind: 'address', value: 'aunt@kin.example' }], children: [] }
] }, wetland: { groups: [] } } }

function mailbox() {
  const mock = createMailMock({ manifest: { id: 'email' } })
  mock.mail.listAccounts = async () => ({ ok: true, data: { accounts } })
  mock.mail.listFolders = async () => ({ ok: true, data: { folders: ['INBOX'], mailboxes: [{ path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', selectable: true, cachedTotal: 2, cachedUnread: 0 }] } })
  mock.mail.queryMessages = vi.fn(async () => ({ ok: true, data: { messages: [] } }))
  mock.api.ai.defaults = vi.fn(async () => ({}))
  return mock
}
const file = async (mock: ReturnType<typeof mailbox>) => JSON.parse((await mock.api.data.files.readText(SMART_GROUPS_FILE)) ?? '{}')

describe('Smart groups settings', () => {
  it('lives on the Grouping subpage with overviewable icon/colour cards, Jev model choice and Marketing & Promotions starters', async () => {
    const mock = mailbox()
    mock.api.ai.connections = vi.fn(async () => [
      { id: 'jev-main', provider: 'jev', providerName: 'Jev', providerCapabilities: ['classification', 'models'] },
      { id: 'chat', provider: 'openai', providerName: 'OpenAI', providerCapabilities: ['chat'] },
      { id: 'unit', provider: 'unit-test-classifier', providerName: 'Test AI', providerCapabilities: ['classification'] }
    ] as unknown as AiConnectionStatus[])
    mock.api.ai.models = vi.fn(async ({ provider }: { provider: string }) => (provider === 'jev' ? [{ provider, id: 'jev-1.13.0', label: 'Jev 1.13' }, { provider, id: 'jev-latest', label: 'Jev latest' }] : [{ provider, id: 'fixture' }]) as AiModelInfo[])
    const openMenu = vi.fn(async () => 'remove')
    mock.api.ui.openMenu = openMenu as unknown as typeof mock.api.ui.openMenu
    dispose = register(mock.api)
    render(<Settings section="grouping" />)

    expect(screen.queryByRole('combobox', { name: 'AI' })).toBeNull()
    fireEvent.click(await screen.findByRole('switch', { name: 'Sort new mail into groups' }))
    await waitFor(async () => expect((await file(mock)).enabled).toBe(true))
    await waitFor(async () => expect(Object.keys((await file(mock)).accounts)).toEqual(['forest', 'wetland']))
    const starters = (await file(mock)).accounts.forest.groups
    expect(starters.map((group: { name: string; icon?: string; color?: string; children: { name: string }[] }) => [group.name, group.icon, group.color, group.children.map(child => child.name)])).toEqual([
      ['Personal', 'user', 'palette:blue', ['Family', 'Invitations & Events']],
      ['Work', 'briefcase', 'palette:indigo', []],
      ['Receipts & Finance', 'receipt', 'palette:green', ['Subscriptions', 'Bills']],
      ['Orders & Shipping', 'package', 'palette:amber', []],
      ['Travel', 'plane', 'palette:cyan', []],
      ['Ads & Promotions', 'megaphone', 'palette:orange', ['Promotions & Marketing', 'Deals & Offers', 'Newsletters']],
      ['Security & Alerts', 'shield', 'palette:red', []]
    ])

    const ai = await screen.findByRole('combobox', { name: 'AI' })
    await waitFor(() => expect(within(ai).getAllByRole('option').map(option => option.textContent)).toEqual(['Valley default', 'Jev', 'Test AI']))
    fireEvent.change(ai, { target: { value: 'unit\u0000unit-test-classifier' } })
    await waitFor(async () => expect((await file(mock)).provider).toEqual({ provider: 'unit-test-classifier', connectionId: 'unit', model: 'fixture' }))
    fireEvent.change(ai, { target: { value: 'jev-main\u0000jev' } })
    await waitFor(async () => expect((await file(mock)).provider).toEqual({ provider: 'jev', connectionId: 'jev-main', model: 'jev-1.13.0' }))
    const model = await screen.findByRole('combobox', { name: 'Model' })
    fireEvent.change(model, { target: { value: 'jev-latest' } })
    await waitFor(async () => expect((await file(mock)).provider).toEqual({ provider: 'jev', connectionId: 'jev-main', model: 'jev-latest' }))

    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveValue('forest')
    // Cards start collapsed for a clean bird's-eye overview.
    expect(screen.queryByRole('spinbutton', { name: /How sure/ })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /Always put mail from/ })).toBeNull()

    // Expand Travel and edit its name, sorting sentence, certainty and sender rule.
    fireEvent.click(screen.getByRole('button', { name: 'Expand Travel' }))
    const rename = await screen.findByRole('textbox', { name: 'Group name' })
    fireEvent.change(rename, { target: { value: 'Trips' } }); fireEvent.keyDown(rename, { key: 'Enter' })
    await waitFor(async () => expect((await file(mock)).accounts.forest.groups[4].name).toBe('Trips'))

    const sentence = await screen.findByRole('textbox', { name: 'Put mail in Trips when…' })
    fireEvent.change(sentence, { target: { value: 'it is a train or plane ticket' } }); fireEvent.blur(sentence)
    await waitFor(async () => expect((await file(mock)).accounts.forest.groups[4].decision).toBe('it is a train or plane ticket'))

    const sure = screen.getByRole('spinbutton', { name: 'How sure for Trips, in percent' })
    fireEvent.change(sure, { target: { value: '75' } }); fireEvent.blur(sure)
    const always = screen.getByRole('textbox', { name: 'Always put mail from these senders in Trips' })
    fireEvent.change(always, { target: { value: 'Tickets@Rail.example' } }); fireEvent.keyDown(always, { key: 'Enter' })
    await waitFor(async () => expect((await file(mock)).accounts.forest.groups[4]).toMatchObject({ threshold: 75, rules: [{ kind: 'address', value: 'tickets@rail.example' }] }))

    // Add a subgroup under Trips and name it Rail.
    fireEvent.click(screen.getByRole('button', { name: 'Add subgroup to Trips' }))
    await waitFor(() => expect(screen.getAllByRole('textbox', { name: 'Group name' })).toHaveLength(2))
    const childName = screen.getAllByRole('textbox', { name: 'Group name' })[1]
    fireEvent.change(childName, { target: { value: 'Rail' } }); fireEvent.keyDown(childName, { key: 'Enter' })
    await waitFor(async () => expect((await file(mock)).accounts.forest.groups[4].children).toEqual([expect.objectContaining({ name: 'Rail', threshold: 60 })]))

    // Context menu removes Security & Alerts.
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Expand Security & Alerts' }))
    await waitFor(() => expect(openMenu).toHaveBeenCalled())
    await waitFor(async () => expect((await file(mock)).accounts.forest.groups.some((g: { name: string }) => g.name === 'Security & Alerts')).toBe(false))

    // Allow multiple groups toggle defaults on and persists changes.
    const multiSwitch = screen.getByRole('switch', { name: 'Allow multiple groups' })
    expect(multiSwitch).toBeChecked()
    fireEvent.click(multiSwitch)
    await waitFor(async () => expect((await file(mock)).multiGroup).toBe(false))
    fireEvent.click(multiSwitch)
    await waitFor(async () => expect((await file(mock)).multiGroup).toBe(true))

    // Plain-language copy check (no internal jargon in visible settings text).
    const words = document.body.textContent ?? ''
    expect(words).not.toMatch(/classif|provider|confidence|threshold|rule|taxonom/i)

    // Switch account: wetland still has its own Security & Alerts group.
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), { target: { value: 'wetland' } })
    expect(await screen.findByRole('button', { name: 'Expand Security & Alerts' })).toBeInTheDocument()
  })
})

describe('Smart groups in the mail view', () => {
  it('lists each account’s groups with icons, colours and counts and opens one with its subgroups', async () => {
    const mock = mailbox()
    await mock.api.data.files.writeTextGuarded(SMART_GROUPS_FILE, JSON.stringify(seeded), null)
    await mergeFolder(emailStoreContext(mock.api.data), 'forest', 'INBOX', ['bills@power.example', 'shop@store.example'].map((from, index) => ({ uid: index + 1, messageId: `<g-${index}@example.test>`, from, to: 'forest@example.test', subject: `Bill ${index}`, date: '2026-01-01T00:00:00.000Z', text: 'Body', snippet: '', flags: [], hasAttachments: false })))
    const rows = (await mock.api.data.dataset('messages').query({})).rows
    for (const [row, categoryId] of [[rows[0], 'billing'], [rows[1], 'receipts']] as const) {
      await mock.api.data.dataset('assignments').insert({ id: String(row.id), categoryId, manual: false, confidence: 0.9, source: 'ai', contentRevision: null, configurationRevision: null, revision: 1 })
      await mock.api.data.dataset('messages').update({ id: String(row.id) }, { categoryId })
    }
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady; await store.smartGroups.ready
    render(<MailboxControls />)
    fireEvent.click(await screen.findByRole('button', { name: 'Mailboxes' }))
    const receipts = await screen.findByRole('menuitemradio', { name: /Receipts/ })
    await waitFor(() => expect(receipts).toHaveTextContent('Receipts2'))
    expect(receipts.querySelector('.email-group-icon svg')).not.toBeNull()
    expect(screen.getByRole('menuitemradio', { name: /Billing/ })).toHaveTextContent('Billing1')
    expect(screen.getByRole('menuitemradio', { name: /Family/ })).toHaveTextContent('Family0')
    expect(screen.getByText('Groups')).toBeInTheDocument()
    fireEvent.click(receipts)
    await waitFor(() => expect(store.getSnapshot().group).toEqual({ accountId: 'forest', groupId: 'receipts' }))
    expect(store.getSnapshot().view).toBe('recent')
    await waitFor(() => expect(mock.mail.queryMessages).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'recent', filters: expect.objectContaining({ categoryIds: ['receipts', 'billing'], categoryAccountId: 'forest' }) })))
    expect(screen.getByRole('button', { name: 'Mailboxes' })).toHaveAttribute('title', 'Receipts')
    fireEvent.click(screen.getByRole('button', { name: 'Mailboxes' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Inbox/ }))
    await waitFor(() => expect(store.getSnapshot().group).toBeNull())
    expect(store.getSnapshot().view).toBe('folder')
  })

  it('shows assigned groups as removable chips, lets users add multiple groups, and keeps single-group fallback', async () => {
    const mock = mailbox()
    await mock.api.data.files.writeTextGuarded(SMART_GROUPS_FILE, JSON.stringify(seeded), null)
    await mock.api.data.dataset('assignments').insert({ id: 'v1:bill', categoryId: 'billing', categoryIds: ['billing'], manual: false, confidence: 0.8, source: 'ai', contentRevision: null, configurationRevision: null, revision: 1 })
    let popoverContent: React.ReactElement | null = null
    mock.api.ui.openPopover = vi.fn((renderFn: (controls: { close(): void }) => React.ReactElement) => {
      popoverContent = renderFn({ close: () => {} })
      return Promise.resolve()
    }) as unknown as typeof mock.api.ui.openPopover
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady; await store.smartGroups.ready
    const message = { id: 'v1:bill', accountId: 'forest', folder: 'INBOX', uid: 1, messageId: '<bill@example.test>', from: 'bills@power.example', to: 'forest@example.test', subject: 'Bill', date: '2026-01-01T00:00:00.000Z', snippet: '', flags: [], hasAttachments: false, memberships: [],
      addresses: { from: [{ name: '', address: 'bills@power.example' }], to: [], cc: [], replyTo: [] } } as unknown as EmailMessageDetail
    render(<MessageOrganization message={message} />)
    expect(await screen.findByText('Receipts / Billing')).toBeInTheDocument()
    expect(screen.getByText('80% sure')).toBeInTheDocument()

    // Open Add group popover and tick Family alongside Billing.
    fireEvent.click(screen.getByRole('button', { name: 'Add group' }))
    expect(popoverContent).not.toBeNull()
    const popover = render(popoverContent!)
    expect(popover.getByText('Up to 3 groups per message')).toBeInTheDocument()
    fireEvent.click(popover.getByRole('menuitemcheckbox', { name: /Family/ }))
    await waitFor(async () => expect(await mock.api.data.dataset('assignments').get({ id: 'v1:bill' })).toMatchObject({ categoryId: 'billing', categoryIds: ['billing', 'family'], manual: true, source: 'manual', confidence: null }))
    popover.unmount()
    expect(await screen.findByText('Family')).toBeInTheDocument()
    expect(await screen.findByText('Set by you')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset to automatic' })).toBeInTheDocument()

    // Remove Billing via its chip × button; Family stays.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Receipts / Billing' }))
    await waitFor(async () => expect(await mock.api.data.dataset('assignments').get({ id: 'v1:bill' })).toMatchObject({ categoryId: 'family', categoryIds: ['family'], manual: true }))
  })

  it('names the most likely group of an ungrouped message for threshold tuning', async () => {
    const mock = mailbox()
    await mock.api.data.files.writeTextGuarded(SMART_GROUPS_FILE, JSON.stringify({ ...seeded, multiGroup: false }), null)
    await mock.api.data.dataset('assignments').insert({ id: 'v1:note', categoryId: null, manual: false, confidence: null, source: null, bestCategoryId: 'billing', bestConfidence: 0.42, contentRevision: null, configurationRevision: null, revision: 1 })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady; await store.smartGroups.ready
    const message = { id: 'v1:note', accountId: 'forest', folder: 'INBOX', uid: 2, messageId: '<note@example.test>', from: 'notes@power.example', to: 'forest@example.test', subject: 'Note', date: '2026-01-01T00:00:00.000Z', snippet: '', flags: [], hasAttachments: false, memberships: [],
      addresses: { from: [{ name: '', address: 'notes@power.example' }], to: [], cc: [], replyTo: [] } } as unknown as EmailMessageDetail
    render(<MessageOrganization message={message} />)
    expect(await screen.findByText('Closest: Receipts / Billing, 42% sure')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('')
  })

  it('removes VIP filter from EmailFilterControls and keeps Contacts, Spam and Group', async () => {
    const mock = mailbox()
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.smartGroups.ready
    render(<MailboxControls />)
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    expect(screen.getByRole('combobox', { name: 'Contacts' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Spam' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'VIP' })).toBeNull()
  })
})
