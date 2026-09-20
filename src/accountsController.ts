import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { EmailMailbox } from './mailTypes'
import type { EmailSnapshot } from './store'
import { mailApi } from './mailApi'
import { uiText } from './localization'

interface AccountPorts {
  snapshot(): Pick<EmailSnapshot, 'accounts' | 'selectedAccountId' | 'selectedAccountIds'>
  activeAccountIds(): string[]
  active(): boolean
  set(patch: Partial<EmailSnapshot>): void
  report(error: unknown): void
  invalidateSelection(): void
  refreshMessages(): Promise<void>
  initialHistory(): void
}

export function createAccountsController(api: ValleyPluginApi, ports: AccountPorts, mail = mailApi(api)) {
  let folderRequest = 0
  let accountRequest = 0
  type FolderResult = { accountId: string; result: Awaited<ReturnType<ReturnType<typeof mailApi>['listFolders']>> }
  const readFolders = (accountIds: string[]): Promise<FolderResult[]> => Promise.all(accountIds.map(async (accountId) => {
    try { return { accountId, result: await mail.listFolders(accountId) } }
    catch (error) { return { accountId, result: { ok: false, error: error instanceof Error ? error.message : String(error) } } }
  }))
  async function refreshFolders(accountIds = ports.activeAccountIds(), loaded?: FolderResult[]): Promise<void> {
    if (!ports.active()) return
    const selected = [...new Set(accountIds)]
    const selection = JSON.stringify(selected)
    const generation = ++folderRequest
    try {
      const results = loaded ?? await readFolders(selected)
      if (JSON.stringify(ports.activeAccountIds()) !== selection || generation !== folderRequest || !ports.active()) return
      const mailboxesByAccount: Record<string, EmailMailbox[]> = {}
      const merged = new Map<string, EmailMailbox>()
      const errors: string[] = []
      for (const { accountId, result } of results) {
        if (!result.ok || !result.data) {
          errors.push(`${ports.snapshot().accounts.find((account) => account.id === accountId)?.address || accountId}: ${result.error || uiText('email.loadFailed')}`)
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
      ports.set({ mailboxes, mailboxesByAccount, folders: mailboxes.map((mailbox) => mailbox.path) })
      if (errors.length) ports.report(errors.join('\n'))
    } catch (error) { if (JSON.stringify(ports.activeAccountIds()) === selection && generation === folderRequest) ports.report(error) }
  }
  async function refreshAccounts(): Promise<void> {
    if (!ports.active()) return
    const generation = ++accountRequest
    try {
      const result = await mail.listAccounts()
      if (!ports.active() || generation !== accountRequest) return
      if (!result.ok || !result.data) throw new Error(result.error || uiText('email.loadFailed'))
      const accounts = result.data.accounts
      const selectedAccountIds = ports.snapshot().selectedAccountIds.filter((id) => accounts.some((account) => account.id === id))
      const selectedAccountId = accounts.some((account) => account.id === ports.snapshot().selectedAccountId) ? ports.snapshot().selectedAccountId : accounts[0]?.id ?? null
      if (JSON.stringify(selectedAccountIds) !== JSON.stringify(ports.snapshot().selectedAccountIds) || selectedAccountId !== ports.snapshot().selectedAccountId) {
        ++folderRequest; ports.invalidateSelection()
        ports.set({ selectedMessage: null, selectedUid: null, loadingMessage: false, messages: [], contacts: {} })
      }
      ports.set({ loading: false, accounts, selectedAccountId, selectedAccountIds })
      if (selectedAccountId) await Promise.all([ports.refreshMessages(), refreshFolders()])
      else ports.set({ messages: [], selectedMessage: null, selectedUid: null, mailboxes: [], mailboxesByAccount: {}, folders: [] })
      ports.initialHistory()
    } catch (error) { if (generation === accountRequest) { ports.set({ loading: false }); ports.report(error) } }
  }
  return { readFolders, refreshFolders, refreshAccounts, invalidateFolders: () => { folderRequest++ } }
}
