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
  { id: 'receipts', name: 'Receipts', decision: 'Bills and subscriptions', threshold: 60, rules: [], children: [{ id: 'billing', name: 'Billing', decision: 'Electricity and other bills', threshold: 60, rules: [], children: [] }] },
  { id: 'family', name: 'Family', decision: '', threshold: 60, rules: [{ kind: 'address', value: 'aunt@kin.example' }], children: [] }
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
  it('works after one switch, edits groups like a folder list and keeps extras behind More', async () => {
    const mock = mailbox()
    mock.api.ai.connections = vi.fn(async () => [
      { id: 'jev-main', provider: 'jev', providerName: 'Jev', providerCapabilities: ['classification', 'models'] },
      { id: 'chat', provider: 'openai', providerName: 'OpenAI', providerCapabilities: ['chat'] },
      { id: 'unit', provider: 'unit-test-classifier', providerName: 'Test AI', providerCapabilities: ['classification'] }
    ] as unknown as AiConnectionStatus[])
    mock.api.ai.models = vi.fn(async ({ provider }: { provider: string }) => (provider === 'jev' ? [{ provider, id: 'jev-1.13.0' }, { provider, id: 'jev-latest' }] : [{ provider, id: 'fixture' }]) as AiModelInfo[])
    const openMenu = vi.fn(async () => 'remove')
    mock.api.ui.openMenu = openMenu as unknown as typeof mock.api.ui.openMenu
    dispose = register(mock.api); render(<Settings />)
    expect(screen.queryByRole('combobox', { name: 'AI' })).toBeNull()
    fireEvent.click(await screen.findByRole('switch', { name: 'Sort new mail into groups' }))
    await waitFor(async () => expect((await file(mock)).enabled).toBe(true))
    await waitFor(async () => expect(Object.keys((await file(mock)).accounts)).toEqual(['forest', 'wetland']))
    const starters = (await file(mock)).accounts.forest.groups
    expect(starters.map((group: { name: string; children: { name: string }[] }) => [group.name, group.children.map(child => child.name)])).toEqual([['Receipts', ['Subscriptions', 'Bills']], ['Travel', []], ['Newsletters', []]])
    expect(starters[0]).toMatchObject({ decision: 'it is a receipt, invoice or payment confirmation', threshold: 60, rules: [] })

    const ai = await screen.findByRole('combobox', { name: 'AI' })
    await waitFor(() => expect(within(ai).getAllByRole('option').map(option => option.textContent)).toEqual(['Valley default', 'Jev', 'Test AI']))
    fireEvent.change(ai, { target: { value: 'unit\u0000unit-test-classifier' } })
    await waitFor(async () => expect((await file(mock)).provider).toEqual({ provider: 'unit-test-classifier', connectionId: 'unit', model: 'fixture' }))
    fireEvent.change(ai, { target: { value: 'jev-main\u0000jev' } })
    await waitFor(async () => expect((await file(mock)).provider).toEqual({ provider: 'jev', connectionId: 'jev-main', model: 'jev-1.13.0' }))
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveValue('forest')
    expect(screen.queryByRole('spinbutton', { name: /How sure/ })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /Always put mail from/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Travel' }))
    const rename = await screen.findByRole('textbox', { name: 'Group name' })
    fireEvent.change(rename, { target: { value: 'Trips' } }); fireEvent.keyDown(rename, { key: 'Enter' })
    await waitFor(async () => expect((await file(mock)).accounts.forest.groups[1].name).toBe('Trips'))
    const sentence = await screen.findByRole('textbox', { name: 'Put mail in Trips when…' })
    fireEvent.change(sentence, { target: { value: 'it is a train or plane ticket' } }); fireEvent.blur(sentence)
    fireEvent.click(screen.getByRole('button', { name: 'Add subgroup to Trips' }))
    const child = await screen.findByRole('textbox', { name: 'Group name' })
    fireEvent.change(child, { target: { value: 'Rail' } }); fireEvent.keyDown(child, { key: 'Enter' })
    await waitFor(async () => expect((await file(mock)).accounts.forest.groups[1]).toMatchObject({ name: 'Trips', decision: 'it is a train or plane ticket', children: [{ name: 'Rail', threshold: 60 }] }))

    const more = screen.getAllByRole('button', { name: /More/ })[3]
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    const sure = screen.getByRole('spinbutton', { name: 'How sure for Trips, in percent' })
    fireEvent.change(sure, { target: { value: '75' } }); fireEvent.blur(sure)
    const always = screen.getByRole('textbox', { name: 'Always put mail from these senders in Trips' })
    fireEvent.change(always, { target: { value: 'Tickets@Rail.example' } }); fireEvent.keyDown(always, { key: 'Enter' })
    await waitFor(async () => expect((await file(mock)).accounts.forest.groups[1]).toMatchObject({ threshold: 75, rules: [{ kind: 'address', value: 'tickets@rail.example' }] }))

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Newsletters' }))
    await waitFor(() => expect(openMenu).toHaveBeenCalled())
    expect((openMenu.mock.calls[0] as unknown as [{ id?: string }[]])[0].map(item => item.id)).toEqual(['rename', 'add', undefined, 'remove'])
    await waitFor(async () => expect((await file(mock)).accounts.forest.groups.map((group: { name: string }) => group.name)).toEqual(['Receipts', 'Trips']))

    const words = (document.querySelector('.email-smart-groups')?.textContent ?? '') + screen.getByRole('switch', { name: 'Sort new mail into groups' }).closest('section')!.textContent
    expect(words).not.toMatch(/classif|provider|confidence|threshold|rule|taxonom/i)
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), { target: { value: 'wetland' } })
    expect(await screen.findByRole('button', { name: 'Newsletters' })).toBeInTheDocument()
  })

  it('gives the daily-allowance number field its own width, so a stacked row still paints the host control', async () => {
    const mock = mailbox()
    await mock.api.data.files.writeTextGuarded(SMART_GROUPS_FILE, JSON.stringify(seeded), null)
    const widths = new Map<string, unknown>()
    const NumberField = mock.api.ui.settings.NumberField
    mock.api.ui.settings.NumberField = ((props: React.ComponentProps<typeof NumberField>) => { widths.set(props.ariaLabel ?? '', props.style?.width); return React.createElement(NumberField, props) }) as typeof NumberField
    dispose = register(mock.api); render(<Settings />)
    await screen.findByRole('spinbutton', { name: 'Sort at most this many new messages per account a day' })
    expect(widths.get('Sort at most this many new messages per account a day')).toEqual(expect.any(String))
  })
})

describe('Smart groups in the mail view', () => {
  it('lists each account’s groups with counts and opens one with its subgroups', async () => {
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

  it('shows the assigned group with its basis and keeps a correction', async () => {
    const mock = mailbox()
    await mock.api.data.files.writeTextGuarded(SMART_GROUPS_FILE, JSON.stringify(seeded), null)
    await mock.api.data.dataset('assignments').insert({ id: 'v1:bill', categoryId: 'billing', manual: false, confidence: 0.8, source: 'ai', contentRevision: null, configurationRevision: null, revision: 1 })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady; await store.smartGroups.ready
    const message = { id: 'v1:bill', accountId: 'forest', folder: 'INBOX', uid: 1, messageId: '<bill@example.test>', from: 'bills@power.example', to: 'forest@example.test', subject: 'Bill', date: '2026-01-01T00:00:00.000Z', snippet: '', flags: [], hasAttachments: false, memberships: [],
      addresses: { from: [{ name: '', address: 'bills@power.example' }], to: [], cc: [], replyTo: [] } } as unknown as EmailMessageDetail
    render(<MessageOrganization message={message} />)
    const picker = await screen.findByRole('combobox', { name: 'Category' })
    await waitFor(() => expect(picker).toHaveValue('billing'))
    expect(within(picker).getAllByRole('option').map(option => option.textContent)).toEqual(['Uncategorized', 'Receipts', 'Receipts / Billing', 'Family'])
    expect(screen.getByText('80% sure')).toBeInTheDocument()
    fireEvent.change(picker, { target: { value: 'family' } })
    await waitFor(async () => expect(await mock.api.data.dataset('assignments').get({ id: 'v1:bill' })).toMatchObject({ categoryId: 'family', manual: true, source: 'manual', confidence: null }))
    expect(await screen.findByText('Set by you')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset to automatic' })).toBeInTheDocument()
  })
})
