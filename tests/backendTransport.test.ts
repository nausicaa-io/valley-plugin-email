import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendSentMessage, applyMessageAction, decodeBodyPart, decodeMailbox, encodeMailbox, fetchFolder, listFolders, MailActionUncertain, MailSendError, parseImapResponse, parseMail, sendMail, verifyImap, verifySmtp, type MailTransportApi } from '../src/backend/transport'
import type { EmailAccount } from '../src/mailTypes'
import { decodeBytes, encodeBytes } from '../src/backend/encoding'
import { MailRefusal } from '../src/backend/automation'

const account: EmailAccount = { id: 'mail-fixture', provider: 'pureemail', address: 'sender@example.test', displayName: 'Sender', createdAt: 0,
  imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true } }

function transport(replies: string, chunkSize = 7) {
  const bytes = new TextEncoder().encode(replies)
  let position = 0
  const writes: string[] = []
  const api: MailTransportApi = {
    network: {
      fetch: vi.fn(), open: vi.fn(async () => 'socket'),
      // @ts-expect-error The mock only serves the base64 overload of network.read.
      read: vi.fn(async () => { const chunk = bytes.slice(position, position += chunkSize); return { base64: encodeBytes(chunk), done: position >= bytes.length } }),
      write: vi.fn(async (_id, base64) => { writes.push(new TextDecoder().decode(decodeBytes(base64))) }),
      startTls: vi.fn(async () => undefined), close: vi.fn(async () => undefined)
    },
    credentials: { presence: vi.fn(async () => 'stored' as const), state: vi.fn(), set: vi.fn(), delete: vi.fn(), handle: vi.fn(async () => 'secret-handle'), write: vi.fn(async () => undefined) },
    accounts: { list: vi.fn(), authorize: vi.fn(async () => 'oauth-handle') }
  }
  return { api, writes }
}

const login = (capabilities = 'IMAP4rev1 AUTH=PLAIN MOVE UIDPLUS') => `* OK ready\r\n* CAPABILITY ${capabilities}\r\nV1 OK capabilities\r\n+ \r\nV2 OK authenticated\r\n`
afterEach(() => vi.useRealTimers())

describe('package-owned IMAP and SMTP', () => {
  it('yields inside one MIME parse without changing Unicode text or attachments', async () => {
    vi.useFakeTimers()
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const decode = vi.spyOn(TextDecoder.prototype, 'decode')
    const lines = 2048
    const raw = new TextEncoder().encode('From: fixture@example.test\r\nTo: recipient@example.test\r\nSubject: Grüsse\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="fixture"\r\n\r\n--fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nä ö ü\r\n--fixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="synthetic.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + `${'A'.repeat(76)}\r\n`.repeat(lines) + '--fixture--\r\n')
    let completed = false
    const parsed = parseMail(raw).then(value => { completed = true; return value })
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toBe(false)
    await vi.runAllTimersAsync()
    const value = await parsed
    expect(value).toMatchObject({ subject: 'Grüsse', text: 'ä ö ü\n', attachments: [{ filename: 'synthetic.bin' }] })
    const content = value.attachments[0].content
    expect(typeof content === 'string' ? content.length : content.byteLength).toBe(lines * 57)
    expect(timer.mock.calls.filter(([, delay]) => delay === 0).length).toBeGreaterThanOrEqual(lines / 32)
    expect(decode.mock.calls.filter(([input]) => input && ArrayBuffer.isView(input)).every(([input]) => (input as Uint8Array).buffer.byteLength === (input as Uint8Array).byteLength)).toBe(true)
    timer.mockRestore()
    decode.mockRestore()
  })
  it('waits between empty socket reads and bounds consecutive empty responses', async () => {
    vi.useFakeTimers()
    const fixture = transport('')
    vi.mocked(fixture.api.network.read).mockResolvedValue({ base64: '', done: false } as never)
    const result = verifyImap(fixture.api, account)
    const rejection = expect(result).rejects.toThrow('repeatedly returned no data')
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.api.network.read).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(80)
    await rejection
    expect(fixture.api.network.read).toHaveBeenCalledTimes(9)
    expect(fixture.api.network.close).toHaveBeenCalledOnce()
  })
  it('yields between buffered IMAP reply batches', async () => {
    vi.useFakeTimers()
    const fixture = transport(`${login()}${Array.from({ length: 65 }, (_, index) => `* ${index} EXISTS\r\n`).join('')}V3 OK examined\r\n`, 65536)
    let completed = false
    const result = verifyImap(fixture.api, account).then(() => { completed = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toBe(false)
    await vi.runAllTimersAsync()
    await result
    expect(completed).toBe(true)
  })
  it('tests saved IMAP and SMTP credentials without reading or sending messages', async () => {
    const imap = transport(`${login()}V3 OK examined\r\n`)
    await verifyImap(imap.api, { ...account, login: 'saved-login' })
    expect(imap.writes.join('')).toContain('EXAMINE "INBOX"')
    expect(imap.writes.join('')).not.toMatch(/SELECT|FETCH|STORE|COPY|MOVE/)
    expect(imap.api.credentials.write).toHaveBeenCalledWith('socket', ['\0saved-login\0', { credential: 'secret-handle' }], expect.any(Object))
    const smtp = transport('220 ready\r\n250 AUTH PLAIN\r\n235 2.7.0 authenticated\r\n')
    await verifySmtp(smtp.api, { ...account, login: 'saved-login' })
    expect(smtp.writes.join('')).not.toMatch(/MAIL FROM|RCPT TO|DATA/)
    expect(smtp.api.credentials.write).toHaveBeenCalledWith('socket', ['\0saved-login\0', { credential: 'secret-handle' }], expect.objectContaining({ prefix: 'AUTH PLAIN ' }))
    expect(smtp.api.network.close).toHaveBeenCalledOnce()
  })
  it('preserves a tagged IMAP authentication rejection before the server challenge', async () => {
    const fixture = transport('* OK ready\r\n* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\nV1 OK caps\r\nV2 NO [AUTHENTICATIONFAILED] Login denied\r\n')
    await expect(verifyImap(fixture.api, account)).rejects.toThrow('[AUTHENTICATIONFAILED] Login denied')
    expect(fixture.api.credentials.write).not.toHaveBeenCalled(); expect(fixture.api.network.close).toHaveBeenCalledOnce()
  })
  it('retains SMTP status codes when saved authentication fails', async () => {
    const fixture = transport('220 ready\r\n250 AUTH PLAIN\r\n535 5.7.8 Authentication credentials invalid\r\n')
    await expect(verifySmtp(fixture.api, account)).rejects.toThrow('535 5.7.8 Authentication credentials invalid')
    expect(fixture.writes.join('')).not.toMatch(/MAIL FROM|DATA/)
  })
  it('decodes fragmented literal MIME data and keeps per-folder UIDs and flags', async () => {
    const mime = 'From: "Canopy" <canopy@example.test>\r\nTo: sender@example.test\r\nSubject: =?UTF-8?B?R3LDvHNzZQ==?=\r\nMessage-ID: <first@example.test>\r\nAuto-Submitted: auto-generated\r\nX-Valley-Origin: origin-fixture\r\nDate: Wed, 9 Sep 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nGrüsse aus dem Wald'
    const size = new TextEncoder().encode(mime).length
    const wire = `${login()}* 10 EXISTS\r\nV3 OK selected\r\n* 10 FETCH (UID 72 FLAGS (\\Seen \\Flagged) RFC822.SIZE ${size})\r\nV4 OK listed\r\n* 10 FETCH (UID 72 FLAGS (\\Seen \\Flagged) RFC822.SIZE ${size} BODY[] {${size}}\r\n${mime})\r\nV5 OK fetched\r\n`
    const fixture = transport(wire)
    const { messages } = await fetchFolder(fixture.api, account, 'INBOX', 4)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ uid: 72, messageId: '<first@example.test>', subject: 'Grüsse', text: 'Grüsse aus dem Wald\n', flags: ['\\Seen', '\\Flagged'] })
    expect(messages[0].automationHeaders).toMatchObject({ observed: true, autoSubmitted: ['auto-generated'], origin: ['origin-fixture'] })
    expect(fixture.writes.join('')).toContain('V4 FETCH 7:* (UID FLAGS INTERNALDATE RFC822.SIZE)')
    expect(fixture.writes.join('')).toContain('V5 UID FETCH 72 (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[])')
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
    expect(await applyMessageAction(fixture.api, account, 'INBOX', 72, 'trash')).toEqual({ destinationFolder: 'Trash', destinationUid: 105, destinationUidValidity: 9 })
    expect(fixture.writes.join('')).toContain('UID MOVE 72 "Trash"')
    expect(fixture.writes.join('')).not.toContain('EXPUNGE')
  })

  it('refuses a stale UID after UIDVALIDITY changes before any remote mutation', async () => {
    const fixture = transport(`${login()}* OK [UIDVALIDITY 8] epoch\r\nV3 OK selected\r\n`)
    await expect(applyMessageAction(fixture.api, account, 'INBOX', 72, 'flag', 7)).rejects.toThrow('mailbox changed')
    expect(fixture.writes.join('')).not.toMatch(/UID STORE|UID MOVE|UID COPY/)
  })

  it('refuses destructive broad expunge when the server cannot move one UID safely', async () => {
    const fixture = transport(`${login('IMAP4rev1 AUTH=PLAIN')}V3 OK selected\r\n* LIST (\\Trash) "/" "Trash"\r\nV4 OK listed\r\n`)
    await expect(applyMessageAction(fixture.api, account, 'INBOX', 72, 'trash')).rejects.toThrow('cannot safely move')
    expect(fixture.writes.join('')).not.toMatch(/COPY|STORE|EXPUNGE/)
    expect(fixture.api.network.close).toHaveBeenCalled()
  })

  it.each([
    ['a tagged NO to the flag change', `V3 OK [READ-WRITE] selected\r\nV4 NO [READ-ONLY] mailbox is read-only\r\n`, 'flag', '[READ-ONLY] mailbox is read-only'],
    ['a tagged BAD to the flag change', `V3 OK selected\r\nV4 BAD command refused\r\n`, 'mark-read', 'command refused'],
    ['a tagged NO to the move', `V3 OK selected\r\n* LIST (\\Trash) "/" "Trash"\r\nV4 OK listed\r\nV5 NO [CANNOT] move refused\r\n`, 'trash', '[CANNOT] move refused'],
    ['a refused folder selection', `V3 NO [NONEXISTENT] no such mailbox\r\n`, 'flag', 'no such mailbox']
  ] as const)('reports %s as not applied', async (_case, replies, action, reason) => {
    const fixture = transport(`${login()}${replies}`)
    const failure = await applyMessageAction(fixture.api, account, 'INBOX', 72, action).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(MailRefusal)
    expect(failure).toMatchObject({ code: 'ACTION_NOT_APPLIED', outcome: 'not-applied' })
    expect((failure as Error).message).toContain(reason)
    expect((failure as Error).message).toContain('Not applied')
  })

  it('reports a failure before any mailbox change was sent as not applied', async () => {
    const fixture = transport('* OK ready\r\n* CAPABILITY IMAP4rev1 AUTH=PLAIN MOVE\r\nV1 OK capabilities\r\n+ \r\nV2 NO [AUTHENTICATIONFAILED] rejected\r\n')
    await expect(applyMessageAction(fixture.api, account, 'INBOX', 72, 'flag')).rejects.toMatchObject({ code: 'ACTION_NOT_APPLIED', outcome: 'not-applied' })
    expect(fixture.writes.join('')).not.toMatch(/SELECT|UID STORE/)
  })

  it.each([
    ['the connection closes after the flag change was sent', `V3 OK selected\r\n`, 'flag', 'UID STORE 72 +FLAGS.SILENT (\\Flagged)'],
    ['the server ends the session during the flag change', `V3 OK selected\r\n* BYE shutting down\r\n`, 'mark-unread', 'UID STORE 72 -FLAGS.SILENT (\\Seen)'],
    ['the connection closes after the move was sent', `V3 OK selected\r\n* LIST (\\Archive) "/" "Archive"\r\nV4 OK listed\r\n`, 'archive', 'UID MOVE 72 "Archive"']
  ] as const)('keeps the outcome unknown when %s', async (_case, replies, action, command) => {
    const fixture = transport(`${login()}${replies}`)
    const failure = await applyMessageAction(fixture.api, account, 'INBOX', 72, action).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(MailActionUncertain)
    expect(failure).toMatchObject({ code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' })
    expect((failure as Error).message).toContain('Outcome unknown')
    expect(fixture.writes.join('')).toContain(command)
  })

  it('keeps the outcome unknown when a copy succeeded and its follow-up is refused', async () => {
    const fixture = transport(`${login('IMAP4rev1 AUTH=PLAIN UIDPLUS')}V3 OK selected\r\n* LIST (\\Trash) "/" "Trash"\r\nV4 OK listed\r\nV5 OK [COPYUID 9 72 105] copied\r\nV6 NO store refused\r\n`)
    await expect(applyMessageAction(fixture.api, account, 'INBOX', 72, 'trash')).rejects.toMatchObject({ code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' })
    expect(fixture.writes.join('')).toContain('UID COPY 72 "Trash"')
    expect(fixture.writes.join('')).not.toContain('EXPUNGE')
  })

  it('sends MIME through TLS with envelope Bcc recipients and no Bcc header', async () => {
    const fixture = transport('220 ready\r\n250-localhost\r\n250 STARTTLS\r\n220 TLS\r\n250-localhost\r\n250 AUTH PLAIN LOGIN\r\n235 authenticated\r\n250 sender\r\n250 to\r\n250 bcc\r\n354 send data\r\n250 accepted\r\n')
    const messageId = await sendMail(fixture.api, { ...account, smtp: { ...account.smtp, secure: false } }, { accountId: account.id, to: 'To <to@example.test>', bcc: 'blind@example.test', subject: 'Grüsse', text: 'Hello\n.leading dot', html: '<p>Grüsse</p>', inReplyTo: '<request@example.test>' })
    const wire = fixture.writes.join('')
    expect(messageId).toMatch(/^<.+@example\.test>$/)
    expect(wire).toContain('RCPT TO:<blind@example.test>')
    expect(wire).not.toMatch(/^Bcc:/im)
    expect(wire).toContain('multipart/alternative')
    expect(wire).toMatch(/^In-Reply-To: <request@example.test>$/im)
    expect(wire).toMatch(/^References: <request@example.test>$/im)
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

  const smtpOpen = '220 ready\r\n250 AUTH PLAIN\r\n235 authenticated\r\n'
  it.each([
    ['the server is unreachable', '', 'not-applied'],
    ['a recipient is refused', `${smtpOpen}250 sender\r\n550 no such user\r\n`, 'not-applied'],
    ['the connection drops while the body is sent', `${smtpOpen}250 sender\r\n250 recipient\r\n354 data\r\n`, 'not-applied'],
    ['the server refuses the finished message', `${smtpOpen}250 sender\r\n250 recipient\r\n354 data\r\n554 rejected\r\n`, 'not-applied'],
    ['the connection drops after the end of DATA', `${smtpOpen}250 sender\r\n250 recipient\r\n354 data\r\n`, 'unknown'],
    ['writing the end of DATA fails', `${smtpOpen}250 sender\r\n250 recipient\r\n354 data\r\n250 accepted\r\n`, 'unknown']
  ] as const)('classifies a send failure when %s', async (name, replies, outcome) => {
    const fixture = transport(replies)
    if (!replies) vi.mocked(fixture.api.network.open).mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:2525'))
    const write = fixture.api.network.write
    const failing = name === 'the connection drops while the body is sent' ? 'Hello' : name === 'writing the end of DATA fails' ? '\r\n.\r\n' : undefined
    if (failing) vi.mocked(write).mockImplementation(async (_id, base64) => {
      const text = new TextDecoder().decode(decodeBytes(base64 as string))
      if (text.includes(failing)) throw new Error('socket closed')
      fixture.writes.push(text)
    })
    const sending = sendMail(fixture.api, account, { accountId: account.id, to: 'fern@example.test', subject: 'Canopy', text: 'Hello' })
    await expect(sending).rejects.toBeInstanceOf(MailSendError)
    await expect(sending).rejects.toMatchObject({ outcome })
    expect(fixture.writes.join('').includes('\r\n.\r\n')).toBe(name === 'the connection drops after the end of DATA' || name === 'the server refuses the finished message')
    if (replies) expect(fixture.api.network.close).toHaveBeenCalledOnce()
  })

  it('keeps an echoed credential out of a send failure', async () => {
    const fixture = transport('220 ready\r\n250 AUTH PLAIN\r\n535 AUTH PLAIN AHNlbmRlcgBodW50ZXIy rejected password=hunter2\r\n')
    const sending = sendMail(fixture.api, account, { accountId: account.id, to: 'fern@example.test', subject: 'Canopy', text: 'Hello' })
    await expect(sending).rejects.toMatchObject({ outcome: 'not-applied' })
    const message = await sending.catch((error: Error) => error.message)
    expect(message).toContain('535')
    expect(message).not.toMatch(/AHNlbmRlcgBodW50ZXIy|hunter2/)
  })

  it('sets automatic headers only from the backend-owned provenance argument', async () => {
    const fixture = transport('220 ready\r\n250 AUTH PLAIN\r\n235 authenticated\r\n250 sender\r\n250 recipient\r\n354 data\r\n250 accepted\r\n')
    const origin = '11111111-1111-4111-8111-111111111111'
    await sendMail(fixture.api, account, { accountId: account.id, to: 'fern@example.test', subject: 'Canopy', text: 'Fern', ...{ headers: { 'Auto-Submitted': 'no', 'X-Valley-Origin': 'forged' } } }, { origin, messageId: '<automated@example.test>' })
    const wire = fixture.writes.join('')
    expect(wire).toMatch(/^Auto-Submitted: auto-generated$/im)
    expect(wire).toMatch(new RegExp(`^X-Valley-Origin: ${origin}$`, 'im'))
    expect(wire).toContain('Message-ID: <automated@example.test>')
    expect(wire).not.toContain('forged')
  })

  it('fetches flags first and downloads bodies only for uncached UIDs', async () => {
    const mime = 'From: moss@example.test\r\nTo: sender@example.test\r\nSubject: Moss\r\nMessage-ID: <moss@example.test>\r\n\r\nMoss body'
    const flags = '* 2 FETCH (UID 71 FLAGS (\\Seen) INTERNALDATE "09-Sep-2026 10:00:00 +0000" RFC822.SIZE 900)\r\n* 3 FETCH (UID 72 FLAGS () INTERNALDATE "10-Sep-2026 10:00:00 +0000" RFC822.SIZE 120)\r\nV4 OK fetched\r\n'
    const fixture = transport(`${login()}* 3 EXISTS\r\n* OK [UIDVALIDITY 9] valid\r\nV3 OK selected\r\n${flags}* 3 FETCH (UID 72 FLAGS () BODY[] {${new TextEncoder().encode(mime).length}}\r\n${mime})\r\nV5 OK fetched\r\n`)
    const stored = { uid: 71, uidValidity: 9, logicalId: 'v1:stored', contentRevision: 'stored', complete: true, messageId: '<fern@example.test>', from: 'fern@example.test', to: 'sender@example.test', subject: 'Fern', date: '', snippet: '', flags: [], hasAttachments: false }
    const cached = vi.fn(async (uids: number[], uidValidity: number | undefined) => new Map(uids.includes(71) && uidValidity === 9 ? [[71, stored]] : []))
    const { messages, uidValidity } = await fetchFolder(fixture.api, account, 'INBOX', 2, cached)
    expect(uidValidity).toBe(9)
    expect(cached).toHaveBeenCalledWith([71, 72], 9)
    const commands = fixture.writes.join('')
    expect(commands).toContain('V4 FETCH 2:* (UID FLAGS INTERNALDATE RFC822.SIZE)\r\n')
    expect(commands).toContain('V5 UID FETCH 72 (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[])\r\n')
    expect(commands.match(/BODY\.PEEK/g)).toHaveLength(1)
    expect(messages).toEqual([{ ...stored, flags: ['\\Seen'], receivedAt: '09-Sep-2026 10:00:00 +0000' }, expect.objectContaining({ uid: 72, uidValidity: 9, messageId: '<moss@example.test>', text: expect.stringContaining('Moss body'), receivedAt: undefined })])
  })

  it('downloads no bodies when every listed UID is cached', async () => {
    const fixture = transport(`${login()}* 1 EXISTS\r\n* OK [UIDVALIDITY 9] valid\r\nV3 OK selected\r\n* 1 FETCH (UID 71 FLAGS (\\Flagged) INTERNALDATE "09-Sep-2026 10:00:00 +0000")\r\nV4 OK fetched\r\n`)
    const stored = { uid: 71, uidValidity: 9, logicalId: 'v1:stored', contentRevision: 'stored', messageId: '<fern@example.test>', from: 'fern@example.test', to: 'sender@example.test', subject: 'Fern', date: '', snippet: '', flags: [], hasAttachments: false }
    const { messages } = await fetchFolder(fixture.api, account, 'INBOX', 50, async () => new Map([[71, stored]]))
    expect(fixture.writes.join('')).not.toContain('BODY')
    expect(messages).toEqual([{ ...stored, flags: ['\\Flagged'], receivedAt: '09-Sep-2026 10:00:00 +0000' }])
  })
})

describe('large body parts', () => {
  it('decodes base64, quoted-printable and split UTF-8 the same slice by slice as through the MIME parser', async () => {
    const value = `${'Grünspecht über der Wiese äöüß – 31 cm. '.repeat(40)}\n`.repeat(400)
    const bytes = new TextEncoder().encode(value)
    const base64 = new TextEncoder().encode(encodeBytes(bytes).replace(/.{76}/g, '$&\r\n'))
    let line = 0
    const quoted = new TextEncoder().encode([...bytes].map(byte => {
      if (byte === 10) { line = 0; return '\r\n' }
      const token = byte >= 33 && byte <= 126 && byte !== 61 ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
      const soft = line + token.length > 75 ? '=\r\n' : ''
      line = (soft ? 0 : line) + token.length
      return soft + token
    }).join(''))
    expect(base64.length).toBeGreaterThan(256 * 1024)
    expect(await decodeBodyPart(base64, { part: '1', kind: 'text', encoding: 'base64', size: base64.length, charset: 'utf-8' })).toBe(value)
    expect(await decodeBodyPart(quoted, { part: '1', kind: 'html', encoding: 'quoted-printable', size: quoted.length, charset: 'utf-8' })).toBe(value.replace(/\n/g, '\r\n'))
    expect(await decodeBodyPart(bytes, { part: '1', kind: 'text', encoding: '8bit', size: bytes.length })).toBe(value)
  })
})

describe('sent mail in the server Sent folder (F15)', () => {
  it('appends the accepted MIME to the special-use Sent folder as seen and reads APPENDUID', async () => {
    const fixture = transport(`${login()}* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Sent) "/" "Gesendet"\r\nV3 OK listed\r\n+ go ahead\r\nV4 OK [APPENDUID 9 12] appended\r\n`, 65536)
    const mime = new TextEncoder().encode('From: sender@example.test\r\nSubject: Grüsse\r\n\r\n.leading dot stays single\r\n')
    expect(await appendSentMessage(fixture.api, account, mime)).toEqual({ folder: 'Gesendet', uid: 12, uidValidity: 9 })
    const wire = fixture.writes.join('')
    expect(wire).toContain(`V4 APPEND "Gesendet" (\\Seen) {${mime.length}}\r\n`)
    expect(wire).toContain('\r\n\r\n.leading dot stays single\r\n\r\n')
    expect(fixture.api.network.close).toHaveBeenCalledOnce()
  })
  it('hands the undotted MIME to the caller only after the server accepted the message', async () => {
    const fixture = transport('220 ready\r\n250 AUTH PLAIN\r\n235 ok\r\n250 sender\r\n250 recipient\r\n354 data\r\n250 queued\r\n', 65536)
    const accepted = vi.fn()
    await sendMail(fixture.api, account, { accountId: account.id, to: 'fern@example.test', subject: 'Canopy', text: '.dot line' }, undefined, accepted)
    expect(accepted).toHaveBeenCalledOnce()
    const mime = new TextDecoder().decode(accepted.mock.calls[0][0] as Uint8Array)
    expect(mime).toMatch(/\r\n\.dot line/)
    expect(fixture.writes.join('')).toMatch(/\r\n\.\.dot line/)
    const refused = transport('220 ready\r\n250 AUTH PLAIN\r\n235 ok\r\n250 sender\r\n250 recipient\r\n354 data\r\n554 refused\r\n', 65536)
    const never = vi.fn()
    await expect(sendMail(refused.api, account, { accountId: account.id, to: 'fern@example.test', subject: 'Canopy', text: 'x' }, undefined, never)).rejects.toThrow('554')
    expect(never).not.toHaveBeenCalled()
  })
})
