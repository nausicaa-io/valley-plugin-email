import { vi } from 'vitest'
import { decodeBytes, encodeBytes } from '../src/backend/encoding'
import type { MailTransportApi } from '../src/backend/transport'

/** A synthetic leaf part: `content` is the encoded body exactly as the server stores it. */
export interface FakePart { type: string; subtype: string; charset?: string; encoding: string; content: Uint8Array; filename?: string }
export interface FakeMessage { uid: number; flags: string[]; internalDate: string; header: Uint8Array; parts: FakePart[]; multipart?: string; raw: Uint8Array; bodystructure: string }

const encoder = new TextEncoder()
const join = (chunks: Uint8Array[]): Uint8Array => { const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0)); chunks.reduce((at, chunk) => { out.set(chunk, at); return at + chunk.length }, 0); return out }
const base64Lines = (bytes: Uint8Array): string => encodeBytes(bytes).replace(/.{76}/g, '$&\r\n').replace(/\r\n$/, '')
const quoted = (value: string | undefined): string => value === undefined ? 'NIL' : `"${value}"`

export const textPart = (value: string, subtype = 'plain'): FakePart => ({ type: 'text', subtype, charset: 'utf-8', encoding: '8bit', content: encoder.encode(value.replace(/\r?\n/g, '\r\n')) })
export const filePart = (filename: string, bytes: Uint8Array, type = 'application/octet-stream'): FakePart => ({ type: type.split('/')[0], subtype: type.split('/')[1], encoding: 'base64', content: encoder.encode(base64Lines(bytes)), filename })

/** Build a message with its raw bytes and BODYSTRUCTURE; part numbers follow RFC 3501. */
export function fakeMessage(uid: number, subject: string, parts: FakePart[], flags: string[] = []): FakeMessage {
  const boundary = `fake-${uid}`
  const top = [`From: "Survey Desk" <desk@birds.example>`, 'To: hoopoe@birds.example', `Subject: ${subject}`, `Message-ID: <m${uid}@birds.example>`, 'Date: Wed, 21 Oct 2026 08:00:00 +0000', 'MIME-Version: 1.0']
  const leafHeaders = (part: FakePart) => [`Content-Type: ${part.type}/${part.subtype}${part.charset ? `; charset="${part.charset}"` : ''}${part.filename ? `; name="${part.filename}"` : ''}`, `Content-Transfer-Encoding: ${part.encoding}`, ...(part.filename ? [`Content-Disposition: attachment; filename="${part.filename}"`] : [])]
  const leafStructure = (part: FakePart) => `(${quoted(part.type.toUpperCase())} ${quoted(part.subtype.toUpperCase())} ${part.charset ? `("CHARSET" "${part.charset}")` : part.filename ? `("NAME" "${part.filename}")` : 'NIL'} NIL NIL ${quoted(part.encoding.toUpperCase())} ${part.content.length}${part.type === 'text' ? ' 1' : ''} NIL ${part.filename ? `("ATTACHMENT" ("FILENAME" "${part.filename}"))` : 'NIL'} NIL NIL)`
  if (parts.length === 1) {
    const header = encoder.encode([...top, ...leafHeaders(parts[0])].join('\r\n') + '\r\n\r\n')
    return { uid, flags, internalDate: '21-Oct-2026 08:00:00 +0000', header, parts, raw: join([header, parts[0].content]), bodystructure: leafStructure(parts[0]) }
  }
  const header = encoder.encode([...top, `Content-Type: multipart/mixed; boundary="${boundary}"`].join('\r\n') + '\r\n\r\n')
  const body = join([...parts.flatMap(part => [encoder.encode(`--${boundary}\r\n${leafHeaders(part).join('\r\n')}\r\n\r\n`), part.content, encoder.encode('\r\n')]), encoder.encode(`--${boundary}--\r\n`)])
  return { uid, flags, internalDate: '21-Oct-2026 08:00:00 +0000', header, parts, multipart: 'MIXED', raw: join([header, body]), bodystructure: `(${parts.map(leafStructure).join('')} "MIXED" ("BOUNDARY" "${boundary}") NIL NIL NIL)` }
}

export interface FakeFolder { uidValidity: number; messages: FakeMessage[]; specialUse?: string }
export interface FakeModes { failUids?: number[]; search?: 'ok' | 'no' | 'empty'; listing?: 'ok' | 'empty'; select?: 'ok' | 'empty' | 'no-uidvalidity'; sizeLie?: number[] }

/** A scripted IMAP server behind the plugin network API; it records commands and the body bytes it sent. */
export function imapFolderFake(folders: Record<string, FakeFolder>, modes: FakeModes = {}) {
  const commands: string[] = []
  const bodies: Array<{ uid: number; section: string; bytes: number }> = []
  let output: Uint8Array[] = []
  let selected: FakeFolder | undefined
  let pendingAuth: string | undefined
  const send = (...chunks: Array<string | Uint8Array>) => { for (const chunk of chunks) output.push(typeof chunk === 'string' ? encoder.encode(chunk) : chunk) }
  const inSet = (set: string, value: number, max: number) => set.split(',').some(range => { const [a, b] = range.split(':'); const lo = a === '*' ? max : Number(a), hi = b === undefined ? lo : b === '*' ? max : Number(b); return value >= Math.min(lo, hi) && value <= Math.max(lo, hi) })
  const run = (tag: string, command: string) => {
    commands.push(command)
    let match: RegExpExecArray | null
    if (command === 'CAPABILITY') return send('* CAPABILITY IMAP4rev1 AUTH=PLAIN MOVE UIDPLUS\r\n', `${tag} OK done\r\n`)
    if (command === 'AUTHENTICATE PLAIN') { pendingAuth = tag; return send('+ \r\n') }
    if ((match = /^(SELECT|EXAMINE) "(.+)"$/.exec(command))) {
      selected = folders[match[2]]
      if (!selected) return send(`${tag} NO no such folder\r\n`)
      send(`* ${modes.select === 'empty' ? 0 : selected.messages.length} EXISTS\r\n`)
      if (modes.select !== 'no-uidvalidity') send(`* OK [UIDVALIDITY ${selected.uidValidity}] valid\r\n`)
      return send(`${tag} OK selected\r\n`)
    }
    if ((match = /^(UID )?FETCH (\S+) \((.*)\)$/.exec(command)) && selected) {
      const byUid = Boolean(match[1]), items = match[3].match(/BODY\.PEEK\[[^\]]*\](?:<\d+\.\d+>)?|[A-Z0-9.]+/g) ?? []
      const withBody = items.some(item => item.startsWith('BODY.PEEK'))
      const max = byUid ? Math.max(0, ...selected.messages.map(message => message.uid)) : selected.messages.length
      const targets = selected.messages.map((message, index) => ({ message, index })).filter(({ message, index }) => inSet(match![2], byUid ? message.uid : index + 1, max))
      if (withBody && targets.some(({ message }) => modes.failUids?.includes(message.uid))) return send(`${tag} NO [SERVERBUG] synthetic failure\r\n`)
      for (const { message, index } of withBody || modes.listing !== 'empty' ? targets : []) {
        send(`* ${index + 1} FETCH (UID ${message.uid}`)
        for (const item of items) {
          if (item === 'FLAGS') send(` FLAGS (${message.flags.join(' ')})`)
          else if (item === 'INTERNALDATE') send(` INTERNALDATE "${message.internalDate}"`)
          else if (item === 'RFC822.SIZE') send(` RFC822.SIZE ${modes.sizeLie?.includes(message.uid) ? 100 : message.raw.length}`)
          else if (item === 'BODYSTRUCTURE') send(` BODYSTRUCTURE ${message.bodystructure}`)
          else if (item.startsWith('BODY.PEEK[')) {
            const section = /^BODY\.PEEK\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/.exec(item)!
            let data = section[1] === '' ? message.raw : section[1] === 'HEADER' ? message.header : message.parts[Number(section[1]) - 1]?.content ?? new Uint8Array()
            let name = `BODY[${section[1]}]`
            if (section[2] !== undefined) { data = data.subarray(Number(section[2]), Number(section[2]) + Number(section[3])); name += `<${section[2]}>` }
            bodies.push({ uid: message.uid, section: name, bytes: data.length })
            send(` ${name} {${data.length}}\r\n`, data)
          }
        }
        send(')\r\n')
      }
      return send(`${tag} OK fetched\r\n`)
    }
    if ((match = /^UID SEARCH UID (\S+)$/.exec(command)) && selected) {
      if (modes.search === 'no') return send(`${tag} NO [UNAVAILABLE] synthetic\r\n`)
      const max = Math.max(0, ...selected.messages.map(message => message.uid))
      const found = modes.search === 'empty' ? [] : selected.messages.filter(message => inSet(match![1], message.uid, max)).map(message => message.uid)
      return send(`* SEARCH${found.map(uid => ` ${uid}`).join('')}\r\n`, `${tag} OK searched\r\n`)
    }
    if ((match = /^UID MOVE (\d+) "(.+)"$/.exec(command)) && selected) {
      const index = selected.messages.findIndex(message => message.uid === Number(match![1])), target = folders[match[2]]
      const moved = { ...selected.messages[index], uid: Math.max(0, ...target.messages.map(message => message.uid)) + 1 }
      target.messages.push(moved); selected.messages.splice(index, 1)
      return send(`* OK [COPYUID ${target.uidValidity} ${match[1]} ${moved.uid}] moved\r\n`, `* ${index + 1} EXPUNGE\r\n`, `${tag} OK moved\r\n`)
    }
    if (command === 'LIST "" "*"') return send(...Object.keys(folders).map(name => `* LIST (${folders[name].specialUse ?? (name === 'Trash' ? '\\Trash' : name === 'Sent' ? '\\Sent' : '\\HasNoChildren')}) "/" "${name}"\r\n`), `${tag} OK listed\r\n`)
    return send(`${tag} BAD unsupported\r\n`)
  }
  let input = ''
  const api: MailTransportApi = {
    network: {
      fetch: vi.fn(),
      open: vi.fn(async () => { output = []; selected = undefined; send('* OK ready\r\n'); return 'socket' }),
      // @ts-expect-error The mock only serves the base64 overload of network.read.
      read: vi.fn(async (_id: string, max: number) => {
        const taken: Uint8Array[] = []
        let size = 0
        while (output.length && size < max) {
          const chunk = output[0], take = Math.min(max - size, chunk.length)
          taken.push(chunk.subarray(0, take)); size += take
          if (take === chunk.length) output.shift(); else output[0] = chunk.subarray(take)
        }
        return { base64: encodeBytes(join(taken)), done: false }
      }),
      write: vi.fn(async (_id: string, base64: string) => {
        input += new TextDecoder().decode(decodeBytes(base64))
        for (let end = input.indexOf('\r\n'); end >= 0; end = input.indexOf('\r\n')) { const line = input.slice(0, end); input = input.slice(end + 2); const [tag, ...rest] = line.split(' '); run(tag, rest.join(' ')) }
      }),
      startTls: vi.fn(async () => undefined), close: vi.fn(async () => undefined)
    },
    credentials: { presence: vi.fn(async () => 'stored' as const), state: vi.fn(async () => 'ok' as const), set: vi.fn(), delete: vi.fn(), handle: vi.fn(async () => 'handle'),
      write: vi.fn(async () => { if (pendingAuth) { send(`${pendingAuth} OK authenticated\r\n`); pendingAuth = undefined } }) },
    accounts: { list: vi.fn(async () => []), authorize: vi.fn() }
  }
  return { api, commands, bodies, modes, folders, reset: () => { commands.length = 0; bodies.length = 0 } }
}
