import type { EmailDriver, EmailMailboxView, EmailMessageDetail, EmailMessageRef } from './mailTypes'
import type { EmailSelection, EmailSnapshot } from './store'
import type { createAccountsController } from './accountsController'
import { messageKey, type createMessageController } from './messageController'
import { uiText } from './localization'

interface MailboxPorts {
  snapshot(): EmailSnapshot
  active(): boolean
  set(patch: Partial<EmailSnapshot>): void
  updateTitle(): void
  clearContacts(): void
  whenReady(): Promise<void>
  accounts: ReturnType<typeof createAccountsController>
  messages: ReturnType<typeof createMessageController>
}

type NavigationEntry = { accountId: string | null; accountIds: string[]; folder: string; view: EmailMailboxView; message: EmailMessageRef | null }

export function createMailboxController(mail: EmailDriver, ports: MailboxPorts) {
  let history: NavigationEntry[] = []
  let historyIndex = -1
  let queryTimer: ReturnType<typeof setTimeout> | undefined
  const pushHistory = (): void => {
    const state = ports.snapshot()
    const entry: NavigationEntry = { accountId: state.selectedAccountId, accountIds: state.selectedAccountIds, folder: state.selectedFolder, view: state.view,
      message: state.selectedMessage ? { accountId: state.selectedMessage.accountId, folder: state.selectedMessage.folder, uid: state.selectedMessage.uid } : null }
    if (JSON.stringify(entry) === JSON.stringify(history[historyIndex])) return
    history = [...history.slice(0, historyIndex + 1), entry].slice(-30)
    historyIndex = history.length - 1
    ports.set({})
  }
  async function selectView(view: EmailMailboxView, folder = ports.snapshot().selectedFolder): Promise<void> {
    if (!ports.active()) return
    ports.messages.invalidateDetail()
    clearTimeout(queryTimer)
    ports.set({ view, selectedFolder: folder, query: '', selectedMessage: null, selectedUid: null,
      loadingMessage: false, messages: [], cursor: undefined, error: null })
    ports.updateTitle()
    pushHistory()
    await ports.messages.loadMessages()
  }
  async function selectAccount(accountId: string): Promise<void> {
    await selectAccounts([accountId])
  }
  async function selectAccounts(accountIds: string[]): Promise<void> {
    if (!ports.active()) return
    const wanted = new Set(accountIds)
    const selectedAccountIds = ports.snapshot().accounts.map((account) => account.id).filter((id) => wanted.has(id))
    if (JSON.stringify(selectedAccountIds) === JSON.stringify(ports.snapshot().selectedAccountIds)) return
    ports.messages.invalidateSelection(); ports.accounts.invalidateFolders(); ports.clearContacts()
    const selectedAccountId = selectedAccountIds[0] ?? (ports.snapshot().accounts.some((account) => account.id === ports.snapshot().selectedAccountId) ? ports.snapshot().selectedAccountId : ports.snapshot().accounts[0]?.id ?? null)
    ports.set({ selectedAccountId, selectedAccountIds, mailboxes: [], mailboxesByAccount: {}, folders: [], contacts: {},
      selectedMessage: null, selectedUid: null, loadingMessage: false, messages: [] })
    await Promise.all([selectView(ports.snapshot().view, ports.snapshot().selectedFolder), ports.accounts.refreshFolders()])
  }
  async function goHistory(delta: number): Promise<boolean> {
    const next = historyIndex + delta
    if (next < 0 || next >= history.length) return false
    const entry = history[next]
    if (!await restoreSelection({ accountIds: entry.accountIds, folder: entry.folder, view: entry.view, ...(entry.message ? { message: entry.message } : {}) }, false)) return false
    historyIndex = next
    ports.set({})
    return true
  }
  async function restoreSelection(selection: EmailSelection, recordHistory = true): Promise<boolean> {
    await ports.whenReady()
    if (!ports.active()) return false
    const generation = ports.messages.invalidateDetail()
    const requested = selection.accountIds.length ? selection.accountIds : ports.snapshot().accounts.map((account) => account.id)
    if (requested.some((id) => !ports.snapshot().accounts.some((account) => account.id === id))) throw new Error(uiText('email.error.accountMissing'))
    if (!requested.length) {
      if (selection.message) throw new Error(uiText('email.error.accountMissing'))
      return true
    }
    let message: EmailMessageDetail | null = null
    if (selection.message) {
      if (!requested.includes(selection.message.accountId)) throw new Error(uiText('email.error.outsideAccount'))
      const result = await mail.readMessage(selection.message)
      if (!ports.active() || generation !== ports.messages.selectionVersion()) return false
      if (!result.ok) throw new Error(result.error || uiText('email.error.readMessage'))
      if (!result.data?.message) throw new Error(uiText('email.error.messageMissing'))
      message = result.data.message
    }
    let folders: Awaited<ReturnType<typeof ports.accounts.readFolders>> | undefined
    if (selection.view === 'folder') {
      folders = await ports.accounts.readFolders(requested)
      if (folders.some(({ result }) => !result.ok)) throw new Error(uiText('email.error.loadMailbox'))
      if (!folders.some(({ result }) => result.data?.folders.includes(selection.folder) || result.data?.mailboxes.some((mailbox) => mailbox.path === selection.folder && mailbox.selectable))) throw new Error(uiText('email.error.folderMissing'))
    }
    if (generation !== ports.messages.selectionVersion() || !ports.active()) return false
    clearTimeout(queryTimer)
    ports.set({ selectedAccountIds: selection.accountIds, selectedAccountId: requested[0], view: selection.view, selectedFolder: selection.folder, query: selection.query ?? '',
      selectedMessage: message, selectedUid: message?.uid ?? null, bodyOverride: null, loadingMessage: false, composing: false, messages: [], cursor: undefined, error: null })
    await Promise.all([ports.messages.loadMessages(), ports.accounts.refreshFolders(requested, folders)])
    if (generation !== ports.messages.selectionVersion() || !ports.active()) return false
    ports.updateTitle()
    if (recordHistory) pushHistory()
    return true
  }
  return {
    selectAccount, selectAccounts, selectView, restoreSelection, pushHistory,
    initialHistory: () => { if (!history.length) pushHistory() },
    goBack: () => goHistory(-1), goForward: () => goHistory(1),
    historyState: () => ({ canGoBack: historyIndex > 0, canGoForward: historyIndex < history.length - 1 }),
    removeFromHistory(key: string): void {
      history = history.filter((entry) => !entry.message || messageKey(entry.message) !== key)
      historyIndex = Math.min(historyIndex, history.length - 1)
    },
    setQuery(query: string): void {
      if (!ports.active()) return
      ports.messages.invalidateSelection(); clearTimeout(queryTimer)
      ports.set({ query, messages: [], cursor: undefined, selectedMessage: null, selectedUid: null, loadingMessage: false })
      queryTimer = setTimeout(() => { void ports.messages.loadMessages() }, 180)
    },
    dispose: () => clearTimeout(queryTimer)
  }
}
