import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { createMailMock as createMockValleyApi } from './mailMock'
import { register } from '../src/index'

afterEach(cleanup)

function panelView(api: ReturnType<typeof createMockValleyApi>['api']): ComponentType {
  const call = (api.registerView as unknown as {
    mock: { calls: [string, ComponentType][] }
  }).mock.calls.find(([id]) => id === 'email.panel')
  expect(call).toBeDefined()
  return call![1]
}

describe('Email panel', () => {
  it('names itself in the shared sidebar header, like every other panel', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'email' } })
    const dispose = register(mock.api)

    const { container } = render(React.createElement(panelView(mock.api)))
    // The title is the shell's own `.panel-header`/`.panel-title`, not a
    // plugin-local band faking the 37px chrome.
    const title = container.querySelector('.panel-header .panel-title')
    expect(title?.textContent).toBe('Email')
    // It survives every state — the empty one included.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add account' })).toBeTruthy())
    expect(container.querySelector('.panel-header .panel-title')).not.toBeNull()
    dispose()
  })

  it('reports a failure as a notice carrying the driver’s own message', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'email' } })
    mock.mail.listAccounts = async () => ({
      ok: false,
      error: 'IMAP login rejected for mailbox@example.com'
    })
    const dispose = register(mock.api)

    const { container } = render(React.createElement(panelView(mock.api)))
    await waitFor(() => expect(container.querySelector('.email-notice')).not.toBeNull())
    // A generic sentence would throw the real cause away.
    expect(screen.getByText('IMAP login rejected for mailbox@example.com')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(container.querySelector('.email-notice')).toBeNull()
    dispose()
  })

})
