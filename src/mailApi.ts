import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { EmailDriver, EmailSyncEvent } from './mailTypes'

export function mailApi(api: Pick<ValleyPluginApi, 'backend'>): EmailDriver {
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
