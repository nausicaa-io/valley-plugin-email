import { t } from './localization'
import PostalMime, { type Address } from 'postal-mime'
import { createMimeMessage } from 'mimetext/browser'
import type { PluginNetworkApi, PluginCredentialApi, PluginAccountApi, PluginSocketEndpoint, PluginCredentialStore } from '@valley/plugin-sdk/pluginNetwork'
import type { CachedMessage, EmailAccount, EmailMailbox, EmailMessageAction, EmailSendInput } from '../mailTypes'
import { decodeBytes, encodeBytes } from './encoding'
import { parseEmailAddresses } from './query'

export interface MailTransportApi {
  network: Pick<PluginNetworkApi, 'fetch' | 'open' | 'read' | 'write' | 'startTls' | 'close'>
  credentials: Pick<PluginCredentialApi, 'state' | 'set' | 'delete' | 'handle' | 'write'>
  accounts: Pick<PluginAccountApi, 'list' | 'authorize'>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export function accountEndpoint(account: EmailAccount, kind: 'imap' | 'smtp'): PluginSocketEndpoint {
  const endpoint = account[kind]
  return { host: endpoint.host, port: endpoint.port, security: endpoint.secure ? 'tls' : 'starttls' }
}

export const MAIL_CREDENTIAL_STORE: PluginCredentialStore = { file: 'secrets.json', valueField: 'password', metadata: { kind: 'password' } }
export function credentialName(accountId: string): string { return accountId }
const credentialSource = (account: EmailAccount) => ({ store: MAIL_CREDENTIAL_STORE, endpoints: [accountEndpoint(account, 'imap'), accountEndpoint(account, 'smtp')] })

class Connection {
  private buffer = new Uint8Array()
  constructor(readonly api: MailTransportApi, readonly id: string) {}
  async write(value: string): Promise<void> { await this.api.network.write(this.id, encodeBytes(encoder.encode(value))) }
  async close(): Promise<void> { await this.api.network.close(this.id).catch(() => undefined) }
  async bytes(length: number): Promise<Uint8Array> {
    if (length > MAX_MESSAGE_BYTES) throw new Error(t('email.backend.messageLimit'))
    while (this.buffer.length < length) await this.more()
    const value = this.buffer.slice(0, length)
    this.buffer = this.buffer.slice(length)
    return value
  }
  async line(): Promise<string> {
    let end: number
    while ((end = this.buffer.indexOf(10)) < 0) {
      if (this.buffer.length > 1024 * 1024) throw new Error(t('email.backend.lineLimit'))
      await this.more()
    }
    const value = decoder.decode(this.buffer.slice(0, end)).replace(/\r$/, '')
    this.buffer = this.buffer.slice(end + 1)
    return value
  }
  private async more(): Promise<void> {
    const reply = await this.api.network.read(this.id, 65536)
    const bytes = decodeBytes(reply.base64)
    if (!bytes.length && reply.done) throw new Error(t('email.backend.closed'))
    const next = new Uint8Array(this.buffer.length + bytes.length)
    next.set(this.buffer)
    next.set(bytes, this.buffer.length)
    this.buffer = next
  }
  async authenticate(account: EmailAccount, kind: 'imap' | 'smtp', prefix: string, suffix = '\r\n'): Promise<void> {
    const credential = account.provider === 'pureemail'
      ? await this.api.credentials.handle(credentialName(account.id), credentialSource(account))
      : await this.api.accounts.authorize(account.id, 'mail', accountEndpoint(account, kind))
    const template = account.provider === 'pureemail'
      ? [`\0${account.address}\0`, { credential }]
      : [`user=${account.address}\x01auth=Bearer `, { credential }, '\x01\x01']
    await this.api.credentials.write(this.id, template, { encoding: 'base64', prefix, suffix })
  }
  async password(account: EmailAccount): Promise<void> {
    const credential = await this.api.credentials.handle(credentialName(account.id), credentialSource(account))
    await this.api.credentials.write(this.id, [{ credential }], { encoding: 'base64', suffix: '\r\n' })
  }
}

type ImapValue = string | null | Uint8Array | ImapValue[]
interface ImapReply { line: string; tokens: ImapValue[] }

export function parseImapResponse(parts: Array<string | Uint8Array>): ImapValue[] {
  const literals: Uint8Array[] = []
  const source = parts.map((part) => typeof part === 'string' ? part : ` \u0000${literals.push(part) - 1}\u0000 `).join('')
  let position = 0
  const list = (nested: boolean): ImapValue[] => {
    const values: ImapValue[] = []
    while (position < source.length) {
      const char = source[position]
      if (/\s/.test(char)) { position++; continue }
      if (char === ')') { position++; if (!nested) throw new Error(t('email.backend.imapResponse')); return values }
      if (char === '(') { position++; values.push(list(true)); continue }
      if (char === '\u0000') {
        const end = source.indexOf('\u0000', ++position)
        if (end < 0) throw new Error(t('email.backend.imapLiteral'))
        values.push(literals[Number(source.slice(position, end))]); position = end + 1; continue
      }
      if (char === '"') {
        let value = ''; position++
        let closed = false
        while (position < source.length) {
          const next = source[position++]
          if (next === '"') { closed = true; break }
          if (next === '\\') value += source[position++] ?? ''
          else value += next
        }
        if (!closed) throw new Error(t('email.backend.imapQuoted'))
        values.push(value); continue
      }
      const start = position
      while (position < source.length && !/[\s()]/.test(source[position])) position++
      const atom = source.slice(start, position)
      values.push(atom.toUpperCase() === 'NIL' ? null : atom)
    }
    if (nested) throw new Error(t('email.backend.imapIncomplete'))
    return values
  }
  return list(false)
}

export function encodeMailbox(value: string): string {
  return value.replace(/[^\x20-\x7e]+|&/g, (part) => {
    if (part === '&') return '&-'
    const bytes = new Uint8Array(part.length * 2)
    for (let index = 0; index < part.length; index++) { bytes[index * 2] = part.charCodeAt(index) >> 8; bytes[index * 2 + 1] = part.charCodeAt(index) & 255 }
    return `&${encodeBytes(bytes).replace(/\//g, ',').replace(/=+$/, '')}-`
  })
}

export function decodeMailbox(value: string): string {
  return value.replace(/&([A-Za-z0-9+,]*)-/g, (_match, encoded: string) => {
    if (!encoded) return '&'
    const bytes = decodeBytes(encoded.replace(/,/g, '/'))
    if (bytes.length % 2) throw new Error(t('email.backend.mailboxEncoding'))
    let decoded = ''
    for (let index = 0; index < bytes.length; index += 2) decoded += String.fromCharCode(bytes[index] * 256 + bytes[index + 1])
    return decoded
  })
}

function quote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error(t('email.backend.mailboxName'))
  return `"${encodeMailbox(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

class ImapConnection extends Connection {
  private sequence = 0
  readonly capabilities = new Set<string>()
  private async reply(): Promise<ImapReply> {
    let line = await this.line()
    const first = line
    const parts: Array<string | Uint8Array> = []
    while (/\{\d+\+?\}$/.test(line)) {
      const literal = /\{(\d+)\+?\}$/.exec(line)!
      parts.push(line.slice(0, literal.index), await this.bytes(Number(literal[1])))
      line = await this.line()
    }
    parts.push(line)
    return { line: first, tokens: parseImapResponse(parts) }
  }
  private async finish(tag: string): Promise<ImapReply[]> {
    const replies: ImapReply[] = []
    for (let count = 0; count < 100000; count++) {
      const reply = await this.reply()
      if (reply.line.startsWith(`${tag} `)) {
        if (!reply.line.startsWith(`${tag} OK`)) throw new Error(reply.line.replace(/^\S+\s+\S+\s*/, ''))
        return [...replies, reply]
      }
      if (reply.line.startsWith('* BYE')) throw new Error(t('email.backend.ended'))
      if (reply.line.startsWith('+')) { await this.write('\r\n'); throw new Error(t('email.backend.authentication')) }
      replies.push(reply)
    }
    throw new Error(t('email.backend.imapLimit'))
  }
  async command(command: string): Promise<ImapReply[]> {
    const tag = `V${++this.sequence}`
    await this.write(`${tag} ${command}\r\n`)
    return this.finish(tag)
  }
  async initialize(account: EmailAccount): Promise<void> {
    const greeting = await this.line()
    if (!/^\* (OK|PREAUTH)\b/.test(greeting)) throw new Error(t('email.backend.rejected'))
    if (!account.imap.secure) { await this.command('STARTTLS'); await this.api.network.startTls(this.id) }
    const response = await this.command('CAPABILITY')
    for (const reply of response) if (reply.tokens[1] === 'CAPABILITY') for (const value of reply.tokens.slice(2)) if (typeof value === 'string') this.capabilities.add(value.toUpperCase())
    if (greeting.startsWith('* PREAUTH')) return
    const tag = `V${++this.sequence}`
    const mechanism = account.provider !== 'pureemail' ? 'XOAUTH2' : this.capabilities.has('AUTH=PLAIN') ? 'PLAIN' : this.capabilities.has('AUTH=LOGIN') ? 'LOGIN' : 'PLAIN'
    await this.write(`${tag} AUTHENTICATE ${mechanism}\r\n`)
    const continuation = await this.line()
    if (!continuation.startsWith('+')) throw new Error(t('email.backend.authUnsupported'))
    if (mechanism === 'LOGIN') {
      await this.write(`${encodeBytes(encoder.encode(account.address))}\r\n`)
      if (!(await this.line()).startsWith('+')) throw new Error(t('email.backend.authentication'))
      await this.password(account)
    } else await this.authenticate(account, 'imap', '')
    await this.finish(tag)
  }
}

async function withImap<T>(api: MailTransportApi, account: EmailAccount, run: (connection: ImapConnection) => Promise<T>): Promise<T> {
  const connection = new ImapConnection(api, await api.network.open(accountEndpoint(account, 'imap')))
  try { await connection.initialize(account); return await run(connection) }
  finally { await connection.close() }
}

function mailboxReplies(replies: ImapReply[]): EmailMailbox[] {
  return replies.flatMap(({ tokens }): EmailMailbox[] => {
    if (tokens[0] !== '*' || tokens[1] !== 'LIST' || !Array.isArray(tokens[2])) return []
    const flags = tokens[2].filter((value): value is string => typeof value === 'string')
    const raw = tokens[4] instanceof Uint8Array ? decoder.decode(tokens[4]) : String(tokens[4] ?? '')
    const path = decodeMailbox(raw)
    const delimiter = typeof tokens[3] === 'string' ? tokens[3] : undefined
    return [{ path, name: delimiter ? path.split(delimiter).at(-1) || path : path, delimiter,
      specialUse: flags.find((flag) => /^\\(?:All|Archive|Drafts|Flagged|Junk|Sent|Trash)$/i.test(flag)),
      selectable: !flags.some((flag) => flag.toLowerCase() === '\\noselect'), cachedTotal: 0, cachedUnread: 0 }]
  })
}

export async function listFolders(api: MailTransportApi, account: EmailAccount): Promise<EmailMailbox[]> {
  return withImap(api, account, async (connection) => mailboxReplies(await connection.command('LIST "" "*"')))
}

const addressText = (addresses?: Address[]): string => (addresses ?? []).flatMap((address) => address.group ?? [address])
  .map((address) => address.name ? `${JSON.stringify(address.name)} <${address.address}>` : address.address).join(', ')

export async function fetchFolder(api: MailTransportApi, account: EmailAccount, folder: string, limit: number): Promise<CachedMessage[]> {
  return withImap(api, account, async (connection) => {
    const selected = await connection.command(`SELECT ${quote(folder)}`)
    const total = Number(selected.find((reply) => reply.tokens[2] === 'EXISTS')?.tokens[1] ?? 0)
    if (!total) return []
    const replies = await connection.command(`FETCH ${Math.max(1, total - limit + 1)}:* (UID FLAGS BODY.PEEK[])`)
    const messages: CachedMessage[] = []
    for (const reply of replies) {
      if (reply.tokens[2] !== 'FETCH' || !Array.isArray(reply.tokens[3])) continue
      const values = reply.tokens[3]
      const fields = new Map<string, ImapValue>()
      for (let index = 0; index < values.length; index += 2) fields.set(String(values[index]).toUpperCase(), values[index + 1])
      const raw = fields.get('BODY[]') ?? fields.get('RFC822')
      const uid = Number(fields.get('UID'))
      if (!(raw instanceof Uint8Array) || !Number.isSafeInteger(uid) || uid < 1) continue
      const parsed = await PostalMime.parse(raw)
      const flags = fields.get('FLAGS')
      messages.push({ uid, messageId: parsed.messageId ?? `missing:${folder}:${uid}`, from: addressText(parsed.from ? [parsed.from] : []),
        replyTo: addressText(parsed.replyTo) || undefined, to: addressText(parsed.to), cc: addressText(parsed.cc) || undefined,
        subject: parsed.subject ?? '(no subject)', date: parsed.date && Number.isFinite(Date.parse(parsed.date)) ? new Date(parsed.date).toISOString() : new Date().toISOString(),
        snippet: (parsed.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200), text: parsed.text, html: parsed.html,
        flags: Array.isArray(flags) ? flags.filter((value): value is string => typeof value === 'string') : [], hasAttachments: parsed.attachments.length > 0 })
    }
    return messages
  })
}

export async function verifyImap(api: MailTransportApi, account: EmailAccount): Promise<void> {
  await withImap(api, account, (connection) => connection.command('SELECT "INBOX"').then(() => undefined))
}

export async function applyMessageAction(api: MailTransportApi, account: EmailAccount, folder: string, uid: number, action: EmailMessageAction): Promise<{ destinationFolder?: string; destinationUid?: number }> {
  return withImap(api, account, async (connection) => {
    await connection.command(`SELECT ${quote(folder)}`)
    if (action === 'archive' || action === 'trash' || action === 'junk') {
      const folders = mailboxReplies(await connection.command('LIST "" "*"'))
      const uses = action === 'archive' ? ['\\Archive', '\\All'] : action === 'junk' ? ['\\Junk'] : ['\\Trash']
      const destinationFolder = folders.find((entry) => entry.selectable && uses.some((use) => use.toLowerCase() === entry.specialUse?.toLowerCase()))?.path
      if (!destinationFolder) throw new Error(t('email.backend.mailboxMissing', { mailbox: t(`email.backend.${action === 'archive' ? 'archive' : action === 'junk' ? 'junk' : 'trash'}`) }))
      if (destinationFolder === folder) throw new Error(t('email.backend.alreadyMoved', { mailbox: destinationFolder }))
      let replies: ImapReply[]
      if (connection.capabilities.has('MOVE') || connection.capabilities.has('IMAP4REV2')) replies = await connection.command(`UID MOVE ${uid} ${quote(destinationFolder)}`)
      else {
        if (!connection.capabilities.has('UIDPLUS')) throw new Error(t('email.backend.moveUnsupported'))
        replies = await connection.command(`UID COPY ${uid} ${quote(destinationFolder)}`)
        await connection.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`)
        await connection.command(`UID EXPUNGE ${uid}`)
      }
      const match = /\[COPYUID \d+ \d+ (\d+)\]/i.exec(replies.map((reply) => reply.line).join('\n'))
      return { destinationFolder, ...(match ? { destinationUid: Number(match[1]) } : {}) }
    }
    const flag = action === 'flag' || action === 'unflag' ? '\\Flagged' : '\\Seen'
    await connection.command(`UID STORE ${uid} ${action === 'mark-unread' || action === 'unflag' ? '-' : '+'}FLAGS.SILENT (${flag})`)
    return {}
  })
}

async function smtpReply(connection: Connection, expected: number[]): Promise<string[]> {
  const lines: string[] = []
  for (let count = 0; count < 1000; count++) {
    const line = await connection.line()
    if (!/^\d{3}[ -]/.test(line)) throw new Error(t('email.backend.smtpResponse'))
    lines.push(line)
    if (line[3] === ' ') {
      if (!expected.includes(Number(line.slice(0, 3)))) throw new Error(line.slice(4))
      return lines
    }
  }
  throw new Error(t('email.backend.smtpLimit'))
}

export async function sendMail(api: MailTransportApi, account: EmailAccount, input: EmailSendInput): Promise<string> {
  const recipients = [...parseEmailAddresses(input.to, true), ...parseEmailAddresses(input.cc ?? '', true), ...parseEmailAddresses(input.bcc ?? '', true)]
  if (!recipients.length) throw new Error(t('email.backend.recipient'))
  const message = createMimeMessage()
  message.setSender({ addr: account.address, name: account.displayName })
  message.setRecipients(parseEmailAddresses(input.to, true).map((address) => ({ addr: address.address, name: address.name })))
  if (input.cc) message.setCc(parseEmailAddresses(input.cc, true).map((address) => ({ addr: address.address, name: address.name })))
  message.setSubject(input.subject)
  const messageId = `<${crypto.randomUUID()}@${account.address.split('@')[1]}>`
  message.setHeader('Message-ID', messageId)
  if (input.inReplyTo) message.setHeader('In-Reply-To', input.inReplyTo)
  message.addMessage({ contentType: 'text/plain', data: input.text ?? '' })
  if (input.html) message.addMessage({ contentType: 'text/html', data: input.html })
  const connection = new Connection(api, await api.network.open(accountEndpoint(account, 'smtp')))
  try {
    await smtpReply(connection, [220])
    await connection.write('EHLO localhost\r\n')
    let capabilities = await smtpReply(connection, [250])
    if (!account.smtp.secure) {
      await connection.write('STARTTLS\r\n'); await smtpReply(connection, [220]); await api.network.startTls(connection.id)
      await connection.write('EHLO localhost\r\n'); capabilities = await smtpReply(connection, [250])
    }
    const auth = capabilities.filter((line) => /^250[ -]AUTH(?:=| )/i.test(line)).join(' ').toUpperCase()
    if (account.provider === 'pureemail' && !/\bPLAIN\b/.test(auth) && /\bLOGIN\b/.test(auth)) {
      await connection.write('AUTH LOGIN\r\n'); await smtpReply(connection, [334])
      await connection.write(`${encodeBytes(encoder.encode(account.address))}\r\n`); await smtpReply(connection, [334])
      await connection.password(account)
    } else await connection.authenticate(account, 'smtp', `AUTH ${account.provider === 'pureemail' ? 'PLAIN' : 'XOAUTH2'} `)
    await smtpReply(connection, [235])
    await connection.write(`MAIL FROM:<${account.address}>\r\n`); await smtpReply(connection, [250])
    for (const recipient of recipients) { await connection.write(`RCPT TO:<${recipient.address}>\r\n`); await smtpReply(connection, [250, 251]) }
    await connection.write('DATA\r\n'); await smtpReply(connection, [354])
    const raw = encoder.encode(message.asRaw().replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'))
    for (let offset = 0; offset < raw.length; offset += 32768) await api.network.write(connection.id, encodeBytes(raw.subarray(offset, offset + 32768)))
    await connection.write('\r\n.\r\n'); await smtpReply(connection, [250])
    return messageId
  } finally { await connection.close() }
}
