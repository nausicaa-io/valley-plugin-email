import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { CONTACTS_DIRECTORY_V1, CONTACTS_DIRECTORY_REVISION_V1, type ContactDirectoryEntry } from '@valley/plugin-sdk'
import { createContactResolution } from '../src/contactResolution'

const entry = (address: string, displayName = address): ContactDirectoryEntry => ({ id: address, displayName, emails: [{ address }] })
const resolve = (addresses: string[]) => addresses.map((address) => ({ address, contacts: [entry(address)] }))
function held() {
  let release!: () => void
  const promise = new Promise<void>((done) => { release = done })
  return { promise, release }
}
function setup(initial: string[], resolver = vi.fn(async (addresses: string[]) => resolve(addresses))) {
  const mock = createMockValleyApi({ manifest: { id: 'email' } })
  const off = mock.provideInterop(CONTACTS_DIRECTORY_V1, { search: async () => [], open: async () => {}, resolveEmails: resolver }, 'contacts')
  let addresses = initial
  const publish = vi.fn()
  const owner = createContactResolution(mock.api, () => addresses, publish)
  return { mock, off, publish, owner, resolver, setAddresses: (next: string[]) => { addresses = next } }
}

describe('Email contact resolution ownership', () => {
  it('normalizes addresses and shares repeated lookups across list, reader and draft refreshes', async () => {
    const gate = held()
    const resolver = vi.fn(async (addresses: string[]) => { await gate.promise; return resolve(addresses) })
    const { owner, publish, setAddresses } = setup([' A@example.com ', 'a@example.com', ''], resolver)
    const first = owner.refresh()
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce())
    const repeated = Array.from({ length: 20 }, () => owner.refresh())
    expect(resolver).toHaveBeenCalledOnce()
    gate.release()
    await Promise.all([first, ...repeated])
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith(['a@example.com'])
    expect(publish).toHaveBeenLastCalledWith({ 'a@example.com': [entry('a@example.com')] })
    setAddresses(['a@example.com', 'b@example.com'])
    await owner.refresh()
    expect(resolver).toHaveBeenLastCalledWith(['b@example.com'])
    await owner.dispose()
  })

  it('retains negative results until the directory revision invalidates them', async () => {
    let known = false
    const resolver = vi.fn(async (addresses: string[]) => addresses.map((address) => ({ address, contacts: known ? [entry(address)] : [] })))
    const { owner, mock, publish } = setup(['new@example.com'], resolver)
    await owner.refresh(); await owner.refresh()
    expect(resolver).toHaveBeenCalledOnce()
    known = true
    mock.api.interop.state.publish(CONTACTS_DIRECTORY_REVISION_V1, 1)
    await owner.refresh()
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({ 'new@example.com': [entry('new@example.com')] })
    await owner.dispose()
  })

  it('stops obsolete pages and resolves the newest address selection after a held lookup', async () => {
    const gate = held()
    const resolver = vi.fn(async (addresses: string[]) => { await gate.promise; return resolve(addresses) })
    const old = Array.from({ length: 401 }, (_, index) => `old${index}@example.com`)
    const { owner, publish, setAddresses } = setup(old, resolver)
    const first = owner.refresh()
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce())
    setAddresses(['new@example.com'])
    const latest = owner.refresh()
    gate.release()
    await Promise.all([first, latest])
    expect(resolver.mock.calls.map(([addresses]) => addresses.length)).toEqual([200, 1])
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ 'new@example.com': [entry('new@example.com')] })
    await owner.dispose()
  })

  it.each([999, 1000, 1001])('publishes all %i addresses while bounding retained cache entries and bytes', async (count) => {
    const addresses = Array.from({ length: count }, (_, index) => `${index}@example.com`)
    const { owner, publish, resolver } = setup(addresses)
    await owner.refresh()
    expect(Object.keys(publish.mock.calls.at(-1)![0])).toHaveLength(count)
    expect(resolver.mock.calls.every(([batch]) => batch.length <= 200)).toBe(true)
    expect(owner.getRetention().entries).toBeLessThanOrEqual(512)
    expect(owner.getRetention().bytes).toBeLessThanOrEqual(1024 * 1024)
    await owner.dispose()
    expect(owner.getRetention()).toEqual({ entries: 0, bytes: 0 })
  })

  it('returns complete oversized contact details without retaining them', async () => {
    const contact = entry('large@example.com', 'x'.repeat(600_000))
    const resolver = vi.fn(async () => [{ address: 'large@example.com', contacts: [contact] }])
    const { owner, publish } = setup(['large@example.com'], resolver)
    await owner.refresh()
    expect(publish).toHaveBeenLastCalledWith({ 'large@example.com': [contact] })
    expect(owner.getRetention()).toEqual({ entries: 0, bytes: 0 })
    await owner.refresh()
    expect(resolver).toHaveBeenCalledTimes(2)
    await owner.dispose()
  })

  it('joins one accepted lookup for repeated disposal and dispatches no following page', async () => {
    const gate = held()
    const resolver = vi.fn(async (addresses: string[]) => { await gate.promise; return resolve(addresses) })
    const { owner, publish } = setup(Array.from({ length: 401 }, (_, index) => `${index}@example.com`), resolver)
    const reading = owner.refresh()
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce())
    const first = owner.dispose()
    expect(owner.dispose()).toBe(first)
    let completed = false
    void first.then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    gate.release()
    await Promise.all([first, reading, owner.refresh()])
    expect(resolver).toHaveBeenCalledOnce()
    expect(publish).not.toHaveBeenCalled()
    expect(owner.getRetention()).toEqual({ entries: 0, bytes: 0 })
  })

  it('rejects a retired provider result and uses a replacement with the same owner name', async () => {
    const gate = held()
    const old = vi.fn(async (addresses: string[]) => { await gate.promise; return addresses.map((address) => ({ address, contacts: [entry(address, 'Retired')] })) })
    const { owner, publish, mock, off } = setup(['one@example.com'], old)
    const reading = owner.refresh()
    await vi.waitFor(() => expect(old).toHaveBeenCalledOnce())
    off()
    const replacement = vi.fn(async (addresses: string[]) => addresses.map((address) => ({ address, contacts: [entry(address, 'Replacement')] })))
    mock.provideInterop(CONTACTS_DIRECTORY_V1, { search: async () => [], open: async () => {}, resolveEmails: replacement }, 'contacts')
    gate.release()
    await reading
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ 'one@example.com': [entry('one@example.com', 'Replacement')] })
    expect(replacement).toHaveBeenCalledOnce()
    await owner.dispose()
  })

  it('falls back on failure and can retry without keeping failed negative cache entries', async () => {
    let fail = true
    const resolver = vi.fn(async (addresses: string[]) => { if (fail) throw new Error('Offline'); return resolve(addresses) })
    const { owner, publish } = setup(['one@example.com'], resolver)
    await owner.refresh()
    expect(publish).toHaveBeenLastCalledWith({})
    fail = false
    await owner.refresh()
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({ 'one@example.com': [entry('one@example.com')] })
    await owner.dispose()
  })
})
