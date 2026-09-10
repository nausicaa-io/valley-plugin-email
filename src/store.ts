import { mailApi } from './mailApi'
import type { CachedMessage, EmailAccount, EmailMailbox } from './mailTypes'
import { CONTACTS_DIRECTORY_V1, CONTACTS_DIRECTORY_REVISION_V1, type ContactDirectoryEntry } from '@valley/plugin-sdk'
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
  dispose(): void
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
  saveDraft(): void
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

export const messageKey = (message: EmailMessageRef): string => JSON.stringify([message.accountId, message.folder, message.uid])
export const formatAddresses = (addresses: EmailAddress[]): string => addresses.map(({ name, address }) => name ? `${JSON.stringify(name)} <${address}>` : address).join(', ')
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

function createStore(): EmailStore {
  type NavigationEntry = { accountId: string | null; accountIds: string[]; folder: string; view: EmailMailboxView; message: EmailMessageRef | null }
  const drafts = api.runtime.getOrCreate<{ draft: ComposeDraft | null }>('email.draft', () => ({ draft: null }))
  let history: NavigationEntry[] = []
  let historyIndex = -1
  let requestId = 0
  let messageRevision = 0
  let pendingMessages: { key: string; revision: number; token: number; promise: Promise<void> } | null = null
  const syncMessageRefresh = new Map<string, Promise<void>>()
  let detailId = 0
  let contactRequest = 0
  let folderRequest = 0
  let accountRequest = 0
  let syncAgain = false
  let draftSequence = Date.now()
  let queryTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let state: EmailSnapshot = {
    loading: true, loadingMessages: false, loadingMessage: false, accounts: [], selectedAccountId: null, selectedAccountIds: [],
    folders: [], mailboxes: [], mailboxesByAccount: {}, selectedFolder: 'INBOX', view: 'folder', messages: [],
    selectedUid: null, selectedMessage: null, syncing: false, actionUid: null, error: null, query: '',
    compose: drafts.draft, composing: Boolean(drafts.draft), bodyOverride: null, sending: false, contacts: {}, canGoBack: false, canGoForward: false
  }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<EmailSnapshot>): void => {
    if (disposed) return
    state = { ...state, ...patch, canGoBack: historyIndex > 0, canGoForward: historyIndex < history.length - 1 }
    drafts.draft = state.compose
    for (const listener of listeners) listener()
  }
  const activeAccountIds = (): string[] => state.selectedAccountIds.length ? state.selectedAccountIds : state.accounts.map((account) => account.id)
  const updateTitle = (): void => api.workspace.setMainTabTitle(state.composing ? uiText('auto.47da6f0838f0')
    : state.selectedMessage?.subject || (state.view === 'folder' ? state.selectedFolder : uiText(`email.view.${state.view}`)))
  const pushHistory = (): void => {
    const entry: NavigationEntry = { accountId: state.selectedAccountId, accountIds: state.selectedAccountIds, folder: state.selectedFolder, view: state.view,
      message: state.selectedMessage ? { accountId: state.selectedMessage.accountId, folder: state.selectedMessage.folder, uid: state.selectedMessage.uid } : null }
    if (JSON.stringify(entry) === JSON.stringify(history[historyIndex])) return
    history = [...history.slice(0, historyIndex + 1), entry].slice(-30)
    historyIndex = history.length - 1
    set({})
  }
  const resolveContacts = async (): Promise<void> => {
    const generation = ++contactRequest
    const provider = api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0]
    if (!provider) { set({ contacts: {} }); return }
    const messages = [...state.messages, ...(state.selectedMessage ? [state.selectedMessage] : [])]
    const addresses = [...new Set([...messages.flatMap((message) => Object.values(message.addresses).flat()), ...(state.compose ? [...state.compose.to, ...state.compose.cc, ...state.compose.bcc] : [])].map((item) => item.address.trim().toLowerCase()))]
    const contacts: EmailSnapshot['contacts'] = {}
    for (let offset = 0; offset < addresses.length; offset += 200) {
      const result = await provider.invoke('resolveEmails', [addresses.slice(offset, offset + 200)])
      if (generation !== contactRequest || disposed) return
      if (!result.ok) { set({ contacts: {} }); return }
      for (const entry of result.value as { address: string; contacts: ContactDirectoryEntry[] }[]) contacts[entry.address] = entry.contacts
    }
    if (generation === contactRequest) set({ contacts })
  }
  const report = (error: unknown): void => set({ error: error instanceof Error ? error.message : String(error) })
  const messageQuery = (append = false) => ({ accountId: state.selectedAccountId!, view: state.view, folder: state.selectedFolder,
    accountIds: activeAccountIds(), query: state.query, cursor: append ? state.cursor : undefined })
  function loadMessages(append = false): Promise<void> {
    const accountIds = activeAccountIds()
    if (!state.selectedAccountId || !accountIds.length || (append && (!state.cursor || state.loadingMessages))) return Promise.resolve()
    const input = messageQuery(append)
    const key = JSON.stringify(input)
    if (pendingMessages?.key === key && pendingMessages.revision === messageRevision && pendingMessages.token === requestId) return pendingMessages.promise
    const token = ++requestId
    set({ loadingMessages: true })
    const promise = read()
    pendingMessages = { key, revision: messageRevision, token, promise }
    const clear = (): void => { if (pendingMessages?.token === token) pendingMessages = null }
    void promise.then(clear, clear)
    return promise
    async function read(): Promise<void> {
      try {
        const result = await mailApi(api).queryMessages(input)
        if (token !== requestId || disposed) return
        if (!result.ok || !result.data) throw new Error(result.error || uiText('email.loadFailed'))
        const messages = append ? [...state.messages, ...result.data.messages.filter((message) => !state.messages.some((current) => current.id === message.id))] : result.data.messages
        set({ messages, cursor: result.data.cursor, loadingMessages: false })
        void resolveContacts()
      } catch (error) {
        if (token === requestId) { set({ loadingMessages: false }); report(error) }
      }
    }
  }
  type FolderResult = { accountId: string; result: Awaited<ReturnType<ReturnType<typeof mailApi>['listFolders']>> }
  const readFolders = (accountIds: string[]): Promise<FolderResult[]> => Promise.all(accountIds.map(async (accountId) => {
    try { return { accountId, result: await mailApi(api).listFolders(accountId) } }
    catch (error) { return { accountId, result: { ok: false, error: error instanceof Error ? error.message : String(error) } } }
  }))
  async function refreshFolders(accountIds = activeAccountIds(), loaded?: FolderResult[]): Promise<void> {
    const selected = [...new Set(accountIds)]
    const selection = JSON.stringify(selected)
    const generation = ++folderRequest
    try {
      const results = loaded ?? await readFolders(selected)
      if (JSON.stringify(activeAccountIds()) !== selection || generation !== folderRequest || disposed) return
      const mailboxesByAccount: Record<string, EmailMailbox[]> = {}
      const merged = new Map<string, EmailMailbox>()
      const errors: string[] = []
      for (const { accountId, result } of results) {
        if (!result.ok || !result.data) {
          errors.push(`${state.accounts.find((account) => account.id === accountId)?.address || accountId}: ${result.error || uiText('email.loadFailed')}`)
          continue
        }
        const mailboxes = result.data.mailboxes.length ? result.data.mailboxes.filter((mailbox) => mailbox.selectable)
          : result.data.folders.map((path) => ({ path, name: path, selectable: true, cachedTotal: 0, cachedUnread: 0 }))
        mailboxesByAccount[accountId] = mailboxes
        for (const mailbox of mailboxes) {
          const current = merged.get(mailbox.path)
          merged.set(mailbox.path, current ? { ...current, cachedTotal: current.cachedTotal + mailbox.cachedTotal, cachedUnread: current.cachedUnread + mailbox.cachedUnread }
            : { ...mailbox })
        }
      }
      const mailboxes = [...merged.values()]
      set({ mailboxes, mailboxesByAccount, folders: mailboxes.map((mailbox) => mailbox.path) })
      if (errors.length) report(errors.join('\n'))
    } catch (error) { if (JSON.stringify(activeAccountIds()) === selection && generation === folderRequest) report(error) }
  }
  async function refreshAccounts(): Promise<void> {
    const generation = ++accountRequest
    try {
      const result = await mailApi(api).listAccounts()
      if (disposed || generation !== accountRequest) return
      if (!result.ok || !result.data) throw new Error(result.error || uiText('email.loadFailed'))
      const accounts = result.data.accounts
      const selectedAccountIds = state.selectedAccountIds.filter((id) => accounts.some((account) => account.id === id))
      const selectedAccountId = accounts.some((account) => account.id === state.selectedAccountId) ? state.selectedAccountId : accounts[0]?.id ?? null
      if (JSON.stringify(selectedAccountIds) !== JSON.stringify(state.selectedAccountIds) || selectedAccountId !== state.selectedAccountId) {
        ++detailId; ++requestId; ++folderRequest; ++contactRequest
        set({ selectedMessage: null, selectedUid: null, loadingMessage: false, messages: [], contacts: {} })
      }
      set({ loading: false, accounts, selectedAccountId, selectedAccountIds })
      if (selectedAccountId) await Promise.all([loadMessages(), refreshFolders()])
      else set({ messages: [], selectedMessage: null, selectedUid: null, mailboxes: [], mailboxesByAccount: {}, folders: [] })
      if (!history.length) pushHistory()
    } catch (error) { if (generation === accountRequest) { set({ loading: false }); report(error) } }
  }
  async function selectView(view: EmailMailboxView, folder = state.selectedFolder): Promise<void> {
    ++detailId
    clearTimeout(queryTimer)
    set({ view, selectedFolder: folder, query: '', selectedMessage: null, selectedUid: null,
      loadingMessage: false, messages: [], cursor: undefined, error: null })
    updateTitle()
    pushHistory()
    await loadMessages()
  }
  async function selectAccount(accountId: string): Promise<void> {
    await selectAccounts([accountId])
  }
  async function selectAccounts(accountIds: string[]): Promise<void> {
    const wanted = new Set(accountIds)
    const selectedAccountIds = state.accounts.map((account) => account.id).filter((id) => wanted.has(id))
    if (JSON.stringify(selectedAccountIds) === JSON.stringify(state.selectedAccountIds)) return
    ++detailId; ++requestId; ++folderRequest; ++contactRequest
    const selectedAccountId = selectedAccountIds[0] ?? (state.accounts.some((account) => account.id === state.selectedAccountId) ? state.selectedAccountId : state.accounts[0]?.id ?? null)
    set({ selectedAccountId, selectedAccountIds, mailboxes: [], mailboxesByAccount: {}, folders: [], contacts: {},
      selectedMessage: null, selectedUid: null, loadingMessage: false, messages: [] })
    await Promise.all([selectView(state.view, state.selectedFolder), refreshFolders()])
  }
  async function readSelected(ref: EmailMessageRef, recordHistory = true): Promise<void> {
    const token = ++detailId
    const summary = state.messages.find((message) => messageKey(message) === messageKey(ref))
    set({ selectedUid: ref.uid, selectedMessage: summary ?? null, loadingMessage: true, composing: false })
    try {
      const result = await mailApi(api).readMessage(ref)
      if (token !== detailId || disposed) return
      if (!result.ok) throw new Error(result.error || uiText('email.loadFailed'))
      const message = result.data?.message ?? null
      if (!message) throw new Error(uiText('email.selectionMissing'))
      set({ selectedMessage: message, selectedUid: message?.uid ?? null, bodyOverride: null, loadingMessage: false })
      updateTitle()
      if (recordHistory) pushHistory()
      void resolveContacts()
      if (message && !message.flags.includes('\\Seen')) void act(message, 'mark-read')
    } catch (error) { if (token === detailId) { set({ loadingMessage: false }); report(error) } }
  }
  function openMessage(input: EmailMessageRef | null): void {
    if (input === null) { ++detailId; set({ selectedMessage: null, selectedUid: null, composing: false }); updateTitle(); return }
    void readSelected(input)
  }
  async function act(ref: EmailMessageRef, action: EmailMessageAction): Promise<boolean> {
    if (state.actionUid !== null) return false
    const key = messageKey(ref)
    const previous = state.selectedMessage
    const generation = detailId
    set({ actionUid: ref.uid, error: null })
    try {
      const result = await mailApi(api).applyMessageAction({ accountId: ref.accountId, folder: ref.folder, uid: ref.uid, action })
      if (!result.ok) throw new Error(result.error || uiText('email.actionFailed'))
      ++messageRevision
      if (generation === detailId && previous && messageKey(previous) === key) {
        if (action === 'trash' || action === 'archive' || action === 'junk') {
          set({ selectedMessage: null, selectedUid: null })
          history = history.filter((entry) => !entry.message || messageKey(entry.message) !== key)
          historyIndex = Math.min(historyIndex, history.length - 1)
        } else {
          const changed = result.data?.messages.find((message) => message.uid === ref.uid)
          if (changed) set({ selectedMessage: { ...previous, ...changed } })
        }
      }
      if (activeAccountIds().includes(ref.accountId)) await loadMessages()
      updateTitle()
      return true
    } catch (error) { report(error); return false }
    finally { set({ actionUid: null }) }
  }
  async function sync(): Promise<void> {
    const accountIds = activeAccountIds()
    if (!accountIds.length || disposed) return
    if (state.syncing) { syncAgain = true; return }
    const view = state.view
    const selectedFolder = state.selectedFolder
    const selection = JSON.stringify(accountIds)
    const isCurrent = (): boolean => !disposed && JSON.stringify(activeAccountIds()) === selection && state.view === view && state.selectedFolder === selectedFolder
    set({ syncing: true, error: null })
    syncMessageRefresh.clear()
    try {
      await refreshFolders(accountIds)
      const errors: string[] = []
      for (const accountId of accountIds) {
        if (!isCurrent()) break
        const mailboxes = state.mailboxesByAccount[accountId] ?? []
        const folders = view === 'folder' ? mailboxes.length && !mailboxes.some((mailbox) => mailbox.path === selectedFolder) ? [] : [selectedFolder]
          : mailboxes.length ? mailboxes.filter((mailbox) => !['\\Trash', '\\Junk', '\\Drafts'].includes(mailbox.specialUse ?? '')).map((mailbox) => mailbox.path) : ['INBOX']
        for (const folder of folders) {
          if (!isCurrent()) break
          try {
            const result = await mailApi(api).syncFolder(accountId, folder, Math.min(500, Number(api.settings.get().syncLimit) || 50))
            if (!result.ok) throw new Error(result.error || uiText('email.syncFailed'))
          } catch (error) {
            errors.push(`${state.accounts.find((account) => account.id === accountId)?.address || accountId}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      if (isCurrent()) {
        await (syncMessageRefresh.get(JSON.stringify([messageRevision, requestId, messageQuery()])) ?? loadMessages())
        if (errors.length) report(errors.join('\n'))
      }
    } catch (error) { if (isCurrent()) report(error) }
    finally {
      syncMessageRefresh.clear()
      set({ syncing: false })
      if (syncAgain) { syncAgain = false; await sync() }
    }
  }
  async function allowDiscard(): Promise<boolean> {
    if (!state.compose?.dirty) return true
    return await api.ui.confirm({ title: uiText('email.discardTitle'), message: uiText('email.discardMessage'), actions: [
      { label: uiText('auto.77dfd2135f4d'), value: 'cancel', variant: 'ghost' },
      { label: uiText('email.discard'), value: 'discard', variant: 'danger' }
    ] }) === 'discard'
  }
  async function startCompose(mode: ComposeDraft['mode'] = 'new', message?: CachedMessage): Promise<void> {
    if (state.sending) return
    if (mode === 'new' && state.compose) { set({ composing: true }); updateTitle(); return }
    const previousDraft = state.compose
    if (!await allowDiscard() || !state.selectedAccountId || state.compose !== previousDraft) return
    const accountId = message && 'accountId' in message && typeof message.accountId === 'string' ? message.accountId : state.selectedAccountId
    let to: EmailAddress[] = []
    let cc: EmailAddress[] = []
    let subject = ''
    let text = ''
    if (message) {
      const own = state.accounts.find((account) => account.id === accountId)?.address.toLowerCase()
      const replying = mode === 'reply' || mode === 'reply-all'
      if (replying) {
        const parsed = await mailApi(api).parseAddresses(message.replyTo || message.from)
        const sender = parsed.data?.addresses ?? []
        const fromOwn = sender.some((entry) => entry.address.toLowerCase() === own)
        const recipients = fromOwn || mode === 'reply-all' ? await mailApi(api).parseAddresses(message.to) : undefined
        to = fromOwn ? recipients?.data?.addresses ?? [] : sender
        if (mode === 'reply-all') {
          const copied = await mailApi(api).parseAddresses(message.cc || '')
          const seen = new Set(state.accounts.map((account) => account.address.trim().toLowerCase()))
          const unique = (addresses: EmailAddress[]): EmailAddress[] => addresses.filter((entry) => {
            const key = entry.address.trim().toLowerCase()
            if (!key || seen.has(key)) return false
            seen.add(key)
            return true
          })
          to = unique([...to, ...(recipients?.data?.addresses ?? [])])
          cc = unique(copied.data?.addresses ?? [])
        }
      }
      subject = /^(re|fw|fwd):/i.test(message.subject) ? message.subject : `${replying ? 'Re' : 'Fwd'}: ${message.subject}`
      text = `\n\n${message.from} · ${new Date(message.date).toLocaleString(api.ui.language())}\n${(message.text || message.snippet).split('\n').map((line) => `> ${line}`).join('\n')}`
    }
    if (state.compose !== previousDraft || disposed) return
    set({ composing: true, compose: { id: ++draftSequence, accountId, mode, to, cc, bcc: [], pending: { to: '', cc: '', bcc: '' }, subject, text,
      inReplyTo: mode === 'reply' || mode === 'reply-all' ? message?.messageId : undefined, dirty: false }, error: null })
    updateTitle()
  }
  function updateDraft(patch: Partial<ComposeDraft>): void {
    if (state.compose && !state.sending) {
      set({ compose: { ...state.compose, ...patch, id: state.compose.id, dirty: true } })
      if (patch.to || patch.cc || patch.bcc) void resolveContacts()
    }
  }
  function saveDraft(): void {
    if (!state.compose || state.sending) return
    set({ composing: false })
    updateTitle()
  }
  async function cancelCompose(): Promise<void> {
    const draft = state.compose
    if (state.sending || !await allowDiscard() || state.compose !== draft) return
    set({ compose: null, composing: false })
    updateTitle()
  }
  async function send(): Promise<boolean> {
    const draft = state.compose
    if (!draft || state.sending || !draft.to.length || Object.values(draft.pending).some((value) => value.trim())) return false
    if (!state.accounts.some((account) => account.id === draft.accountId)) { set({ error: uiText('email.senderUnavailable') }); return false }
    set({ sending: true, error: null })
    try {
      const result = await mailApi(api).sendEmail({ accountId: draft.accountId, to: formatAddresses(draft.to), cc: formatAddresses(draft.cc),
        bcc: formatAddresses(draft.bcc), subject: draft.subject, text: draft.text, inReplyTo: draft.inReplyTo })
      if (!result.ok) throw new Error(result.error || uiText('email.sendFailed'))
      ++messageRevision
      set({ compose: null, composing: false })
      updateTitle()
      void loadMessages()
      return true
    } catch (error) { report(error); return false }
    finally { set({ sending: false }) }
  }
  async function goHistory(delta: number): Promise<boolean> {
    const next = historyIndex + delta
    if (next < 0 || next >= history.length) return false
    const entry = history[next]
    if (!await restoreSelection({ accountIds: entry.accountIds, folder: entry.folder, view: entry.view, ...(entry.message ? { message: entry.message } : {}) }, false)) return false
    historyIndex = next
    set({})
    return true
  }
  async function restoreSelection(selection: EmailSelection, recordHistory = true): Promise<boolean> {
    await whenReady
    const generation = ++detailId
    const requested = selection.accountIds.length ? selection.accountIds : state.accounts.map((account) => account.id)
    if (requested.some((id) => !state.accounts.some((account) => account.id === id))) throw new Error(uiText('email.error.accountMissing'))
    if (!requested.length) {
      if (selection.message) throw new Error(uiText('email.error.accountMissing'))
      return true
    }
    let message: EmailMessageDetail | null = null
    if (selection.message) {
      if (!requested.includes(selection.message.accountId)) throw new Error(uiText('email.error.outsideAccount'))
      const result = await mailApi(api).readMessage(selection.message)
      if (!result.ok) throw new Error(result.error || uiText('email.error.readMessage'))
      if (!result.data?.message) throw new Error(uiText('email.error.messageMissing'))
      message = result.data.message
    }
    let folders: FolderResult[] | undefined
    if (selection.view === 'folder') {
      folders = await readFolders(requested)
      if (folders.some(({ result }) => !result.ok)) throw new Error(uiText('email.error.loadMailbox'))
      if (!folders.some(({ result }) => result.data?.folders.includes(selection.folder) || result.data?.mailboxes.some((mailbox) => mailbox.path === selection.folder && mailbox.selectable))) throw new Error(uiText('email.error.folderMissing'))
    }
    if (generation !== detailId || disposed) return false
    clearTimeout(queryTimer)
    set({ selectedAccountIds: selection.accountIds, selectedAccountId: requested[0], view: selection.view, selectedFolder: selection.folder, query: selection.query ?? '',
      selectedMessage: message, selectedUid: message?.uid ?? null, bodyOverride: null, loadingMessage: false, composing: false, messages: [], cursor: undefined, error: null })
    await Promise.all([loadMessages(), refreshFolders(requested, folders)])
    if (generation !== detailId || disposed) return false
    updateTitle()
    if (recordHistory) pushHistory()
    return true
  }
  const offContacts = api.interop.services.subscribe(CONTACTS_DIRECTORY_V1, () => { void resolveContacts() })
  const offContactRevision = api.interop.state.subscribe(CONTACTS_DIRECTORY_REVISION_V1, () => { void resolveContacts() })
  const offSync = mailApi(api).onSync((event) => {
    if (activeAccountIds().includes(event.accountId) && event.status === 'done') {
      ++messageRevision
      const refresh = loadMessages()
      const key = JSON.stringify([messageRevision, requestId, messageQuery()])
      if (state.syncing) syncMessageRefresh.set(key, refresh)
    }
  })
  const offSettings = api.settings.subscribe(() => set({ bodyOverride: null }))
  const whenReady = refreshAccounts()
  return {
    whenReady,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => state,
    dispose: () => { disposed = true; ++requestId; ++detailId; ++contactRequest; clearTimeout(queryTimer); offContacts(); offContactRevision(); offSync(); offSettings(); listeners.clear() },
    refreshAccounts, selectAccount, selectAccounts, selectView, selectFolder: (folder) => selectView('folder', folder), loadMore: () => loadMessages(true),
    openMessage, sync, act, setPlainText: (message, htmlContent, plainText) => set({ bodyOverride: { key: messageKey(message), htmlContent, plainText } }), dismissError: () => set({ error: null }),
    setQuery: (query) => {
      ++requestId; ++detailId; clearTimeout(queryTimer)
      set({ query, messages: [], cursor: undefined, selectedMessage: null, selectedUid: null, loadingMessage: false })
      queryTimer = setTimeout(() => { void loadMessages() }, 180)
    },
    startCompose, updateDraft, saveDraft, cancelCompose, send,
    removeAccount: async (accountId) => {
      const result = await mailApi(api).removeAccount(accountId)
      if (!result.ok) { report(result.error || uiText('email.actionFailed')); return }
      await refreshAccounts()
    },
    goBack: () => goHistory(-1), goForward: () => goHistory(1), restoreSelection
  }
}

export function getStore(): EmailStore {
  const holder = api.runtime.getOrCreate<{ current: EmailStore | null }>('email.store', () => ({ current: null }))
  if (!holder.current) holder.current = createStore()
  return holder.current
}

export function disposeStore(): void {
  const holder = api.runtime.getOrCreate<{ current: EmailStore | null }>('email.store', () => ({ current: null }))
  holder.current?.dispose()
  holder.current = null
}
