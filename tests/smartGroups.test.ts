import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import type { AiClassificationRequest, AiClassificationResult } from '@valley/plugin-sdk/ai'
import config from '../config.json'
import { createClassificationQueue } from '../src/classificationQueue'
import { emailStoreContext, mergeFolder } from '../src/backend/cache'
import {
  addGroup, adoptAccountKeys, chipRule, createSmartGroupsStore, fillStarters, ruleChip, decideSmartGroup, findGroupPath, groupFilter, migrateLegacyGrouping, moveGroup, normalizeSmartGroups, removeGroup, SMART_GROUPS_FILE,
  type SmartGroup, type SmartGroupClassifier, type SmartGroupsConfig
} from '../src/smartGroups'

const group = (id: string, threshold: number, extra: Partial<SmartGroup> = {}): SmartGroup => ({ id, name: id, decision: `${id} mail`, threshold, rules: [], children: [], ...extra })
const tree = (): SmartGroup[] => [
  group('receipts', 60, { children: [group('subscriptions', 60), group('billing', 70)] }),
  group('family', 60, { rules: [{ kind: 'address', value: 'aunt@kin.example' }, { kind: 'domain', value: 'kin.example' }], children: [group('dinner', 50), group('photos', 50)] })
]
/** A provider answer: the probabilities the fake gives each requested category id (the rest goes to "none"). */
function fakeProvider(table: Record<string, number>) {
  const seen: string[][] = []
  const classify: SmartGroupClassifier = async categories => {
    seen.push(categories.map(category => category.id))
    const probabilities = Object.fromEntries(categories.map(category => [category.id, table[category.id] ?? 0]))
    const rest = 1 - Object.values(probabilities).reduce((sum, value) => sum + value, 0)
    probabilities.uncategorized = Math.max(0, rest + (probabilities.uncategorized ?? 0))
    const categoryId = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]
    return { status: 'completed', categoryId, confidence: probabilities[categoryId], probabilities, model: 'fixture' }
  }
  return { classify, seen }
}
const nobody = { sender: 'shop@store.example', contactIds: new Set<string>() }

describe('smart group decisions', () => {
  it('assigns a group only at or above its own threshold', async () => {
    expect(await decideSmartGroup([group('receipts', 60)], nobody, fakeProvider({ receipts: 0.59 }).classify)).toEqual({ status: 'decided', categoryId: null, confidence: null, source: null, best: { categoryId: 'receipts', confidence: 0.59 } })
    expect(await decideSmartGroup([group('receipts', 60)], nobody, fakeProvider({ receipts: 0.6 }).classify)).toEqual({ status: 'decided', categoryId: 'receipts', confidence: 0.6, source: 'ai' })
    expect(await decideSmartGroup([group('receipts', 0), group('orders', 0)], nobody, fakeProvider({ receipts: 0.2, orders: 0.3 }).classify)).toMatchObject({ categoryId: 'orders' })
  })

  it('only considers subgroups once their parent qualifies and keeps the parent when no subgroup does', async () => {
    const failed = fakeProvider({ receipts: 0.55, subscriptions: 0.99 })
    expect(await decideSmartGroup(tree(), nobody, failed.classify)).toMatchObject({ categoryId: null, best: { categoryId: 'receipts', confidence: 0.55 } })
    expect(failed.seen).toEqual([['receipts', 'family', 'uncategorized']])
    const parent = fakeProvider({ receipts: 0.8, billing: 0.69 })
    expect(await decideSmartGroup(tree(), nobody, parent.classify)).toEqual({ status: 'decided', categoryId: 'receipts', confidence: 0.8, source: 'ai' })
    expect(parent.seen).toEqual([['receipts', 'family', 'uncategorized'], ['subscriptions', 'billing', 'uncategorized']])
    expect(await decideSmartGroup(tree(), nobody, fakeProvider({ receipts: 0.8, billing: 0.7 }).classify)).toMatchObject({ categoryId: 'billing', confidence: 0.7 })
  })

  it('lets rules decide before the provider, with or without one', async () => {
    const provider = fakeProvider({ receipts: 0.99, dinner: 0.9 })
    expect(await decideSmartGroup(tree(), { sender: 'aunt@kin.example', contactIds: new Set() }, provider.classify)).toEqual({ status: 'decided', categoryId: 'dinner', confidence: 0.9, source: 'ai' })
    expect(provider.seen).toEqual([['dinner', 'photos', 'uncategorized']])
    expect(await decideSmartGroup(tree(), { sender: 'cousin@mail.kin.example', contactIds: new Set() })).toEqual({ status: 'decided', categoryId: 'family', confidence: 1, source: 'rule' })
    const contacts = [group('family', 60, { decision: '', rules: [{ kind: 'contact', contactId: 'contact-7', label: 'Aunt' }] })]
    expect(await decideSmartGroup(contacts, { sender: 'other@elsewhere.example', contactIds: new Set(['contact-7']) })).toMatchObject({ categoryId: 'family', source: 'rule' })
    expect(await decideSmartGroup(contacts, { sender: 'other@elsewhere.example', contactIds: new Set(['contact-8']) }, provider.classify)).toMatchObject({ categoryId: null })
  })

  it('passes a paused provider through so the job is retried later', async () => {
    const paused: SmartGroupClassifier = async () => ({ status: 'paused', reason: 'rate-limited', retryAt: 42 })
    expect(await decideSmartGroup(tree(), nobody, paused)).toEqual({ status: 'paused', reason: 'rate-limited', retryAt: 42 })
  })
})

describe('smart group configuration', () => {
  it('normalizes limits, duplicate ids, thresholds and the reserved none id', () => {
    const deep = { id: 'a', children: [{ id: 'b', children: [{ id: 'c', children: [{ id: 'd' }] }] }] }
    const parsed = normalizeSmartGroups({ enabled: true, dailyLimit: 99999, accounts: { forest: { enabled: true, groups: [deep, { id: 'a' }, { id: 'uncategorized' }, { id: 'e', threshold: 140, rules: [{ kind: 'domain', value: '@Kin.Example' }, { kind: 'regex', value: '.*' }] }] } } })
    expect(parsed.dailyLimit).toBe(10000)
    const groups = parsed.accounts.forest.groups
    expect(groups.map(item => item.id)).toEqual(['a', 'e'])
    expect(groups[0].children[0].children[0].children).toEqual([])
    expect(groups[1]).toMatchObject({ threshold: 100, rules: [{ kind: 'domain', value: 'kin.example' }] })
    const starters = normalizeSmartGroups({ enabled: true, accounts: { emptied: { groups: [] } } })
    expect(fillStarters(starters, [{ id: 'emptied' }, { id: 'fresh' }], () => [group('receipts', 60)])).toBe(true)
    expect(starters.accounts).toEqual({ emptied: { groups: [] }, fresh: { groups: [group('receipts', 60)] } })
    expect(fillStarters(normalizeSmartGroups({ enabled: false }), [{ id: 'fresh' }], () => [group('receipts', 60)])).toBe(false)
    expect(chipRule('Aunt@Kin.Example')).toEqual({ kind: 'address', value: 'aunt@kin.example' })
    expect(chipRule('@kin.example')).toEqual({ kind: 'domain', value: 'kin.example' })
    expect(chipRule(ruleChip({ kind: 'contact', contactId: 'c:7', label: 'Aunt Robin' }))).toEqual({ kind: 'contact', contactId: 'c:7', label: 'Aunt Robin' })
    expect(chipRule('Aunt Robin')).toBeNull()
  })

  it('edits the tree without losing other groups', () => {
    let groups = tree()
    groups = addGroup(groups, 'family', group('invitations', 60))
    groups = moveGroup(groups, 'invitations', -1)
    groups = removeGroup(groups, 'subscriptions')
    expect(groups[1].children.map(item => item.id)).toEqual(['dinner', 'invitations', 'photos'])
    expect(groups[0].children.map(item => item.id)).toEqual(['billing'])
    expect(groupFilter({ ...normalizeSmartGroups({}), accounts: { forest: { groups } } }, 'forest', 'family')).toEqual({ categoryId: 'family', categoryIds: ['family', 'dinner', 'invitations', 'photos'], categoryAccountId: 'forest' })
  })

  it('migrates the former global categories into every account with the same ids', () => {
    const migrated = migrateLegacyGrouping({ automatic: true, dailyLimit: 25, categories: { canopy: 'Forest canopy research', uncategorized: 'x' } }, [{ id: 'canopy', name: 'Canopy' }], ['forest', 'wetland'])
    expect(migrated).toMatchObject({ enabled: true, dailyLimit: 25, provider: null })
    for (const account of ['forest', 'wetland']) expect(migrated.accounts[account]).toEqual({ groups: [{ id: 'canopy', name: 'Canopy', decision: 'Forest canopy research', threshold: 60, rules: [], children: [] }] })
    expect(findGroupPath(migrated.accounts.forest.groups, 'canopy')?.[0].name).toBe('Canopy')
  })
})

const disposers: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })

async function mailbox(settings: Partial<SmartGroupsConfig>, accounts = [{ id: 'forest', address: 'forest@example.test' }, { id: 'wetland', address: 'wetland@example.test' }]) {
  const mock = createMockValleyApi({ manifest: { id: 'canopy-mail', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] }, groups: [] })
  mock.api.ai.defaults = vi.fn(async () => ({}))
  const senders = ['bills@power.example', 'aunt@kin.example', 'news@paper.example']
  for (const account of accounts) await mergeFolder(emailStoreContext(mock.api.data), account.id, 'INBOX', senders.map((from, index) => ({ uid: index + 1, messageId: `<${account.id}-${index}@example.test>`, from, to: account.address, subject: `Note ${index}`, date: '2026-01-01T00:00:00.000Z', text: 'Body', snippet: '', flags: [], hasAttachments: false })))
  const ids = mock.datasets.get('canopy-mail.messages')!.map(row => ({ id: String(row.id), accountId: String(row.accountId), from: String(row.from) }))
  const groups = createSmartGroupsStore(mock.api, () => accounts)
  await groups.ready
  await groups.update(() => normalizeSmartGroups(settings))
  const queue = createClassificationQueue(mock.api, groups, () => {}, async () => {})
  disposers.push(() => groups.dispose(), queue.dispose)
  const settled = () => vi.waitFor(async () => expect(await mock.api.data.dataset('classification_jobs').count({ status: { in: ['queued', 'running'] } })).toBe(0))
  const assignment = async (accountId: string, from: string) => mock.api.data.dataset('assignments').get({ id: ids.find(row => row.accountId === accountId && row.from === from)!.id })
  return { mock, groups, queue, ids, settled, assignment }
}
const forestGroups = { groups: [group('receipts', 60, { children: [group('billing', 60)] }), group('family', 60, { decision: '', rules: [{ kind: 'address', value: 'aunt@kin.example' }] })] }

describe('provider-neutral classification queue', () => {
  it('runs the same groups and gating for any picked classification provider', async () => {
    const answers = { receipts: 0.9, billing: 0.8 }
    const outcomes: unknown[] = []
    for (const provider of [{ provider: 'jev', connectionId: 'jev-main', model: 'jev-1.13.0' }, { provider: 'unit-test-classifier', connectionId: 'test-local', model: 'fixture' }]) {
      const { mock, queue, ids, settled, assignment } = await mailbox({ enabled: true, provider, accounts: { forest: forestGroups } })
      const requests: AiClassificationRequest[] = []
      const fake = fakeProvider(answers)
      mock.api.ai.classify = vi.fn(async (request: AiClassificationRequest): Promise<AiClassificationResult> => {
        requests.push(request)
        return /power/.test(JSON.parse(request.input).sender) ? fake.classify(request.categories) : fakeProvider({}).classify(request.categories)
      })
      await queue.enqueue(ids.map(row => row.id))
      await settled()
      outcomes.push(await Promise.all(['bills@power.example', 'aunt@kin.example', 'news@paper.example'].map(async from => {
        const row = await assignment('forest', from)
        return row && { categoryId: row.categoryId, confidence: row.confidence, source: row.source }
      })))
      expect(requests.every(request => request.provider === provider.provider && request.connectionId === provider.connectionId && request.model === provider.model)).toBe(true)
      expect(requests.map(request => request.categories.map(category => category.id).join(',')).sort()).toEqual(['billing,uncategorized', 'receipts,uncategorized', 'receipts,uncategorized'])
      expect(await mock.api.data.dataset('classification_jobs').count({ accountId: 'wetland' })).toBe(0)
    }
    expect(outcomes[0]).toEqual([{ categoryId: 'billing', confidence: 0.8, source: 'ai' }, { categoryId: 'family', confidence: 1, source: 'rule' }, { categoryId: null, confidence: null, source: null }])
    expect(outcomes[1]).toEqual(outcomes[0])
  })

  it('groups by rules alone when no provider is chosen or set as default', async () => {
    const { mock, queue, ids, settled, assignment } = await mailbox({ enabled: true, provider: null, accounts: { forest: forestGroups } })
    mock.api.ai.classify = vi.fn()
    await queue.enqueue(ids.map(row => row.id))
    await settled()
    expect(mock.api.ai.classify).not.toHaveBeenCalled()
    expect(await assignment('forest', 'aunt@kin.example')).toMatchObject({ categoryId: 'family', source: 'rule', confidence: 1 })
    expect(await assignment('forest', 'bills@power.example')).toMatchObject({ categoryId: null })
  })

  it('never sends mail of an account without groups or with the switch off', async () => {
    const provider = { provider: 'jev', connectionId: 'jev-main', model: 'jev-1.13.0' }
    const off = await mailbox({ enabled: true, provider, accounts: { forest: { groups: [] }, wetland: { groups: [] } } })
    off.mock.api.ai.classify = vi.fn()
    await off.queue.enqueue(off.ids.map(row => row.id))
    await off.queue.enqueue(off.ids.map(row => row.id), true)
    expect(await off.mock.api.data.dataset('classification_jobs').count()).toBe(0)
    const master = await mailbox({ enabled: false, provider, accounts: { forest: forestGroups } })
    master.mock.api.ai.classify = vi.fn()
    await master.queue.enqueue(master.ids.map(row => row.id))
    expect(await master.mock.api.data.dataset('classification_jobs').count()).toBe(0)
    expect(off.mock.api.ai.classify).not.toHaveBeenCalled()
    expect(master.mock.api.ai.classify).not.toHaveBeenCalled()
  })

  it('stops queued work for good once the switch is turned off', async () => {
    const { mock, groups, queue, ids } = await mailbox({ enabled: true, provider: { provider: 'jev', connectionId: 'jev-main', model: 'jev-1.13.0' }, accounts: { forest: forestGroups } })
    mock.api.ai.classify = vi.fn(async (): Promise<AiClassificationResult> => ({ status: 'paused', reason: 'rate-limited', retryAt: Date.now() + 600000 }))
    await queue.enqueue(ids.filter(row => row.from !== 'aunt@kin.example').map(row => row.id))
    await vi.waitFor(async () => { expect(mock.api.ai.classify).toHaveBeenCalled(); expect(await mock.api.data.dataset('classification_jobs').count({ status: 'running' })).toBe(0) })
    expect(await mock.api.data.dataset('classification_jobs').count({ status: 'queued' })).toBe(2)
    const calls = vi.mocked(mock.api.ai.classify).mock.calls.length
    await groups.update(config => { config.enabled = false })
    queue.retry()
    await vi.waitFor(async () => expect(await mock.api.data.dataset('classification_jobs').count({ status: 'cancelled' })).toBe(2))
    expect(mock.api.ai.classify).toHaveBeenCalledTimes(calls)
  })

  it('keeps a user correction and never classifies it away', async () => {
    const { mock, queue, ids, settled, assignment } = await mailbox({ enabled: true, provider: { provider: 'jev', connectionId: 'jev-main', model: 'jev-1.13.0' }, accounts: { forest: forestGroups } })
    const target = ids.find(row => row.accountId === 'forest' && row.from === 'aunt@kin.example')!.id
    await queue.assign(target, 'receipts')
    mock.api.ai.classify = vi.fn(async (request: AiClassificationRequest) => fakeProvider({ receipts: 0.95 }).classify(request.categories))
    await queue.enqueue([target])
    await queue.enqueue([target], true)
    await settled()
    expect(await mock.api.data.dataset('classification_jobs').count({ messageId: target })).toBe(0)
    expect(await assignment('forest', 'aunt@kin.example')).toMatchObject({ categoryId: 'receipts', manual: true, source: 'manual' })
    expect(mock.api.ai.classify).not.toHaveBeenCalled()
  })
})

describe('smart groups file', () => {
  it('migrates once into plugin data, keeps the legacy setting and adopts address-keyed entries', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'canopy-mail', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] }, groups: [{ id: 'canopy', name: 'Canopy', color: '#668866' }] })
    const legacy = { automatic: false, dailyLimit: 40, categories: { canopy: 'Forest canopy research' } }
    await mock.api.settings.set('grouping', legacy)
    const accounts = [{ id: 'acct-1', address: 'Forest@Example.test' }, { id: 'acct-2', address: 'wetland@example.test' }]
    const first = createSmartGroupsStore(mock.api, () => accounts)
    disposers.push(() => first.dispose())
    await first.ready
    const written = JSON.parse((await mock.api.data.files.readText(SMART_GROUPS_FILE))!)
    expect(written).toMatchObject({ enabled: false, dailyLimit: 40, accounts: { 'acct-1': { groups: [{ id: 'canopy', name: 'Canopy', threshold: 60 }] }, 'acct-2': { groups: [{ id: 'canopy' }] } } })
    expect(mock.api.settings.get().grouping).toEqual(legacy)
    const seeded = { version: 1, enabled: true, provider: null, dailyLimit: 20, accounts: { 'forest@example.test': { enabled: true, groups: [{ id: 'receipts', name: 'Receipts', decision: 'Bills', threshold: 60 }] } } }
    const current = await mock.api.data.files.readTextBaseline(SMART_GROUPS_FILE)
    expect((await mock.api.data.files.writeTextGuarded(SMART_GROUPS_FILE, JSON.stringify(seeded), current!.baseline)).ok).toBe(true)
    const second = createSmartGroupsStore(mock.api, () => accounts)
    disposers.push(() => second.dispose())
    await second.ready
    expect(Object.keys(second.get().accounts)).toEqual(['acct-1'])
    expect(second.get().accounts['acct-1'].groups[0]).toMatchObject({ id: 'receipts', name: 'Receipts' })
    expect(Object.keys(JSON.parse((await mock.api.data.files.readText(SMART_GROUPS_FILE))!).accounts)).toEqual(['acct-1'])
    const merged = normalizeSmartGroups({ accounts: { 'acct-1': { groups: [{ id: 'canopy', name: 'Canopy' }] }, 'FOREST@example.test': { groups: [{ id: 'canopy', name: 'Duplicate' }, { id: 'receipts', name: 'Receipts' }] } } })
    expect(adoptAccountKeys(merged, accounts)).toBe(true)
    expect(merged.accounts).toEqual({ 'acct-1': { groups: [expect.objectContaining({ id: 'canopy', name: 'Canopy' }), expect.objectContaining({ id: 'receipts' })] } })
  })
})
