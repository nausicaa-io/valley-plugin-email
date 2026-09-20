import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { EmailDriver, EmailSyncEvent } from './mailTypes'

export function mailApi(api: { backend: Pick<ValleyPluginApi['backend'], 'call' | 'on'> }): EmailDriver {
  const call = <T>(method: string, payload: unknown): Promise<T> => api.backend.call(method, payload) as Promise<T>
  return {
    queryMessages: (input) => call('queryMessages', input),
    readMessage: (input) => call('readMessage', input),
    parseAddresses: (value) => call('parseAddresses', { value }),
    listAccounts: () => call('listAccounts', {}),
    addSmtpAccount: (input) => call('addSmtpAccount', input),
    removeAccount: (accountId) => call('removeAccount', { accountId }),
    listFolders: (accountId) => call('listFolders', { accountId }),
    syncFolder: (accountId, folder, limit) => call('syncFolder', { accountId, folder, limit }),
    readFolder: (accountId, folder) => call('readFolder', { accountId, folder }),
    sendEmail: (input) => call('sendEmail', input),
    applyMessageAction: (input) => call('applyMessageAction', input),
    onSync: (listener) => api.backend.on('sync', (payload) => listener(payload as EmailSyncEvent))
  }
}

export function createMailSession(api: ValleyPluginApi) {
  let active = true
  let draining: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  const subscriptions = new Set<() => void>()
  const driver = mailApi({ backend: {
    call<T = unknown>(method: string, payload?: unknown): Promise<T> {
      if (!active) return Promise.reject(new Error('Email session is disposed'))
      let resolve!: (value: T) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
      pending.add(promise)
      const settle = (): void => { pending.delete(promise) }
      void promise.then(settle, settle)
      try { api.backend.call<T>(method, payload).then(resolve, reject) } catch (error) { reject(error) }
      return promise
    },
    on(event, listener): () => void {
      if (!active) return () => {}
      const off = api.backend.on(event, (payload) => { if (active) listener(payload) })
      const release = (): void => { if (subscriptions.delete(release)) off() }
      subscriptions.add(release)
      return release
    }
  } })
  return {
    driver,
    dispose(): Promise<void> {
      if (draining) return draining
      active = false
      const failures: unknown[] = []
      for (const release of subscriptions) {
        try { release() } catch (error) { failures.push(error) }
      }
      draining = Promise.allSettled([...pending]).then(() => { if (failures.length) throw failures[0] })
      return draining
    }
  }
}
