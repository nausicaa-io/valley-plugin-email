import { createMailSession } from './mailApi'
import type { CachedMessage, EmailAccount, EmailMailbox } from './mailTypes'
import type { ContactDirectoryEntry, ValleyPluginApi } from '@valley/plugin-sdk'
import { createContactResolution } from './contactResolution'
import { createSyncController } from './syncController'
import { createAccountsController } from './accountsController'
import { createDraftController } from './draftController'
import type { RetainedDraft } from './draftRepository'
import { createMessageController, messageKey } from './messageController'
import { createMailboxController } from './mailboxController'
export { messageKey } from './messageController'
import type { EmailAddress, EmailMailboxView, EmailMessageAction, EmailMessageDetail, EmailMessageRef, EmailMessageSummary } from './mailTypes'
import { api } from './runtime'
import { uiText } from './localization'

export interface ComposeDraft {
  id: number
  accountId: string
  mode: 'new' | 'reply' | 'reply-all' | 'forward'
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  pending: { to: string; cc: string; bcc: string }
  subject: string
  text: string
  inReplyTo?: string
  dirty: boolean
}

export interface EmailSnapshot {
  loading: boolean
  loadingMessages: boolean
  loadingMessage: boolean
  accounts: EmailAccount[]
  selectedAccountId: string | null
  selectedAccountIds: string[]
  folders: string[]
  mailboxes: EmailMailbox[]
  mailboxesByAccount: Record<string, EmailMailbox[]>
  selectedFolder: string
  view: EmailMailboxView
  messages: EmailMessageSummary[]
  cursor?: string
  selectedUid: number | null
  selectedMessage: EmailMessageDetail | null
  syncing: boolean
  actionUid: number | null
  error: string | null
  query: string
  compose: ComposeDraft | null
  composing: boolean
  bodyOverride: { key: string; htmlContent: boolean; plainText: boolean } | null
  sending: boolean
  contacts: Record<string, ContactDirectoryEntry[]>
  canGoBack: boolean
  canGoForward: boolean
}

export interface EmailStore {
  whenReady: Promise<void>
  subscribe(listener: () => void): () => void
  getSnapshot(): EmailSnapshot
  dispose(): Promise<void>
  refreshAccounts(): Promise<void>
  selectAccount(accountId: string): Promise<void>
  selectAccounts(accountIds: string[]): Promise<void>
  selectFolder(folder: string): Promise<void>
  selectView(view: EmailMailboxView, folder?: string): Promise<void>
  loadMore(): Promise<void>
  openMessage(message: EmailMessageRef | null): void
  sync(): Promise<void>
  act(message: EmailMessageRef, action: EmailMessageAction): Promise<boolean>
  setPlainText(message: EmailMessageRef, htmlContent: boolean, plainText: boolean): void
  dismissError(): void
  setQuery(query: string): void
  startCompose(mode?: ComposeDraft['mode'], message?: CachedMessage): Promise<void>
  updateDraft(patch: Partial<ComposeDraft>): void
  saveDraft(): Promise<boolean>
  flushDraft(): Promise<void>
  cancelCompose(): Promise<void>
  send(): Promise<boolean>
  removeAccount(accountId: string): Promise<void>
  goBack(): Promise<boolean>
  goForward(): Promise<boolean>
  restoreSelection(selection: EmailSelection): Promise<boolean>
}

export interface EmailSelection {
  accountIds: string[]
  view: EmailMailboxView
  folder: string
  query?: string
  message?: EmailMessageRef
}

export function formatEmailTimestamp(value: string, dateFormat: string, timeFormat: '24h' | '12h', language: string, includeTime = false): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (number: number): string => String(number).padStart(2, '0')
  const dateText = (dateFormat || 'dd.mm.yyyy').replace(/yyyy/i, String(date.getFullYear()))
    .replace(/mm/i, pad(date.getMonth() + 1)).replace(/dd/i, pad(date.getDate()))
  if (!includeTime) return dateText
  const timeText = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' }).format(date)
  return `${dateText} · ${timeText}`
}

function createStore(api: ValleyPluginApi): EmailStore {
  const mailSession = createMailSession(api)
  const mail = mailSession.driver
  const drafts = api.runtime.getOrCreate<RetainedDraft>('email.draft', () => ({ draft: null }))
  let disposed = false
  let draining: Promise<void> | undefined
  let state: EmailSnapshot = {
    loading: true, loadingMessages: false, loadingMessage: false, accounts: [], selectedAccountId: null, selectedAccountIds: [],
    folders: [], mailboxes: [], mailboxesByAccount: {}, selectedFolder: 'INBOX', view: 'folder', messages: [],
    selectedUid: null, selectedMessage: null, syncing: false, actionUid: null, error: null, query: '',
    compose: drafts.draft, composing: Boolean(drafts.draft), bodyOverride: null, sending: false, contacts: {}, canGoBack: false, canGoForward: false
  }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<EmailSnapshot>): void => {
    if (disposed) return
    state = { ...state, ...patch, ...mailboxController.historyState() }
    drafts.draft = state.compose
    for (const listener of listeners) listener()
  }
  const activeAccountIds = (): string[] => state.selectedAccountIds.length ? state.selectedAccountIds : state.accounts.map((account) => account.id)
  const updateTitle = (): void => { if (!disposed) api.workspace.setMainTabTitle(state.composing ? uiText('auto.47da6f0838f0')
    : state.selectedMessage?.subject || (state.view === 'folder' ? state.selectedFolder : uiText(`email.view.${state.view}`))) }
  const contacts = createContactResolution(api, () => {
    const messages = [...state.messages, ...(state.selectedMessage ? [state.selectedMessage] : [])]
    return [...messages.flatMap((message) => Object.values(message.addresses).flat()), ...(state.compose ? [...state.compose.to, ...state.compose.cc, ...state.compose.bcc] : [])].map((item) => item.address)
  }, (contacts) => set({ contacts }))
  const resolveContacts = contacts.refresh
  const report = (error: unknown): void => set({ error: error instanceof Error ? error.message : String(error) })
  const messagesController = createMessageController(mail, {
    snapshot: () => state, active: () => !disposed, activeAccountIds, set, report, updateTitle, pushHistory: () => mailboxController.pushHistory(), resolveContacts,
    removeFromHistory: (key) => mailboxController.removeFromHistory(key)
  })
  const { loadMessages, openMessage, act } = messagesController
  const accountsController = createAccountsController(api, {
    snapshot: () => state,
    activeAccountIds,
    active: () => !disposed,
    set,
    report,
    invalidateSelection: () => { messagesController.invalidateSelection(); contacts.clearSelection() },
    refreshMessages: () => loadMessages(),
    initialHistory: () => mailboxController.initialHistory()
  }, mail)
  const { refreshFolders, refreshAccounts } = accountsController
  const mailboxController = createMailboxController(mail, {
    snapshot: () => state, active: () => !disposed, set, updateTitle, clearContacts: contacts.clearSelection,
    whenReady: () => whenReady, accounts: accountsController, messages: messagesController
  })
  const { selectAccount, selectAccounts, selectView, restoreSelection, setQuery, goBack, goForward } = mailboxController
  const syncController = createSyncController(api, {
    scope: () => ({ accountIds: [...activeAccountIds()], view: state.view, folder: state.selectedFolder }),
    folders: (accountId) => state.mailboxesByAccount[accountId] ?? [],
    accountLabel: (accountId) => state.accounts.find((account) => account.id === accountId)?.address || accountId,
    refreshFolders,
    refreshMessages: () => loadMessages(),
    messageKey: () => messagesController.queryKey(),
    setSyncing: (syncing) => set({ syncing, ...(syncing ? { error: null } : {}) }),
    report
  }, mail)
  const sync = syncController.sync
  const draftController = createDraftController(api, {
    snapshot: () => state, active: () => !disposed, set, report, updateTitle, resolveContacts,
    invalidateMessages: () => { messagesController.invalidateMessages() }, refreshMessages: () => loadMessages(),
    sent: (draft) => { if (drafts.draft === draft) drafts.draft = null }
  }, drafts, mail)
  const { startCompose, updateDraft, saveDraft, cancelCompose, send } = draftController
  const offSync = mail.onSync((event) => {
    if (activeAccountIds().includes(event.accountId) && event.status === 'done') {
      messagesController.invalidateMessages()
      const refresh = loadMessages()
      const key = messagesController.queryKey()
      if (state.syncing) syncController.recordRefresh(key, refresh)
    }
  })
  const offSettings = api.settings.subscribe(() => set({ bodyOverride: null }))
  const whenReady = Promise.all([refreshAccounts(), draftController.whenReady]).then(() => {})
  return {
    whenReady,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => state,
    dispose: () => {
      if (draining) return draining
      disposed = true; messagesController.invalidateSelection(); contacts.clearSelection(); mailboxController.dispose(); offSync(); offSettings(); listeners.clear()
      draining = Promise.allSettled([contacts.dispose(), syncController.dispose(), draftController.dispose(), mailSession.dispose()]).then((results) => {
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      })
      return draining
    },
    refreshAccounts, selectAccount, selectAccounts, selectView, selectFolder: (folder) => selectView('folder', folder), loadMore: () => loadMessages(true),
    openMessage, sync, act, setPlainText: (message, htmlContent, plainText) => set({ bodyOverride: { key: messageKey(message), htmlContent, plainText } }), dismissError: () => set({ error: null }),
    setQuery,
    startCompose, updateDraft, saveDraft, cancelCompose, send, flushDraft: draftController.flush,
    removeAccount: async (accountId) => {
      if (disposed) return
      const result = await mail.removeAccount(accountId)
      if (!result.ok) { report(result.error || uiText('email.actionFailed')); return }
      await refreshAccounts()
    },
    goBack, goForward, restoreSelection
  }
}

export function getStore(pluginApi = api): EmailStore {
  const holder = pluginApi.runtime.getOrCreate<{ current: EmailStore | null }>('email.store', () => ({ current: null }))
  if (!holder.current) holder.current = createStore(pluginApi)
  return holder.current
}

export function disposeStore(pluginApi = api): Promise<void> {
  const holder = pluginApi.runtime.getOrCreate<{ current: EmailStore | null }>('email.store', () => ({ current: null }))
  const store = holder.current
  if (!store) return Promise.resolve()
  const disposed = store.dispose()
  const release = (): void => { if (holder.current === store) holder.current = null }
  void disposed.then(release, release)
  return disposed
}
