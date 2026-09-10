import type { DriverResult } from '@valley/plugin-sdk/types'

export type EmailProvider = string

/** IMAP/SMTP server coordinates for an email account. */
export interface MailHost {
  host: string
  port: number
  secure: boolean
}

/** A configured email account (non-secret; credentials live in safeStorage). */
export interface EmailAccount {
  id: string
  provider: EmailProvider
  address: string
  displayName?: string
  imap: MailHost
  smtp: MailHost
  createdAt: number
  /** PureMail only: health of the stored password (`unreadable` = keychain can
   *  no longer decrypt it — prompt a re-entry instead of failing silently). */
  secretState?: 'absent' | 'ok' | 'unreadable'
}

/** A cached email message stored in the plugin's per-folder JSONL. */
export interface CachedMessage {
  uid: number
  messageId: string
  from: string
  replyTo?: string
  to: string
  cc?: string
  subject: string
  date: string
  snippet: string
  text?: string
  html?: string
  flags: string[]
  hasAttachments: boolean
}

/** One selectable IMAP mailbox plus counts available from the local cache. */
export interface EmailMailbox {
  path: string
  name: string
  delimiter?: string
  specialUse?: string
  selectable: boolean
  cachedTotal: number
  cachedUnread: number
}

export interface EmailSyncEvent {
  accountId: string
  folder: string
  status: 'start' | 'done' | 'error'
  fetched?: number
  total?: number
  error?: string
}

export interface EmailAccountsResult extends DriverResult {
  data?: { accounts: EmailAccount[] }
}

export interface EmailAccountResult extends DriverResult {
  data?: { account: EmailAccount; accounts: EmailAccount[] }
}

/** `DriverResult` whose `data` carries cached messages for a folder. */
export interface EmailMessagesResult extends DriverResult {
  data?: { messages: CachedMessage[] }
}

export interface EmailAddress {
  name: string
  address: string
}

export interface EmailMessageRef {
  accountId: string
  folder: string
  uid: number
}

export type EmailMailboxView = 'recent' | 'unread' | 'flagged' | 'folder'

export interface EmailMessageSummary extends Omit<CachedMessage, 'text' | 'html'>, EmailMessageRef {
  id: string
  memberships: EmailMessageRef[]
  addresses: { from: EmailAddress[]; to: EmailAddress[]; cc: EmailAddress[]; replyTo: EmailAddress[] }
}

export interface EmailMessageDetail extends EmailMessageSummary {
  text?: string
  html?: string
}

export interface EmailMessageQuery {
  accountId: string
  accountIds?: string[]
  view: EmailMailboxView
  folder?: string
  query?: string
  limit?: number
  cursor?: string
}

export interface EmailQueryResult extends DriverResult {
  data?: { messages: EmailMessageSummary[]; cursor?: string }
}

export interface EmailDetailResult extends DriverResult {
  data?: { message: EmailMessageDetail | null }
}

export interface EmailAddressesResult extends DriverResult {
  data?: { addresses: EmailAddress[] }
}

export interface EmailFoldersResult extends DriverResult {
  data?: { folders: string[]; mailboxes: EmailMailbox[] }
}

export type EmailMessageAction = 'mark-read' | 'mark-unread' | 'flag' | 'unflag' | 'archive' | 'trash' | 'junk'

export interface EmailMessageActionInput {
  accountId: string
  folder: string
  uid: number
  action: EmailMessageAction
}

export interface EmailMessageActionResult extends DriverResult {
  data?: {
    action: EmailMessageAction
    folder: string
    messages: CachedMessage[]
    destinationFolder?: string
  }
}

export interface EmailSmtpAccountInput {
  address: string
  displayName?: string
  password: string
  imap: MailHost
  smtp: MailHost
}

export interface EmailSendInput {
  accountId: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  text?: string
  html?: string
  inReplyTo?: string
}

export interface EmailDriver {
  /** Search the selected account's local cache, with folder-qualified identities. */
  queryMessages(input: EmailMessageQuery): Promise<EmailQueryResult>
  readMessage(input: EmailMessageRef): Promise<EmailDetailResult>
  parseAddresses(value: string): Promise<EmailAddressesResult>
  /**
   * List mail accounts: centralized Google/Microsoft accounts (managed in
   * Settings → Accounts) plus any local PureMail (generic IMAP/SMTP) accounts.
   */
  listAccounts(): Promise<EmailAccountsResult>
  /** Add a generic SMTP/IMAP (PureMail) account; verifies before saving. */
  addSmtpAccount(input: EmailSmtpAccountInput): Promise<EmailAccountResult>
  /** Remove an account, its cached messages and stored credentials. */
  removeAccount(accountId: string): Promise<EmailAccountsResult>
  /** List an account's IMAP mailbox folders. */
  listFolders(accountId: string): Promise<EmailFoldersResult>
  /** Fetch recent messages for a folder into the local cache. */
  syncFolder(accountId: string, folder?: string, limit?: number): Promise<DriverResult>
  /** Read cached messages for a folder (no network). */
  readFolder(accountId: string, folder?: string): Promise<EmailMessagesResult>
  /** Send a message and append it to the Sent cache. */
  sendEmail(input: EmailSendInput): Promise<DriverResult & { data?: { messageId: string } }>
  /** Mutate one message on the server and mirror the successful result into the local cache. */
  applyMessageAction(input: EmailMessageActionInput): Promise<EmailMessageActionResult>
  /** Subscribe to IMAP sync progress events. Returns an unsubscribe fn. */
  onSync(cb: (event: EmailSyncEvent) => void): () => void
}
