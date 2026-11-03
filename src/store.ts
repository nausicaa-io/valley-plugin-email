import { createMailSession } from './mailApi'
import type { CachedMessage, EmailAccount, EmailMailbox } from './mailTypes'
import type { ContactDirectoryEntry, ValleyPluginApi } from '@valley/plugin-sdk'
import { createContactResolution } from './contactResolution'
import { createEmailProjections } from './projections'
import { createClassificationQueue, type ClassificationProgress } from './classificationQueue'
import { vipAddresses } from './grouping'
import { createSmartGroupsStore, currentGroupFilter, groupFilter, starterGroups, type SmartGroupsStore } from './smartGroups'
import { createSyncController } from './syncController'
import { createAccountsController } from './accountsController'
import { createDraftController } from './draftController'
import type { RetainedDraft } from './draftRepository'
import { createMessageController, messageKey, type EmailActionOptions } from './messageController'
import { createMailboxController, type EmailNavigation } from './mailboxController'
export { messageKey } from './messageController'
import type { EmailAddress, EmailFilters, EmailGroupRef, EmailMailboxView, EmailMessageAction, EmailMessageDetail, EmailMessageRef, EmailMessageSummary } from './mailTypes'
import { api } from './runtime'
import { folderLabel, uiText } from './localization'
import { COMPOSE_TAB_SETTING, MAIN_TAB_TITLE_SETTING, focusedTabInstance, noteEmailTabTitle, releaseComposeTab } from './tabs'

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
  filters: EmailFilters
  classification: ClassificationProgress
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
  /** The smart group this tab shows (with the Recent view), or null. */
  group: EmailGroupRef | null
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
  /** "Try again" on the notice: reload the accounts and run the sync again. */
  retry(): Promise<void>
  selectAccount(accountId: string): Promise<void>
  selectAccounts(accountIds: string[]): Promise<void>
  selectFolder(folder: string): Promise<void>
  selectView(view: EmailMailboxView, folder?: string): Promise<void>
  loadMore(): Promise<void>
  openMessage(message: EmailMessageRef | null): void
  smartGroups: SmartGroupsStore
  sync(): Promise<void>
  /** Sync unless every account of the current folder view was synced within the last minute. */
  syncIfStale(): Promise<void>
  act(message: EmailMessageRef, action: EmailMessageAction, options?: EmailActionOptions): Promise<boolean>
  setPlainText(message: EmailMessageRef, htmlContent: boolean, plainText: boolean): void
  dismissError(): void
  setQuery(query: string): void
  setFilters(filters: EmailFilters): void
  /** Opens a smart group (and its subgroups) of one account in the Recent view of this tab, like a folder. */
  selectGroup(accountId: string, groupId: string): Promise<void>
  toggleVip(address: EmailAddress): Promise<void>
  assignCategory(id: string, categoryId: string | null): Promise<void>
  resetCategory(id: string): Promise<void>
  classifyExisting(ids: string[]): Promise<void>
  retryClassification(): void
  cancelClassification(): Promise<void>
  startCompose(mode?: ComposeDraft['mode'], message?: CachedMessage, initial?: Pick<ComposeDraft, 'to' | 'cc' | 'bcc' | 'subject' | 'text'>): Promise<void>
  updateDraft(patch: Partial<ComposeDraft>): void
  saveDraft(): Promise<boolean>
  flushDraft(): Promise<void>
  cancelCompose(): Promise<void>
  closeCompose(): Promise<{ discarded: boolean }>
  revertCompose(previous: Pick<EmailSnapshot, 'compose' | 'composing' | 'error'>, created: number | null): Promise<void>
  send(): Promise<boolean>
  removeAccount(accountId: string): Promise<void>
  goBack(): Promise<boolean>
  goForward(): Promise<boolean>
  restoreSelection(selection: EmailSelection): Promise<boolean>
  captureNavigation(): EmailNavigation
  restoreNavigation(saved: EmailNavigation): Promise<void>
  /** Show or hide the current draft in the live mailbox's tab without changing the draft. */
  setComposing(composing: boolean): void
}

export interface EmailSelection {
  accountIds: string[]
  view: EmailMailboxView
  folder: string
  query?: string
  message?: EmailMessageRef
  group?: EmailGroupRef
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
    filters: (api.settings.get().filters as EmailFilters | undefined) ?? {}, classification: { pending: 0, completed: 0, failed: 0 },
    loading: true, loadingMessages: false, loadingMessage: false, accounts: [], selectedAccountId: null, selectedAccountIds: [],
    folders: [], mailboxes: [], mailboxesByAccount: {}, selectedFolder: 'INBOX', view: 'folder', group: null, messages: [],
    selectedUid: null, selectedMessage: null, syncing: false, actionUid: null, error: null, query: '',
    compose: drafts.draft, composing: Boolean(drafts.draft && drafts.composing), bodyOverride: null, sending: false, contacts: {}, canGoBack: false, canGoForward: false
  }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<EmailSnapshot>): void => {
    if (disposed) return
    const accountsChanged = patch.accounts && patch.accounts.map(account => account.id).join('\u0000') !== state.accounts.map(account => account.id).join('\u0000')
    state = { ...state, ...patch, ...mailboxController.historyState() }
    if (accountsChanged) void smartGroups.reload().catch(() => {})
    drafts.draft = state.compose
    drafts.composing = state.composing
    for (const listener of listeners) listener()
  }
  const activeAccountIds = (): string[] => state.selectedAccountIds.length ? state.selectedAccountIds : state.accounts.map((account) => account.id)
  const updateTitle = (): void => {
    if (disposed) return
    const mailbox = state.mailboxes.find((entry) => entry.path === state.selectedFolder) ?? { path: state.selectedFolder, name: state.selectedFolder }
    const title = state.composing ? uiText('auto.47da6f0838f0') : state.selectedMessage?.subject || (state.view === 'folder' ? folderLabel(mailbox) : uiText(`email.view.${state.view}`))
    api.workspace.setMainTabTitle(title, focusedTabInstance())
    noteEmailTabTitle(title)
  }
  const contacts = createContactResolution(api, () => {
    const messages = [...state.messages, ...(state.selectedMessage ? [state.selectedMessage] : [])]
    return [...messages.flatMap((message) => Object.values(message.addresses).flat()), ...(state.compose ? [...state.compose.to, ...state.compose.cc, ...state.compose.bcc] : [])].map((item) => item.address)
  }, (contacts) => set({ contacts }))
  const resolveContacts = contacts.refresh
  const report = (error: unknown): void => set({ error: error instanceof Error ? error.message : String(error) })
  let syncError: string | null = null
  const messagesController = createMessageController(mail, {
    snapshot: () => state, active: () => !disposed, activeAccountIds, set, report, updateTitle, pushHistory: () => mailboxController.pushHistory(), resolveContacts,
    removeFromHistory: (key) => mailboxController.removeFromHistory(key),
    groupFilters: () => { const value = state.group ? groupFilter(smartGroups.get(), state.group.accountId, state.group.groupId) : {}; return value.categoryIds ? value : {} }
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
  const { selectAccount, selectAccounts, selectView, restoreSelection, setQuery, goBack, goForward, captureNavigation, restoreNavigation } = mailboxController
  const syncController = createSyncController(api, {
    scope: () => ({ accountIds: [...activeAccountIds()], view: state.view, folder: state.selectedFolder }),
    folders: (accountId) => state.mailboxesByAccount[accountId] ?? [],
    accountLabel: (accountId) => state.accounts.find((account) => account.id === accountId)?.address || accountId,
    refreshFolders,
    refreshMessages: () => loadMessages(),
    messageKey: () => messagesController.queryKey(),
    setSyncing: (syncing) => set({ syncing, ...(syncing ? { error: null } : {}) }),
    report,
    reportSync: (error) => {
      if (error) { syncError = error; set({ error }) }
      else if (syncError !== null && state.error === syncError) set({ error: null })
      if (!error) syncError = null
    }
  }, mail)
  const sync = syncController.sync
  const syncIfStale = (): Promise<void> => syncController.syncIfStale()
  const draftController = createDraftController(api, {
    snapshot: () => state, active: () => !disposed, set, report, updateTitle, resolveContacts, release: releaseComposeTab,
    invalidateMessages: () => { messagesController.invalidateMessages() }, refreshMessages: () => loadMessages(),
    sent: (draft) => { if (drafts.draft === draft) drafts.draft = null }
  }, drafts, mail)
  const { startCompose, updateDraft, saveDraft, cancelCompose, closeCompose, revertCompose, send } = draftController
  let accountsLoaded!: () => void
  const smartGroups = createSmartGroupsStore(api, () => state.accounts, new Promise<void>(resolve => { accountsLoaded = resolve }), () => starterGroups(key => uiText(key)))
  const classification = createClassificationQueue(api, smartGroups, classification => set({ classification }), async () => { messagesController.invalidateMessages(); await loadMessages() })
  const setFilters = (filters: EmailFilters): void => { messagesController.invalidateMessages(); set({ filters, messages: [], cursor: undefined }); void api.settings.set('filters', filters).catch(report); void loadMessages() }
  // Saved group filters follow the groups: a removed group or a stale subtree never leaves the list filtered on ids that match nothing.
  let groupsLoaded = false
  const reconcileFilters = (): void => { if (disposed || !groupsLoaded) return; const next = currentGroupFilter(smartGroups.get(), state.filters); if (next !== state.filters) setFilters(next) }
  void smartGroups.ready.then(() => { groupsLoaded = true; reconcileFilters() })
  const offGroups = smartGroups.subscribe(reconcileFilters)
  const projections = createEmailProjections(api, async () => { messagesController.invalidateMessages(); await loadMessages() })
  const offSync = mail.onSync((event) => {
    if (event.status === 'done') syncController.noteSynced(event.accountId, event.folder)
    if (event.status === 'done' && event.arrived?.length) void classification.enqueue(event.arrived, true).catch(report)
    if (activeAccountIds().includes(event.accountId) && event.status === 'done') {
      messagesController.invalidateMessages()
      const refresh = loadMessages()
      const key = messagesController.queryKey()
      if (state.syncing) syncController.recordRefresh(key, refresh)
    }
  })
  // Remembering the compose tab or a tab title is not a display change and keeps the per-message plain text/HTML choice.
  const displaySettings = (): string => JSON.stringify({ ...api.settings.get(), [COMPOSE_TAB_SETTING]: undefined, [MAIN_TAB_TITLE_SETTING]: undefined })
  let displayed = displaySettings()
  const offSettings = api.settings.subscribe(() => {
    const next = displaySettings()
    if (next === displayed) return
    displayed = next
    set({ bodyOverride: null })
  })
  const whenReady = Promise.all([refreshAccounts(), draftController.whenReady]).then(() => {})
  void whenReady.finally(accountsLoaded).catch(() => {})
  return {
    whenReady,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => state,
    dispose: () => {
      if (draining) return draining
      disposed = true; messagesController.invalidateSelection(); contacts.clearSelection(); mailboxController.dispose(); offSync(); offSettings(); offGroups(); smartGroups.dispose(); listeners.clear()
      draining = Promise.allSettled([classification.dispose(), projections.dispose(), contacts.dispose(), syncController.dispose(), draftController.dispose(), mailSession.dispose()]).then((results) => {
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      })
      return draining
    },
    smartGroups, refreshAccounts, selectAccount, selectAccounts, selectView, selectFolder: (folder) => selectView('folder', folder), loadMore: () => loadMessages(true),
    // Opening mail in the tab that shows the draft releases the draft in that same turn.
    openMessage: (message) => { if (!disposed && state.composing) releaseComposeTab(); openMessage(message) }, sync, syncIfStale, act, setPlainText: (message, htmlContent, plainText) => set({ bodyOverride: { key: messageKey(message), htmlContent, plainText } }), dismissError: () => set({ error: null }),
    retry: async () => { set({ error: null }); await refreshAccounts(); await sync() },
    setQuery,
    setFilters,
    selectGroup: (accountId, groupId) => selectView('recent', state.selectedFolder, { accountId, groupId }),
    toggleVip: async address => {
      const values = vipAddresses(api), key = address.address.trim().toLowerCase()
      const matched = state.contacts[key]
      const addresses = matched?.length === 1 ? matched[0].emails.map(email => email.address.trim().toLowerCase()) : [key]
      const remove = values.has(key)
      for (const value of addresses) { if (remove) values.delete(value); else values.add(value) }
      await api.settings.set('vipAddresses', [...values])
    },
    assignCategory: (id, categoryId) => classification.assign(id, categoryId), resetCategory: classification.reset, classifyExisting: ids => classification.enqueue(ids), retryClassification: classification.retry, cancelClassification: classification.cancel,
    startCompose, updateDraft, saveDraft, cancelCompose, closeCompose, revertCompose, send, flushDraft: draftController.flush,
    removeAccount: async (accountId) => {
      if (disposed) return
      const result = await mail.removeAccount(accountId)
      if (!result.ok) { report(result.error || uiText('email.actionFailed')); return }
      await refreshAccounts()
    },
    goBack, goForward, restoreSelection, captureNavigation, restoreNavigation,
    setComposing: (composing) => {
      if (disposed || state.composing === composing || composing && !state.compose) return
      set({ composing })
      updateTitle()
    }
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
