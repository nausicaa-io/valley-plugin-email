import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import type { PluginDatasetApi, DatasetRecord } from '@valley/plugin-sdk'
import config from '../config.json'
import { register } from '../src/index'
import { getStore, type ComposeDraft } from '../src/store'
import { createMailMock } from './mailMock'

const draft: ComposeDraft = {
  id: 42, accountId: 'one', mode: 'reply-all', to: [{ name: 'Canopy', address: 'canopy@example.com' }],
  cc: [{ name: '', address: 'moss@example.com' }], bcc: [{ name: 'Hidden', address: 'hidden@example.com' }],
  pending: { to: 'fern@', cc: '', bcc: 'private@' }, subject: 'Survey', text: 'Forest\nÄnderungen', inReplyTo: '<original@example.com>', dirty: true
}
const row = (value: ComposeDraft = draft, delivery = 'editing'): DatasetRecord => ({ id: 'compose', draft: value as unknown as DatasetRecord, delivery })
const disposers: Array<() => Promise<void>> = []
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function setup(rows: DatasetRecord[] = [], configure?: (mock: ReturnType<typeof createMailMock>, dataset: PluginDatasetApi) => void) {
  const mock = createMailMock({ datasets: { 'email.drafts': structuredClone(rows) } })
  mock.mail.listAccounts = async () => ({ ok: true, data: { accounts: [{ id: 'one', provider: 'pureemail', address: 'one@example.com', displayName: 'One',
    imap: { host: 'example.com', port: 993, secure: true }, smtp: { host: 'example.com', port: 465, secure: true }, createdAt: 1 }] } })
  const factory = mock.api.data.dataset
  const dataset = factory('drafts')
  mock.api.data.dataset = ((id: string) => id === 'drafts' ? dataset : factory(id)) as typeof factory
  configure?.(mock, dataset)
  const dispose = register(mock.api)
  disposers.push(dispose)
  return { ...mock, dataset, dispose, store: getStore(mock.api) }
}
afterEach(async () => { await Promise.allSettled(disposers.splice(0).map((dispose) => dispose())) })

describe('durable Email drafts', () => {
  it('declares a private sensitive durable dataset and restores every compose field in an independent runtime', async () => {
    expect(config.datasets.find((dataset) => dataset.id === 'drafts')).toMatchObject({ store: 'durable', visibility: 'private', sensitivity: 'sensitive', primaryKey: ['id'] })
    const first = setup()
    await first.store.whenReady
    await first.store.startCompose()
    first.store.updateDraft({ ...draft })
    const expected = structuredClone(first.store.getSnapshot().compose)
    expect(await first.store.saveDraft()).toBe(true)
    await first.dispose()
    const next = setup(first.datasets.get('email.drafts'))
    await next.store.whenReady
    expect(next.store.getSnapshot()).toMatchObject({ compose: expected, composing: true })
    expect(next.api.runtime).not.toBe(first.api.runtime)
  })

  it('coalesces overlapping edits and joins the last physical write on Save, unload, and disposal', async () => {
    const first = deferred(), last = deferred()
    const mock = setup([], (_mock, dataset) => {
      const upsert = dataset.upsert.bind(dataset)
      vi.spyOn(dataset, 'upsert').mockImplementationOnce(async (...args) => { await first.promise; return upsert(...args) })
        .mockImplementationOnce(async (...args) => { await last.promise; return upsert(...args) })
    })
    await mock.store.whenReady
    await mock.store.startCompose()
    mock.store.updateDraft({ text: 'First' })
    await waitFor(() => expect(mock.dataset.upsert).toHaveBeenCalledTimes(1))
    mock.store.updateDraft({ text: 'Middle' })
    mock.store.updateDraft({ text: 'Last', pending: { to: 'unfinished@', cc: '', bcc: '' } })
    const save = mock.store.saveDraft()
    let saved = false, unloaded = false, disposed = false
    void save.then(() => { saved = true })
    const unload = mock.runBeforeUnload().then(() => { unloaded = true })
    first.resolve()
    await waitFor(() => expect(mock.dataset.upsert).toHaveBeenCalledTimes(2))
    const dispose = mock.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect([saved, unloaded, disposed]).toEqual([false, false, false])
    last.resolve()
    await Promise.all([save, unload, dispose])
    expect(mock.dataset.upsert).toHaveBeenCalledTimes(2)
    expect(mock.datasets.get('email.drafts')).toMatchObject([{ draft: { text: 'Last', pending: { to: 'unfinished@' } } }])
  })

  it('keeps newly typed edits while initial hydration is held', async () => {
    const held = deferred()
    const mock = setup([], (_mock, dataset) => {
      const read = dataset.read.bind(dataset)
      vi.spyOn(dataset, 'read').mockImplementation(async (...args) => { await held.promise; return read(...args) })
      vi.spyOn(dataset, 'upsert')
    })
    await waitFor(() => expect(mock.store.getSnapshot().selectedAccountId).toBe('one'))
    await mock.store.startCompose()
    mock.store.updateDraft({ text: 'Typed before read' })
    expect(mock.dataset.upsert).not.toHaveBeenCalled()
    held.resolve()
    await mock.store.whenReady
    await mock.store.flushDraft()
    expect(mock.datasets.get('email.drafts')).toMatchObject([{ draft: { text: 'Typed before read' } }])
  })

  it('preserves retained and newly typed state over same-revision hydration', async () => {
    const held = deferred()
    const mock = setup([row()], (mock, dataset) => {
      mock.api.runtime.getOrCreate('email.draft', () => ({ draft: { ...structuredClone(draft), text: 'Retained edits' }, revision: 0 }))
      const read = dataset.read.bind(dataset)
      vi.spyOn(dataset, 'read').mockImplementation(async (...args) => { await held.promise; return read(...args) })
    })
    expect(mock.store.getSnapshot().compose?.text).toBe('Retained edits')
    mock.store.updateDraft({ subject: 'Typed during hydration' })
    held.resolve()
    await mock.store.whenReady
    await mock.store.flushDraft()
    expect(mock.datasets.get('email.drafts')).toMatchObject([{ draft: { text: 'Retained edits', subject: 'Typed during hydration' } }])
  })

  it('finishes an old owner save against its captured API after a different runtime opens', async () => {
    const held = deferred()
    const first = setup([], (_mock, dataset) => {
      const upsert = dataset.upsert.bind(dataset)
      vi.spyOn(dataset, 'upsert').mockImplementation(async (...args) => { await held.promise; return upsert(...args) })
    })
    await first.store.whenReady
    await first.store.startCompose()
    first.store.updateDraft({ text: 'Original vault' })
    await waitFor(() => expect(first.dataset.upsert).toHaveBeenCalledTimes(1))
    const disposing = first.dispose()
    const next = setup()
    await next.store.whenReady
    await next.store.startCompose()
    next.store.updateDraft({ text: 'New vault' })
    await next.store.saveDraft()
    held.resolve()
    await disposing
    expect(first.datasets.get('email.drafts')).toMatchObject([{ draft: { text: 'Original vault' } }])
    expect(next.datasets.get('email.drafts')).toMatchObject([{ draft: { text: 'New vault' } }])
  })

  it('preserves both versions when hydration discovers a different saved draft', async () => {
    const held = deferred()
    const mock = setup([row()], (_mock, dataset) => {
      const read = dataset.read.bind(dataset)
      vi.spyOn(dataset, 'read').mockImplementation(async (...args) => { await held.promise; return read(...args) })
      vi.spyOn(dataset, 'upsert')
    })
    await waitFor(() => expect(mock.store.getSnapshot().selectedAccountId).toBe('one'))
    await mock.store.startCompose()
    mock.store.updateDraft({ text: 'New local draft' })
    held.resolve()
    await mock.store.whenReady
    expect(await mock.store.saveDraft()).toBe(false)
    expect(mock.store.getSnapshot()).toMatchObject({ compose: { text: 'New local draft' }, error: expect.stringContaining('changed elsewhere') })
    expect(mock.dataset.upsert).not.toHaveBeenCalled()
    expect(mock.datasets.get('email.drafts')).toEqual([row()])
    await expect(mock.runBeforeUnload()).rejects.toThrow('changed elsewhere')
  })

  it.each(['read-failure', 'invalid-record'])('never treats %s as a missing draft', async (mode) => {
    const mock = setup(mode === 'invalid-record' ? [{ id: 'compose', draft: { text: 'Bad' }, delivery: 'editing' }] : [], (_mock, dataset) => {
      if (mode === 'read-failure') vi.spyOn(dataset, 'read').mockRejectedValue(new Error('Storage unavailable'))
      vi.spyOn(dataset, 'upsert')
    })
    await mock.store.whenReady
    await mock.store.startCompose()
    mock.store.updateDraft({ text: 'Keep in memory' })
    expect(await mock.store.saveDraft()).toBe(false)
    expect(mock.store.getSnapshot().compose?.text).toBe('Keep in memory')
    expect(mock.dataset.upsert).not.toHaveBeenCalled()
    await expect(mock.runBeforeUnload()).rejects.toThrow()
  })

  it('does not replay an outcome-unknown write and preserves current edits', async () => {
    const mock = setup([], (_mock, dataset) => {
      const upsert = dataset.upsert.bind(dataset)
      vi.spyOn(dataset, 'upsert').mockImplementation(async (...args) => {
        await upsert(...args)
        throw Object.assign(new Error('Reply lost'), { outcomeUnknown: true, retryable: false })
      })
    })
    await mock.store.whenReady
    await mock.store.startCompose()
    mock.store.updateDraft({ text: 'Accepted content' })
    expect(await mock.store.saveDraft()).toBe(false)
    mock.store.updateDraft({ text: 'New retained content' })
    expect(await mock.store.saveDraft()).toBe(false)
    expect(mock.dataset.upsert).toHaveBeenCalledTimes(1)
    expect(mock.datasets.get('email.drafts')).toMatchObject([{ draft: { text: 'Accepted content' } }])
    expect(mock.store.getSnapshot().compose?.text).toBe('New retained content')
  })

  it('guards explicit discard against a concurrent writer', async () => {
    const mock = setup([row()])
    await mock.store.whenReady
    await mock.dataset.upsert(row({ ...draft, text: 'Other window' }))
    mock.api.ui.confirm = async () => 'discard'
    await mock.store.cancelCompose()
    expect(mock.store.getSnapshot().compose).toEqual(draft)
    expect(mock.datasets.get('email.drafts')).toEqual([row({ ...draft, text: 'Other window' })])
    expect(mock.store.getSnapshot().error).toBeTruthy()
  })

  it('does not let an older physical discard completion clear newer edits', async () => {
    const held = deferred()
    const mock = setup([row()], (_mock, dataset) => {
      const remove = dataset.delete.bind(dataset)
      vi.spyOn(dataset, 'delete').mockImplementation(async (...args) => { await held.promise; return remove(...args) })
    })
    await mock.store.whenReady
    mock.api.ui.confirm = async () => 'discard'
    const discarding = mock.store.cancelCompose()
    await waitFor(() => expect(mock.dataset.delete).toHaveBeenCalledTimes(1))
    mock.store.updateDraft({ text: 'Newer edits' })
    held.resolve()
    await discarding
    await mock.store.flushDraft()
    expect(mock.store.getSnapshot().compose?.text).toBe('Newer edits')
    expect(mock.datasets.get('email.drafts')).toMatchObject([{ draft: { text: 'Newer edits' } }])
  })

  it('persists send uncertainty before remote dispatch and restores it without automatically resending', async () => {
    const held = deferred()
    const mock = setup([row({ ...draft, pending: { to: '', cc: '', bcc: '' } })], (mock, dataset) => {
      const upsert = dataset.upsert.bind(dataset)
      vi.spyOn(dataset, 'upsert').mockImplementation(async (...args) => { await held.promise; return upsert(...args) })
      mock.mail.sendEmail = vi.fn(async () => ({ ok: false, error: 'Connection lost after sending' }))
    })
    await mock.store.whenReady
    const sending = mock.store.send()
    await waitFor(() => expect(mock.dataset.upsert).toHaveBeenCalledTimes(1))
    expect(mock.mail.sendEmail).not.toHaveBeenCalled()
    held.resolve()
    expect(await sending).toBe(false)
    expect(mock.datasets.get('email.drafts')).toMatchObject([{ delivery: 'sending' }])
    const restored = setup(mock.datasets.get('email.drafts'), (mock) => { mock.mail.sendEmail = vi.fn() })
    await restored.store.whenReady
    expect(restored.store.getSnapshot()).toMatchObject({ compose: { text: draft.text }, error: expect.stringContaining('Check Sent') })
    expect(restored.mail.sendEmail).not.toHaveBeenCalled()
    restored.store.updateDraft({ subject: 'Intentional edit' })
    await restored.store.saveDraft()
    expect(restored.datasets.get('email.drafts')).toMatchObject([{ delivery: 'sending' }])
  })

  it('does not dispatch mail after disposal while the durable marker is pending', async () => {
    const held = deferred()
    const mock = setup([row({ ...draft, pending: { to: '', cc: '', bcc: '' } })], (mock, dataset) => {
      const upsert = dataset.upsert.bind(dataset)
      vi.spyOn(dataset, 'upsert').mockImplementation(async (...args) => { await held.promise; return upsert(...args) })
      mock.mail.sendEmail = vi.fn()
    })
    await mock.store.whenReady
    const sending = mock.store.send()
    await waitFor(() => expect(mock.dataset.upsert).toHaveBeenCalledTimes(1))
    const disposing = mock.dispose()
    held.resolve()
    expect(await sending).toBe(false)
    await disposing
    expect(mock.mail.sendEmail).not.toHaveBeenCalled()
    expect(mock.datasets.get('email.drafts')).toMatchObject([{ delivery: 'sending' }])
  })

  it('does not contact the mail server when the uncertainty marker cannot be saved', async () => {
    const original = row({ ...draft, pending: { to: '', cc: '', bcc: '' } })
    const mock = setup([original], (mock, dataset) => {
      vi.spyOn(dataset, 'upsert').mockRejectedValue(new Error('Storage unavailable'))
      mock.mail.sendEmail = vi.fn()
    })
    await mock.store.whenReady
    expect(await mock.store.send()).toBe(false)
    expect(mock.mail.sendEmail).not.toHaveBeenCalled()
    expect(mock.datasets.get('email.drafts')).toEqual([original])
    expect(mock.store.getSnapshot().compose?.text).toBe(draft.text)
  })

  it.each([false, true])('removes only a definitely sent draft, including cache failure (cacheFailure=%s)', async (cacheFailure) => {
    const mock = setup([row({ ...draft, pending: { to: '', cc: '', bcc: '' } })], (mock) => {
      mock.mail.sendEmail = vi.fn(async () => cacheFailure ? { ok: false, outcome: 'remote-complete' as const, error: 'Sent cache unavailable' } : { ok: true })
    })
    await mock.store.whenReady
    expect(await mock.store.send()).toBe(true)
    expect(mock.store.getSnapshot().compose).toBeNull()
    expect(mock.datasets.get('email.drafts')).toEqual([])
    if (cacheFailure) expect(mock.store.getSnapshot().error).toBe('Sent cache unavailable')
  })

  it('never deletes a concurrent replacement after a definite remote success', async () => {
    const held = deferred()
    const mock = setup([row({ ...draft, pending: { to: '', cc: '', bcc: '' } })], (mock) => {
      mock.mail.sendEmail = vi.fn(async () => { await held.promise; return { ok: true } })
    })
    await mock.store.whenReady
    const sending = mock.store.send()
    await waitFor(() => expect(mock.mail.sendEmail).toHaveBeenCalledTimes(1))
    const replacement = row({ ...draft, id: 43, text: 'Other window draft' })
    await mock.dataset.upsert(replacement)
    held.resolve()
    expect(await sending).toBe(true)
    expect(mock.datasets.get('email.drafts')).toEqual([replacement])
    expect(mock.store.getSnapshot().error).toBeTruthy()
    expect(mock.mail.sendEmail).toHaveBeenCalledTimes(1)
  })
})
