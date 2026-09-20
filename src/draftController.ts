import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { CachedMessage, EmailAddress } from './mailTypes'
import type { ComposeDraft, EmailSnapshot } from './store'
import { mailApi } from './mailApi'
import { uiText } from './localization'
import { createDraftRepository, type RetainedDraft } from './draftRepository'

interface DraftPorts {
  snapshot(): Pick<EmailSnapshot, 'compose' | 'sending' | 'selectedAccountId' | 'accounts'>
  active(): boolean
  set(patch: Partial<EmailSnapshot>): void
  report(error: unknown): void
  updateTitle(): void
  resolveContacts(): Promise<void>
  invalidateMessages(): void
  refreshMessages(): Promise<void>
  sent(draft: ComposeDraft): void
}

const formatAddresses = (addresses: EmailAddress[]): string => addresses.map(({ name, address }) => name ? `${JSON.stringify(name)} <${address}>` : address).join(', ')

export function createDraftController(api: ValleyPluginApi, ports: DraftPorts, retained: RetainedDraft, mail = mailApi(api)) {
  let draftSequence = Date.now()
  let generation = 0
  let active = true
  let draining: Promise<void> | undefined
  let pendingSend: Promise<boolean> | undefined
  let revoke!: () => void
  const revoked = new Promise<null>((resolve) => { revoke = () => resolve(null) })
  const accepted = new Set<Promise<unknown>>()
  const current = (): boolean => active && ports.active()
  function dispatch<T>(operation: () => Promise<T>): Promise<T> {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    accepted.add(promise)
    const settle = (): void => { accepted.delete(promise) }
    void promise.then(settle, settle)
    try { operation().then(resolve, reject) } catch (error) { reject(error) }
    return promise
  }
  const repository = createDraftRepository(api, retained)
  const whenReady = repository.loaded.then((saved) => {
    const local = ports.snapshot().compose
    if (local && saved && local.id !== saved.draft.id) {
      const error = new Error(uiText('email.draftConflict'))
      repository.block(error)
      throw error
    }
    if (!current()) return
    draftSequence = Math.max(draftSequence, local?.id ?? 0, saved?.draft.id ?? 0)
    if (!local && saved) {
      ports.set({ compose: saved.draft, composing: true })
      ports.updateTitle()
      void ports.resolveContacts()
    }
    if (local && (local.dirty || local.mode !== 'new')) persist(local)
    if (saved?.delivery === 'sending') ports.report(new Error(uiText('email.draftUncertain')))
  }).catch((error) => { if (current()) ports.report(error) })
  function persist(draft: ComposeDraft): void {
    try { void repository.save(draft).catch((error) => { if (current()) ports.report(error) }) }
    catch (error) { if (current()) ports.report(error) }
  }
  async function allowDiscard(): Promise<boolean> {
    if (!ports.snapshot().compose?.dirty) return true
    return await Promise.race([revoked, api.ui.confirm({ title: uiText('email.discardTitle'), message: uiText('email.discardMessage'), actions: [
      { label: uiText('auto.77dfd2135f4d'), value: 'cancel', variant: 'ghost' },
      { label: uiText('email.discard'), value: 'discard', variant: 'danger' }
    ] })]) === 'discard'
  }
  async function startCompose(mode: ComposeDraft['mode'] = 'new', message?: CachedMessage): Promise<void> {
    if (!current() || ports.snapshot().sending) return
    const token = ++generation
    const valid = (): boolean => current() && token === generation
    try {
      if (mode === 'new' && ports.snapshot().compose) { ports.set({ composing: true }); ports.updateTitle(); return }
      const previousDraft = ports.snapshot().compose
      if (!await allowDiscard() || !valid() || ports.snapshot().compose !== previousDraft) return
      const selectedAccountId = ports.snapshot().selectedAccountId
      if (!selectedAccountId) return
      const accountId = message && 'accountId' in message && typeof message.accountId === 'string' ? message.accountId : selectedAccountId
      let to: EmailAddress[] = []
      let cc: EmailAddress[] = []
      let subject = ''
      let text = ''
      if (message) {
        const own = ports.snapshot().accounts.find((account) => account.id === accountId)?.address.toLowerCase()
        const replying = mode === 'reply' || mode === 'reply-all'
        if (replying) {
          const parsed = await dispatch(() => mail.parseAddresses(message.replyTo || message.from))
          if (!valid()) return
          const sender = parsed.data?.addresses ?? []
          const fromOwn = sender.some((entry) => entry.address.toLowerCase() === own)
          const recipients = fromOwn || mode === 'reply-all' ? await dispatch(() => mail.parseAddresses(message.to)) : undefined
          if (!valid()) return
          to = fromOwn ? recipients?.data?.addresses ?? [] : sender
          if (mode === 'reply-all') {
            const copied = await dispatch(() => mail.parseAddresses(message.cc || ''))
            if (!valid()) return
            const seen = new Set(ports.snapshot().accounts.map((account) => account.address.trim().toLowerCase()))
            const unique = (addresses: EmailAddress[]): EmailAddress[] => addresses.filter((entry) => {
              const key = entry.address.trim().toLowerCase()
              if (!key || seen.has(key)) return false
              seen.add(key)
              return true
            })
            to = unique([...to, ...(recipients?.data?.addresses ?? [])])
            cc = unique(copied.data?.addresses ?? [])
          }
        }
        subject = /^(re|fw|fwd):/i.test(message.subject) ? message.subject : `${replying ? 'Re' : 'Fwd'}: ${message.subject}`
        text = `\n\n${message.from} · ${new Date(message.date).toLocaleString(api.ui.language())}\n${(message.text || message.snippet).split('\n').map((line) => `> ${line}`).join('\n')}`
      }
      if (ports.snapshot().compose !== previousDraft || !valid()) return
      if (previousDraft && !await repository.clear(previousDraft)) return
      if (ports.snapshot().compose !== previousDraft || !valid()) return
      ports.set({ composing: true, compose: { id: ++draftSequence, accountId, mode, to, cc, bcc: [], pending: { to: '', cc: '', bcc: '' }, subject, text,
        inReplyTo: mode === 'reply' || mode === 'reply-all' ? message?.messageId : undefined, dirty: false }, error: null })
      ports.updateTitle()
      if (mode !== 'new') persist(ports.snapshot().compose!)
    } catch (error) { if (valid()) ports.report(error) }
  }
  function updateDraft(patch: Partial<ComposeDraft>): void {
    const draft = ports.snapshot().compose
    if (current() && draft && !ports.snapshot().sending) {
      ++generation
      ports.set({ compose: { ...draft, ...patch, id: draft.id, dirty: true } })
      persist(ports.snapshot().compose!)
      if (patch.to || patch.cc || patch.bcc) void ports.resolveContacts()
    }
  }
  async function saveDraft(): Promise<boolean> {
    const draft = ports.snapshot().compose
    if (!current() || !draft || ports.snapshot().sending) return false
    ++generation
    try {
      await repository.save(draft)
      if (current() && ports.snapshot().compose?.id === draft.id) {
        ports.set({ composing: false })
        ports.updateTitle()
      }
      return true
    } catch (error) { if (current()) ports.report(error); return false }
  }
  async function cancelCompose(): Promise<void> {
    if (!current() || ports.snapshot().sending) return
    const token = ++generation
    const draft = ports.snapshot().compose
    try {
      if (!await allowDiscard() || !current() || token !== generation || ports.snapshot().compose !== draft) return
      if (draft && !await repository.clear(draft)) return
      if (!current() || token !== generation || ports.snapshot().compose !== draft) return
      ports.set({ compose: null, composing: false })
      ports.updateTitle()
    } catch (error) { if (current() && token === generation) ports.report(error) }
  }
  function send(): Promise<boolean> {
    const draft = ports.snapshot().compose
    if (!current() || !draft || ports.snapshot().sending || !draft.to.length || Object.values(draft.pending).some((value) => value.trim())) return Promise.resolve(false)
    if (!ports.snapshot().accounts.some((account) => account.id === draft.accountId)) { ports.set({ error: uiText('email.senderUnavailable') }); return Promise.resolve(false) }
    ++generation
    ports.set({ sending: true, error: null })
    pendingSend = sendDraft(draft)
    return pendingSend
  }
  async function sendDraft(draft: ComposeDraft): Promise<boolean> {
    try {
      await repository.save(draft, true)
      if (!current()) return false
      const result = await dispatch(() => mail.sendEmail({ accountId: draft.accountId, to: formatAddresses(draft.to), cc: formatAddresses(draft.cc),
        bcc: formatAddresses(draft.bcc), subject: draft.subject, text: draft.text, inReplyTo: draft.inReplyTo }))
      if (!result.ok && result.outcome !== 'remote-complete') throw new Error(result.error || uiText('email.sendFailed'))
      try {
        if (await repository.clear(draft)) {
          ports.sent(draft)
          if (current() && ports.snapshot().compose === draft) {
            ports.set({ compose: null, composing: false })
            ports.updateTitle()
          }
        }
      } catch (error) { if (current()) ports.report(error) }
      if (current()) {
        ports.invalidateMessages()
        try { await ports.refreshMessages() } catch (error) { ports.report(error) }
        if (!result.ok) ports.report(new Error(result.error || uiText('email.sendFailed')))
      }
      return true
    } catch (error) { if (current()) ports.report(error); return false }
    finally { if (current()) ports.set({ sending: false }) }
  }
  async function flush(): Promise<void> {
    await pendingSend
    await repository.flush()
  }
  return {
    whenReady, startCompose, updateDraft, saveDraft, cancelCompose, send, flush,
    dispose(): Promise<void> {
      if (draining) return draining
      active = false
      ++generation
      revoke()
      draining = Promise.allSettled([...accepted, flush()]).then((results) => {
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      })
      return draining
    }
  }
}
