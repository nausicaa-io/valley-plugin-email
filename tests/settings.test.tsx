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

  it('lists mailboxes as full-bleed rows and opens one as a detail page', async () => {
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
})
