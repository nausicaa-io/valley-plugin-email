import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { EmailDriver, EmailSyncEvent } from './mailTypes'

export function mailApi(api: { backend: Pick<ValleyPluginApi['backend'], 'call' | 'on'> & Partial<Pick<ValleyPluginApi['backend'], 'callOperation'>> }): EmailDriver {
  const call = <T>(method: string, payload: unknown): Promise<T> => api.backend.call(method, payload) as Promise<T>
  return {
    queryMessages: (input, cancellation) => {
      const payload = Object.fromEntries(Object.entries({ ...input, filters: input.filters ? Object.fromEntries(Object.entries(input.filters).filter(([, value]) => value !== undefined)) : undefined }).filter(([, value]) => value !== undefined))
      return api.backend.callOperation ? api.backend.callOperation('queryMessages', payload, { cancellation }) : call('queryMessages', payload)
    },
    // A cached read answers at once: an operation would only report it at its next status poll.
    readMessage: async (input, cancellation) => {
      cancellation?.throwIfAborted()
      const payload = { accountId: input.accountId, folder: input.folder, uid: input.uid, ...(input.uidValidity === undefined ? {} : { uidValidity: input.uidValidity }) }
      const result = await call<Awaited<ReturnType<EmailDriver['readMessage']>>>('readMessage', payload)
      cancellation?.throwIfAborted()
      return result
    },
    loadMessageContent: async (input, cancellation) => {
      cancellation?.throwIfAborted()
      const result = await call<Awaited<ReturnType<EmailDriver['loadMessageContent']>>>('loadMessageContent', { accountId: input.accountId, folder: input.folder, uid: input.uid, ...(input.uidValidity === undefined ? {} : { uidValidity: input.uidValidity }), field: input.field, offset: input.offset })
      cancellation?.throwIfAborted()
      return result
    },
    readAttachment: (input) => call('readAttachment', { accountId: input.accountId, folder: input.folder, uid: input.uid, ...(input.uidValidity === undefined ? {} : { uidValidity: input.uidValidity }), index: input.index, offset: input.offset }),
    parseAddresses: (value) => call('parseAddresses', { value }),
    listAccounts: () => call('listAccounts', {}),
    addSmtpAccount: (input) => call('addSmtpAccount', input),
    updateSmtpAccount: (input) => call('updateSmtpAccount', input),
    testAccount: (accountId, cancellation) => api.backend.callOperation ? api.backend.callOperation('command.testAccount', { accountId }, { cancellation }) : call('testAccount', { accountId }),
    removeAccount: (accountId) => call('removeAccount', { accountId }),
    listFolders: (accountId) => call('listFolders', { accountId }),
    syncFolder: (accountId, folder, limit) => call('syncFolder', { accountId, folder, limit }),
    readFolder: (accountId, folder, only) => call('readFolder', { accountId, folder, ...only }),
    sendEmail: (input) => call('sendEmail', input),
    applyMessageAction: (input) => call('applyMessageAction', input),
    onSync: (listener) => api.backend.on('sync', (payload) => listener(payload as EmailSyncEvent))
  }
}

export function createMailSession(api: ValleyPluginApi) {
  let active = true
  let draining: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  const controllers = new Set<AbortController>()
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
    callOperation<T = unknown>(method: string, payload?: unknown, options?: { cancellation?: AbortSignal }): Promise<T> {
      if (!active) return Promise.reject(new Error('Email session is disposed'))
      const controller = new AbortController()
      const abort = () => controller.abort()
      if (options?.cancellation?.aborted) abort()
      options?.cancellation?.addEventListener('abort', abort, { once: true })
      controllers.add(controller)
      const promise = api.backend.callOperation<T>(method, payload, { cancellation: controller.signal })
      pending.add(promise)
      const settle = () => { pending.delete(promise); controllers.delete(controller); options?.cancellation?.removeEventListener('abort', abort) }
      void promise.then(settle, settle)
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
      for (const controller of controllers) controller.abort()
      const failures: unknown[] = []
      for (const release of subscriptions) {
        try { release() } catch (error) { failures.push(error) }
      }
      draining = Promise.allSettled([...pending]).then(() => { if (failures.length) throw failures[0] })
      return draining
    }
  }
}
