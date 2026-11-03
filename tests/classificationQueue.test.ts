import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import type { AiClassificationResult } from '@valley/plugin-sdk/ai'
import config from '../config.json'
import { createClassificationQueue } from '../src/classificationQueue'
import { createSmartGroupsStore } from '../src/smartGroups'
import { emailStoreContext, mergeFolder } from '../src/backend/cache'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())); vi.restoreAllMocks() })
async function setup(count = 1) {
  const mock = createMockValleyApi({ manifest: { id: 'canopy-mail', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] }, groups: [{ id: 'canopy', name: 'Canopy', color: '#668866' }] })
  mock.api.ai.defaults = vi.fn(async () => ({ classification: { provider: 'laya', connectionId: 'local', model: 'english' } }))
  await mock.api.settings.set('grouping', { automatic: true, dailyLimit: 100, categories: { canopy: 'Forest canopy research' } })
  await mergeFolder(emailStoreContext(mock.api.data), 'forest', 'INBOX', Array.from({ length: count }, (_, index) => ({ uid: index + 1, messageId: `<fern-${index}@example.test>`, from: 'fern@example.test', to: 'moss@example.test', subject: `Fern survey ${index}`, date: '2026-01-01T00:00:00.000Z', text: 'Fern survey', snippet: '', flags: [], hasAttachments: false })))
  const ids = mock.datasets.get('canopy-mail.messages')!.map(row => String(row.id))
  const publish = vi.fn()
  const groups = createSmartGroupsStore(mock.api, () => [{ id: 'forest', address: 'forest@example.test' }])
  const queue = createClassificationQueue(mock.api, groups, publish, async () => {})
  disposers.push(queue.dispose, async () => groups.dispose())
  return { mock, queue, ids, publish, groups }
}
const answer: AiClassificationResult = { status: 'completed', categoryId: 'canopy', confidence: 1, probabilities: { canopy: 1, uncategorized: 0 }, model: 'english', inputTokens: 5, outputTokens: 1 }

describe('durable classification queue', () => {
  it('lets a manual assignment win an in-flight automatic result', async () => {
    const { mock, queue, ids } = await setup()
    let finish!: (result: AiClassificationResult) => void
    mock.api.ai.classify = vi.fn(() => new Promise<AiClassificationResult>(resolve => { finish = resolve }))
    await queue.enqueue(ids, true)
    await vi.waitFor(() => expect(mock.api.ai.classify).toHaveBeenCalledOnce())
    await queue.assign(ids[0], null)
    finish(answer)
    await vi.waitFor(async () => expect((await mock.api.data.dataset('classification_jobs').query({})).rows[0].status).toBe('cancelled'))
    expect(await mock.api.data.dataset('assignments').get({ id: ids[0] })).toMatchObject({ categoryId: null, manual: true })
  })

  it('stores the most likely group and its probability for a result below every threshold', async () => {
    const { mock, queue, ids } = await setup()
    mock.api.ai.classify = vi.fn(async () => ({ ...answer, categoryId: 'uncategorized', confidence: 0.7, probabilities: { canopy: 0.3, uncategorized: 0.7 } }))
    await queue.enqueue(ids, true)
    await vi.waitFor(async () => expect(await mock.api.data.dataset('assignments').get({ id: ids[0] })).toMatchObject({ categoryId: null, confidence: null, bestCategoryId: 'canopy', bestConfidence: 0.3 }))
    await queue.assign(ids[0], 'canopy')
    expect(await mock.api.data.dataset('assignments').get({ id: ids[0] })).toMatchObject({ categoryId: 'canopy', manual: true, bestCategoryId: null, bestConfidence: null })
  })

  it('caps 2000 explicit automatic candidates at 100 and deduplicates repeated arrivals', async () => {
    const { mock, queue, ids } = await setup(2000)
    mock.api.ai.classify = vi.fn(async () => answer)
    expect(await mock.api.data.dataset('classification_jobs').count()).toBe(0)
    await queue.enqueue(ids, true)
    await vi.waitFor(async () => expect(await mock.api.data.dataset('classification_jobs').count({ status: 'completed' })).toBe(100), { timeout: 30000 })
    await queue.enqueue(ids, true)
    expect(await mock.api.data.dataset('classification_jobs').count()).toBe(100)
    expect(mock.api.ai.classify).toHaveBeenCalledTimes(100)
    expect((await mock.api.data.dataset('classification_jobs').query({ limit: 100 })).rows.every(row => !('body' in row) && !('text' in row))).toBe(true)
  }, 60000)

  it('retains paused work and does not silently replay failed requests', async () => {
    const { mock, queue, ids } = await setup()
    mock.api.ai.classify = vi.fn(async (): Promise<AiClassificationResult> => ({ status: 'paused', reason: 'unavailable', retryAt: Date.now() + 300000 }))
    await queue.enqueue(ids)
    await vi.waitFor(() => expect(mock.api.ai.classify).toHaveBeenCalledOnce())
    await vi.waitFor(async () => expect((await mock.api.data.dataset('classification_jobs').query({})).rows[0].status).toBe('queued'))
    mock.api.ai.classify = vi.fn(async () => { throw new Error('Timed out; outcome unknown') })
    queue.retry()
    await vi.waitFor(async () => expect((await mock.api.data.dataset('classification_jobs').query({})).rows[0].status).toBe('failed'))
    await queue.enqueue(ids)
    expect(mock.api.ai.classify).toHaveBeenCalledOnce()
  })

  it('discards an in-flight result after category configuration changes', async () => {
    const { mock, queue, ids, groups } = await setup()
    let finish!: (result: AiClassificationResult) => void
    mock.api.ai.classify = vi.fn(() => new Promise<AiClassificationResult>(resolve => { finish = resolve }))
    await queue.enqueue(ids)
    await vi.waitFor(() => expect(mock.api.ai.classify).toHaveBeenCalledOnce())
    await groups.update(config => { config.accounts.forest.groups[0].decision = 'Wetland canopy research' })
    finish(answer)
    await vi.waitFor(async () => expect((await mock.api.data.dataset('classification_jobs').query({})).rows[0].status).toBe('cancelled'))
    expect(await mock.api.data.dataset('assignments').get({ id: ids[0] })).toBeNull()
  })

  it('moves the messages of a removed group back to ungrouped in that account only, also manual ones', async () => {
    const { mock, queue, ids, groups } = await setup(2)
    await groups.ready
    expect(groups.get().accounts.forest.groups.map(group => group.id)).toContain('canopy')
    await queue.assign(ids[0], 'canopy')
    await queue.assign(ids[1], 'canopy', false)
    await mock.api.data.dataset('assignments').upsert({ id: 'wetland-message', categoryId: 'canopy', manual: true, revision: 1 })
    await groups.update(config => { config.accounts.forest.groups = config.accounts.forest.groups.filter(group => group.id !== 'canopy') })
    await vi.waitFor(async () => expect(await mock.api.data.dataset('assignments').get({ id: ids[0] })).toMatchObject({ categoryId: null, manual: false }))
    expect(await mock.api.data.dataset('assignments').get({ id: ids[1] })).toMatchObject({ categoryId: null })
    expect((await mock.api.data.dataset('messages').get({ id: ids[0] }))?.categoryId).toBeNull()
    expect(await mock.api.data.dataset('assignments').get({ id: 'wetland-message' })).toMatchObject({ categoryId: 'canopy' })
  })

  it('keeps cancellation authoritative when a provider completes afterward', async () => {
    const { mock, queue, ids } = await setup()
    let finish!: (result: AiClassificationResult) => void
    mock.api.ai.classify = vi.fn(() => new Promise<AiClassificationResult>(resolve => { finish = resolve }))
    mock.api.ai.cancel = vi.fn(async () => true)
    await queue.enqueue(ids)
    await vi.waitFor(() => expect(mock.api.ai.classify).toHaveBeenCalledOnce())
    await queue.cancel()
    expect(mock.api.ai.cancel).toHaveBeenCalledOnce()
    finish(answer)
    await queue.dispose()
    expect((await mock.api.data.dataset('classification_jobs').query({})).rows[0].status).toBe('cancelled')
    expect(await mock.api.data.dataset('assignments').get({ id: ids[0] })).toBeNull()
  })
})

it('reserves one shared rolling allowance across two queues and skips incomplete messages', async () => {
  const { mock, queue, ids, groups } = await setup(120)
  await groups.update(config => { config.dailyLimit = 10 })
  mock.api.ai.classify = vi.fn(async () => answer)
  await mock.api.data.dataset('messages').update({ id: ids[0] }, { complete: false })
  const other = createClassificationQueue(mock.api, groups, () => {}, async () => {})
  disposers.push(other.dispose)
  await Promise.all([queue.enqueue(ids.slice(0, 70), true), other.enqueue(ids.slice(60), true)])
  await vi.waitFor(async () => expect(await mock.api.data.dataset('classification_jobs').count({ status: 'completed' })).toBe(10))
  expect(await mock.api.data.dataset('classification_jobs').count()).toBe(10)
  expect(await mock.api.data.dataset('classification_jobs').count({ messageId: ids[0] })).toBe(0)
})
