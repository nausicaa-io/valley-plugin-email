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
  login?: string
  displayName?: string
  imap: MailHost
  smtp: MailHost
  createdAt: number
  secretState?: 'absent' | 'stored' | 'ok' | 'unreadable'
}

/** A message payload with a separate IMAP location. */
export interface CachedMessage {
  automationHeaders?: MailAutomationHeaders
  logicalId?: string
  contentRevision?: string
  uidValidity?: number
  originalDate?: string | null
  receivedAt?: string
  attachmentDigests?: string[]
  bcc?: string
  complete?: boolean
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
  /** Size, attachment parts, text bodies not downloaded yet, and a download failure, as recorded by sync. */
  structure?: MailStructure
}

/** One attachment of a cached message, located by its IMAP part number; its bytes are fetched only when saved. */
export interface MailAttachmentPart {
  part: string
  filename: string
  mimeType: string
  encoding: string
  /** Bytes of the part as stored on the server (before transfer decoding). */
  encodedSize: number
  /** Approximate decoded size. */
  size: number
  inline?: boolean
  contentId?: string
}

/** One text or HTML body part. */
export interface MailBodyPart {
  part: string
  kind: 'text' | 'html'
  encoding: string
  size: number
  charset?: string
}

export interface MailStructure {
  size?: number
  attachments?: MailAttachmentPart[]
  /** Body parts above the sync limit, downloaded when the message is opened. */
  deferred?: MailBodyPart[]
  /** Why the message could not be downloaded; it is kept once and retried only when opened. */
  failure?: string
}

/** An attachment as the reader lists it. */
export interface EmailAttachment {
  index: number
  filename: string
  mimeType: string
  size: number
  inline?: boolean
}

export interface MailAutomationHeaders {
  observed: true
  autoSubmitted: string[]
  precedence: string[]
  listId: string[]
  suppress: string[]
  origin: string[]
  inReplyTo?: string[]
  references?: string[]
  uncertain?: boolean
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
  arrived?: string[]
  fetched?: number
  total?: number
  /** Messages that could not be downloaded in this sync and were kept as unavailable. */
  unavailable?: number
  /** Cached messages removed because the server no longer has them. */
  removed?: number
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
  uidValidity?: number
  accountId: string
  folder: string
  uid: number
}

export type EmailMailboxView = 'recent' | 'unread' | 'flagged' | 'folder'
/** A smart group opened like a folder; part of each tab's own view, never of the global filters. */
export interface EmailGroupRef { accountId: string; groupId: string }

export interface EmailMessageSummary extends Omit<CachedMessage, 'text' | 'html' | 'structure'>, EmailMessageRef {
  id: string
  categoryId?: string
  isVip?: boolean
  isSpam?: boolean
  hasContact?: boolean
  memberships: EmailMessageRef[]
  addresses: { from: EmailAddress[]; to: EmailAddress[]; cc: EmailAddress[]; replyTo: EmailAddress[] }
}

export interface EmailMessageDetail extends EmailMessageSummary {
  text?: string
  html?: string
  attachments?: EmailAttachment[]
  /** The body is not in this reply: it is too large to return at once or was not downloaded yet. Load it with `loadMessageContent`. */
  bodyDeferred?: boolean
  /** The recorded reason the message could not be downloaded. */
  bodyError?: string
  /** Characters of the body the reader shows, when it is too long to show completely. */
  bodyTruncated?: { shown: number; total: number }
}

export interface EmailBodyChunk { field: 'text' | 'html'; offset: number; total: number; chunk: string }
export interface EmailBodyChunkResult extends DriverResult { data?: EmailBodyChunk }
export interface EmailAttachmentSlice { filename: string; mimeType: string; encoding: string; encodedSize: number; offset: number; data: string }
export interface EmailAttachmentSliceResult extends DriverResult { data?: EmailAttachmentSlice }

export interface EmailFilters {
  contact?: 'all' | 'known' | 'unknown'
  vip?: 'all' | 'vip' | 'others'
  spam?: 'default' | 'spam' | 'not-spam' | 'all'
  categoryId?: string
  /** The opened group plus its subgroups; `categoryId` names the opened group for labels. */
  categoryIds?: string[]
  categoryAccountId?: string
}

export interface EmailMessageQuery {
  filters?: EmailFilters
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
  data?: { folders: string[]; mailboxes: EmailMailbox[]; warning?: string }
}
export interface EmailConnectionResult extends DriverResult { data?: { checkedAt: string; imap: { ok: boolean; error?: string }; smtp: { ok: boolean; error?: string } } }

export type EmailMessageAction = 'mark-read' | 'mark-unread' | 'flag' | 'unflag' | 'archive' | 'trash' | 'junk'

export interface EmailMessageActionInput {
  uidValidity?: number
  accountId: string
  folder: string
  uid: number
  action: EmailMessageAction
}

export interface EmailMessageActionResult extends DriverResult {
  /** `not-applied`: the mailbox was not changed; `unknown`: the change was sent and its result is unknown; `remote-complete`: applied, cache not updated. */
  outcome?: 'remote-complete' | 'not-applied' | 'unknown'
  code?: string
  data?: {
    action: EmailMessageAction
    folder: string
    messages: CachedMessage[]
    destinationFolder?: string
  }
}

export interface EmailSmtpAccountInput {
  address: string
  login?: string
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
  queryMessages(input: EmailMessageQuery, cancellation?: AbortSignal): Promise<EmailQueryResult>
  readMessage(input: EmailMessageRef, cancellation?: AbortSignal): Promise<EmailDetailResult>
  parseAddresses(value: string): Promise<EmailAddressesResult>
  /**
   * List mail accounts: centralized Google/Microsoft accounts (managed in
   * Settings → Accounts) plus any local PureMail (generic IMAP/SMTP) accounts.
   */
  listAccounts(): Promise<EmailAccountsResult>
  /** Add a generic SMTP/IMAP (PureMail) account; verifies before saving. */
  addSmtpAccount(input: EmailSmtpAccountInput): Promise<EmailAccountResult>
  updateSmtpAccount(input: { accountId: string; address: string; login: string; password: string }): Promise<EmailAccountResult>
  testAccount(accountId: string, cancellation?: AbortSignal): Promise<EmailConnectionResult>
  /** Remove an account, its cached messages and stored credentials. */
  removeAccount(accountId: string): Promise<EmailAccountsResult>
  /** List an account's IMAP mailbox folders. */
  listFolders(accountId: string): Promise<EmailFoldersResult>
  /** Fetch recent messages for a folder into the local cache. */
  syncFolder(accountId: string, folder?: string, limit?: number): Promise<DriverResult>
  /** Read cached messages for a folder (no network). */
  /** Cached messages of a folder, newest first; `uid` reads one message and `limit` only the newest ones (each with its body). */
  readFolder(accountId: string, folder?: string, only?: { uid?: number; limit?: number }): Promise<EmailMessagesResult>
  /** Send a message and append it to the Sent cache. */
  sendEmail(input: EmailSendInput): Promise<DriverResult & { outcome?: 'remote-complete' | 'not-applied' | 'unknown'; data?: { messageId: string } }>
  /** Mutate one message on the server and mirror the successful result into the local cache. */
  applyMessageAction(input: EmailMessageActionInput): Promise<EmailMessageActionResult>
  /** Download a body that is deferred or too large for one reply (once), then return one slice of it. */
  loadMessageContent(input: EmailMessageRef & { field: 'text' | 'html'; offset: number }, cancellation?: AbortSignal): Promise<EmailBodyChunkResult>
  /** One base64 slice of an attachment's encoded bytes, fetched from the server on demand. */
  readAttachment(input: EmailMessageRef & { index: number; offset: number }): Promise<EmailAttachmentSliceResult>
  /** Subscribe to IMAP sync progress events. Returns an unsubscribe fn. */
  onSync(cb: (event: EmailSyncEvent) => void): () => void
}
