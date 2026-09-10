import { describe, expect, it, vi } from 'vitest'
import { createMailMock as createMockValleyApi } from './mailMock'
import type { CachedMessage, EmailAccount } from '../src/mailTypes'
import { emailAgentTools, registerEmailAgentCommands } from '../src/agentTools'

const account: EmailAccount = {
  id: 'forest-mail',
  provider: 'pureemail',
  address: 'botany@example.test',
  displayName: 'Forest Mail',
  imap: { host: 'imap.example.test', port: 993, secure: true },
  smtp: { host: 'smtp.example.test', port: 465, secure: true },
  createdAt: Date.parse('2026-08-30T08:00:00.000Z')
}

const message: CachedMessage = {
  uid: 17,
  messageId: '<canopy@example.test>',
  from: 'Canopy Survey <canopy@example.test>',
  replyTo: 'field-team@example.test',
  to: 'botany@example.test',
  subject: 'Canopy update',
  date: '2026-08-30T09:00:00.000Z',
  snippet: 'The upper canopy gained a new layer.',
  text: 'The upper canopy gained a new layer.\nMoss cover remained stable.',
  flags: ['\\Flagged'],
  hasAttachments: false
}

function setup() {
  const mock = createMockValleyApi()
  const email = mock.mail
  vi.spyOn(email, 'listAccounts').mockResolvedValue({ ok: true, data: { accounts: [account] } })
  vi.spyOn(email, 'listFolders').mockResolvedValue({
    ok: true,
    data: {
      folders: ['INBOX', 'Archive'],
      mailboxes: [
        { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', selectable: true, cachedTotal: 2, cachedUnread: 1 },
        { path: 'Archive', name: 'Archive', specialUse: '\\Archive', selectable: true, cachedTotal: 8, cachedUnread: 0 }
      ]
    }
  })
  vi.spyOn(email, 'syncFolder').mockResolvedValue({ ok: true })
  vi.spyOn(email, 'readFolder').mockResolvedValue({ ok: true, data: { messages: [message] } })
  vi.spyOn(email, 'applyMessageAction').mockResolvedValue({
    ok: true,
    data: { action: 'archive', folder: 'INBOX', destinationFolder: 'Archive', messages: [] }
  })
  vi.spyOn(email, 'sendEmail').mockResolvedValue({ ok: true, data: { messageId: '<sent@example.test>' } })
  registerEmailAgentCommands(mock.api)
  return { mock, email, provider: emailAgentTools(mock.api) }
}

describe('email assistant tools', () => {
  it('publishes discover, read, mutation, and send tools with accurate side effects', () => {
    const { provider } = setup()
    expect(provider.tools.map(({ name, sideEffect }) => [name, sideEffect])).toEqual([
      ['list_mail_accounts', 'read'],
      ['list_mail_folders', 'read'],
      ['read_inbox', 'read'],
      ['search_email_messages', 'read'],
      ['read_mail_message', 'read'],
      ['update_email_message', 'write'],
      ['compose_email', 'write'],
      ['reply_to_email', 'write'],
      ['forward_email', 'write']
    ])
  })

  it('lists folders and returns stable UIDs from search for a full message read', async () => {
    const { email, provider } = setup()
    const folders = JSON.parse(String(await provider.execute('list_mail_folders', { accountId: account.id })))
    expect(folders.folders[0]).toMatchObject({ path: 'INBOX', cachedUnread: 1 })

    const found = JSON.parse(String(await provider.execute('search_email_messages', { accountId: account.id, folder: 'INBOX', query: 'moss' })))
    expect(found.messages).toEqual([expect.objectContaining({ uid: 17, subject: 'Canopy update', flagged: true })])
    expect(email.syncFolder).toHaveBeenCalledWith('forest-mail', 'INBOX', 50)

    const read = JSON.parse(String(await provider.execute('read_mail_message', { accountId: account.id, folder: 'INBOX', uid: 17 })))
    expect(read).toMatchObject({ uid: 17, replyTo: 'field-team@example.test', text: expect.stringContaining('Moss cover') })
    expect(email.applyMessageAction).not.toHaveBeenCalled()
  })

  it('routes mailbox mutations through the package backend action', async () => {
    const { email, provider } = setup()
    const output = JSON.parse(String(await provider.execute('update_email_message', { accountId: account.id, folder: 'INBOX', uid: 17, action: 'archive' })))
    expect(output).toMatchObject({ uid: 17, action: 'archive', destinationFolder: 'Archive' })
    expect(email.applyMessageAction).toHaveBeenCalledWith({
      accountId: 'forest-mail', folder: 'INBOX', uid: 17, action: 'archive'
    })
  })

  it('builds threaded replies and forwards from cached messages', async () => {
    const { email, provider } = setup()
    await provider.execute('reply_to_email', { accountId: account.id, folder: 'INBOX', uid: 17, text: 'Thank you for the field report.' })
    expect(email.sendEmail).toHaveBeenNthCalledWith(1, expect.objectContaining({
      accountId: 'forest-mail',
      to: 'field-team@example.test',
      subject: 'Re: Canopy update',
      inReplyTo: '<canopy@example.test>',
      text: expect.stringContaining('> Moss cover remained stable.')
    }))

    await provider.execute('forward_email', { accountId: account.id, folder: 'INBOX', uid: 17, to: 'archive@example.test', text: 'For the seasonal archive.' })
    expect(email.sendEmail).toHaveBeenNthCalledWith(2, expect.objectContaining({
      accountId: 'forest-mail',
      to: 'archive@example.test',
      subject: 'Fwd: Canopy update',
      text: expect.stringContaining('---------- Forwarded message ----------')
    }))
  })

  it('requires explicit account and folder targets without sending or changing mail during preview', async () => {
    const { mock, email, provider } = setup()
    await expect(provider.execute('update_email_message', { uid: 17, action: 'trash' })).rejects.toThrow('accountId is required')
    expect(await mock.api.commands.preview(`${mock.api.pluginId}:compose-email`, { accountId: account.id, to: 'field@example.test', subject: 'Survey', text: 'Ready.' })).toMatchObject({ ok: true, value: { action: 'compose-email', accountId: account.id } })
    expect(email.sendEmail).not.toHaveBeenCalled()
    expect(email.applyMessageAction).not.toHaveBeenCalled()
  })
})
