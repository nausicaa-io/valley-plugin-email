import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { AiClassificationResult, AiModelRef } from '@valley/plugin-sdk/ai'
import { digest } from './backend/identity'
import type { EmailFilters } from './mailTypes'

export type SmartGroupRule = { kind: 'address'; value: string } | { kind: 'domain'; value: string } | { kind: 'contact'; contactId: string; label: string }
export interface SmartGroup { id: string; name: string; decision: string; threshold: number; rules: SmartGroupRule[]; children: SmartGroup[] }
export interface SmartGroupsAccount { groups: SmartGroup[] }
export interface SmartGroupsConfig { version: 1; enabled: boolean; provider: AiModelRef | null; dailyLimit: number; accounts: Record<string, SmartGroupsAccount> }
export interface SmartGroupEntry { group: SmartGroup; depth: number; path: string[]; parentId: string | null }
export type SmartGroupOutcome = { status: 'decided'; categoryId: string | null; confidence: number | null; source: 'rule' | 'ai' | null; /** An ungrouped result's most likely top-level group below its threshold, for threshold tuning. */ best?: { categoryId: string; confidence: number } }
  | { status: 'paused'; reason: 'unavailable' | 'rate-limited'; retryAt: number }
export type SmartGroupClassifier = (categories: { id: string; description: string }[]) => Promise<AiClassificationResult>

export const SMART_GROUPS_FILE = 'smart-groups.json'
export const NO_GROUP = 'uncategorized'
export const SMART_GROUP_LIMITS = { depth: 3, siblings: 254, groups: 500, rules: 50, name: 80, decision: 2000, value: 320 } as const
export const DEFAULT_THRESHOLD = 60

const text = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : ''
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export const emptySmartGroups = (): SmartGroupsConfig => ({ version: 1, enabled: false, provider: null, dailyLimit: 100, accounts: {} })
export const dailyLimitValue = (value: unknown): number => Math.max(0, Math.min(10000, Math.floor(Number(value ?? 100) || 0)))
export const newGroupId = (): string => `g-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

function normalizeRule(value: unknown): SmartGroupRule | null {
  const raw = record(value)
  if (raw.kind === 'contact') {
    const contactId = text(raw.contactId, 200)
    return contactId ? { kind: 'contact', contactId, label: text(raw.label, SMART_GROUP_LIMITS.name) || contactId } : null
  }
  if (raw.kind !== 'address' && raw.kind !== 'domain') return null
  const entry = text(raw.value, SMART_GROUP_LIMITS.value).toLowerCase()
  return { kind: raw.kind, value: raw.kind === 'domain' ? entry.replace(/^@+/, '') : entry }
}

function normalizeGroups(value: unknown, depth: number, seen: Set<string>, budget: { left: number }): SmartGroup[] {
  if (!Array.isArray(value) || depth >= SMART_GROUP_LIMITS.depth) return []
  const groups: SmartGroup[] = []
  for (const item of value) {
    if (groups.length >= SMART_GROUP_LIMITS.siblings || budget.left <= 0) break
    const raw = record(item), id = text(raw.id, 200)
    if (!id || id === NO_GROUP || seen.has(id)) continue
    seen.add(id); budget.left--
    const threshold = Number(raw.threshold)
    groups.push({
      id, name: text(raw.name, SMART_GROUP_LIMITS.name), decision: text(raw.decision, SMART_GROUP_LIMITS.decision),
      threshold: Number.isFinite(threshold) ? Math.max(0, Math.min(100, Math.round(threshold))) : DEFAULT_THRESHOLD,
      rules: (Array.isArray(raw.rules) ? raw.rules : []).slice(0, SMART_GROUP_LIMITS.rules).map(normalizeRule).filter((rule): rule is SmartGroupRule => Boolean(rule)),
      children: normalizeGroups(raw.children, depth + 1, seen, budget)
    })
  }
  return groups
}

export function normalizeAccount(value: unknown): SmartGroupsAccount {
  const raw = record(value)
  return { groups: normalizeGroups(raw.groups, 0, new Set(), { left: SMART_GROUP_LIMITS.groups }) }
}

function normalizeProvider(value: unknown): AiModelRef | null {
  const raw = record(value), provider = text(raw.provider, 64), model = text(raw.model, 512), connectionId = text(raw.connectionId, 64)
  return provider && model ? { provider, model, ...(connectionId ? { connectionId } : {}) } : null
}

export function normalizeSmartGroups(value: unknown): SmartGroupsConfig {
  const raw = record(value)
  const accounts: Record<string, SmartGroupsAccount> = {}
  for (const [id, account] of Object.entries(record(raw.accounts)).slice(0, 100)) if (id.trim()) accounts[id] = normalizeAccount(account)
  return { version: 1, enabled: raw.enabled === true, provider: normalizeProvider(raw.provider), dailyLimit: dailyLimitValue(raw.dailyLimit), accounts }
}

/** One-time transfer of the former global categories: every account gets them as top-level groups with the same ids, so existing assignments keep resolving. */
export function migrateLegacyGrouping(legacy: unknown, sharedGroups: { id: string; name: string }[], accountIds: string[]): SmartGroupsConfig {
  const raw = record(legacy), categories = Object.entries(record(raw.categories)).filter(([id, description]) => id !== NO_GROUP && typeof description === 'string')
  const groups = categories.map(([id, description]) => ({ id, name: sharedGroups.find(group => group.id === id)?.name ?? id, decision: String(description), threshold: DEFAULT_THRESHOLD, rules: [], children: [] }))
  const config = normalizeSmartGroups({ enabled: raw.automatic === true, dailyLimit: raw.dailyLimit, provider: null })
  if (groups.length) for (const id of accountIds) config.accounts[id] = normalizeAccount({ groups })
  return config
}

/** Accounts without an entry get the starter groups once the switch is on; an account emptied by the user stays empty. */
export function fillStarters(config: SmartGroupsConfig, accounts: { id: string }[], starters: () => SmartGroup[]): boolean {
  if (!config.enabled) return false
  let changed = false
  for (const account of accounts) {
    if (config.accounts[account.id]) continue
    const groups = starters()
    if (!groups.length) break
    config.accounts[account.id] = normalizeAccount({ groups }); changed = true
  }
  return changed
}

/** Hand-authored entries may name an account by address; they are adopted under the account id, adding their groups after any existing ones. */
export function adoptAccountKeys(config: SmartGroupsConfig, accounts: { id: string; address: string }[]): boolean {
  let changed = false
  for (const key of Object.keys(config.accounts)) {
    if (accounts.some(account => account.id === key)) continue
    const account = accounts.find(candidate => candidate.address.trim().toLowerCase() === key.trim().toLowerCase())
    if (!account) continue
    const adopted = config.accounts[key], existing = config.accounts[account.id]
    config.accounts[account.id] = existing ? normalizeAccount({ groups: [...existing.groups, ...adopted.groups] }) : adopted
    delete config.accounts[key]
    changed = true
  }
  return changed
}

export function flattenGroups(groups: SmartGroup[], depth = 0, path: string[] = [], parentId: string | null = null): SmartGroupEntry[] {
  return groups.flatMap(group => [{ group, depth, path: [...path, group.name], parentId }, ...flattenGroups(group.children, depth + 1, [...path, group.name], group.id)])
}

export const findGroupPath = (groups: SmartGroup[], id: string): SmartGroup[] | undefined => {
  for (const group of groups) {
    if (group.id === id) return [group]
    const inner = findGroupPath(group.children, id)
    if (inner) return [group, ...inner]
  }
  return undefined
}

export const descendantIds = (group: SmartGroup): string[] => [group.id, ...group.children.flatMap(descendantIds)]
export const groupLabel = (groups: SmartGroup[], id: string): string | undefined => findGroupPath(groups, id)?.map(group => group.name || '…').join(' / ')

export function senderAddress(from: string): string {
  const match = /<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>"',;]+@[^\s<>"',;]+)/.exec(from)
  return (match?.[1] ?? '').trim().toLowerCase()
}

export function ruleMatches(rule: SmartGroupRule, sender: string, contactIds: ReadonlySet<string>): boolean {
  if (!sender) return false
  if (rule.kind === 'contact') return contactIds.has(rule.contactId)
  if (!rule.value) return false
  if (rule.kind === 'address') return sender === rule.value
  const domain = sender.slice(sender.lastIndexOf('@') + 1)
  return domain === rule.value || domain.endsWith(`.${rule.value}`)
}

export const usesContacts = (groups: SmartGroup[]): boolean => flattenGroups(groups).some(entry => entry.group.rules.some(rule => rule.kind === 'contact'))
export const hasRules = (groups: SmartGroup[]): boolean => flattenGroups(groups).some(entry => entry.group.rules.some(rule => rule.kind === 'contact' || Boolean(rule.value)))

/**
 * Walks the tree level by level. Rules decide first and need no provider; otherwise one provider-neutral classification
 * over the level's groups plus "none". A group qualifies at or above its own threshold, and its subgroups are only
 * considered once it qualified. The deepest qualifying group wins.
 */
export async function decideSmartGroup(groups: SmartGroup[], message: { sender: string; contactIds: ReadonlySet<string> }, classify?: SmartGroupClassifier): Promise<SmartGroupOutcome> {
  let level = groups
  let chosen: { group: SmartGroup; confidence: number; source: 'rule' | 'ai' } | undefined
  let best: { group: SmartGroup; confidence: number } | undefined
  for (let depth = 0; level.length && depth < SMART_GROUP_LIMITS.depth; depth++) {
    let next: typeof chosen
    const ruled = level.find(group => group.rules.some(rule => ruleMatches(rule, message.sender, message.contactIds)))
    if (ruled) next = { group: ruled, confidence: 1, source: 'rule' }
    else if (classify) {
      const eligible = level.filter(group => group.decision)
      if (eligible.length) {
        const result = await classify([
          ...eligible.map(group => ({ id: group.id, description: `${group.name}: ${group.decision}` })),
          { id: NO_GROUP, description: chosen ? `None of these subgroups fits; the message stays in ${chosen.group.name}.` : 'None of these groups fits this message.' }
        ])
        if (result.status === 'paused') return result
        for (const group of eligible) {
          const probability = Number(result.probabilities[group.id] ?? 0)
          if (probability >= group.threshold / 100 && (!next || probability > next.confidence)) next = { group, confidence: probability, source: 'ai' }
          if (depth === 0 && probability > 0 && (!best || probability > best.confidence)) best = { group, confidence: probability }
        }
      }
    }
    if (!next) break
    chosen = next
    level = next.group.children
  }
  const rounded = (value: number) => Math.round(value * 1000) / 1000
  return { status: 'decided', categoryId: chosen?.group.id ?? null, confidence: chosen ? rounded(chosen.confidence) : null, source: chosen?.source ?? null,
    ...(!chosen && best ? { best: { categoryId: best.group.id, confidence: rounded(best.confidence) } } : {}) }
}

export const accountRevision = (model: AiModelRef | undefined, account: SmartGroupsAccount): Promise<string> => digest(JSON.stringify([model ?? null, account.groups]))

export async function resolveClassifierModel(api: ValleyPluginApi, config: SmartGroupsConfig): Promise<AiModelRef | undefined> {
  return config.provider ?? (await api.ai.defaults()).classification
}

type ReadBaseline = Awaited<ReturnType<ValleyPluginApi['data']['files']['readTextBaseline']>>

export interface SmartGroupsStore {
  ready: Promise<void>
  get(): SmartGroupsConfig
  subscribe(listener: () => void): () => void
  reload(): Promise<void>
  update(mutate: (config: SmartGroupsConfig) => SmartGroupsConfig | void): Promise<void>
  dispose(): void
}

export function createSmartGroupsStore(api: ValleyPluginApi, accounts: () => { id: string; address: string }[], start: Promise<unknown> = Promise.resolve(), starters: () => SmartGroup[] = () => []): SmartGroupsStore {
  let config = emptySmartGroups()
  let baseline: NonNullable<ReadBaseline>['baseline'] | null = null
  let exists = false, disposed = false
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of listeners) listener() }
  let queue = Promise.resolve()
  const serialize = (work: () => Promise<void>): Promise<void> => { const next = queue.then(work); queue = next.catch(() => {}); return next }
  const write = async (next: SmartGroupsConfig): Promise<boolean> => {
    const result = await api.data.files.writeTextGuarded(SMART_GROUPS_FILE, `${JSON.stringify(next, null, 2)}\n`, exists ? baseline : null)
    if (!result.ok) return false
    config = next; baseline = result.baseline; exists = true; emit()
    return true
  }
  const read = async (): Promise<void> => {
    const file = await api.data.files.readTextBaseline(SMART_GROUPS_FILE)
    if (disposed) return
    if (file?.baseline) {
      let parsed: unknown
      try { parsed = JSON.parse(file.content) } catch { parsed = {} }
      config = normalizeSmartGroups(parsed); baseline = file.baseline; exists = true
    } else {
      exists = false; baseline = null
      config = migrateLegacyGrouping(api.settings.get().grouping, api.getState().groups ?? [], accounts().map(account => account.id))
    }
    emit()
  }
  const persistAdopted = async (): Promise<void> => {
    if (!exists && !accounts().length) return
    const next = structuredClone(config)
    const adopted = adoptAccountKeys(next, accounts())
    const started = fillStarters(next, accounts(), starters)
    if (adopted || started || !exists && (next.enabled || Object.keys(next.accounts).length)) await write(next)
  }
  const reload = (): Promise<void> => serialize(async () => { await read(); await persistAdopted() })
  const ready = start.then(reload, reload).catch(() => {})
  const off = api.data.files.onChanged(path => { if (path === SMART_GROUPS_FILE) void reload().catch(() => {}) })
  return {
    ready, reload,
    get: () => config,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    update: mutate => serialize(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const draft = structuredClone(config)
        const next = normalizeSmartGroups(mutate(draft) ?? draft)
        fillStarters(next, accounts(), starters)
        if (await write(next)) return
        await read()
      }
      throw new Error('Smart groups changed elsewhere; try again.')
    }),
    dispose: () => { disposed = true; off(); listeners.clear() }
  }
}

const starter = (id: string, name: string, decision: string, children: SmartGroup[] = []): SmartGroup => ({ id, name, decision, threshold: DEFAULT_THRESHOLD, rules: [], children })
/** Ready-made groups so the switch works with no setup; names and sentences come from the active catalog. */
export const starterGroups = (t: (key: string) => string): SmartGroup[] => [
  starter('receipts', t('email.smartGroups.starter.receipts'), t('email.smartGroups.starter.receiptsWhen'), [
    starter('receipts-subscriptions', t('email.smartGroups.starter.subscriptions'), t('email.smartGroups.starter.subscriptionsWhen')),
    starter('receipts-bills', t('email.smartGroups.starter.bills'), t('email.smartGroups.starter.billsWhen'))
  ]),
  starter('travel', t('email.smartGroups.starter.travel'), t('email.smartGroups.starter.travelWhen')),
  starter('newsletters', t('email.smartGroups.starter.newsletters'), t('email.smartGroups.starter.newslettersWhen'))
]

export const newSmartGroup = (name = ''): SmartGroup => ({ id: newGroupId(), name, decision: '', threshold: DEFAULT_THRESHOLD, rules: [], children: [] })

function editSiblings(groups: SmartGroup[], id: string, edit: (siblings: SmartGroup[], index: number) => SmartGroup[]): SmartGroup[] {
  const index = groups.findIndex(group => group.id === id)
  if (index >= 0) return edit(groups, index)
  return groups.map(group => ({ ...group, children: editSiblings(group.children, id, edit) }))
}

export const updateGroup = (groups: SmartGroup[], id: string, patch: Partial<Omit<SmartGroup, 'id'>>): SmartGroup[] =>
  editSiblings(groups, id, (siblings, index) => siblings.map((group, position) => position === index ? { ...group, ...patch } : group))
export const removeGroup = (groups: SmartGroup[], id: string): SmartGroup[] => editSiblings(groups, id, (siblings, index) => siblings.filter((_, position) => position !== index))
export const moveGroup = (groups: SmartGroup[], id: string, delta: -1 | 1): SmartGroup[] => editSiblings(groups, id, (siblings, index) => {
  const target = index + delta
  if (target < 0 || target >= siblings.length) return siblings
  const next = [...siblings]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
})
export const addGroup = (groups: SmartGroup[], parentId: string | null, group: SmartGroup): SmartGroup[] =>
  parentId ? editSiblings(groups, parentId, (siblings, index) => siblings.map((item, position) => position === index ? { ...item, children: [...item.children, group] } : item)) : [...groups, group]

export const noGroupFilter = { categoryId: undefined, categoryIds: undefined, categoryAccountId: undefined } satisfies Partial<EmailFilters>
export function groupFilter(config: SmartGroupsConfig, accountId: string, groupId: string): Pick<EmailFilters, 'categoryId' | 'categoryIds' | 'categoryAccountId'> {
  const path = findGroupPath(config.accounts[accountId]?.groups ?? [], groupId)
  return path ? { categoryId: groupId, categoryIds: descendantIds(path[path.length - 1]), categoryAccountId: accountId } : noGroupFilter
}

/**
 * The saved filters with their group part resolved against the current groups: an open group's current subtree, nothing once the
 * group or its account is gone, and no subtree or account left over from an older picker that saved them without a group.
 */
export function currentGroupFilter(config: SmartGroupsConfig, filters: EmailFilters): EmailFilters {
  if (filters.categoryIds === undefined && filters.categoryAccountId === undefined) return filters
  const next: EmailFilters = { ...filters, ...(filters.categoryAccountId && filters.categoryId ? groupFilter(config, filters.categoryAccountId, filters.categoryId) : { categoryIds: undefined, categoryAccountId: undefined }) }
  return JSON.stringify(next) === JSON.stringify(filters) ? filters : next
}

/** "Always put mail from" chips: `name@domain` (address), `@domain` (domain), `contact:<id>:<name>` (Contacts entry). */
export const ruleChip = (rule: SmartGroupRule): string => rule.kind === 'contact' ? `contact:${encodeURIComponent(rule.contactId)}:${rule.label}` : rule.kind === 'domain' ? `@${rule.value}` : rule.value
export function chipRule(chip: string): SmartGroupRule | null {
  const value = chip.trim()
  const contact = /^contact:([^:]+):(.*)$/.exec(value)
  if (contact) return { kind: 'contact', contactId: decodeURIComponent(contact[1]), label: contact[2] }
  const lower = value.toLowerCase().replace(/^mailto:/, '')
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(lower)) return { kind: 'address', value: lower }
  if (/^@?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(lower)) return { kind: 'domain', value: lower.replace(/^@/, '') }
  return null
}
