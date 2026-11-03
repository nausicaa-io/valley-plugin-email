import { CONTACTS_DIRECTORY_V1, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { DatasetPage, DatasetRecord } from '@valley/plugin-sdk/datasets'
import { digest } from './backend/identity'
import { accountRevision, decideSmartGroup, descendantIds, hasRules, resolveClassifierModel, senderAddress, usesContacts, type SmartGroupsConfig, type SmartGroupsStore } from './smartGroups'

export interface ClassificationProgress { pending: number; completed: number; failed: number; paused?: 'unavailable' | 'rate-limited'; error?: string }
const configurationKey = '_configuration'

export function createClassificationQueue(api: ValleyPluginApi, smartGroups: SmartGroupsStore, publish: (state: ClassificationProgress) => void, refresh: () => Promise<void>) {
  const jobs = api.data.dataset('classification_jobs'), assignments = api.data.dataset('assignments'), messages = api.data.dataset('messages')
  const active = new Map<string, Promise<void>>()
  const requests = new Map<string, string>()
  let disposed = false, pumping = false, stopped = false, timer: ReturnType<typeof setTimeout> | undefined
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  let paused: ClassificationProgress['paused'], error: string | undefined
  let mutation = Promise.resolve()
  const serialize = <T,>(work: () => Promise<T>): Promise<T> => {
    const result = mutation.then(work)
    mutation = result.then(() => {}, () => {})
    return result
  }
  const configuration = async (accountId: string) => {
    await smartGroups.ready
    const settings = smartGroups.get(), account = settings.accounts[accountId]
    const groups = settings.enabled ? account?.groups ?? [] : []
    const model = groups.length ? await resolveClassifierModel(api, settings) : undefined
    const revision = groups.length ? await accountRevision(model, account!) : 'inactive'
    const key = { id: `${configurationKey}:${accountId}` }
    const current = await assignments.read(key)
    if (current.value?.configurationRevision !== revision) {
      try { await assignments.upsert({ ...key, categoryId: null, manual: false, contentRevision: null, configurationRevision: revision, revision: Number(current.value?.revision ?? 0) + 1 }, { expected: [{ dataset: 'assignments', key, revision: current.revision }] }) }
      catch (reason) { if ((reason as { code?: string }).code !== 'conflict' || (await assignments.get(key))?.configurationRevision !== revision) throw reason }
    }
    return { groups, model, revision, usable: groups.length > 0 && (Boolean(model) || hasRules(groups)), marker: await assignments.read(key), key }
  }
  const contactIds = async (sender: string): Promise<Set<string>> => {
    const provider = api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0]
    if (!provider || !sender) return new Set()
    const response = await provider.invoke('resolveEmails', [[sender]])
    return new Set(response.ok ? (response.value as { contacts: { id: string }[] }[]).flatMap(entry => entry.contacts.map(contact => contact.id)) : [])
  }
  const report = async () => {
    if (disposed) return
    const rows = await jobs.aggregate({ groupBy: ['status'], metrics: { count: { operation: 'count' } } })
    const count = (status: string) => Number(rows.find(row => row.status === status)?.count ?? 0)
    publish({ pending: count('queued') + count('running'), completed: count('completed'), failed: count('failed') + count('uncertain'), paused, error })
  }
  const project = async (id: string) => {
    const assignment = await assignments.get({ id })
    if (await messages.get({ id })) await messages.update({ id }, { categoryId: assignment?.categoryId ?? null })
    await refresh()
  }
  const schedule = (at: number) => {
    if (timer) clearTimeout(timer)
    if (!disposed) timer = setTimeout(() => { timer = undefined; paused = undefined; void pump() }, Math.max(1, at - Date.now()))
  }
  const run = async (job: DatasetRecord) => {
    const requestId = crypto.randomUUID(), id = String(job.id), messageId = String(job.messageId), accountId = String(job.accountId)
    let ownsJob = false
    try {
      const config = await serialize(() => configuration(accountId))
      const assignment = await assignments.read({ id: messageId })
      const message = await messages.get({ id: messageId })
      if (!message || assignment.value?.manual || !config.usable || config.revision !== job.configurationRevision || message.contentRevision !== job.contentRevision) {
        await jobs.update({ id }, { status: 'cancelled' }); return
      }
      const claimed = await jobs.read({ id })
      if (claimed.value?.status !== 'queued') return
      await jobs.update({ id }, { status: 'running', requestId, error: null, startedAt: new Date().toISOString() }, { expected: [{ dataset: 'classification_jobs', key: { id }, revision: claimed.revision }] })
      ownsJob = true; requests.set(id, requestId)
      const sender = senderAddress(String(message.from ?? ''))
      const body = String(message.text ?? String(message.html ?? '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
      const input = JSON.stringify({ sender: String(message.from).slice(0, 1024), subject: String(message.subject).slice(0, 2048), body: body.replace(/[\u0000-\u001f]/g, ' ').slice(0, 32000) })
      const model = config.model
      const result = await decideSmartGroup(config.groups, { sender, contactIds: usesContacts(config.groups) ? await contactIds(sender) : new Set() },
        model ? categories => api.ai.classify({ ...model, requestId, input, categories }) : undefined)
      if (disposed || stopped) { await jobs.update({ id }, { status: 'cancelled' }); return }
      if (result.status === 'paused') {
        paused = result.reason
        await jobs.update({ id }, { status: 'queued', requestId: null })
        schedule(result.retryAt); return
      }
      const latest = await serialize(() => configuration(accountId))
      if (latest.revision !== config.revision) { await jobs.update({ id }, { status: 'cancelled' }); return }
      const currentJob = await jobs.read({ id })
      const currentMessage = await messages.get({ id: messageId })
      if (currentJob.value?.status !== 'running' || currentJob.value.requestId !== requestId || currentMessage?.contentRevision !== job.contentRevision) return
      await api.data.transaction([
        { operation: 'upsert', dataset: 'assignments', values: { id: messageId, categoryId: result.categoryId, confidence: result.confidence, source: result.source, bestCategoryId: result.best?.categoryId ?? null, bestConfidence: result.best?.confidence ?? null, manual: false, contentRevision: job.contentRevision, configurationRevision: config.revision, revision: Number(assignment.value?.revision ?? 0) + 1 } },
        { operation: 'update', dataset: 'classification_jobs', key: { id }, values: { status: 'completed', requestId: null } }
      ], { expected: [{ dataset: 'classification_jobs', key: { id }, revision: currentJob.revision }, { dataset: 'assignments', key: { id: messageId }, revision: assignment.revision }, { dataset: 'assignments', key: config.key, revision: config.marker.revision }] })
      await project(messageId)
    } catch (reason) {
      const conflict = (reason as { code?: string }).code === 'conflict'
      error = conflict ? undefined : reason instanceof Error ? reason.message : String(reason)
      if (ownsJob) await jobs.update({ id }, { status: conflict ? 'cancelled' : 'failed', error: error ?? null, requestId: null }).catch(() => {})
    } finally { requests.delete(id) }
  }
  async function pump(): Promise<void> {
    if (pumping || disposed || stopped || paused) return
    pumping = true
    try {
      const page = await jobs.query({ where: { status: 'queued' }, orderBy: [{ field: 'createdAt', direction: 'asc' }], limit: 3 })
      for (const job of page.rows) {
        if (active.size >= 3 || active.has(String(job.id))) continue
        const task = run(job).finally(() => { active.delete(String(job.id)); void report(); if (!disposed && !paused && !stopped) void pump() })
        active.set(String(job.id), task)
      }
    } catch (reason) { error = String(reason) }
    finally { pumping = false; await report() }
  }
  const enqueue = (ids: string[], automatic = false): Promise<void> => serialize(async () => {
    if (disposed) return
    await smartGroups.ready
    const { enabled, dailyLimit } = smartGroups.get()
    if (!enabled) return
    const configurations = new Map<string, Awaited<ReturnType<typeof configuration>>>()
    const since = new Date(Date.now() - 86400000).toISOString()
    const selected = [...new Set(ids)].slice(0, 2000)
    for (let offset = 0; offset < selected.length; offset += 100) {
      const page = await messages.query({ where: { id: { in: selected.slice(offset, offset + 100) }, complete: true, ...(automatic ? { isSpam: false, exists: { dataset: 'folder_messages', on: { id: 'messageId', accountId: 'accountId' }, where: { unread: true, folder: 'INBOX', spam: false } } } : {}) }, select: ['id', 'accountId', 'contentRevision'], limit: 100 })
      const manual = await assignments.query({ where: { id: { in: page.rows.map(row => String(row.id)) }, manual: true }, select: ['id'], limit: 100 })
      const candidates: DatasetRecord[] = []
      for (const message of page.rows) {
        const messageId = String(message.id), accountId = String(message.accountId)
        if (!message.contentRevision || !messageId.startsWith('v1:') || manual.rows.some(row => row.id === messageId)) continue
        if (!configurations.has(accountId)) configurations.set(accountId, await configuration(accountId))
        const config = configurations.get(accountId)!
        if (!config.usable) continue
        const id = await digest(JSON.stringify([messageId, message.contentRevision, config.revision]))
        candidates.push({ id, messageId, accountId, contentRevision: message.contentRevision, configurationRevision: config.revision, status: 'queued', automatic, createdAt: new Date().toISOString(), startedAt: null, requestId: null, error: null })
      }
      if (!candidates.length) continue
      for (let attempt = 0; attempt < 8; attempt++) {
        const snapshot = await api.data.snapshot([
          { operation: 'query', dataset: 'classification_jobs', query: { where: { id: { in: candidates.map(row => String(row.id)) } }, select: ['id'], limit: 100 } },
          { operation: 'aggregate', dataset: 'classification_jobs', request: { where: { automatic: true, createdAt: { gte: since }, accountId: { in: [...new Set(candidates.map(row => String(row.accountId)))] } }, groupBy: ['accountId'], metrics: { count: { operation: 'count' } } } }
        ])
        const existing = snapshot.values[0] as DatasetPage, counts = snapshot.values[1] as DatasetRecord[]
        const remaining = new Map(counts.map(row => [String(row.accountId), dailyLimit - Number(row.count)]))
        const inserts = candidates.filter(row => {
          if (existing.rows.some(value => value.id === row.id)) return false
          if (!automatic) return true
          const account = String(row.accountId), available = remaining.get(account) ?? dailyLimit
          if (available <= 0) return false
          remaining.set(account, available - 1); return true
        })
        if (!inserts.length) break
        try { await jobs.insert(inserts, { expected: [{ dataset: 'classification_jobs', revision: existing.revision }] }); break }
        catch (reason) { if ((reason as { code?: string }).code !== 'conflict' || attempt === 7) throw reason }
      }
    }
    stopped = false; void pump()
  })
  const assign = (id: string, categoryId: string | null, manual = true) => serialize(async () => {
    const current = await assignments.read({ id })
    const message = await messages.get({ id })
    await assignments.upsert({ id, categoryId, manual, confidence: null, source: manual ? 'manual' : null, bestCategoryId: null, bestConfidence: null, contentRevision: message?.contentRevision ?? null, configurationRevision: null, revision: Number(current.value?.revision ?? 0) + 1 })
    await project(id)
  })
  const recover = async () => {
    for (;;) {
      const page = await jobs.query({ where: { status: 'running', or: [{ startedAt: { isNull: true } }, { startedAt: { lt: new Date(Date.now() - 900000).toISOString() } }] }, limit: 100 })
      if (!page.rows.length) break
      await jobs.updateMany(page.rows.map(row => ({ key: { id: String(row.id) }, values: { status: 'uncertain', error: 'Interrupted request: review before retrying', requestId: null } })))
    }
    const next = await jobs.query({ where: { status: 'running' }, orderBy: [{ field: 'startedAt', direction: 'asc' }], limit: 1 })
    if (!disposed && next.rows.length) recoveryTimer = setTimeout(() => { recoveryTimer = undefined; void recover().catch(reason => { error = String(reason); void report() }) }, Math.max(1000, Date.parse(String(next.rows[0].startedAt)) + 900001 - Date.now()))
    await pump()
  }
  const startup = recover().catch(reason => { error = String(reason); void report() })
  // A removed group leaves no messages on its id: they go back to ungrouped (also manual ones) and can be sorted again.
  const groupIds = (config: SmartGroupsConfig): Map<string, Set<string>> => new Map(Object.entries(config.accounts).map(([accountId, account]) => [accountId, new Set((account?.groups ?? []).flatMap(descendantIds))]))
  let known: Map<string, Set<string>> | undefined
  const forget = (accountId: string, removed: string[]) => serialize(async () => {
    for (;;) {
      const page = await messages.query({ where: { accountId, categoryId: { in: removed } }, select: ['id'], limit: 200 })
      const rows = page.rows.length ? page.rows : []
      const stale = (await assignments.query({ where: { id: { in: rows.map(row => String(row.id)) }, categoryId: { in: removed } }, limit: 200 })).rows
      for (const row of stale) await assignments.upsert({ ...row, categoryId: null, manual: false, confidence: null, source: null, bestCategoryId: null, bestConfidence: null, configurationRevision: null, revision: Number(row.revision ?? 0) + 1 })
      if (rows.length) await messages.updateMany(rows.map(row => ({ key: { id: String(row.id) }, values: { categoryId: null } })))
      if (page.rows.length < 200) break
    }
    if (!disposed) await refresh()
  })
  const watchGroups = () => {
    void smartGroups.ready.then(() => {
      if (disposed) return
      const next = groupIds(smartGroups.get())
      const previous = known
      known = next
      if (!previous) return
      for (const [accountId, ids] of previous) {
        const removed = [...ids].filter(id => !next.get(accountId)?.has(id))
        if (removed.length) void forget(accountId, removed).catch(reason => { error = String(reason); void report() })
      }
    })
  }
  watchGroups()
  const offGroups = smartGroups.subscribe(watchGroups)
  return {
    enqueue, assign,
    reset: async (id: string) => { await assign(id, null, false); const stale = await jobs.query({ where: { messageId: id, status: { notIn: ['running', 'queued'] } }, limit: 1000 }); if (stale.rows.length) await jobs.updateMany(stale.rows.map(row => ({ key: { id: String(row.id) }, values: { status: 'queued', error: null } }))); await enqueue([id]); void pump() },
    retry: () => { paused = undefined; error = undefined; stopped = false; if (timer) clearTimeout(timer); void pump() },
    cancel: async () => {
      stopped = true; if (timer) clearTimeout(timer)
      const pending = await jobs.query({ where: { status: 'running' }, limit: 100 })
      if (pending.rows.length) await jobs.updateMany(pending.rows.map(row => ({ key: { id: String(row.id) }, values: { status: 'cancelled' } })))
      await Promise.allSettled(pending.rows.flatMap(row => typeof row.requestId === 'string' ? [api.ai.cancel(row.requestId)] : []))
      for (;;) { const page = await jobs.query({ where: { status: 'queued' }, limit: 500 }); if (!page.rows.length) break; await jobs.updateMany(page.rows.map(row => ({ key: { id: String(row.id) }, values: { status: 'cancelled' } }))) }
      await report()
    },
    dispose: async () => { disposed = true; offGroups(); if (recoveryTimer) clearTimeout(recoveryTimer); if (timer) clearTimeout(timer); await startup; await Promise.allSettled([...requests.values()].map(requestId => api.ai.cancel(requestId))); await Promise.allSettled([...active.values(), mutation]) }
  }
}
