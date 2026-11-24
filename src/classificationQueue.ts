import { CONTACTS_DIRECTORY_V1, type ContactDirectoryEntry, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { DatasetPage, DatasetRecord, DatasetWhere } from '@valley/plugin-sdk/datasets'
import { digest } from './backend/identity'
import { MAX_GROUPS_PER_MESSAGE, messageCategoryProjection, normalizeCategoryIds } from './backend/categories'
import { accountRevision, decideSmartGroup, descendantIds, hasRules, resolveClassifierModel, senderAddress, type SmartGroupsConfig, type SmartGroupsStore } from './smartGroups'
import { formatVcfContactForAi, type VcfContactsStore } from './vcfContacts'

export interface ClassificationProgress { pending: number; completed: number; failed: number; paused?: 'unavailable' | 'rate-limited'; error?: string }
export type AccountClassificationScope = 'inbox-ungrouped' | 'all-ungrouped' | 'reclassify'
const configurationKey = '_configuration'

const AUTOMATED_LOCAL_PART = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|bounce|notifications?|alerts?|updates?|news|newsletter|digest|marketing|promo|promotions?|offers?|deals?|sales|campaigns?|info|hello|team|support|billing|invoices?|receipts?|orders?|shipping|dispatch|security|verify|account|admin|automated|bot)([+.0-9_-]|$)/i
const UNSUBSCRIBE_HINT = /\b(unsubscribe|manage\s+(your\s+)?(email\s+)?(preferences|subscriptions)|opt[\s-]?out|view\s+(this\s+email\s+)?in\s+(your\s+)?browser|abbestellen|abmelden|se\s+d[eé]sabonner|darse\s+de\s+baja)\b/i

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  euro: '€'
}

export function cleanTextForClassification(text: unknown, html: unknown): string {
  const plain = typeof text === 'string' && text.trim() ? text : ''
  const raw = plain || (typeof html === 'string'
    ? html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(head|style|script|noscript|svg|title)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&([a-z]+|#\d+|#x[0-9a-f]+);/gi, (_match, entity: string) => {
        const lower = entity.toLowerCase()
        if (lower in HTML_ENTITIES) return HTML_ENTITIES[lower]
        if (lower.startsWith('#x')) {
          const code = Number.parseInt(lower.slice(2), 16)
          return Number.isFinite(code) && code >= 32 && code < 0x110000 ? String.fromCodePoint(code) : ' '
        }
        if (lower.startsWith('#')) {
          const code = Number.parseInt(lower.slice(1), 10)
          return Number.isFinite(code) && code >= 32 && code < 0x110000 ? String.fromCodePoint(code) : ' '
        }
        return ' '
      })
    : '')
  return raw
    .replace(/[\u0000-\u001f\u200b-\u200f\u2028-\u202f\ufeff\u034f\u00ad]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildClassificationInput(
  message: DatasetRecord,
  sender: string,
  senderContact?: Record<string, unknown>
): string {
  const from = String(message.from ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 1024)
  const subject = String(message.subject ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 2048)
  const to = String(message.to ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 512)
  const replyTo = typeof message.replyTo === 'string' ? message.replyTo.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 512) : ''
  const body = cleanTextForClassification(message.text, message.html).slice(0, 16000)
  const at = sender.lastIndexOf('@')
  const localPart = at > 0 ? sender.slice(0, at) : ''
  const senderDomain = at > 0 ? sender.slice(at + 1) : ''
  const hasUnsubscribe = UNSUBSCRIBE_HINT.test(body) || (typeof message.html === 'string' && UNSUBSCRIBE_HINT.test(message.html))
  const automatedSender = Boolean(localPart && AUTOMATED_LOCAL_PART.test(localPart))

  return JSON.stringify({
    sender: from,
    ...(senderDomain ? { senderDomain } : {}),
    ...(replyTo && senderAddress(replyTo) !== sender ? { replyTo } : {}),
    ...(to ? { to } : {}),
    subject,
    hasAttachments: message.hasAttachments === true,
    signals: {
      automatedSender,
      hasUnsubscribe
    },
    senderContact: senderContact ?? { known: false },
    body
  })
}

export function createClassificationQueue(
  api: ValleyPluginApi,
  smartGroups: SmartGroupsStore,
  publish: (state: ClassificationProgress) => void,
  refresh: () => Promise<void>,
  vcf?: VcfContactsStore
) {
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
    const revision = groups.length ? await accountRevision(model, account!, settings.multiGroup) : 'inactive'
    const key = { id: `${configurationKey}:${accountId}` }
    const current = await assignments.read(key)
    if (current.value?.configurationRevision !== revision) {
      try { await assignments.upsert({ ...key, categoryId: null, categoryIds: null, manual: false, contentRevision: null, configurationRevision: revision, revision: Number(current.value?.revision ?? 0) + 1 }, { expected: [{ dataset: 'assignments', key, revision: current.revision }] }) }
      catch (reason) { if ((reason as { code?: string }).code !== 'conflict' || (await assignments.get(key))?.configurationRevision !== revision) throw reason }
    }
    return { groups, model, multiGroup: settings.multiGroup, revision, usable: groups.length > 0 && (Boolean(model) || hasRules(groups)), marker: await assignments.read(key), key }
  }
  const resolveSenderInfo = async (sender: string): Promise<{ contactIds: Set<string>; aiContact?: Record<string, unknown> }> => {
    const ids = new Set<string>()
    let aiContact: Record<string, unknown> | undefined
    if (!sender) return { contactIds: ids }
    if (vcf) {
      await vcf.ready()
      const vcfMatches = vcf.resolveEmail(sender)
      for (const contact of vcfMatches) ids.add(contact.id)
      aiContact = formatVcfContactForAi(vcfMatches, sender)
    }
    const provider = api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0]
    if (provider) {
      const response = await provider.invoke('resolveEmails', [[sender]]).catch(() => ({ ok: false as const }))
      if (response.ok) {
        const entries = (response.value as { contacts: ContactDirectoryEntry[] }[]).flatMap(entry => entry.contacts)
        for (const contact of entries) ids.add(contact.id)
        if (!aiContact && entries.length) {
          const first = entries[0]
          const matchedEmail = first.emails.find((email) => email.address.trim().toLowerCase() === sender)
          aiContact = {
            known: true,
            name: first.displayName,
            ...(matchedEmail?.label ? { emailLabel: matchedEmail.label } : {})
          }
        }
      }
    }
    return { contactIds: ids, aiContact }
  }
  const report = async () => {
    if (disposed) return
    const rows = await jobs.aggregate({ groupBy: ['status'], metrics: { count: { operation: 'count' } } })
    const count = (status: string) => Number(rows.find(row => row.status === status)?.count ?? 0)
    publish({ pending: count('queued') + count('running'), completed: count('completed'), failed: count('failed') + count('uncertain'), paused, error })
  }
  const project = async (id: string) => {
    const assignment = await assignments.get({ id })
    if (await messages.get({ id })) await messages.update({ id }, messageCategoryProjection(assignment))
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
      const { contactIds, aiContact } = await resolveSenderInfo(sender)
      const input = buildClassificationInput(message, sender, aiContact)
      const model = config.model
      const result = await decideSmartGroup(
        config.groups,
        { sender, contactIds },
        model ? categories => api.ai.classify({ ...model, requestId, input, categories }) : undefined,
        { multiGroup: config.multiGroup, maxGroups: MAX_GROUPS_PER_MESSAGE }
      )
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
      const assignedIds = normalizeCategoryIds(result.categoryIds, result.categoryId)
      await api.data.transaction([
        { operation: 'upsert', dataset: 'assignments', values: { id: messageId, categoryId: assignedIds[0] ?? null, categoryIds: assignedIds.length ? assignedIds : null, confidence: result.confidence, source: result.source, bestCategoryId: result.best?.categoryId ?? null, bestConfidence: result.best?.confidence ?? null, manual: false, contentRevision: job.contentRevision, configurationRevision: config.revision, revision: Number(assignment.value?.revision ?? 0) + 1 } },
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
      // A message whose body download was deferred (F2) is sorted by its headers and the text it has; one that could not be
      // downloaded at all has no sender and stays unsorted.
      const page = await messages.query({ where: { id: { in: selected.slice(offset, offset + 100) }, or: [{ complete: true }, { from: { gt: '' } }], ...(automatic ? { isSpam: false, exists: { dataset: 'folder_messages', on: { id: 'messageId', accountId: 'accountId' }, where: { unread: true, folder: 'INBOX', spam: false } } } : {}) }, select: ['id', 'accountId', 'contentRevision'], limit: 100 })
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
  const enqueueAccount = async (accountId: string, scope: AccountClassificationScope): Promise<number> => {
    if (disposed) return 0
    await smartGroups.ready
    if (!smartGroups.get().enabled) return 0
    const config = await serialize(() => configuration(accountId))
    if (!config.usable) return 0
    const collected: { id: string; contentRevision: string }[] = []
    let cursor: string | undefined
    const where: DatasetWhere = {
      accountId,
      isSpam: false,
      ...(scope !== 'reclassify' ? { categoryId: { isNull: true } } : {}),
      ...(scope === 'inbox-ungrouped'
        ? { exists: { dataset: 'folder_messages', on: { id: 'messageId', accountId: 'accountId' }, where: { folder: 'INBOX', excluded: false, spam: false } } }
        : { exists: { dataset: 'folder_messages', on: { id: 'messageId', accountId: 'accountId' }, where: { excluded: false, spam: false } } })
    }
    while (collected.length < 2000) {
      const page = await messages.query({
        where,
        select: ['id', 'contentRevision'],
        orderBy: [{ field: 'sortDate', direction: 'desc' }],
        limit: Math.min(200, 2000 - collected.length),
        cursor
      })
      for (const row of page.rows) {
        if (typeof row.id === 'string' && typeof row.contentRevision === 'string' && row.id.startsWith('v1:')) {
          collected.push({ id: row.id, contentRevision: row.contentRevision })
        }
      }
      cursor = page.cursor
      if (!cursor || !page.rows.length) break
    }
    if (!collected.length) return 0
    // Exclude messages the user assigned manually so regrouping never overwrites manual picks.
    const manualIds = new Set<string>()
    for (let offset = 0; offset < collected.length; offset += 200) {
      const batch = collected.slice(offset, offset + 200).map((item) => item.id)
      const manual = await assignments.query({ where: { id: { in: batch }, manual: true }, select: ['id'], limit: 200 })
      for (const row of manual.rows) if (typeof row.id === 'string') manualIds.add(row.id)
    }
    const eligible = collected.filter((item) => !manualIds.has(item.id))
    if (!eligible.length) return 0
    if (scope === 'reclassify') {
      await serialize(async () => {
        const expectedJobIds = await Promise.all(
          eligible.map((item) => digest(JSON.stringify([item.id, item.contentRevision, config.revision])))
        )
        for (let offset = 0; offset < expectedJobIds.length; offset += 200) {
          const batch = expectedJobIds.slice(offset, offset + 200)
          const existing = await jobs.query({ where: { id: { in: batch }, status: { notIn: ['running', 'queued'] } }, select: ['id'], limit: 200 })
          if (existing.rows.length) {
            await jobs.updateMany(existing.rows.map((row) => ({ key: { id: String(row.id) }, values: { status: 'queued', error: null, requestId: null } })))
          }
        }
      })
    }
    paused = undefined
    error = undefined
    stopped = false
    await enqueue(eligible.map((item) => item.id), false)
    void pump()
    return eligible.length
  }
  const assignCategories = (id: string, categoryIds: string[], manual = true) => serialize(async () => {
    const current = await assignments.read({ id })
    const message = await messages.get({ id })
    const clean = normalizeCategoryIds(categoryIds)
    await assignments.upsert({
      id,
      categoryId: clean[0] ?? null,
      categoryIds: clean.length ? clean : null,
      manual,
      confidence: null,
      source: manual ? 'manual' : null,
      bestCategoryId: null,
      bestConfidence: null,
      contentRevision: message?.contentRevision ?? null,
      configurationRevision: null,
      revision: Number(current.value?.revision ?? 0) + 1
    })
    await project(id)
  })
  const assign = (id: string, categoryId: string | null, manual = true) => assignCategories(id, categoryId ? [categoryId] : [], manual)
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
    const removedSet = new Set(removed)
    const where: DatasetWhere = {
      accountId,
      or: [
        { categoryId: { in: removed } },
        ...removed.slice(0, 100).map((id) => ({ categoryKeys: { contains: `|${id}|` } }))
      ]
    }
    for (;;) {
      const page = await messages.query({ where, select: ['id', 'categoryId', 'categoryIds'], limit: 200 })
      const rows = page.rows
      if (!rows.length) break
      const ids = rows.map((row) => String(row.id))
      const existingAssignments = new Map((await assignments.query({ where: { id: { in: ids } }, limit: 200 })).rows.map((row) => [String(row.id), row]))
      const messageUpdates: { key: { id: string }; values: ReturnType<typeof messageCategoryProjection> }[] = []
      for (const row of rows) {
        const id = String(row.id)
        const assignmentRow = existingAssignments.get(id)
        const currentIds = normalizeCategoryIds(assignmentRow?.categoryIds ?? row.categoryIds, assignmentRow?.categoryId ?? row.categoryId)
        const remaining = currentIds.filter((groupId) => !removedSet.has(groupId))
        if (assignmentRow) {
          if (remaining.length) {
            await assignments.upsert({
              ...assignmentRow,
              categoryId: remaining[0],
              categoryIds: remaining,
              revision: Number(assignmentRow.revision ?? 0) + 1
            })
          } else {
            await assignments.upsert({
              ...assignmentRow,
              categoryId: null,
              categoryIds: null,
              manual: false,
              confidence: null,
              source: null,
              bestCategoryId: null,
              bestConfidence: null,
              configurationRevision: null,
              revision: Number(assignmentRow.revision ?? 0) + 1
            })
          }
        }
        messageUpdates.push({ key: { id }, values: messageCategoryProjection({ categoryIds: remaining }) })
      }
      if (messageUpdates.length) await messages.updateMany(messageUpdates)
      if (rows.length < 200) break
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
    enqueue, enqueueAccount, assign, assignCategories,
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
