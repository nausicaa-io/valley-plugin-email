import { createMockValleyApi } from '@valley/plugin-testkit'
import { expect } from 'vitest'
import type { EmailDriver, EmailMessageActionInput, EmailMessageQuery, EmailMessageRef, EmailSendInput, EmailSmtpAccountInput } from '../src/mailTypes'
import { parseEmailAddresses } from '../src/backend/query'
import config from '../config.json'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'

export function createMailMock(options?: Parameters<typeof createMockValleyApi>[0]) {
  const mock = createMockValleyApi({ ...options, manifest: { id: 'email', ...options?.manifest, datasets: options?.manifest?.datasets ?? config.datasets as unknown as ValleyPluginManifest['datasets'] } })
  const mail: EmailDriver = {
    queryMessages: async () => ({ ok: true, data: { messages: [] } }),
    readMessage: async () => ({ ok: true, data: { message: null } }),
    loadMessageContent: async (input) => ({ ok: true, data: { field: input.field, offset: input.offset, total: 0, chunk: '' } }),
    readAttachment: async () => ({ ok: false, error: 'No attachment fixture' }),
    parseAddresses: async (value) => ({ ok: true, data: { addresses: parseEmailAddresses(value, true) } }),
    listAccounts: async () => ({ ok: true, data: { accounts: [] } }),
    addSmtpAccount: async () => ({ ok: false, error: 'No account fixture' }),
    updateSmtpAccount: async () => ({ ok: false, error: 'No account fixture' }),
    testAccount: async () => ({ ok: false, error: 'No connection fixture' }),
    removeAccount: async () => ({ ok: true, data: { accounts: [] } }),
    listFolders: async () => ({ ok: true, data: { folders: [], mailboxes: [] } }),
    syncFolder: async () => ({ ok: true }),
    readFolder: async () => ({ ok: true, data: { messages: [] } }),
    sendEmail: async () => ({ ok: true, data: { messageId: 'fixture-sent' } }),
    applyMessageAction: async (input) => ({ ok: true, data: { action: input.action, folder: input.folder, messages: [] } }),
    onSync: () => () => {}
  }
  const backend = {
    async call(method: string, payload: unknown): Promise<unknown> {
      const input = payload as Record<string, unknown>
      switch (method) {
        case 'queryMessages': return mail.queryMessages(payload as EmailMessageQuery)
        case 'readMessage': return mail.readMessage(payload as EmailMessageRef)
        case 'loadMessageContent': return mail.loadMessageContent(payload as Parameters<EmailDriver['loadMessageContent']>[0])
        case 'readAttachment': return mail.readAttachment(payload as Parameters<EmailDriver['readAttachment']>[0])
        case 'parseAddresses': return mail.parseAddresses(String(input.value))
        case 'listAccounts': return mail.listAccounts()
        case 'addSmtpAccount': return mail.addSmtpAccount(payload as EmailSmtpAccountInput)
        case 'updateSmtpAccount': return mail.updateSmtpAccount(payload as Parameters<EmailDriver['updateSmtpAccount']>[0])
        case 'testAccount': case 'command.testAccount': return mail.testAccount(String(input.accountId))
        case 'removeAccount': return mail.removeAccount(String(input.accountId))
        case 'listFolders': return mail.listFolders(String(input.accountId))
        case 'syncFolder': return mail.syncFolder(String(input.accountId), input.folder as string | undefined, input.limit as number | undefined)
        case 'readFolder': { const only = { ...(input.uid === undefined ? {} : { uid: input.uid as number }), ...(input.limit === undefined ? {} : { limit: input.limit as number }) }; return Object.keys(only).length ? mail.readFolder(String(input.accountId), input.folder as string | undefined, only) : mail.readFolder(String(input.accountId), input.folder as string | undefined) }
        case 'sendEmail': return mail.sendEmail(payload as EmailSendInput)
        case 'applyMessageAction': return mail.applyMessageAction(payload as EmailMessageActionInput)
        default: throw new Error(`Unknown mail fixture method: ${method}`)
      }
    },
    async callOperation(method: string, payload: unknown, options?: { cancellation?: AbortSignal }): Promise<unknown> {
      options?.cancellation?.throwIfAborted()
      expect(payload).toStrictEqual(JSON.parse(JSON.stringify(payload)))
      return backend.call(method, payload)
    },
    on(event: string, listener: (payload: unknown) => void): () => void { return event === 'sync' ? mail.onSync(listener) : () => {} }
  }
  return { ...mock, api: Object.assign(mock.api, { backend }), mail }
}
