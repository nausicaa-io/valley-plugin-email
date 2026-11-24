import { createIndexObserver, type ContactDirectoryEntry, type ValleyPluginApi } from '@valley/plugin-sdk'
import { CONFIG_DIR } from '@valley/plugin-sdk/paths'

export interface VcfOrganization {
  name?: string
  department?: string
  title?: string
}

export interface VcfRelation {
  type: string
  to: string
  role?: string
}

export interface VcfContact {
  id: string
  relPath: string
  displayName: string
  firstName: string
  lastName: string
  nickname: string
  emails: { address: string; label?: string }[]
  organizations: VcfOrganization[]
  groups: string[]
  relations: VcfRelation[]
  note: string
}

export interface VcfContactsSnapshot {
  root: string
  contacts: VcfContact[]
  count: number
  emailCount: number
  loading: boolean
}

export interface VcfContactsStore {
  getSnapshot(): VcfContactsSnapshot
  subscribe(listener: () => void): () => void
  ready(): Promise<void>
  resolveEmail(address: string): VcfContact[]
  resolveEmails(addresses: string[]): Map<string, VcfContact[]>
  search(query: string, limit?: number): VcfContact[]
  toDirectoryEntry(contact: VcfContact): ContactDirectoryEntry
  dispose(): Promise<void>
}

const CONTACT_EXTENSION = '.vcf'
const MAX_CONCURRENT_READS = 4
const MAX_NOTE_LENGTH = 240
const IGNORED_EMAIL_TYPES = new Set(['internet', 'pref', 'x-internet', 'voice', 'msg'])

export function readContactsRoot(api: Pick<ValleyPluginApi, 'settings'>): string {
  const raw = api.settings.get().contactsRoot
  return typeof raw === 'string' ? raw.trim().replace(/^\/+|\/+$/g, '') : ''
}

function normalizedPrefix(root: string): string {
  const cleaned = root.trim().replace(/^\/+|\/+$/g, '')
  return !cleaned || cleaned === '.' ? '' : `${cleaned.toLowerCase()}/`
}

function unescapeVCardValue(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_match, code: string) => (code === 'n' || code === 'N' ? '\n' : code))
}

function decodeQuotedPrintable(value: string): string {
  const cleaned = value.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '=' && /^[0-9a-fA-F]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(cleaned.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(cleaned.charCodeAt(i) & 0xff)
    }
  }
  try {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes))
  } catch {
    return cleaned
  }
}

function splitEscaped(value: string, separator: string): string[] {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value[++i]
      continue
    }
    if (ch === separator) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

function splitOutsideQuotes(value: string, separator: string, limit = Infinity): string[] {
  const out: string[] = []
  let quoted = false
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '"') quoted = !quoted
    else if (ch === separator && !quoted) {
      out.push(value.slice(start, i))
      start = i + 1
      if (out.length === limit - 1) break
    }
  }
  out.push(value.slice(start))
  return out
}

function cleanParam(value: string): string {
  const stripped = value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  return stripped.replace(/\^([n^'])/g, (_m, code: string) => (code === 'n' ? '\n' : code === '^' ? '^' : '"')).trim()
}

function fileBaseName(relPath: string): string {
  return (relPath.split('/').pop() ?? relPath).replace(/\.vcf$/i, '').trim()
}

/**
 * Unfold physical vCard lines while skipping heavy binary properties (PHOTO/LOGO/SOUND)
 * so cards with embedded multi-megabyte avatars parse instantaneously.
 */
function unfoldVCardLines(raw: string): string[] {
  const physical = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const lines: string[] = []
  let skippingBinary = false
  for (const line of physical) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (!skippingBinary && lines.length) lines[lines.length - 1] += line.slice(1)
      continue
    }
    const colon = line.indexOf(':')
    const head = (colon >= 0 ? line.slice(0, colon) : line).toUpperCase()
    const prop = head.split(';')[0].split('.').pop()?.trim() ?? ''
    if (prop === 'PHOTO' || prop === 'LOGO' || prop === 'SOUND' || prop === 'KEY') {
      skippingBinary = true
      continue
    }
    skippingBinary = false
    if (line.trim()) lines.push(line)
  }
  return lines
}

/** Parse one or more vCard 2.1 / 3.0 / 4.0 cards from a `.vcf` file. */
export function parseVcfFile(relPath: string, raw: string): VcfContact[] {
  const lines = unfoldVCardLines(raw)
  const cards: string[][] = []
  let current: string[] | null = null
  for (const line of lines) {
    const upper = line.trim().toUpperCase()
    if (upper === 'BEGIN:VCARD') {
      current = []
      continue
    }
    if (upper === 'END:VCARD') {
      if (current) cards.push(current)
      current = null
      continue
    }
    if (current) current.push(line)
  }
  const results: VcfContact[] = []
  const fallbackName = fileBaseName(relPath)

  cards.forEach((cardLines, cardIndex) => {
    let uid = ''
    let fn = ''
    let firstName = ''
    let lastName = ''
    let nickname = ''
    let note = ''
    let title = ''
    let role = ''
    const emails: { address: string; label?: string }[] = []
    const seenEmails = new Set<string>()
    const orgs: VcfOrganization[] = []
    const groups: string[] = []
    const seenGroups = new Set<string>()
    const relations: VcfRelation[] = []
    const groupLabels = new Map<string, string>()

    interface ParsedProp {
      group: string
      name: string
      types: string[]
      encoding: string
      value: string
    }
    const props: ParsedProp[] = []

    for (const line of cardLines) {
      const [head, value] = splitOutsideQuotes(line, ':', 2)
      if (value === undefined) continue
      const [nameWithGroup, ...rawParams] = splitOutsideQuotes(head, ';')
      const dot = nameWithGroup.lastIndexOf('.')
      const group = dot > 0 ? nameWithGroup.slice(0, dot).trim().toLowerCase() : ''
      const name = (dot > 0 ? nameWithGroup.slice(dot + 1) : nameWithGroup).trim().toUpperCase()
      if (!/^[A-Z0-9-]+$/.test(name)) continue
      const types: string[] = []
      let encoding = ''
      for (const param of rawParams) {
        const eq = param.indexOf('=')
        if (eq < 0) {
          const bare = param.trim().toUpperCase()
          if (bare === 'QUOTED-PRINTABLE' || bare === 'BASE64') encoding = bare
          else if (bare) types.push(bare)
        } else {
          const key = param.slice(0, eq).trim().toUpperCase()
          const vals = splitOutsideQuotes(param.slice(eq + 1), ',').map(cleanParam).filter(Boolean)
          if (key === 'TYPE') types.push(...vals)
          else if (key === 'ENCODING' && vals[0]) encoding = vals[0].toUpperCase()
        }
      }
      const decoded = encoding === 'QUOTED-PRINTABLE' ? decodeQuotedPrintable(value) : value
      if (name === 'X-ABLABEL' && group) {
        const cleaned = unescapeVCardValue(decoded).replace(/^_\$!<(.*?)>!\$_$/, '$1').trim()
        if (cleaned) groupLabels.set(group, cleaned)
        continue
      }
      props.push({ group, name, types, encoding, value: decoded })
    }

    for (const prop of props) {
      const val = unescapeVCardValue(prop.value).trim()
      if (!val) continue
      switch (prop.name) {
        case 'UID':
          if (!uid) uid = val
          break
        case 'FN':
          if (!fn) fn = val
          break
        case 'N': {
          const parts = splitEscaped(prop.value, ';').map((p) => unescapeVCardValue(p).trim())
          if (!lastName && parts[0]) lastName = parts[0]
          if (!firstName && parts[1]) firstName = parts[1]
          break
        }
        case 'NICKNAME':
          if (!nickname) nickname = splitEscaped(prop.value, ',').map((p) => unescapeVCardValue(p).trim()).filter(Boolean)[0] ?? ''
          break
        case 'EMAIL': {
          const addr = val.replace(/^mailto:/i, '').trim().toLowerCase()
          if (!addr || !addr.includes('@') || seenEmails.has(addr)) break
          seenEmails.add(addr)
          const label = (prop.group ? groupLabels.get(prop.group) : undefined)
            ?? prop.types.map((t) => t.replace(/^X-/i, '').trim()).find((t) => t && !IGNORED_EMAIL_TYPES.has(t.toLowerCase()))
          emails.push({ address: addr, ...(label ? { label: label.toLowerCase() } : {}) })
          break
        }
        case 'ORG': {
          const parts = splitEscaped(prop.value, ';').map((p) => unescapeVCardValue(p).trim()).filter(Boolean)
          if (parts.length) orgs.push({ name: parts[0], ...(parts[1] ? { department: parts[1] } : {}) })
          break
        }
        case 'TITLE':
          if (!title) title = val
          break
        case 'ROLE':
          if (!role) role = val
          break
        case 'CATEGORIES': {
          for (const rawGroup of splitEscaped(prop.value, ',')) {
            const cleaned = unescapeVCardValue(rawGroup).trim()
            if (cleaned && !seenGroups.has(cleaned.toLowerCase())) {
              seenGroups.add(cleaned.toLowerCase())
              groups.push(cleaned)
            }
          }
          break
        }
        case 'RELATED':
        case 'X-VALLEY-RELATION': {
          const relType = prop.types[0]?.toLowerCase() || 'other'
          const target = val.replace(/^urn:uuid:/i, '').replace(/^\[\[|\]\]$/g, '').trim()
          if (target) relations.push({ type: relType, to: target })
          break
        }
        case 'NOTE':
          if (!note) note = val.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LENGTH)
          break
      }
    }

    if (title || role) {
      const effectiveTitle = title || role
      if (orgs.length) {
        if (!orgs[0].title) orgs[0].title = effectiveTitle
      } else {
        orgs.push({ title: effectiveTitle })
      }
    }

    const joinedName = [firstName, lastName].filter(Boolean).join(' ')
    const displayName = fn || joinedName || nickname || orgs[0]?.name || (cards.length === 1 ? fallbackName : '') || emails[0]?.address || ''
    if (!displayName && !emails.length) return

    results.push({
      id: uid ? `vcf:${uid}` : `vcf:${relPath}${cardIndex > 0 ? `#${cardIndex}` : ''}`,
      relPath,
      displayName,
      firstName,
      lastName,
      nickname,
      emails,
      organizations: orgs,
      groups,
      relations,
      note
    })
  })

  return results
}

function underRoot(relPath: string, root: string): boolean {
  const firstSegment = relPath.split('/')[0]?.toLowerCase() ?? ''
  if (firstSegment === CONFIG_DIR) return false
  if (!relPath.toLowerCase().endsWith(CONTACT_EXTENSION)) return false
  const prefix = normalizedPrefix(root)
  if (!prefix) return true
  return relPath.toLowerCase().startsWith(prefix)
}

export function createVcfContactsStore(api: ValleyPluginApi): VcfContactsStore {
  const hasIndex = Boolean(api.index && typeof api.index.observe === 'function')
  let observer: ReturnType<typeof createIndexObserver> | null = null
  let offIndex: (() => void) | undefined
  const files = new Map<string, { key: string; contacts: VcfContact[]; pending: boolean }>()
  const queue: { path: string; record: { key: string; contacts: VcfContact[]; pending: boolean } }[] = []
  const listeners = new Set<() => void>()
  let active = true
  let generation = 0
  let reading = 0
  let notifyQueued = false
  let root = readContactsRoot(api)
  let byEmail = new Map<string, VcfContact[]>()
  let snapshot: VcfContactsSnapshot = { root, contacts: [], count: 0, emailCount: 0, loading: false }
  const waiters: (() => void)[] = []

  const resolveWaiters = (): void => {
    if (snapshot.loading) return
    while (waiters.length) waiters.shift()!()
  }

  const rebuild = (): void => {
    const contacts: VcfContact[] = []
    const emailMap = new Map<string, VcfContact[]>()
    let loading = false
    for (const record of files.values()) {
      if (record.pending) loading = true
      for (const contact of record.contacts) {
        contacts.push(contact)
        for (const email of contact.emails) {
          const list = emailMap.get(email.address) ?? []
          list.push(contact)
          emailMap.set(email.address, list)
        }
      }
    }
    contacts.sort((a, b) => a.displayName.localeCompare(b.displayName))
    byEmail = emailMap
    snapshot = { root, contacts, count: contacts.length, emailCount: emailMap.size, loading }
    resolveWaiters()
    for (const listener of [...listeners]) listener()
  }

  const scheduleNotify = (): void => {
    if (notifyQueued || !active) return
    notifyQueued = true
    queueMicrotask(() => {
      notifyQueued = false
      if (active) rebuild()
    })
  }

  const pump = (): void => {
    while (active && reading < MAX_CONCURRENT_READS && queue.length) {
      const { path, record } = queue.shift()!
      if (files.get(path) !== record) continue
      reading++
      const epoch = generation
      void api.realm.readFile(path).then((raw) => {
        if (!active || epoch !== generation || files.get(path) !== record) return
        try {
          record.contacts = parseVcfFile(path, raw)
        } catch {
          record.contacts = []
        }
      }, () => {
        if (active && epoch === generation && files.get(path) === record) record.contacts = []
      }).finally(() => {
        if (epoch !== generation) return
        reading--
        if (files.get(path) === record) record.pending = false
        pump()
        scheduleNotify()
      })
    }
  }

  const ensureObserver = (): ReturnType<typeof createIndexObserver> | null => {
    if (!hasIndex || !root) return null
    if (!observer) {
      observer = createIndexObserver(api, { extensions: [CONTACT_EXTENSION], fields: ['mtimeMs', 'size'] })
      offIndex = observer.subscribe(syncIndex)
    }
    return observer
  }

  const dropObserver = (): void => {
    offIndex?.()
    offIndex = undefined
    const previous = observer
    observer = null
    if (previous) void previous.dispose().catch(() => {})
  }

  const syncIndex = (): void => {
    if (!active) return
    const nextRoot = readContactsRoot(api)
    if (nextRoot !== root) {
      root = nextRoot
      generation++
      files.clear()
      queue.length = 0
      reading = 0
      if (!root) dropObserver()
    }
    const activeObserver = ensureObserver()
    if (!activeObserver) {
      rebuild()
      return
    }
    const indexSnap = activeObserver.getSnapshot()
    if (indexSnap.status === 'loading') {
      snapshot = { ...snapshot, root, loading: true }
      for (const listener of [...listeners]) listener()
      return
    }
    const entries = indexSnap.status === 'ready' ? indexSnap.entries : []
    const retained = new Set<string>()
    for (const entry of entries) {
      if (!underRoot(entry.relPath, root)) continue
      retained.add(entry.relPath)
      const key = `${entry.mtimeMs ?? ''}:${entry.size ?? ''}`
      let record = files.get(entry.relPath)
      if (!record || record.key !== key) {
        record = { key, contacts: record?.contacts ?? [], pending: true }
        files.set(entry.relPath, record)
        queue.push({ path: entry.relPath, record })
      }
    }
    for (const path of [...files.keys()]) {
      if (!retained.has(path)) files.delete(path)
    }
    pump()
    rebuild()
  }

  const offSettings = api.settings.subscribe(() => {
    if (readContactsRoot(api) !== root) syncIndex()
  })
  syncIndex()

  const toDirectoryEntry = (contact: VcfContact): ContactDirectoryEntry => ({
    id: contact.id,
    displayName: contact.displayName,
    emails: contact.emails
  })

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    ready: () => {
      if (!snapshot.loading) return Promise.resolve()
      return new Promise<void>((resolve) => { waiters.push(resolve) })
    },
    resolveEmail: (address) => byEmail.get(address.trim().toLowerCase()) ?? [],
    resolveEmails: (addresses) => {
      const result = new Map<string, VcfContact[]>()
      for (const raw of addresses) {
        const key = raw.trim().toLowerCase()
        if (key) result.set(key, byEmail.get(key) ?? [])
      }
      return result
    },
    search: (query, limit = 10) => {
      const q = query.trim().toLowerCase()
      if (!q) return snapshot.contacts.slice(0, limit)
      const matches: VcfContact[] = []
      for (const contact of snapshot.contacts) {
        const hay = [
          contact.displayName,
          contact.firstName,
          contact.lastName,
          contact.nickname,
          ...contact.emails.map((e) => e.address),
          ...contact.organizations.flatMap((o) => [o.name ?? '', o.title ?? '']),
          ...contact.groups
        ].join(' ').toLowerCase()
        if (hay.includes(q)) {
          matches.push(contact)
          if (matches.length >= limit) break
        }
      }
      return matches
    },
    toDirectoryEntry,
    dispose: async () => {
      active = false
      offIndex?.()
      offIndex = undefined
      offSettings()
      files.clear()
      queue.length = 0
      listeners.clear()
      while (waiters.length) waiters.shift()!()
      const current = observer
      observer = null
      await current?.dispose()
    }
  }
}

/** Build a compact, high-signal contact profile for AI classification. */
export function formatVcfContactForAi(contacts: VcfContact[], senderAddress: string): Record<string, unknown> | undefined {
  if (!contacts.length) return undefined
  const contact = contacts[0]
  const matchedEmail = contact.emails.find((entry) => entry.address === senderAddress.toLowerCase())
  const orgs = contact.organizations
    .map((org) => [org.name, org.title, org.department].filter(Boolean).join(' — '))
    .filter(Boolean)
  const relations = contact.relations.map((rel) => (rel.role ? `${rel.type} (${rel.role})` : rel.type)).filter(Boolean)
  return {
    known: true,
    name: contact.displayName,
    ...(contact.nickname ? { nickname: contact.nickname } : {}),
    ...(matchedEmail?.label ? { emailLabel: matchedEmail.label } : {}),
    ...(orgs.length ? { organizations: orgs } : {}),
    ...(contact.groups.length ? { groups: contact.groups } : {}),
    ...(relations.length ? { relations } : {}),
    ...(contact.note ? { note: contact.note } : {})
  }
}
