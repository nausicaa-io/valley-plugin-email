import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { createMailMock as createMockValleyApi } from './mailMock'
import { register } from '../src/index'
import { Settings } from '../src/Settings'
import { emailDisplaySettingsKey, readEmailDisplaySettings } from '../src/hooks'

afterEach(cleanup)

describe('Email Settings', () => {
  it('tests the saved account independently of unsaved credential inputs', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'email' } })
    mock.mail.listAccounts = async () => ({ ok: true, data: { accounts: [{ id: 'saved', provider: 'pureemail', address: 'mail@example.com', secretState: 'stored', imap: { host: 'imap.example.com', port: 993, secure: true }, smtp: { host: 'smtp.example.com', port: 465, secure: true }, createdAt: 0 }] } })
    const test = vi.spyOn(mock.mail, 'testAccount').mockResolvedValue({ ok: true, data: { checkedAt: new Date().toISOString(), imap: { ok: false, error: 'Authentication failed' }, smtp: { ok: true } } })
    const update = vi.spyOn(mock.mail, 'updateSmtpAccount'), send = vi.spyOn(mock.mail, 'sendEmail')
    const dispose = register(mock.api); render(<Settings />)
    await waitFor(() => expect(screen.getByText('Credentials saved')).toBeInTheDocument())
    expect(screen.queryByText('connected')).toBeNull()
    fireEvent.click(screen.getByText('mail@example.com'))
    fireEvent.change(screen.getByLabelText('Password (or app password)'), { target: { value: 'unsaved-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(test).toHaveBeenCalledWith('saved'))
    expect(await screen.findByText('IMAP: Authentication failed')).toBeInTheDocument(); expect(screen.getByText('SMTP: Authenticated')).toBeInTheDocument()
    expect(screen.getByLabelText('Password (or app password)')).toHaveValue('unsaved-password')
    expect(update).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); dispose()
  })
  it('submits a PureMail account through host Settings controls', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'email' } })
    const submit = vi.spyOn(mock.mail, 'addSmtpAccount')
    const dispose = register(mock.api)
    const call = (mock.api.registerView as unknown as {
      mock: { calls: [string, ComponentType][] }
    }).mock.calls.find(([id]) => id === 'email.settings')
    expect(call).toBeDefined()

    render(React.createElement(call![1]))
    fireEvent.click(screen.getByRole('button', { name: 'Add mailbox' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Email address' }), {
      target: { value: 'mail@example.com' }
    })
    fireEvent.change(screen.getByLabelText('Password (or app password)'), {
      target: { value: 'secret' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'IMAP host' }), {
      target: { value: 'imap.example.com' }
    })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'IMAP port' }), {
      target: { value: '143' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'SMTP host' }), {
      target: { value: 'smtp.example.com' }
    })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'SMTP port' }), {
      target: { value: '587' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))

    await waitFor(() => {
      expect(submit).toHaveBeenCalledWith({
          address: 'mail@example.com',
          password: 'secret',
          imap: { host: 'imap.example.com', port: 143, secure: true },
          smtp: { host: 'smtp.example.com', port: 587, secure: false }
      })
    })
    dispose()
  })

  it.each(['ok', 'stored'] as const)('keeps %s mailboxes editable through save and remount', async secretState => {
    const mock = createMockValleyApi({ manifest: { id: 'email' } })
    mock.mail.listAccounts = async () => ({
      ok: true,
      data: {
        accounts: [
          {
            id: 'g1',
            provider: 'google',
            address: 'cloud@example.com',
            imap: { host: '', port: 993, secure: true },
            smtp: { host: '', port: 465, secure: true },
            createdAt: 0
          },
          {
            id: 'p1',
            provider: 'pureemail',
            secretState,
            address: 'mailbox@example.com',
            imap: { host: 'imap.example.com', port: 993, secure: true },
            smtp: { host: 'smtp.example.com', port: 465, secure: true },
            createdAt: 0
          }
        ]
      }
    })
    const dispose = register(mock.api)
    const call = (mock.api.registerView as unknown as {
      mock: { calls: [string, ComponentType][] }
    }).mock.calls.find(([id]) => id === 'email.settings')

    const { container } = render(React.createElement(call![1]))
    // The shared list-page chrome, never bordered cards: a header band with `+`
    // and one hairline row per mailbox.
    await waitFor(() => expect(container.querySelectorAll('.settings-list-row')).toHaveLength(2))
    expect(container.querySelector('.settings-listpage-header')).not.toBeNull()
    if (secretState === 'stored') expect(screen.getByText('Credentials saved')).toBeInTheDocument()

    fireEvent.click(screen.getByText('mailbox@example.com'))
    expect(screen.getByRole('button', { name: 'Remove account' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'HTML content' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Remote images' })).toBeChecked()
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'HTML content' })) })
    expect(screen.getByRole('switch', { name: 'HTML content' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Remote images' })).toBeChecked()
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Remote images' })) })
    expect(mock.api.settings.get()[emailDisplaySettingsKey('p1')]).toEqual({ htmlContent: false, remoteImages: false })
    // An OAuth mailbox is managed in Settings → Accounts, so its page never
    // offers a remove button of its own.
    fireEvent.click(screen.getByRole('button', { name: 'Back to Mail accounts' }))
    fireEvent.click(screen.getByText('cloud@example.com'))
    expect(screen.queryByRole('button', { name: 'Remove account' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'HTML content' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Remote images' })).toBeChecked()
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Remote images' })) })
    expect(mock.api.settings.get()[emailDisplaySettingsKey('g1')]).toEqual({ htmlContent: true, remoteImages: false })
    cleanup()
    render(<Settings />)
    fireEvent.click(screen.getByText('mailbox@example.com'))
    expect(screen.getByRole('switch', { name: 'HTML content' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Remote images' })).not.toBeChecked()
    const save = vi.spyOn(mock.api.settings, 'set').mockResolvedValueOnce({ ok: false, error: 'Unavailable' })
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'HTML content' })) })
    expect(screen.getByText('Could not save email display settings. Try again.')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'HTML content' })).not.toBeChecked()
    save.mockRestore()
    dispose()
  })

  it('defaults missing or invalid account display settings to enabled', () => {
    const mock = createMockValleyApi({ manifest: { id: 'email' }, settings: {
      [emailDisplaySettingsKey('invalid')]: { htmlContent: null, remoteImages: 'false' },
      [emailDisplaySettingsKey('off')]: { htmlContent: false, remoteImages: false }
    } })
    const dispose = register(mock.api)
    expect(readEmailDisplaySettings()).toEqual({ htmlContent: true, remoteImages: true })
    expect(readEmailDisplaySettings('new')).toEqual({ htmlContent: true, remoteImages: true })
    expect(readEmailDisplaySettings('invalid')).toEqual({ htmlContent: true, remoteImages: true })
    expect(readEmailDisplaySettings('off')).toEqual({ htmlContent: false, remoteImages: false })
    dispose()
  })

  it('reconnects an existing mailbox with blank password input and preserves its identity', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'email' } })
    mock.mail.listAccounts = async () => ({ ok: true, data: { accounts: [{ id: 'existing', provider: 'pureemail', address: 'mail@example.com', login: 'saved-user', imap: { host: 'imap.example.com', port: 993, secure: true }, smtp: { host: 'smtp.example.com', port: 465, secure: true }, createdAt: 0 }] } })
    const reconnect = vi.spyOn(mock.mail, 'updateSmtpAccount').mockResolvedValue({ ok: true })
    const add = vi.spyOn(mock.mail, 'addSmtpAccount'), remove = vi.spyOn(mock.mail, 'removeAccount')
    const dispose = register(mock.api)
    render(<Settings />)
    await waitFor(() => expect(screen.getByText('mail@example.com')).toBeInTheDocument())
    fireEvent.click(screen.getByText('mail@example.com'))
    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveValue('mail@example.com')
    expect(screen.getByRole('textbox', { name: 'Login / username' })).toHaveValue('saved-user')
    expect(screen.getByLabelText('Password (or app password)')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Save and reconnect' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Login / username' }), { target: { value: 'updated-user' } })
    fireEvent.change(screen.getByLabelText('Password (or app password)'), { target: { value: 'new-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and reconnect' }))
    await waitFor(() => expect(reconnect).toHaveBeenCalledWith({ accountId: 'existing', address: 'mail@example.com', login: 'updated-user', password: 'new-secret' }))
    await waitFor(() => expect(screen.getByLabelText('Password (or app password)')).toHaveValue(''))
    expect(add).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    dispose()
  })

  it('edits the Contacts .vcf folder and sync limits on the main Email settings page', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'email' } })
    const dispose = register(mock.api)
    render(<Settings />)

    const folder = screen.getByRole('textbox', { name: 'Contacts folder' })
    fireEvent.change(folder, { target: { value: '.archive/contacts' } })
    fireEvent.blur(folder)
    await waitFor(() => expect(mock.api.settings.get().contactsRoot).toBe('.archive/contacts'))

    const perSync = screen.getByRole('spinbutton', { name: 'Messages per sync' })
    fireEvent.change(perSync, { target: { value: '120' } })
    fireEvent.blur(perSync)
    await waitFor(() => expect(mock.api.settings.get().syncLimit).toBe(120))

    const cacheDays = screen.getByRole('spinbutton', { name: 'Keep cached mail for' })
    fireEvent.change(cacheDays, { target: { value: '90' } })
    fireEvent.blur(cacheDays)
    await waitFor(() => expect(mock.api.settings.get().cacheDays).toBe(90))
    dispose()
  })
})
