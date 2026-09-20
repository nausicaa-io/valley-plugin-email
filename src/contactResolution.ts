import { CONTACTS_DIRECTORY_V1, CONTACTS_DIRECTORY_REVISION_V1, type ContactDirectoryEntry, type ValleyPluginApi } from '@valley/plugin-sdk'

const MAX_ENTRIES = 512
const MAX_BYTES = 1024 * 1024
const BATCH_SIZE = 200
type Contacts = Record<string, ContactDirectoryEntry[]>

export function createContactResolution(api: ValleyPluginApi, addresses: () => string[], publish: (contacts: Contacts) => void) {
  const cache = new Map<string, { value: ContactDirectoryEntry[]; bytes: number }>()
  let retainedBytes = 0
  let providerKey = ''
  let revision = 0
  let requestedRevision = 0
  let wanted: string[] = []
  let dirty = false
  let active = true
  let pending: Promise<void> | undefined
  let draining: Promise<void> | undefined
  const clear = (): void => { cache.clear(); retainedBytes = 0 }
  const remember = (address: string, value: ContactDirectoryEntry[]): void => {
    const bytes = (address.length + JSON.stringify(value).length) * 2
    const previous = cache.get(address)
    if (previous) { retainedBytes -= previous.bytes; cache.delete(address) }
    if (bytes > MAX_BYTES) return
    while (cache.size && (cache.size >= MAX_ENTRIES || retainedBytes + bytes > MAX_BYTES)) {
      const key = cache.keys().next().value!
      retainedBytes -= cache.get(key)!.bytes
      cache.delete(key)
    }
    cache.set(address, { value, bytes })
    retainedBytes += bytes
  }
  const read = async (): Promise<void> => {
    while (active && dirty) {
      dirty = false
      const acceptedRequest = requestedRevision
      const requested = wanted
      try {
        const provider = api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0]
        const identity = provider ? JSON.stringify([provider.owner, provider.providerId, provider.sessionId, provider.version]) : ''
        if (providerKey !== identity) { providerKey = identity; revision++; clear() }
        const acceptedRevision = revision
        if (!provider) { publish({}); continue }
        const result: Contacts = {}
        const missing: string[] = []
        for (const address of requested) {
          const saved = cache.get(address)
          if (saved) { result[address] = saved.value; cache.delete(address); cache.set(address, saved) }
          else if (address.length <= 1000) missing.push(address)
          else result[address] = []
        }
        for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
          if (!active || acceptedRevision !== revision || acceptedRequest !== requestedRevision) break
          const batch = missing.slice(offset, offset + BATCH_SIZE)
          const response = await provider.invoke('resolveEmails', [batch])
          if (!active || acceptedRevision !== revision) break
          if (!response.ok) throw new Error(response.error.message)
          const resolved = new Map((response.value as { address: string; contacts: ContactDirectoryEntry[] }[]).map((entry) => [entry.address.trim().toLowerCase(), entry.contacts]))
          for (const address of batch) {
            const value = structuredClone(resolved.get(address) ?? [])
            remember(address, value)
            result[address] = value
          }
        }
        if (active && acceptedRevision === revision && acceptedRequest === requestedRevision) publish(result)
      } catch {
        if (active && acceptedRequest === requestedRevision) { clear(); publish({}) }
      }
    }
  }
  const refresh = (): Promise<void> => {
    if (!active) return draining ?? Promise.resolve()
    wanted = [...new Set(addresses().map((address) => address.trim().toLowerCase()).filter(Boolean))]
    requestedRevision++
    dirty = true
    if (!pending) pending = Promise.resolve().then(read).finally(() => {
      pending = undefined
      if (active && dirty) return refresh()
    })
    return pending
  }
  const invalidate = (): void => { revision++; clear(); void refresh() }
  const offProvider = api.interop.services.subscribe(CONTACTS_DIRECTORY_V1, invalidate)
  const offRevision = api.interop.state.subscribe(CONTACTS_DIRECTORY_REVISION_V1, invalidate)
  return {
    refresh,
    clearSelection(): void { requestedRevision++; wanted = []; dirty = false; if (active) publish({}) },
    getRetention: () => ({ entries: cache.size, bytes: retainedBytes }),
    dispose(): Promise<void> {
      if (draining) return draining
      active = false
      dirty = false
      offProvider(); offRevision(); clear()
      draining = pending ?? Promise.resolve()
      return draining
    }
  }
}
