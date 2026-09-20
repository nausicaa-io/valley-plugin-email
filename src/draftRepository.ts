import { z } from 'zod'
import type { DatasetRecord, ValleyPluginApi } from '@valley/plugin-sdk'
import type { ComposeDraft } from './store'
import { uiText } from './localization'

const address = z.object({ name: z.string(), address: z.string() }).strict()
const draftSchema = z.object({
  id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), accountId: z.string(), mode: z.enum(['new', 'reply', 'reply-all', 'forward']),
  to: z.array(address), cc: z.array(address), bcc: z.array(address),
  pending: z.object({ to: z.string(), cc: z.string(), bcc: z.string() }).strict(),
  subject: z.string(), text: z.string(), inReplyTo: z.string().optional(), dirty: z.boolean()
}).strict()
const recordSchema = z.object({ id: z.literal('compose'), draft: draftSchema, delivery: z.enum(['editing', 'sending']) }).strict()
type StoredDraft = z.infer<typeof recordSchema>

export interface RetainedDraft {
  draft: ComposeDraft | null
  revision?: number
}

export function createDraftRepository(api: ValleyPluginApi, retained: RetainedDraft) {
  const dataset = api.data.dataset('drafts')
  const key = { id: 'compose' }
  let revision: number | undefined
  let stored: StoredDraft | null = null
  let desired: StoredDraft | null | undefined
  let pending: Promise<void> | undefined
  let failure: { error: unknown } | undefined
  const loaded = dataset.read(key).then(result => {
    const parsed = result.value === null ? null : recordSchema.safeParse(result.value)
    if (parsed && !parsed.success) throw new Error(uiText('email.draftInvalid'))
    if (retained.draft && retained.revision !== undefined && retained.revision !== result.revision) throw new Error(uiText('email.draftConflict'))
    stored = parsed?.success ? parsed.data : null
    revision = result.revision
    retained.revision = revision
    return stored
  }).catch(error => { failure = { error }; throw error })
  void loaded.catch(() => {})

  async function write(): Promise<void> {
    await loaded
    if (failure) throw failure.error
    while (desired !== undefined) {
      const next = desired
      desired = undefined
      if (next && stored?.draft.id === next.draft.id && stored.delivery === 'sending') next.delivery = 'sending'
      if (JSON.stringify(next) === JSON.stringify(stored)) continue
      try {
        const options = { operationId: crypto.randomUUID(), expected: [{ dataset: `${api.pluginId}.drafts`, key, revision: revision! }] }
        const result = next ? await dataset.upsert(next as unknown as DatasetRecord, options) : await dataset.delete(key, options)
        revision = result.revision
        retained.revision = revision
        stored = next
      } catch (error) {
        if (desired === undefined) desired = next
        failure = { error }
        throw error
      }
    }
  }
  function schedule(): Promise<void> {
    if (pending) return pending
    const work = Promise.resolve().then(write)
    pending = work
    const settled = (): void => { if (pending === work) pending = undefined }
    void work.then(settled, settled)
    return work
  }
  async function flush(): Promise<void> {
    await loaded
    do {
      if (failure) throw failure.error
      const work = pending ?? (desired !== undefined ? schedule() : undefined)
      if (!work) return
      await work
    } while (pending || desired !== undefined)
  }
  return {
    loaded,
    block(error: unknown): void { failure = { error } },
    save(draft: ComposeDraft, sending = false): Promise<void> {
      const previous = desired ?? stored
      const value = draftSchema.parse(draft)
      if (value.inReplyTo === undefined) delete value.inReplyTo
      desired = { id: 'compose', draft: value, delivery: sending || previous?.draft.id === draft.id && previous.delivery === 'sending' ? 'sending' : 'editing' }
      return flush()
    },
    async clear(draft: ComposeDraft): Promise<boolean> {
      await flush()
      if (stored && JSON.stringify(stored.draft) !== JSON.stringify(draftSchema.parse(draft))) return false
      desired = null
      await flush()
      return true
    },
    flush
  }
}
