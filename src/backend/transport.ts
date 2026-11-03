import { t } from './localization'
import PostalMime, { decodeWords, type Address, type Email } from 'postal-mime'
import { createMimeMessage } from 'mimetext/browser'
import type { PluginNetworkApi, PluginCredentialApi, PluginAccountApi, PluginSocketEndpoint, PluginCredentialStore } from '@valley/plugin-sdk/pluginNetwork'
import type { CachedMessage, EmailAccount, EmailMailbox, EmailMessageAction, EmailSendInput, MailAttachmentPart, MailBodyPart, MailStructure } from '../mailTypes'
import { decodeBytes, encodeBytes } from './encoding'
import { parseEmailAddresses } from './query'
import { digest } from './identity'
import { automationHeaders, MailRefusal } from './automation'

export interface MailTransportApi {
  network: Pick<PluginNetworkApi, 'fetch' | 'open' | 'read' | 'write' | 'startTls' | 'close'>
  credentials: Pick<PluginCredentialApi, 'presence' | 'state' | 'set' | 'delete' | 'handle' | 'write'>
  accounts: Pick<PluginAccountApi, 'list' | 'authorize'>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
/** Per-message memory bounds for sync; the guest heap is 128 MiB and every large string also crosses the host boundary as JSON. */
export const MAIL_SYNC_LIMITS = {
  /** Messages up to this RFC822.SIZE are downloaded whole; larger ones as headers, structure and text bodies. */
  wholeMessageBytes: 1024 * 1024,
  /** Bytes of whole messages requested by one FETCH; each batch is parsed and stored before the next. */
  batchBytes: 4 * 1024 * 1024,
  batchMessages: 25,
  /** Text and HTML body parts are downloaded during sync while their sizes add up to this; the rest when the message is opened. */
  bodyBytes: 1024 * 1024,
  headerBytes: 64 * 1024,
  /** Largest single body part fetched on demand. */
  openPartBytes: 16 * 1024 * 1024,
  /** Cached UIDs below the listed window checked with UID SEARCH per sync; the next sync continues after the last one. */
  reconcileUids: 1000,
  /** Largest slice of an attachment returned by one request. */
  attachmentSliceBytes: 3 * 1024 * 1024
} as const
const yieldTurn = (delay = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, delay))
let mimeSchedulingInstalled = false

export function parseMail(raw: Uint8Array) {
  if (!mimeSchedulingInstalled) {
    type IncrementalParser = PostalMime & { processLine(line: Uint8Array, final: boolean): Promise<void> }
    const prototype = PostalMime.prototype as IncrementalParser
    const processLine = prototype.processLine
    if (typeof processLine !== 'function') throw new Error('The installed MIME parser does not support cooperative scheduling.')
    const lines = new WeakMap<PostalMime, number>()
    prototype.processLine = async function(line, final) {
      const count = (lines.get(this) ?? 0) + 1
      lines.set(this, count)
      if (count % 32 === 0) await yieldTurn()
      return processLine.call(this, line.slice(), final)
    }
    mimeSchedulingInstalled = true
  }
  return PostalMime.parse(raw)
}

export function mailDiagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\b(?:Bearer|AUTH\s+(?:PLAIN|XOAUTH2))\s+\S+/gi, '[redacted]').replace(/\b(password|secret|token|api[-_]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]').replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, '$1[redacted]@').slice(0, 512)
}

/** A send failure with a classified outcome: `not-applied` when the server cannot have accepted the message, `unknown` once the end of DATA was written and no definite reply arrived. */
export class MailSendError extends Error {
  constructor(message: string, readonly outcome: 'not-applied' | 'unknown') { super(message) }
}

/** A tagged NO or BAD reply: the server answered the command and refused it; the connection stays usable. */
export class ImapRefusal extends Error {}

/** A message change whose command was sent but whose result never arrived (lost connection, session end, no reply). */
export class MailActionUncertain extends Error {
  readonly code = 'ACTION_OUTCOME_UNKNOWN'
  readonly outcome = 'unknown' as const
}

export function accountEndpoint(account: EmailAccount, kind: 'imap' | 'smtp'): PluginSocketEndpoint {
  const endpoint = account[kind]
  return { host: endpoint.host, port: endpoint.port, security: endpoint.secure ? 'tls' : 'starttls' }
}

export const MAIL_CREDENTIAL_STORE: PluginCredentialStore = { file: 'secrets.json', valueField: 'password', metadata: { kind: 'password' } }
export function credentialName(accountId: string): string { return accountId }
const credentialSource = (account: EmailAccount) => ({ store: MAIL_CREDENTIAL_STORE, endpoints: [accountEndpoint(account, 'imap'), accountEndpoint(account, 'smtp')] })

class Connection {
  // Received data stays in the chunks it arrived in; a read copies each byte once into a result of exactly the requested size.
  private chunks: Uint8Array[] = []
  private offset = 0
  private available = 0
  private emptyReads = 0
  constructor(readonly api: MailTransportApi, readonly id: string) {}
  async write(value: string): Promise<void> { await this.api.network.write(this.id, encodeBytes(encoder.encode(value))) }
  async close(): Promise<void> { await this.api.network.close(this.id).catch(() => undefined) }
  /** Read `length` bytes; with `keep` false they are drained without being retained. */
  async bytes(length: number, keep = true): Promise<Uint8Array> {
    if (keep && length > MAX_MESSAGE_BYTES) throw new Error(t('email.backend.messageLimit'))
    const value = new Uint8Array(keep ? length : 0)
    let filled = 0
    while (filled < length) {
      if (!this.available) await this.more()
      const chunk = this.chunks[0]
      const take = Math.min(length - filled, chunk.length - this.offset)
      if (keep) value.set(chunk.subarray(this.offset, this.offset + take), filled)
      filled += take
      this.consume(take)
    }
    return value
  }
  async line(): Promise<string> {
    let scanned = 0
    for (;;) {
      let position = 0
      for (let index = 0; index < this.chunks.length; index++) {
        const chunk = this.chunks[index], from = index ? 0 : this.offset, size = chunk.length - from
        if (position + size > scanned) {
          const end = chunk.indexOf(10, from + Math.max(0, scanned - position))
          if (end >= 0) {
            const value = decoder.decode(await this.bytes(position + end - from)).replace(/\r$/, '')
            this.consume(1)
            return value
          }
        }
        position += size
      }
      scanned = position
      if (scanned > 1024 * 1024) throw new Error(t('email.backend.lineLimit'))
      await this.more()
    }
  }
  private consume(length: number): void {
    this.offset += length
    this.available -= length
    while (this.chunks.length && this.offset >= this.chunks[0].length) { this.offset -= this.chunks[0].length; this.chunks.shift() }
  }
  private async more(): Promise<void> {
    const reply = await this.api.network.read(this.id, 65536)
    const bytes = decodeBytes(reply.base64)
    if (!bytes.length && reply.done) throw new Error(t('email.backend.closed'))
    if (!bytes.length) {
      if (++this.emptyReads > 8) throw new Error(t('email.backend.emptyRead'))
      await yieldTurn(10)
      return
    }
    this.emptyReads = 0
    this.chunks.push(bytes)
    this.available += bytes.length
  }
  async authenticate(account: EmailAccount, kind: 'imap' | 'smtp', prefix: string, suffix = '\r\n'): Promise<void> {
    const credential = account.provider === 'pureemail'
      ? await this.api.credentials.handle(credentialName(account.id), credentialSource(account))
      : await this.api.accounts.authorize(account.id, 'mail', accountEndpoint(account, kind))
    const template = account.provider === 'pureemail'
      ? [`\0${account.login || account.address}\0`, { credential }]
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
/** Stands in for a literal larger than the command allowed; its bytes were drained, not kept. */
export const SKIPPED_LITERAL: Uint8Array = new Uint8Array(0)

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
  private async reply(literalLimit = MAX_MESSAGE_BYTES): Promise<ImapReply> {
    let line = await this.line()
    const first = line
    const parts: Array<string | Uint8Array> = []
    while (/\{\d+\+?\}$/.test(line)) {
      const literal = /\{(\d+)\+?\}$/.exec(line)!
      const length = Number(literal[1])
      parts.push(line.slice(0, literal.index), length > literalLimit ? (await this.bytes(length, false), SKIPPED_LITERAL) : await this.bytes(length))
      line = await this.line()
    }
    parts.push(line)
    return { line: first, tokens: parseImapResponse(parts) }
  }
  private async finish(tag: string, literalLimit?: number): Promise<ImapReply[]> {
    const replies: ImapReply[] = []
    for (let count = 0; count < 100000; count++) {
      if (count && count % 32 === 0) await yieldTurn()
      const reply = await this.reply(literalLimit)
      if (reply.line.startsWith(`${tag} `)) {
        if (!reply.line.startsWith(`${tag} OK`)) throw new ImapRefusal(mailDiagnostic(reply.line.replace(/^\S+\s+\S+\s*/, '')))
        return [...replies, reply]
      }
      if (reply.line.startsWith('* BYE')) throw new Error(t('email.backend.ended'))
      if (reply.line.startsWith('+')) { await this.write('\r\n'); throw new Error(t('email.backend.authentication')) }
      replies.push(reply)
    }
    throw new Error(t('email.backend.imapLimit'))
  }
  /** Run one tagged command; literals larger than `literalLimit` are drained and replaced by {@link SKIPPED_LITERAL}. */
  async command(command: string, literalLimit?: number): Promise<ImapReply[]> {
    const tag = `V${++this.sequence}`
    await this.write(`${tag} ${command}\r\n`)
    return this.finish(tag, literalLimit)
  }
  /** APPEND one message as a synchronising literal. */
  async append(mailbox: string, flags: string[], message: Uint8Array): Promise<ImapReply[]> {
    const tag = `V${++this.sequence}`
    await this.write(`${tag} APPEND ${quote(mailbox)} (${flags.join(' ')}) {${message.length}}\r\n`)
    const ready = await this.line()
    if (!ready.startsWith('+')) throw ready.startsWith(`${tag} `) ? new ImapRefusal(mailDiagnostic(ready.replace(/^\S+\s+\S+\s*/, ''))) : new Error(t('email.backend.imapResponse'))
    for (let offset = 0; offset < message.length; offset += 32768) await this.api.network.write(this.id, encodeBytes(message.subarray(offset, offset + 32768)))
    await this.write('\r\n')
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
    if (!continuation.startsWith('+')) throw new Error(continuation.startsWith(`${tag} `) ? mailDiagnostic(continuation.replace(/^\S+\s+\S+\s*/, '')) : t('email.backend.authUnsupported'))
    if (mechanism === 'LOGIN') {
      await this.write(`${encodeBytes(encoder.encode(account.login || account.address))}\r\n`)
      if (!(await this.line()).startsWith('+')) throw new Error(t('email.backend.authentication'))
      await this.password(account)
    } else await this.authenticate(account, 'imap', '')
    await this.finish(tag)
  }
}

/**
 * Store a sent message in the account's Sent folder (special use \\Sent, else a folder named like it) with \\Seen.
 * Returns the folder and, when the server reports APPENDUID, the copy's UID and UIDVALIDITY.
 */
export async function appendSentMessage(api: MailTransportApi, account: EmailAccount, mime: Uint8Array): Promise<{ folder: string; uid?: number; uidValidity?: number }> {
  return withImap(api, account, async (connection) => {
    const folders = mailboxReplies(await connection.command('LIST "" "*"')).filter(folder => folder.selectable)
    const sent = folders.find(folder => folder.specialUse?.toLowerCase() === '\\sent') ?? folders.find(folder => /^(?:sent|sent items|sent messages|sent mail)$/i.test(folder.name))
    if (!sent) throw new Error(t('email.backend.mailboxMissing', { mailbox: t('email.backend.sent') }))
    const replies = await connection.append(sent.path, ['\\Seen'], mime)
    const match = /\[APPENDUID (\d+) (\d+)\]/i.exec(replies.map(reply => reply.line).join('\n'))
    return { folder: sent.path, ...(match ? { uidValidity: Number(match[1]), uid: Number(match[2]) } : {}) }
  })
}

async function openImap(api: MailTransportApi, account: EmailAccount): Promise<ImapConnection> {
  const connection = new ImapConnection(api, await api.network.open(accountEndpoint(account, 'imap')))
  try { await connection.initialize(account) } catch (error) { await connection.close(); throw error }
  return connection
}

async function withImap<T>(api: MailTransportApi, account: EmailAccount, run: (connection: ImapConnection) => Promise<T>): Promise<T> {
  const connection = await openImap(api, account)
  try { return await run(connection) }
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

function fetchedFields(replies: ImapReply[]): Map<string, ImapValue>[] {
  return replies.flatMap((reply) => {
    if (reply.tokens[2] !== 'FETCH' || !Array.isArray(reply.tokens[3])) return []
    const values = reply.tokens[3]
    const fields = new Map<string, ImapValue>()
    for (let index = 0; index < values.length; index += 2) fields.set(String(values[index]).toUpperCase(), values[index + 1])
    const uid = fetchedUid(fields)
    return Number.isSafeInteger(uid) && uid >= 1 ? [fields] : []
  })
}

const fetchedUid = (fields: Map<string, ImapValue>): number => Number(fields.get('UID'))
const fetchedFlags = (fields: Map<string, ImapValue>): string[] => { const flags = fields.get('FLAGS'); return Array.isArray(flags) ? flags.filter((value): value is string => typeof value === 'string') : [] }
const fetchedReceivedAt = (fields: Map<string, ImapValue>): string | undefined => typeof fields.get('INTERNALDATE') === 'string' ? String(fields.get('INTERNALDATE')) : undefined
const fetchedSize = (fields: Map<string, ImapValue>): number | undefined => { const size = Number(fields.get('RFC822.SIZE')); return Number.isSafeInteger(size) && size >= 0 ? size : undefined }
const valueText = (value: ImapValue | undefined): string => typeof value === 'string' ? value : value instanceof Uint8Array ? decoder.decode(value.slice()) : ''
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** ISO time of an IMAP INTERNALDATE (`09-Sep-2026 10:00:00 +0000`), or '' when it cannot be read. */
export function internalDateIso(value: string | undefined): string {
  const match = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value ?? '')
  const month = match ? months.indexOf(match[2].toLowerCase()) : -1
  if (!match || month < 0) return ''
  const offset = (match[7] === '-' ? -1 : 1) * (Number(match[8]) * 60 + Number(match[9]))
  return new Date(Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6])) - offset * 60_000).toISOString()
}

interface StructurePart { part: string; type: string; subtype: string; params: Record<string, string>; id?: string; encoding: string; size: number; disposition?: string; filename?: string }

function parameters(value: ImapValue | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!Array.isArray(value)) return result
  for (let index = 0; index + 1 < value.length; index += 2) {
    const key = valueText(value[index]).toLowerCase(), raw = valueText(value[index + 1])
    if (key.endsWith('*')) {
      const extended = /^([^']*)'[^']*'(.*)$/.exec(raw)
      let decoded = extended?.[2] ?? raw
      try { decoded = /^utf-?8$/i.test(extended?.[1] ?? 'utf-8') ? decodeURIComponent(decoded) : unescape(decoded) } catch { /* Keep the undecoded value. */ }
      result[key.slice(0, -1)] = decoded
    } else if (!(key in result)) result[key] = decodeWords(raw)
  }
  return result
}

/** Leaf parts of a BODYSTRUCTURE with their RFC 3501 part numbers; message/rfc822 parts stay leaves. */
export function structureParts(value: ImapValue | undefined, prefix = ''): StructurePart[] {
  if (!Array.isArray(value) || !value.length) return []
  if (Array.isArray(value[0])) {
    const parts: StructurePart[] = []
    let index = 0
    for (const child of value) {
      if (!Array.isArray(child)) break
      index++
      parts.push(...structureParts(child, prefix ? `${prefix}.${index}` : String(index)))
    }
    return parts
  }
  const type = valueText(value[0]).toLowerCase(), subtype = valueText(value[1]).toLowerCase(), params = parameters(value[2])
  const extension = type === 'text' ? 8 : type === 'message' && subtype === 'rfc822' ? 10 : 7
  const disposition = Array.isArray(value[extension + 1]) ? value[extension + 1] as ImapValue[] : undefined
  const dispositionParams = parameters(disposition?.[1])
  return [{ part: prefix || '1', type, subtype, params, id: valueText(value[3]) || undefined, encoding: valueText(value[5]).toLowerCase() || '7bit',
    size: Number(valueText(value[6])) || 0, disposition: disposition ? valueText(disposition[0]).toLowerCase() : undefined, filename: dispositionParams.filename ?? params.name }]
}

const decodedSize = (part: StructurePart): number => part.encoding === 'base64' ? Math.floor(part.size * 57 / 78) : part.size

/** Split structure leaves into the readable text/HTML bodies and the attachments. */
export function messageLayout(parts: StructurePart[]): { bodies: MailBodyPart[]; attachments: MailAttachmentPart[] } {
  const bodies: MailBodyPart[] = [], attachments: MailAttachmentPart[] = []
  for (const part of parts) {
    if (part.type === 'text' && (part.subtype === 'plain' || part.subtype === 'html') && part.disposition !== 'attachment' && !(part.filename && part.disposition !== 'inline')) {
      bodies.push({ part: part.part, kind: part.subtype === 'html' ? 'html' : 'text', encoding: part.encoding, size: part.size, ...(part.params.charset ? { charset: part.params.charset } : {}) })
    } else {
      attachments.push({ part: part.part, filename: part.filename || `${part.type}-${part.subtype}`, mimeType: `${part.type}/${part.subtype}`, encoding: part.encoding, encodedSize: part.size, size: decodedSize(part),
        ...(part.disposition === 'inline' ? { inline: true } : {}), ...(part.id ? { contentId: part.id } : {}) })
    }
  }
  return { bodies, attachments }
}

/** Parts above this size are decoded slice by slice instead of through the MIME parser, which keeps several copies of every line. */
const STREAMED_PART_BYTES = 256 * 1024

function transferDecoder(encoding: string): (slice: Uint8Array, final: boolean) => Uint8Array {
  let carry = new Uint8Array()
  const joined = (slice: Uint8Array): Uint8Array => { if (!carry.length) return slice; const next = new Uint8Array(carry.length + slice.length); next.set(carry); next.set(slice, carry.length); return next }
  if (encoding === 'base64') return (slice, final) => {
    const input = joined(slice)
    const clean = new Uint8Array(input.length)
    let length = 0
    for (const byte of input) if (byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 47 && byte <= 57 || byte === 43 || byte === 61) clean[length++] = byte
    const usable = final ? length : length - length % 4
    carry = clean.slice(usable, length)
    let text = ''
    for (let index = 0; index < usable; index += 32768) text += String.fromCharCode(...clean.subarray(index, Math.min(usable, index + 32768)))
    return text ? decodeBytes(text) : new Uint8Array()
  }
  if (encoding === 'quoted-printable') return (slice, final) => {
    const input = joined(slice)
    const last = input.lastIndexOf(61)
    const keep = !final && last >= 0 && last >= input.length - 2 ? input.length - last : 0
    carry = input.slice(input.length - keep)
    const out = new Uint8Array(input.length)
    let length = 0
    const hex = (value: number): number => value >= 48 && value <= 57 ? value - 48 : (value | 32) >= 97 && (value | 32) <= 102 ? (value | 32) - 87 : -1
    for (let index = 0; index < input.length - keep; index++) {
      const byte = input[index]
      if (byte !== 61) { out[length++] = byte; continue }
      if (input[index + 1] === 13 && input[index + 2] === 10) { index += 2; continue }
      if (input[index + 1] === 10) { index += 1; continue }
      const high = hex(input[index + 1] ?? -1), low = hex(input[index + 2] ?? -1)
      if (high >= 0 && low >= 0) { out[length++] = high * 16 + low; index += 2 } else out[length++] = byte
    }
    return out.slice(0, length)
  }
  return slice => slice
}

/** Decode a part slice by slice into pieces (one per slice), so no step copies or scans the whole body at once. */
export async function decodeBodyPieces(bytes: Uint8Array, part: MailBodyPart): Promise<string[]> {
  let text: TextDecoder
  try { text = new TextDecoder(part.charset || 'utf-8') } catch { text = new TextDecoder() }
  const transfer = transferDecoder(part.encoding.toLowerCase())
  const pieces: string[] = []
  let carry = ''
  for (let offset = 0; ; offset += STREAMED_PART_BYTES) {
    const final = offset + STREAMED_PART_BYTES >= bytes.length
    let piece = carry + text.decode(transfer(bytes.slice(offset, offset + STREAMED_PART_BYTES), final), { stream: !final })
    carry = ''
    if (part.kind === 'text') {
      if (!final && piece.endsWith('\r')) { carry = '\r'; piece = piece.slice(0, -1) }
      piece = piece.replace(/\r\n?/g, '\n')
    }
    if (piece) pieces.push(piece)
    await yieldTurn()
    if (final) return pieces
  }
}

/** Decode one fetched text/HTML body part by its transfer encoding and charset. */
export async function decodeBodyPart(bytes: Uint8Array, part: MailBodyPart): Promise<string> {
  if (bytes.length > STREAMED_PART_BYTES) return (await decodeBodyPieces(bytes, part)).join('')
  const head = encoder.encode(`Content-Type: text/${part.kind === 'html' ? 'html' : 'plain'}; charset="${(part.charset ?? 'utf-8').replace(/["\\\r\n]/g, '')}"\r\nContent-Transfer-Encoding: ${part.encoding.replace(/[^\w-]/g, '')}\r\n\r\n`)
  const entity = new Uint8Array(head.length + bytes.length)
  entity.set(head); entity.set(bytes, head.length)
  const parsed = await parseMail(entity)
  return (part.kind === 'html' ? parsed.html : parsed.text) ?? ''
}

async function messageFields(parsed: Email, uid: number, uidValidity: number | undefined, fields: Map<string, ImapValue>, rest: Pick<CachedMessage, 'complete' | 'attachmentDigests' | 'text' | 'html' | 'hasAttachments' | 'structure'>): Promise<CachedMessage> {
  const text = rest.text
  return { uid, uidValidity, automationHeaders: automationHeaders(parsed.headers), originalDate: parsed.date ?? null, receivedAt: fetchedReceivedAt(fields),
    bcc: addressText(parsed.bcc) || undefined, messageId: parsed.messageId ?? '', from: addressText(parsed.from ? [parsed.from] : []),
    replyTo: addressText(parsed.replyTo) || undefined, to: addressText(parsed.to), cc: addressText(parsed.cc) || undefined,
    subject: parsed.subject ?? '(no subject)', date: parsed.date && Number.isFinite(Date.parse(parsed.date)) ? new Date(parsed.date).toISOString() : '',
    snippet: (text ?? '').slice(0, 4000).replace(/\s+/g, ' ').trim().slice(0, 200), flags: fetchedFlags(fields), ...rest }
}

/** A whole message from `BODY[]`, with content digests exactly as before and the attachment parts from BODYSTRUCTURE. */
async function wholeMessage(raw: Uint8Array, uid: number, uidValidity: number | undefined, fields: Map<string, ImapValue>): Promise<CachedMessage> {
  const parsed = await parseMail(raw)
  await yieldTurn()
  const attachmentDigests = await Promise.all(parsed.attachments.map(async attachment => digest(JSON.stringify([attachment.filename, attachment.mimeType, attachment.contentId ?? null, await digest(typeof attachment.content === 'string' ? attachment.content : new Uint8Array(attachment.content))]))))
  const attachments = messageLayout(structureParts(fields.get('BODYSTRUCTURE'))).attachments
  return messageFields(parsed, uid, uidValidity, fields, { complete: true, attachmentDigests, text: parsed.text, html: parsed.html, hasAttachments: parsed.attachments.length > 0,
    structure: { size: fetchedSize(fields) ?? raw.length, attachments } })
}

/** A large message: headers, structure and the text bodies up to the part limit; attachments are listed, never downloaded. */
async function structuredMessage(connection: ImapConnection, uid: number, uidValidity: number | undefined): Promise<CachedMessage> {
  const replies = await connection.command(`UID FETCH ${uid} (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER]<0.${MAIL_SYNC_LIMITS.headerBytes}>)`, MAIL_SYNC_LIMITS.headerBytes)
  const fields = fetchedFields(replies).find(entry => fetchedUid(entry) === uid)
  if (!fields) throw new Error(t('email.backend.messageMissing'))
  const header = [...fields.entries()].find(([key]) => key.startsWith('BODY[HEADER]'))?.[1]
  const headerBytes = header instanceof Uint8Array ? header : new Uint8Array()
  const cut = headerBytes.length >= MAIL_SYNC_LIMITS.headerBytes ? Math.max(0, headerBytes.lastIndexOf(10) + 1) : headerBytes.length
  const head = new Uint8Array(cut + 4)
  head.set(headerBytes.subarray(0, cut)); head.set([13, 10, 13, 10], cut)
  const parsed = await parseMail(head)
  const { bodies, attachments } = messageLayout(structureParts(fields.get('BODYSTRUCTURE')))
  let budget = MAIL_SYNC_LIMITS.bodyBytes
  const wanted = bodies.filter(part => part.size <= budget && (budget -= part.size, true))
  const deferred = bodies.filter(part => !wanted.includes(part))
  const content = await bodyContent(connection, uid, wanted, MAIL_SYNC_LIMITS.bodyBytes * 2)
  const missing = wanted.filter(part => content.get(part.part) === undefined)
  const { text, html } = joinBodies(bodies, content)
  const structure: MailStructure = { size: fetchedSize(fields), attachments, ...(deferred.length || missing.length ? { deferred: [...deferred, ...missing] } : {}) }
  const complete = !structure.deferred
  return messageFields(parsed, uid, uidValidity, fields, { complete, text, html, hasAttachments: attachments.length > 0, structure,
    attachmentDigests: await Promise.all(attachments.map(part => digest(JSON.stringify(['part', part.part, part.filename, part.mimeType, part.contentId ?? null, part.encodedSize])))) })
}

async function bodyContent(connection: ImapConnection, uid: number, parts: MailBodyPart[], literalLimit: number): Promise<Map<string, string>> {
  const content = new Map<string, string>()
  if (!parts.length) return content
  const replies = await connection.command(`UID FETCH ${uid} (${parts.map(part => `BODY.PEEK[${part.part}]`).join(' ')})`, literalLimit)
  const fields = fetchedFields(replies).find(entry => fetchedUid(entry) === uid)
  for (const part of parts) {
    const bytes = fields?.get(`BODY[${part.part}]`)
    if (bytes instanceof Uint8Array && bytes !== SKIPPED_LITERAL) { content.set(part.part, await decodeBodyPart(bytes, part)); await yieldTurn() }
  }
  return content
}

function joinBodies(bodies: MailBodyPart[], content: Map<string, string>): { text?: string; html?: string } {
  const pick = (kind: MailBodyPart['kind']) => { const values = bodies.filter(part => part.kind === kind && content.has(part.part)).map(part => content.get(part.part)!); return values.length ? values.join('\n') : undefined }
  return { text: pick('text'), html: pick('html') }
}

/** A message that could not be downloaded: kept once with its listing data so later syncs do not fetch it again. */
function unavailableMessage(uid: number, uidValidity: number | undefined, listed: Map<string, ImapValue>, error: unknown): CachedMessage {
  const receivedAt = fetchedReceivedAt(listed)
  return { uid, uidValidity, receivedAt, complete: false, messageId: '', from: '', to: '', subject: t('email.backend.unavailableSubject'), date: internalDateIso(receivedAt), snippet: t('email.backend.unavailableSnippet'),
    flags: fetchedFlags(listed), hasAttachments: false, structure: { size: fetchedSize(listed), failure: mailDiagnostic(error) } }
}

export interface FolderSyncHooks {
  /** Called once after SELECT with the server's UIDVALIDITY, before anything is stored. */
  epoch?(uidValidity: number | undefined): Promise<void>
  /** Store newly downloaded messages; called per bounded batch so memory never holds the whole folder. */
  store?(messages: CachedMessage[]): Promise<void>
  /** Cached server UIDs of this folder in the current epoch, for reconciliation. */
  cachedUids?(uidValidity: number): Promise<number[]>
  /** Where the bounded check of cached UIDs below the listed window continues, and the UIDs a pending removal asks to check again. */
  reconcileFrom?(uidValidity: number): { after?: number; recheck?: number[] | null }
}

export interface FolderSyncResult {
  /** Listed messages that were already cached (flags refreshed), plus downloaded ones when no store hook took them. */
  messages: CachedMessage[]
  uidValidity?: number
  /** Downloaded and stored messages, without their bodies. */
  stored?: CachedMessage[]
  /** UIDs that could not be downloaded and were stored as unavailable. */
  unavailable?: number[]
  /** Cached UIDs the server confirmed are gone; absent when the listing could not be verified. */
  removed?: number[]
  /** How many cached UIDs the reconciliation checked. */
  checked?: number
  /** The last UID of the older range checked by UID SEARCH this time (0 once the range wrapped); absent when nothing older was searched or a recheck ran. */
  reconciledThrough?: number
}

const compactSet = (uids: number[]): string[] => {
  const sorted = [...new Set(uids)].sort((a, b) => a - b), ranges: string[] = []
  for (let index = 0; index < sorted.length;) {
    let end = index
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++
    ranges.push(end > index ? `${sorted[index]}:${sorted[end]}` : String(sorted[index]))
    index = end + 1
  }
  return ranges
}

function searchUids(replies: ImapReply[]): number[] {
  return replies.flatMap(reply => reply.tokens[0] === '*' && String(reply.tokens[1]).toUpperCase() === 'SEARCH' ? reply.tokens.slice(2).map(value => Number(value)).filter(uid => Number.isSafeInteger(uid) && uid > 0) : [])
}

/**
 * Synchronise one folder window: list UIDs, flags and sizes; download missing messages in byte-bounded batches (large ones as
 * structure plus text bodies); keep a message that fails once as unavailable; and, with `cachedUids`, report cached UIDs the
 * server no longer has. Any refusal, dropped connection or inconsistent answer leaves `removed` undefined.
 */
export async function fetchFolder(api: MailTransportApi, account: EmailAccount, folder: string, limit: number, cached?: (uids: number[], uidValidity: number | undefined) => Promise<Map<number, CachedMessage>>, hooks: FolderSyncHooks = {}): Promise<FolderSyncResult> {
  let connection = await openImap(api, account)
  let broken = false
  const select = async (): Promise<{ total: number; uidValidity?: number }> => {
    const selected = await connection.command(`SELECT ${quote(folder)}`)
    const epoch = selected.map(reply => /\[UIDVALIDITY (\d+)\]/i.exec(reply.line)?.[1]).find(Boolean)
    return { total: Number(selected.find((reply) => reply.tokens[2] === 'EXISTS')?.tokens[1] ?? 0), uidValidity: epoch ? Number(epoch) : undefined }
  }
  try {
    const { total, uidValidity } = await select()
    await hooks.epoch?.(uidValidity)
    const listing = total ? fetchedFields(await connection.command(`FETCH ${Math.max(1, total - limit + 1)}:* (UID FLAGS INTERNALDATE RFC822.SIZE)`)) : []
    const consistent = listing.length === Math.min(total, limit)
    const known = cached ? await cached(listing.map(fetchedUid), uidValidity) : new Map<number, CachedMessage>()
    const pending = listing.filter(fields => !known.has(fetchedUid(fields)))
    const downloaded: CachedMessage[] = [], unavailable: number[] = []
    const reconnect = async (): Promise<void> => {
      await connection.close()
      connection = await openImap(api, account)
      broken = false
      if ((await select()).uidValidity !== uidValidity) throw new Error(t('email.backend.mailboxChanged'))
    }
    const keep = async (messages: CachedMessage[]): Promise<void> => {
      if (!messages.length) return
      if (hooks.store) { await hooks.store(messages); downloaded.push(...messages.map(({ text: _text, html: _html, ...summary }) => summary)) }
      else downloaded.push(...messages)
    }
    // A refusal or a second failure on a fresh connection is the message's own: it is kept as unavailable. A failed reconnect aborts the sync.
    const single = async (fields: Map<string, ImapValue>): Promise<CachedMessage> => {
      const uid = fetchedUid(fields)
      let failure: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        if (broken) await reconnect()
        try { return await structuredMessage(connection, uid, uidValidity) }
        catch (error) { failure = error; if (error instanceof ImapRefusal) break; broken = true }
      }
      unavailable.push(uid)
      return unavailableMessage(uid, uidValidity, fields, failure)
    }
    const whole = pending.filter(fields => (fetchedSize(fields) ?? 0) <= MAIL_SYNC_LIMITS.wholeMessageBytes)
    const large = pending.filter(fields => (fetchedSize(fields) ?? 0) > MAIL_SYNC_LIMITS.wholeMessageBytes)
    for (let index = 0; index < whole.length;) {
      const batch: Map<string, ImapValue>[] = []
      let bytes = 0
      while (index < whole.length && batch.length < MAIL_SYNC_LIMITS.batchMessages && (!batch.length || bytes + (fetchedSize(whole[index]) ?? 0) <= MAIL_SYNC_LIMITS.batchBytes)) { bytes += fetchedSize(whole[index]) ?? 0; batch.push(whole[index++]) }
      let replies: Map<string, ImapValue>[] | undefined
      try {
        if (broken) await reconnect()
        replies = fetchedFields(await connection.command(`UID FETCH ${batch.map(fetchedUid).join(',')} (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[])`, MAIL_SYNC_LIMITS.wholeMessageBytes * 2))
      } catch (error) { if (!(error instanceof ImapRefusal)) broken = true }
      const messages: CachedMessage[] = []
      for (const fields of batch) {
        const uid = fetchedUid(fields), reply = replies?.find(entry => fetchedUid(entry) === uid)
        const raw = reply?.get('BODY[]') ?? reply?.get('RFC822')
        if (reply && raw instanceof Uint8Array && raw !== SKIPPED_LITERAL) {
          try { messages.push(await wholeMessage(raw, uid, uidValidity, reply)); continue } catch { /* Parsed again part by part below. */ }
        }
        if (replies && !reply) continue
        messages.push(await single(fields))
      }
      await keep(messages)
    }
    for (const fields of large) await keep([await single(fields)])
    const listed = listing.flatMap((fields): CachedMessage[] => {
      const stored = known.get(fetchedUid(fields))
      return stored ? [{ ...stored, uid: fetchedUid(fields), uidValidity, flags: fetchedFlags(fields), receivedAt: fetchedReceivedAt(fields) }] : []
    })
    const fresh = new Map(downloaded.map(message => [message.uid, message]))
    const ordered = listing.flatMap((fields): CachedMessage[] => { const uid = fetchedUid(fields), message = listed.find(entry => entry.uid === uid) ?? fresh.get(uid); return message ? [message] : [] })
    const result: FolderSyncResult = { messages: hooks.store ? listed : ordered, uidValidity, ...(hooks.store ? { stored: downloaded } : {}), ...(unavailable.length ? { unavailable } : {}) }
    if (hooks.cachedUids && uidValidity !== undefined && consistent && !broken) {
      try {
        const candidates = [...new Set((await hooks.cachedUids(uidValidity)).filter(uid => Number.isSafeInteger(uid) && uid >= 1 && uid <= 0xffffffff))].sort((a, b) => a - b)
        // The listing holds the highest UIDs of the folder (all of them when it is no larger than the window): a cached UID at or
        // above its lowest UID that it does not list is gone without asking. Only older cached UIDs need UID SEARCH, a bounded
        // slice per sync that continues where the previous sync stopped, or exactly the UIDs a pending removal waits on.
        const listed = new Set(listing.map(fetchedUid))
        const floor = total > listing.length ? Math.min(...listed) : 0
        const window = candidates.filter(uid => uid >= floor), older = candidates.filter(uid => uid < floor)
        const removed = window.filter(uid => !listed.has(uid))
        let checked = window.length, through: number | undefined
        if (older.length) {
          const from = hooks.reconcileFrom?.(uidValidity) ?? {}
          const recheck = new Set(from.recheck ?? [])
          let slice = recheck.size ? older.filter(uid => recheck.has(uid)).slice(0, MAIL_SYNC_LIMITS.reconcileUids) : []
          if (!slice.length) {
            slice = older.filter(uid => uid > (from.after ?? 0)).slice(0, MAIL_SYNC_LIMITS.reconcileUids)
            if (!slice.length) slice = older.slice(0, MAIL_SYNC_LIMITS.reconcileUids)
            through = slice[slice.length - 1] < older[older.length - 1] ? slice[slice.length - 1] : 0
          }
          // The lowest listed UID goes along as a canary: the server must report it, and nothing it was not asked about.
          const asked = new Set([...slice, floor])
          const present = new Set(searchUids(await connection.command(`UID SEARCH UID ${compactSet([...asked]).join(',')}`)))
          if (!present.has(floor) || [...present].some(uid => !asked.has(uid))) throw new Error(t('email.backend.mailboxChanged'))
          removed.push(...slice.filter(uid => !present.has(uid)))
          checked += slice.length
        }
        result.removed = removed; result.checked = checked
        if (through !== undefined) result.reconciledThrough = through
      } catch { /* An unverified listing removes nothing. */ }
    }
    return result
  } finally { await connection.close() }
}

/** Download the deferred text bodies of one message (or the whole message when it was stored unavailable). */
export async function fetchMessageContent(api: MailTransportApi, account: EmailAccount, folder: string, uid: number, uidValidity: number | undefined, deferred: MailBodyPart[] | undefined): Promise<{ text?: string[]; html?: string[]; message?: CachedMessage }> {
  return withImap(api, account, async (connection) => {
    const selected = await connection.command(`EXAMINE ${quote(folder)}`)
    const epoch = selected.map(reply => /\[UIDVALIDITY (\d+)\]/i.exec(reply.line)?.[1]).find(Boolean)
    if (uidValidity !== undefined && Number(epoch) !== uidValidity) throw new Error(t('email.backend.mailboxChanged'))
    if (!deferred) return { message: await structuredMessage(connection, uid, uidValidity) }
    const tooLarge = deferred.find(part => part.size > MAIL_SYNC_LIMITS.openPartBytes)
    if (tooLarge) throw new Error(t('email.backend.bodyTooLarge', { size: Math.ceil(tooLarge.size / 1024 / 1024) }))
    // One part per command, decoded into pieces: only one part's bytes are held at a time.
    const body: { text?: string[]; html?: string[] } = {}
    for (const part of deferred) {
      const replies = await connection.command(`UID FETCH ${uid} (BODY.PEEK[${part.part}])`, MAIL_SYNC_LIMITS.openPartBytes * 2)
      const bytes = fetchedFields(replies).find(entry => fetchedUid(entry) === uid)?.get(`BODY[${part.part}]`)
      if (!(bytes instanceof Uint8Array) || bytes === SKIPPED_LITERAL) throw new Error(t('email.backend.messageMissing'))
      const target = body[part.kind] ??= []
      if (target.length) target.push('\n')
      target.push(...await decodeBodyPieces(bytes, part))
    }
    return body
  })
}

/** One slice of an attachment's encoded bytes, as stored on the server. */
export async function fetchAttachmentSlice(api: MailTransportApi, account: EmailAccount, folder: string, uid: number, uidValidity: number | undefined, part: string, offset: number): Promise<Uint8Array> {
  if (!/^\d+(?:\.\d+)*$/.test(part)) throw new Error(t('email.backend.messageMissing'))
  return withImap(api, account, async (connection) => {
    const selected = await connection.command(`EXAMINE ${quote(folder)}`)
    const epoch = selected.map(reply => /\[UIDVALIDITY (\d+)\]/i.exec(reply.line)?.[1]).find(Boolean)
    if (uidValidity !== undefined && Number(epoch) !== uidValidity) throw new Error(t('email.backend.mailboxChanged'))
    const replies = await connection.command(`UID FETCH ${uid} (BODY.PEEK[${part}]<${offset}.${MAIL_SYNC_LIMITS.attachmentSliceBytes}>)`, MAIL_SYNC_LIMITS.attachmentSliceBytes)
    const fields = fetchedFields(replies).find(entry => fetchedUid(entry) === uid)
    const value = fields && [...fields.entries()].find(([key]) => key.startsWith(`BODY[${part}]`))?.[1]
    if (!(value instanceof Uint8Array) || value === SKIPPED_LITERAL) throw new Error(t('email.backend.messageMissing'))
    return value
  })
}

export async function verifyImap(api: MailTransportApi, account: EmailAccount): Promise<void> {
  await withImap(api, account, (connection) => connection.command('EXAMINE "INBOX"').then(() => undefined))
}

/**
 * Applies one read/flag change or move. Failures are classified for the caller: nothing that can change the mailbox was sent yet,
 * or the server refused it with a tagged NO/BAD → `MailRefusal` (not applied); the change was sent and no answer arrived, or a
 * later step failed after a copy succeeded → `MailActionUncertain` (outcome unknown).
 */
export async function applyMessageAction(api: MailTransportApi, account: EmailAccount, folder: string, uid: number, action: EmailMessageAction, uidValidity?: number): Promise<{ destinationFolder?: string; destinationUid?: number; destinationUidValidity?: number }> {
  let sent = false, copied = false
  try { return await withImap(api, account, async (connection) => {
    const change = (command: string): Promise<ImapReply[]> => { sent = true; return connection.command(command) }
    const selected = await connection.command(`SELECT ${quote(folder)}`)
    const epoch = selected.map(reply => /\[UIDVALIDITY (\d+)\]/i.exec(reply.line)?.[1]).find(Boolean)
    if (uidValidity !== undefined && Number(epoch) !== uidValidity) throw new Error(t('email.backend.mailboxChanged'))
    if (action === 'archive' || action === 'trash' || action === 'junk') {
      const folders = mailboxReplies(await connection.command('LIST "" "*"'))
      const uses = action === 'archive' ? ['\\Archive', '\\All'] : action === 'junk' ? ['\\Junk'] : ['\\Trash']
      const destinationFolder = folders.find((entry) => entry.selectable && uses.some((use) => use.toLowerCase() === entry.specialUse?.toLowerCase()))?.path
      if (!destinationFolder) throw new Error(t('email.backend.mailboxMissing', { mailbox: t(`email.backend.${action === 'archive' ? 'archive' : action === 'junk' ? 'junk' : 'trash'}`) }))
      if (destinationFolder === folder) throw new Error(t('email.backend.alreadyMoved', { mailbox: destinationFolder }))
      let replies: ImapReply[]
      if (connection.capabilities.has('MOVE') || connection.capabilities.has('IMAP4REV2')) replies = await change(`UID MOVE ${uid} ${quote(destinationFolder)}`)
      else {
        if (!connection.capabilities.has('UIDPLUS')) throw new Error(t('email.backend.moveUnsupported'))
        replies = await change(`UID COPY ${uid} ${quote(destinationFolder)}`)
        copied = true
        await connection.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`)
        await connection.command(`UID EXPUNGE ${uid}`)
      }
      const match = /\[COPYUID (\d+) \d+ (\d+)\]/i.exec(replies.map((reply) => reply.line).join('\n'))
      return { destinationFolder, ...(match ? { destinationUid: Number(match[2]), destinationUidValidity: Number(match[1]) } : {}) }
    }
    const flag = action === 'flag' || action === 'unflag' ? '\\Flagged' : '\\Seen'
    await change(`UID STORE ${uid} ${action === 'mark-unread' || action === 'unflag' ? '-' : '+'}FLAGS.SILENT (${flag})`)
    return {}
  }) } catch (error) {
    const reason = mailDiagnostic(error)
    if (!sent || error instanceof ImapRefusal && !copied) throw new MailRefusal('ACTION_NOT_APPLIED', t('email.backend.actionNotApplied', { reason }))
    throw new MailActionUncertain(t('email.backend.actionUncertain', { reason }))
  }
}

async function smtpReply(connection: Connection, expected: number[]): Promise<string[]> {
  const lines: string[] = []
  for (let count = 0; count < 1000; count++) {
    const line = await connection.line()
    if (!/^\d{3}[ -]/.test(line)) throw new Error(t('email.backend.smtpResponse'))
    lines.push(line)
    if (line[3] === ' ') {
      if (!expected.includes(Number(line.slice(0, 3)))) throw Object.assign(new Error(mailDiagnostic(line)), { smtpReply: true })
      return lines
    }
  }
  throw new Error(t('email.backend.smtpLimit'))
}

async function initializeSmtp(connection: Connection, account: EmailAccount): Promise<void> {
  await smtpReply(connection, [220])
  await connection.write('EHLO localhost\r\n')
  let capabilities = await smtpReply(connection, [250])
  if (!account.smtp.secure) {
    await connection.write('STARTTLS\r\n'); await smtpReply(connection, [220]); await connection.api.network.startTls(connection.id)
    await connection.write('EHLO localhost\r\n'); capabilities = await smtpReply(connection, [250])
  }
  const auth = capabilities.filter((line) => /^250[ -]AUTH(?:=| )/i.test(line)).join(' ').toUpperCase()
  if (account.provider === 'pureemail' && !/\bPLAIN\b/.test(auth) && /\bLOGIN\b/.test(auth)) {
    await connection.write('AUTH LOGIN\r\n'); await smtpReply(connection, [334])
    await connection.write(`${encodeBytes(encoder.encode(account.login || account.address))}\r\n`); await smtpReply(connection, [334])
    await connection.password(account)
  } else await connection.authenticate(account, 'smtp', `AUTH ${account.provider === 'pureemail' ? 'PLAIN' : 'XOAUTH2'} `)
  await smtpReply(connection, [235])
}

export async function verifySmtp(api: MailTransportApi, account: EmailAccount): Promise<void> {
  const connection = new Connection(api, await api.network.open(accountEndpoint(account, 'smtp')))
  try { await initializeSmtp(connection, account) } finally { await connection.close() }
}

/** Send through SMTP; after the server accepted the message, `accepted` receives its MIME bytes (for the copy in Sent). */
export async function sendMail(api: MailTransportApi, account: EmailAccount, input: EmailSendInput, automatic?: { origin: string; messageId: string }, accepted?: (mime: Uint8Array) => void): Promise<string> {
  const recipients = [...parseEmailAddresses(input.to, true), ...parseEmailAddresses(input.cc ?? '', true), ...parseEmailAddresses(input.bcc ?? '', true)]
  if (!recipients.length) throw new MailSendError(t('email.backend.recipient'), 'not-applied')
  const message = createMimeMessage()
  message.setSender({ addr: account.address, name: account.displayName })
  message.setRecipients(parseEmailAddresses(input.to, true).map((address) => ({ addr: address.address, name: address.name })))
  if (input.cc) message.setCc(parseEmailAddresses(input.cc, true).map((address) => ({ addr: address.address, name: address.name })))
  message.setSubject(input.subject)
  const messageId = automatic?.messageId ?? `<${crypto.randomUUID()}@${account.address.split('@')[1]}>`
  message.setHeader('Message-ID', messageId)
  if (automatic) {
    if (!/^[a-f0-9-]{36}$/i.test(automatic.origin) || !/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId)) throw new MailSendError(t('email.automatic.invalidProvenance'), 'not-applied')
    message.setHeader('Auto-Submitted', 'auto-generated')
    message.setHeader('X-Valley-Origin', automatic.origin)
  }
  if (input.inReplyTo) {
    message.setHeader('In-Reply-To', input.inReplyTo)
    message.setHeader('References', input.inReplyTo)
  }
  message.addMessage({ contentType: 'text/plain', data: input.text ?? '' })
  if (input.html) message.addMessage({ contentType: 'text/html', data: input.html })
  // The server takes responsibility for the message only after the end of DATA. A failure before that leaves nothing sent; after it, only an SMTP reply settles the outcome.
  let ended = false
  let connection: Connection | undefined
  try {
    connection = new Connection(api, await api.network.open(accountEndpoint(account, 'smtp')))
    await initializeSmtp(connection, account)
    await connection.write(`MAIL FROM:<${account.address}>\r\n`); await smtpReply(connection, [250])
    for (const recipient of recipients) { await connection.write(`RCPT TO:<${recipient.address}>\r\n`); await smtpReply(connection, [250, 251]) }
    await connection.write('DATA\r\n'); await smtpReply(connection, [354])
    const mime = message.asRaw().replace(/\r?\n/g, '\r\n')
    const raw = encoder.encode(mime.replace(/^\./gm, '..'))
    for (let offset = 0; offset < raw.length; offset += 32768) await api.network.write(connection.id, encodeBytes(raw.subarray(offset, offset + 32768)))
    ended = true
    await connection.write('\r\n.\r\n'); await smtpReply(connection, [250])
    accepted?.(encoder.encode(mime))
    return messageId
  } catch (error) {
    throw new MailSendError(mailDiagnostic(error), ended && !(error as { smtpReply?: boolean }).smtpReply ? 'unknown' : 'not-applied')
  } finally { await connection?.close() }
}
