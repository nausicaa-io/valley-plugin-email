import * as React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmailMessageDetail } from '../src/mailTypes'
import { createMailMock } from './mailMock'
import { register } from '../src/index'
import { Panel } from '../src/Panel'
import { getStore } from '../src/store'
import { injectStyles } from '../src/styles'

const folders = ['INBOX', 'Archive', 'Drafts', 'Junk', 'Sent', 'Trash', 'Field notes', 'Herbarium', 'Moths', 'Ponds', 'Raptors', 'Seeds']
const message: EmailMessageDetail = {
  id: 'heron', accountId: 'one', folder: 'INBOX', uid: 3, messageId: '<heron@example.com>', from: 'heron@example.com', to: 'reader@example.com',
  subject: 'Heron count', snippet: 'Heron count', text: 'Twelve herons.', date: '2026-08-30T09:00:00.000Z', flags: ['\\Seen'], hasAttachments: false,
  memberships: [{ accountId: 'one', folder: 'INBOX', uid: 3 }],
  addresses: { from: [{ name: '', address: 'heron@example.com' }], to: [{ name: '', address: 'reader@example.com' }], cc: [], replyTo: [] }
}
let dispose: (() => void | Promise<void>) | undefined
afterEach(async () => { cleanup(); await dispose?.(); dispose = undefined })

function setup() {
  const mock = createMailMock({ manifest: { id: 'email' } })
  mock.mail.listAccounts = async () => ({ ok: true, data: { accounts: [{ id: 'one', provider: 'pureemail', address: 'one@example.com', displayName: 'one',
    imap: { host: 'example.com', port: 993, secure: true }, smtp: { host: 'example.com', port: 465, secure: true }, createdAt: 1 }] } })
  mock.mail.listFolders = async () => ({ ok: true, data: { folders, mailboxes: folders.map((path) => ({ path, name: path === 'INBOX' ? 'Inbox' : path, ...(path === 'INBOX' ? { specialUse: '\\Inbox' } : {}), selectable: true, cachedTotal: 0, cachedUnread: 0 })) } })
  mock.mail.queryMessages = vi.fn(async () => ({ ok: true, data: { messages: [message] } }))
  mock.mail.readMessage = vi.fn(async () => ({ ok: true, data: { message } }))
  dispose = register(mock.api)
  return mock
}

// The plugin's stylesheet as flat `selector { declarations }` pairs (at-rule blocks are skipped).
function rules(): Map<string, string> {
  const off = injectStyles()
  const css = document.getElementById('notes-email-plugin-styles')?.textContent ?? ''
  off()
  const flat = css.replace(/@[^{]+\{([^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  return new Map([...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body.replace(/\s+/g, '')]))
}

describe('Email sidebar layout', () => {
  it('draws the sidebar toolbar as one standard header row: 37px content and a 1px bottom line in a 38px bar', () => {
    const css = rules()
    const bar = css.get('.email-panel .email-panel-toolbar > :is(.email-mailbox-controls,.email-add-account)')
    expect(bar).toContain('height:var(--app-bar-height)')
    expect(bar).toContain('box-sizing:border-box')
    expect(bar).toContain('border-bottom:1pxsolidvar(--border-light)')
    expect(bar).toContain('flex:none')
    for (const [selector, body] of css) {
      if (!selector.includes('email-mailbox-controls') && !selector.includes('email-panel-toolbar')) continue
      expect(body, selector).not.toContain('calc(var(--app-bar-height)-1px)')
    }
  })

  it('shows every mailbox at full height instead of an inner scroller, and lets the sidebar scroll', () => {
    const css = rules()
    const options = css.get('.email-inline-options')
    expect(options).not.toMatch(/max-height|overflow/)
    expect(options).toContain('padding:6px')
    expect(css.get('.email-inline-options .email-account-popover')).toContain('max-height:none')
    expect(css.get('.email-inline-options .email-account-popover')).toContain('overflow:visible')
    expect(css.get('.email-panel')).toContain('overflow-y:auto')
  })

  it('centres every toolbar icon in an equal 26px square and draws keyboard rings inside the button, never after a pointer press', () => {
    const css = rules()
    const account = css.get('.email-mailbox-controls.compact .email-account-selector')
    expect(account).toContain('justify-content:center')
    expect(account).toContain('width:26px')
    expect(account).toContain('padding:0')
    expect(account).toContain('flex:0026px')
    expect(css.get('.email-icon-btn')).toMatch(/width:26px;height:26px;/)
    expect(css.get('.email-selector:focus-visible')).toContain('outline-offset:-1px')
    expect(css.get('.email-mailbox-controls .email-icon-btn:focus-visible')).toContain('outline-offset:-1px')
    expect(css.get('.email-mailbox-controls [data-focus-source="pointer"]:focus-visible')).toContain('outline:none')
  })

  it('gives the sidebar mailbox selector room for a long folder name such as Posteingang', () => {
    const selector = rules().get('.email-mailbox-controls.compact .email-selector')
    expect(selector).toContain('max-width:150px')
  })

  it('lets the compose recipient field shrink with a narrow pane instead of overflowing it', () => {
    const add = rules().get('.email-recipient-add')
    expect(add).toContain('min-width:0')
    expect(add).toContain('flex:11120px')
    expect(add).not.toContain('min-width:120px')
  })

  it('marks toolbar buttons pressed with a pointer and clears the mark on the next key', async () => {
    setup()
    await getStore().whenReady
    render(<Panel />)
    const trigger = await screen.findByRole('button', { name: 'Mailboxes' })
    const filters = screen.getByRole('button', { name: 'Filters' })
    fireEvent.pointerDown(trigger)
    expect(trigger.dataset.focusSource).toBe('pointer')
    expect(filters.dataset.focusSource).toBe('pointer')
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(trigger.dataset.focusSource).toBeUndefined()
    expect(filters.dataset.focusSource).toBeUndefined()
  })

  it('lists every folder in the open Mailboxes section and keeps arrow, Escape and trigger focus behaviour', async () => {
    setup()
    await getStore().whenReady
    const { container } = render(<Panel />)
    const trigger = await screen.findByRole('button', { name: 'Mailboxes' })
    trigger.focus()
    fireEvent.click(trigger)
    const section = container.querySelector<HTMLElement>('.email-panel-toolbar > .email-inline-options')!
    expect(section).toBeTruthy()
    const options = [...section.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')]
    expect(options.map((option) => option.textContent?.replace('✓', '').trim())).toEqual(expect.arrayContaining(['Inbox', 'Archive', 'Seeds', 'Raptors']))
    expect(options.length).toBeGreaterThanOrEqual(3 + folders.length)
    options[0].focus()
    fireEvent.keyDown(options[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(options[1])
    fireEvent.keyDown(options[1], { key: 'End' })
    expect(document.activeElement).toBe(options.at(-1))
    fireEvent.keyDown(options.at(-1)!, { key: 'Escape' })
    expect(container.querySelector('.email-inline-options')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mailboxes' }))
  })

  it.each(['Mailboxes', 'Filters'])('closes the open %s section on Escape while its trigger has focus', async (name) => {
    setup()
    await getStore().whenReady
    const { container } = render(<Panel />)
    const trigger = await screen.findByRole('button', { name })
    trigger.focus()
    fireEvent.click(trigger)
    expect(container.querySelector('.email-inline-options')).toBeTruthy()
    const escape = fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(container.querySelector('.email-inline-options')).toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
    expect(escape).toBe(false)
  })
})
