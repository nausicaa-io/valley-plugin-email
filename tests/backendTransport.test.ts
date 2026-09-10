import { describe, expect, it, vi } from 'vitest'
import { applyMessageAction, decodeMailbox, encodeMailbox, fetchFolder, listFolders, parseImapResponse, sendMail, verifyImap, type MailTransportApi } from '../src/backend/transport'
import type { EmailAccount } from '../src/mailTypes'
import { decodeBytes, encodeBytes } from '../src/backend/encoding'

const account: EmailAccount = { id: 'mail-fixture', provider: 'pureemail', address: 'sender@example.test', displayName: 'Sender', createdAt: 0,
  imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true } }

function transport(replies: string, chunkSize = 7) {
  const bytes = new TextEncoder().encode(replies)
  let position = 0
  const writes: string[] = []
  const api: MailTransportApi = {
    network: {
      fetch: vi.fn(), open: vi.fn(async () => 'socket'),
      read: vi.fn(async () => { const chunk = bytes.slice(position, position += chunkSize); return { base64: encodeBytes(chunk), done: position >= bytes.length } }),
      write: vi.fn(async (_id, base64) => { writes.push(new TextDecoder().decode(decodeBytes(base64))) }),
      startTls: vi.fn(async () => undefined), close: vi.fn(async () => undefined)
    },
    credentials: { state: vi.fn(), set: vi.fn(), delete: vi.fn(), handle: vi.fn(async () => 'secret-handle'), write: vi.fn(async () => undefined) },
    accounts: { list: vi.fn(), authorize: vi.fn(async () => 'oauth-handle') }
  }
  return { api, writes }
}

const login = (capabilities = 'IMAP4rev1 AUTH=PLAIN MOVE UIDPLUS') => `* OK ready\r\n* CAPABILITY ${capabilities}\r\nV1 OK capabilities\r\n+ \r\nV2 OK authenticated\r\n`

describe('package-owned IMAP and SMTP', () => {
  it('decodes fragmented literal MIME data and keeps per-folder UIDs and flags', async () => {
    const mime = 'From: "Anna" <anna@example.test>\r\nTo: sender@example.test\r\nSubject: =?UTF-8?B?R3LDvHNzZQ==?=\r\nMessage-ID: <first@example.test>\r\nDate: Wed, 9 Sep 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nGrüsse aus Zürich'
    const wire = `${login()}* 10 EXISTS\r\nV3 OK selected\r\n* 10 FETCH (UID 72 FLAGS (\\Seen \\Flagged) BODY[] {${new TextEncoder().encode(mime).length}}\r\n${mime})\r\nV4 OK fetched\r\n`
    const fixture = transport(wire)
    const messages = await fetchFolder(fixture.api, account, 'INBOX', 4)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ uid: 72, messageId: '<first@example.test>', subject: 'Grüsse', text: 'Grüsse aus Zürich\n', flags: ['\\Seen', '\\Flagged'] })
    expect(fixture.writes.join('')).toContain('FETCH 7:* (UID FLAGS BODY.PEEK[])')
    expect(fixture.api.credentials.write).toHaveBeenCalledWith('socket', ['\0sender@example.test\0', { credential: 'secret-handle' }], { encoding: 'base64', prefix: '', suffix: '\r\n' })
    expect(fixture.writes.join('')).not.toContain('secret-handle')
    expect(fixture.api.network.close).toHaveBeenCalledWith('socket')
  })

  it('upgrades TLS before requesting any password and supports SASL LOGIN', async () => {
    const fixture = transport('* OK ready\r\nV1 OK TLS\r\n* CAPABILITY IMAP4rev1 AUTH=LOGIN\r\nV2 OK caps\r\n+ username\r\n+ password\r\nV3 OK login\r\nV4 OK selected\r\n')
    await verifyImap(fixture.api, { ...account, imap: { ...account.imap, secure: false } })
    expect(fixture.api.network.startTls).toHaveBeenCalledWith('socket')
    expect(vi.mocked(fixture.api.network.startTls).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fixture.api.credentials.handle).mock.invocationCallOrder[0])
    expect(fixture.writes.join('')).toContain('AUTHENTICATE LOGIN')
    expect(fixture.api.credentials.write).toHaveBeenCalledWith('socket', [{ credential: 'secret-handle' }], { encoding: 'base64', suffix: '\r\n' })
  })

  it('keeps OAuth bearer tokens behind an authorized account handle', async () => {
    const fixture = transport(`${login('IMAP4rev1 AUTH=XOAUTH2')}V3 OK selected\r\n`)
    await verifyImap(fixture.api, { ...account, provider: 'google' })
    expect(fixture.api.accounts.authorize).toHaveBeenCalledWith(account.id, 'mail', { host: account.imap.host, port: 993, security: 'tls' })
    expect(fixture.api.credentials.handle).not.toHaveBeenCalled()
    expect(fixture.api.credentials.write).toHaveBeenCalledWith('socket', ['user=sender@example.test\x01auth=Bearer ', { credential: 'oauth-handle' }, '\x01\x01'], expect.any(Object))
  })

  it('decodes mailbox names and retains special-use and nonselectable folders', async () => {
    const fixture = transport(`${login()}* LIST (\\Sent) "/" "${encodeMailbox('Gesendet/Grüsse & mehr')}"\r\n* LIST (\\Noselect) "/" "Root"\r\nV3 OK listed\r\n`)
    expect(await listFolders(fixture.api, account)).toMatchObject([
      { path: 'Gesendet/Grüsse & mehr', name: 'Grüsse & mehr', specialUse: '\\Sent', selectable: true },
      { path: 'Root', selectable: false }
    ])
    expect(decodeMailbox(encodeMailbox('日本語 & Grüsse 🏔'))).toBe('日本語 & Grüsse 🏔')
    expect(() => parseImapResponse(['* LIST (unfinished'])).toThrow('Incomplete')
  })

  it('moves exactly the requested UID and captures the destination UID', async () => {
    const fixture = transport(`${login()}V3 OK selected\r\n* LIST (\\Trash) "/" "Trash"\r\nV4 OK listed\r\nV5 OK [COPYUID 9 72 105] moved\r\n`)
    expect(await applyMessageAction(fixture.api, account, 'INBOX', 72, 'trash')).toEqual({ destinationFolder: 'Trash', destinationUid: 105 })
    expect(fixture.writes.join('')).toContain('UID MOVE 72 "Trash"')
    expect(fixture.writes.join('')).not.toContain('EXPUNGE')
  })

  it('refuses destructive broad expunge when the server cannot move one UID safely', async () => {
    const fixture = transport(`${login('IMAP4rev1 AUTH=PLAIN')}V3 OK selected\r\n* LIST (\\Trash) "/" "Trash"\r\nV4 OK listed\r\n`)
    await expect(applyMessageAction(fixture.api, account, 'INBOX', 72, 'trash')).rejects.toThrow('cannot safely move')
    expect(fixture.writes.join('')).not.toMatch(/COPY|STORE|EXPUNGE/)
    expect(fixture.api.network.close).toHaveBeenCalled()
  })

  it('sends MIME through TLS with envelope Bcc recipients and no Bcc header', async () => {
    const fixture = transport('220 ready\r\n250-localhost\r\n250 STARTTLS\r\n220 TLS\r\n250-localhost\r\n250 AUTH PLAIN LOGIN\r\n235 authenticated\r\n250 sender\r\n250 to\r\n250 bcc\r\n354 send data\r\n250 accepted\r\n')
    const messageId = await sendMail(fixture.api, { ...account, smtp: { ...account.smtp, secure: false } }, { accountId: account.id, to: 'To <to@example.test>', bcc: 'blind@example.test', subject: 'Grüsse', text: 'Hello\n.leading dot', html: '<p>Grüsse</p>' })
    const wire = fixture.writes.join('')
    expect(messageId).toMatch(/^<.+@example\.test>$/)
    expect(wire).toContain('RCPT TO:<blind@example.test>')
    expect(wire).not.toMatch(/^Bcc:/im)
    expect(wire).toContain('multipart/alternative')
    expect(wire).toContain('\r\n.\r\n')
    expect(fixture.api.network.startTls).toHaveBeenCalled()
    expect(fixture.api.credentials.write).toHaveBeenCalledWith('socket', expect.any(Array), expect.objectContaining({ prefix: 'AUTH PLAIN ' }))
  })

  it('rejects authentication failures and closes the stream', async () => {
    const fixture = transport('* OK ready\r\n* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\nV1 OK caps\r\n+ \r\nV2 NO authentication failed\r\n')
    await expect(verifyImap(fixture.api, account)).rejects.toThrow('authentication failed')
    expect(fixture.api.network.close).toHaveBeenCalledTimes(1)
    expect(fixture.writes.join('')).not.toContain('SELECT')
  })
})
