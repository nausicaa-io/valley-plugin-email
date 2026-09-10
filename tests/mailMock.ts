import { createMockValleyApi } from '@valley/plugin-testkit'
import type { EmailDriver, EmailMessageActionInput, EmailMessageQuery, EmailMessageRef, EmailSendInput, EmailSmtpAccountInput } from '../src/mailTypes'
import { parseEmailAddresses } from '../src/backend/query'

export function createMailMock(options?: Parameters<typeof createMockValleyApi>[0]) {
  const mock = createMockValleyApi(options)
  const mail: EmailDriver = {
    queryMessages: async () => ({ ok: true, data: { messages: [] } }),
    readMessage: async () => ({ ok: true, data: { message: null } }),
    parseAddresses: async (value) => ({ ok: true, data: { addresses: parseEmailAddresses(value, true) } }),
    listAccounts: async () => ({ ok: true, data: { accounts: [] } }),
    addSmtpAccount: async () => ({ ok: false, error: 'No account fixture' }),
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
        case 'parseAddresses': return mail.parseAddresses(String(input.value))
        case 'listAccounts': return mail.listAccounts()
        case 'addSmtpAccount': return mail.addSmtpAccount(payload as EmailSmtpAccountInput)
        case 'removeAccount': return mail.removeAccount(String(input.accountId))
        case 'listFolders': return mail.listFolders(String(input.accountId))
        case 'syncFolder': return mail.syncFolder(String(input.accountId), input.folder as string | undefined, input.limit as number | undefined)
        case 'readFolder': return mail.readFolder(String(input.accountId), input.folder as string | undefined)
        case 'sendEmail': return mail.sendEmail(payload as EmailSendInput)
        case 'applyMessageAction': return mail.applyMessageAction(payload as EmailMessageActionInput)
        default: throw new Error(`Unknown mail fixture method: ${method}`)
      }
    },
    on(event: string, listener: (payload: unknown) => void): () => void { return event === 'sync' ? mail.onSync(listener) : () => {} }
  }
  return { ...mock, api: Object.assign(mock.api, { backend }), mail }
}
