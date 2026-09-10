import { uiText } from './localization'
import { mailApi } from './mailApi'
import {
  createAgentToolProvider,
  type AgentToolProvider,
  type AgentToolDefinition,
  type ValleyPluginApi
} from '@valley/plugin-sdk'
import type { CachedMessage, EmailAccount } from './mailTypes'

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false
})
const text = (description: string) => ({ type: 'string', description })
const str = (value: unknown) => value == null ? '' : String(value)
const folderArg = text('Mailbox folder path; defaults to INBOX')
const accountArg = text('Explicit account id returned by list_mail_accounts')
const uidArg = { type: 'integer', minimum: 1, description: 'Message UID returned by search_email_messages or read_inbox' }
const json = (value: unknown) => JSON.stringify(value, null, 2)
const limitOf = (value: unknown, fallback: number, maximum = 100) =>
  Math.max(1, Math.min(maximum, typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback))

async function accountFor(api: ValleyPluginApi, requested: unknown): Promise<EmailAccount | null> {
  const result = await mailApi(api).listAccounts()
  if (!result.ok) throw new Error(result.error ?? uiText('email.agentError.listAccounts'))
  const accounts = result.data?.accounts ?? []
  const id = str(requested)
  if (!id) return accounts[0] ?? null
  const account = accounts.find((candidate) => candidate.id === id)
  if (!account) throw new Error(uiText('email.agentError.account', { value: id }))
  return account
}

async function cachedMessage(
  api: ValleyPluginApi,
  accountId: string,
  folder: string,
  uid: number
): Promise<CachedMessage> {
  const result = await mailApi(api).readFolder(accountId, folder)
  if (!result.ok) throw new Error(result.error ?? uiText('email.agentError.read', { value: folder }))
  const message = (result.data?.messages ?? []).find((candidate) => candidate.uid === uid)
  if (!message) throw new Error(uiText('email.agentError.message', { uid, folder }))
  return message
}

const summary = (message: CachedMessage) => ({
  uid: message.uid,
  messageId: message.messageId,
  from: message.from,
  to: message.to,
  subject: message.subject,
  date: message.date,
  read: message.flags.includes('\\Seen'),
  flagged: message.flags.includes('\\Flagged'),
  hasAttachments: message.hasAttachments,
  snippet: message.snippet
})

const subjectWith = (prefix: 'Re' | 'Fwd', subject: string) =>
  new RegExp(`^${prefix}:`, 'i').test(subject) ? subject : `${prefix}: ${subject || '(no subject)'}`

const quoted = (message: CachedMessage) =>
  (message.text || message.snippet || '').split('\n').map((line) => `> ${line}`).join('\n')

function emailToolDefinitions(api: ValleyPluginApi): AgentToolDefinition[] {
  return [
    {
      name: 'list_mail_accounts', description: 'List configured email accounts.',
      parameters: schema({}), sideEffect: 'read', timeoutMs: 120_000,
      run: async () => {
        const result = await mailApi(api).listAccounts()
        if (!result.ok) throw new Error(result.error ?? uiText('email.agentError.listAccounts'))
        const accounts = result.data?.accounts ?? []
        return accounts.length ? json(accounts.map((account) => ({
          id: account.id,
          address: account.address,
          displayName: account.displayName ?? null,
          provider: account.provider
        }))) : 'No accounts.'
      }
    },
    {
      name: 'list_mail_folders', description: 'List selectable folders and cached message counts for an email account.',
      parameters: schema({ accountId: accountArg }), sideEffect: 'read', timeoutMs: 120_000,
      run: async (args) => {
        const account = await accountFor(api, args.accountId)
        if (!account) return 'No email account configured.'
        const result = await mailApi(api).listFolders(account.id)
        if (!result.ok) throw new Error(result.error ?? uiText('email.agentError.listFolders'))
        const mailboxes = result.data?.mailboxes ?? []
        return json({
          accountId: account.id,
          folders: mailboxes.length ? mailboxes.map((mailbox) => ({
            path: mailbox.path,
            name: mailbox.name,
            specialUse: mailbox.specialUse ?? null,
            selectable: mailbox.selectable,
            cachedTotal: mailbox.cachedTotal,
            cachedUnread: mailbox.cachedUnread
          })) : (result.data?.folders ?? []).map((path) => ({ path }))
        })
      }
    },
    {
      name: 'read_inbox', description: 'Sync and read recent messages from an email inbox.',
      parameters: schema({ accountId: accountArg, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
      sideEffect: 'read', timeoutMs: 120_000,
      run: async (args) => {
        const account = await accountFor(api, args.accountId)
        if (!account) return 'No email account configured.'
        const limit = limitOf(args.limit, 10)
        const synced = await mailApi(api).syncFolder(account.id, 'INBOX', limit)
        if (!synced.ok) throw new Error(synced.error ?? uiText('email.agentError.sync', { value: 'INBOX' }))
        const result = await mailApi(api).readFolder(account.id, 'INBOX')
        if (!result.ok) throw new Error(result.error ?? uiText('email.agentError.read', { value: 'INBOX' }))
        const messages = (result.data?.messages ?? []).slice(0, limit)
        return messages.length ? json({ accountId: account.id, folder: 'INBOX', messages: messages.map(summary) }) : 'Inbox empty.'
      }
    },
    {
      name: 'search_email_messages', description: 'Sync and search cached messages in one email folder. Returns UIDs for follow-up tools.',
      parameters: schema({
        query: text('Text to match against sender, recipients, subject, snippet, or body'),
        accountId: accountArg,
        folder: folderArg,
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum matches; defaults to 20' },
        sync: { type: 'boolean', description: 'Sync the folder before searching; defaults to true' }
      }, ['query']),
      sideEffect: 'read', timeoutMs: 120_000,
      run: async (args) => {
        const account = await accountFor(api, args.accountId)
        if (!account) return 'No email account configured.'
        const folder = str(args.folder) || 'INBOX'
        const limit = limitOf(args.limit, 20)
        if (args.sync !== false) {
          const synced = await mailApi(api).syncFolder(account.id, folder, Math.max(limit, 50))
          if (!synced.ok) throw new Error(synced.error ?? uiText('email.agentError.sync', { value: folder }))
        }
        const result = await mailApi(api).readFolder(account.id, folder)
        if (!result.ok) throw new Error(result.error ?? uiText('email.agentError.read', { value: folder }))
        const query = str(args.query).trim().toLocaleLowerCase()
        const matches = (result.data?.messages ?? []).filter((message) =>
          [message.from, message.replyTo, message.to, message.cc, message.subject, message.snippet, message.text]
            .some((value) => value?.toLocaleLowerCase().includes(query))
        ).slice(0, limit)
        return json({ accountId: account.id, folder, query, messages: matches.map(summary) })
      }
    },
    {
      name: 'read_mail_message', description: 'Read one cached email message by account, folder, and UID without changing its read state.',
      parameters: schema({ accountId: accountArg, folder: folderArg, uid: uidArg }, ['uid']),
      sideEffect: 'read', timeoutMs: 120_000,
      run: async (args) => {
        const account = await accountFor(api, args.accountId)
        if (!account) return 'No email account configured.'
        const folder = str(args.folder) || 'INBOX'
        const message = await cachedMessage(api, account.id, folder, Number(args.uid))
        return json({
          accountId: account.id,
          folder,
          ...summary(message),
          replyTo: message.replyTo ?? null,
          cc: message.cc ?? null,
          text: message.text || message.snippet
        })
      }
    },
    {
      name: 'update_email_message', description: 'Mark a message read or unread, flag or unflag it, archive it, or move it to Trash.',
      parameters: schema({
        accountId: accountArg,
        folder: folderArg,
        uid: uidArg,
        action: {
          type: 'string',
          enum: ['mark-read', 'mark-unread', 'flag', 'unflag', 'archive', 'trash'],
          description: 'Mailbox action to apply'
        }
      }, ['uid', 'action']),
      sideEffect: 'write', timeoutMs: 120_000,
      run: async (args) => {
        const account = await accountFor(api, args.accountId)
        if (!account) return 'No email account configured.'
        const folder = str(args.folder) || 'INBOX'
        const action = str(args.action)
        if (!['mark-read', 'mark-unread', 'flag', 'unflag', 'archive', 'trash'].includes(action)) {
          throw new Error(uiText('email.agentError.action', { value: action }))
        }
        const result = await mailApi(api).applyMessageAction({
          accountId: account.id,
          folder,
          uid: Number(args.uid),
          action: action as 'mark-read' | 'mark-unread' | 'flag' | 'unflag' | 'archive' | 'trash'
        })
        if (!result.ok) throw new Error(result.error ?? uiText('email.agentError.update'))
        return json({
          accountId: account.id,
          folder,
          uid: Number(args.uid),
          action,
          destinationFolder: result.data?.destinationFolder ?? null
        })
      }
    },
    {
      name: 'compose_email', description: 'Send an email from a configured account.',
      parameters: schema({
        to: text('Recipient address'),
        subject: text('Subject'),
        text: text('Body text'),
        cc: text('Optional CC recipients'),
        bcc: text('Optional BCC recipients'),
        accountId: accountArg
      }, ['to', 'subject', 'text']),
      sideEffect: 'write', timeoutMs: 120_000,
      run: async (args) => {
        const account = await accountFor(api, args.accountId)
        if (!account) return 'No email account configured.'
        const result = await mailApi(api).sendEmail({
          accountId: account.id,
          to: str(args.to),
          cc: str(args.cc) || undefined,
          bcc: str(args.bcc) || undefined,
          subject: str(args.subject),
          text: str(args.text)
        })
        if (!result.ok) throw new Error(result.error ?? uiText('email.agentError.send'))
        return json({ sent: true, accountId: account.id, to: str(args.to), messageId: result.data?.messageId ?? null })
      }
    },
    {
      name: 'reply_to_email', description: 'Reply to a cached email message and preserve its message-thread identifier.',
      parameters: schema({ accountId: accountArg, folder: folderArg, uid: uidArg, text: text('Reply body text') }, ['uid', 'text']),
      sideEffect: 'write', timeoutMs: 120_000,
      run: async (args) => {
        const account = await accountFor(api, args.accountId)
        if (!account) return 'No email account configured.'
        const folder = str(args.folder) || 'INBOX'
        const message = await cachedMessage(api, account.id, folder, Number(args.uid))
        const to = message.replyTo || message.from
        const body = `${str(args.text).trim()}\n\nOn ${message.date}, ${message.from} wrote:\n${quoted(message)}`
        const result = await mailApi(api).sendEmail({
          accountId: account.id,
          to,
          subject: subjectWith('Re', message.subject),
          text: body,
          inReplyTo: message.messageId
        })
        if (!result.ok) throw new Error(result.error ?? uiText('email.agentError.reply'))
        return json({
          sent: true,
          accountId: account.id,
          inReplyTo: message.messageId,
          to,
          messageId: result.data?.messageId ?? null
        })
      }
    },
    {
      name: 'forward_email', description: 'Forward a cached email message to new recipients with its original metadata and body.',
      parameters: schema({
        accountId: accountArg,
        folder: folderArg,
        uid: uidArg,
        to: text('Recipient address'),
        cc: text('Optional CC recipients'),
        bcc: text('Optional BCC recipients'),
        text: text('Optional introductory text before the forwarded message')
      }, ['uid', 'to']),
      sideEffect: 'write', timeoutMs: 120_000,
      run: async (args) => {
        const account = await accountFor(api, args.accountId)
        if (!account) return 'No email account configured.'
        const folder = str(args.folder) || 'INBOX'
        const message = await cachedMessage(api, account.id, folder, Number(args.uid))
        const intro = str(args.text).trim()
        const forwarded = `${intro ? `${intro}\n\n` : ''}---------- Forwarded message ----------\n` +
          `From: ${message.from}\nDate: ${message.date}\nSubject: ${message.subject}\nTo: ${message.to}\n` +
          `${message.cc ? `Cc: ${message.cc}\n` : ''}\n${message.text || message.snippet}`
        const result = await mailApi(api).sendEmail({
          accountId: account.id,
          to: str(args.to),
          cc: str(args.cc) || undefined,
          bcc: str(args.bcc) || undefined,
          subject: subjectWith('Fwd', message.subject),
          text: forwarded
        })
        if (!result.ok) throw new Error(result.error ?? uiText('email.agentError.forward'))
        return json({
          sent: true,
          accountId: account.id,
          forwardedMessageId: message.messageId,
          to: str(args.to),
          messageId: result.data?.messageId ?? null
        })
      }
    }
  ]
}

const commandId = (name: string): string => name.replaceAll('_', '-')

function commandSchema(tool: AgentToolDefinition): Record<string, unknown> {
  const properties = tool.parameters.properties as Record<string, unknown>
  const required = [...(tool.parameters.required as string[] ?? [])]
  if (properties.accountId && !required.includes('accountId')) required.push('accountId')
  if (properties.folder && !required.includes('folder')) required.push('folder')
  return { ...tool.parameters, required }
}

function parseToolInput(raw: unknown, parameters: Record<string, unknown>): Record<string, unknown> {
  const input = raw === undefined ? {} : raw
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(uiText('email.agentError.input'))
  const value = input as Record<string, unknown>
  const properties = parameters.properties as Record<string, { type?: string; enum?: unknown[]; minimum?: number; maximum?: number }>
  for (const key of parameters.required as string[] ?? []) if (value[key] === undefined || value[key] === '') throw new Error(uiText('email.agentError.required', { value: key }))
  for (const [key, item] of Object.entries(value)) {
    const field = properties[key]
    if (!field) throw new Error(uiText('email.agentError.unknown', { value: key }))
    if (field.type === 'string' && typeof item !== 'string') throw new Error(uiText('email.agentError.string', { value: key }))
    if (field.type === 'boolean' && typeof item !== 'boolean') throw new Error(uiText('email.agentError.boolean', { value: key }))
    if (field.type === 'integer' && (!Number.isSafeInteger(item) || Number(item) < (field.minimum ?? -Infinity) || Number(item) > (field.maximum ?? Infinity))) throw new Error(uiText('email.agentError.integer', { value: key }))
    if (field.enum && !field.enum.includes(item)) throw new Error(uiText('email.agentError.unsupported', { field: key, value: String(item) }))
  }
  return structuredClone(value)
}

export function registerEmailAgentCommands(api: ValleyPluginApi): () => void {
  const offs = emailToolDefinitions(api).map((tool) => {
    const parameters = commandSchema(tool)
    return api.commands.register({
      id: commandId(tool.name), label: `Email: ${tool.description}`, paletteSafe: false, sideEffect: tool.sideEffect, timeoutMs: tool.timeoutMs,
      input: { schema: parameters, parse: (raw) => parseToolInput(raw, parameters) },
      preview: (input) => ({ action: commandId(tool.name), ...input }),
      revision: async (input) => {
        if (input.uid !== undefined) return await cachedMessage(api, str(input.accountId), str(input.folder), Number(input.uid))
        if (input.accountId !== undefined) return await accountFor(api, input.accountId)
        return null
      },
      run: async (input, context) => {
        const output = await tool.run(input, { cancellation: context.cancellation })
        let value: unknown = output
        if (typeof output === 'string') { try { value = JSON.parse(output) } catch { value = output } }
        return tool.sideEffect === 'write' ? { value, revert: null } : value
      }
    })
  })
  return () => offs.forEach((off) => off())
}

export function emailAgentTools(api: ValleyPluginApi): AgentToolProvider {
  return createAgentToolProvider(emailToolDefinitions(api).map((tool) => ({
    ...tool, commandId: commandId(tool.name), parameters: commandSchema(tool),
    run: async (args, context) => {
      const result = await api.commands.executeOwn(commandId(tool.name), args, { ...context, autonomous: true })
      if (!result.ok) throw new Error(result.error.message)
      return typeof result.value === 'string' ? result.value : JSON.stringify(result.value)
    }
  })))
}
