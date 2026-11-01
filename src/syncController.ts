import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { EmailMailbox, EmailMailboxView } from './mailTypes'
import { mailApi } from './mailApi'
import { uiText } from './localization'

interface SyncScope { accountIds: string[]; view: EmailMailboxView; folder: string }
interface SyncPorts {
  scope(): SyncScope
  folders(accountId: string): EmailMailbox[]
  accountLabel(accountId: string): string
  refreshFolders(accountIds: string[]): Promise<void>
  refreshMessages(): Promise<void>
  messageKey(): string
  setSyncing(syncing: boolean): void
  report(error: unknown): void
}

/** A folder synced this recently (by this view or by the backend's own poll) is not synced again just because a view opened. */
export const FRESH_SYNC_MS = 60_000
const freshKey = (accountId: string, folder: string): string => JSON.stringify([accountId, folder])

export function createSyncController(api: ValleyPluginApi, ports: SyncPorts, mail = mailApi(api)) {
  const synced = new Map<string, number>()
  let active = true
  let again = false
  let pending: Promise<void> | undefined
  let draining: Promise<void> | undefined
  let latestRefresh: { key: string; promise: Promise<void> } | undefined
  const run = async (): Promise<void> => {
    while (active && again) {
      again = false
      const scope = ports.scope()
      if (!scope.accountIds.length) continue
      const identity = JSON.stringify(scope)
      const current = (): boolean => active && JSON.stringify(ports.scope()) === identity
      ports.setSyncing(true)
      latestRefresh = undefined
      try {
        await ports.refreshFolders(scope.accountIds)
        const errors: string[] = []
        for (const accountId of scope.accountIds) {
          if (!current()) break
          const mailboxes = ports.folders(accountId)
          const folders = scope.view === 'folder' ? mailboxes.length && !mailboxes.some((mailbox) => mailbox.path === scope.folder) ? [] : [scope.folder]
            : mailboxes.length ? mailboxes.filter((mailbox) => !['\\Trash', '\\Junk', '\\Drafts'].includes(mailbox.specialUse ?? '')).map((mailbox) => mailbox.path) : ['INBOX']
          for (const folder of folders) {
            if (!current()) break
            try {
              const result = await mail.syncFolder(accountId, folder, Math.min(500, Number(api.settings.get().syncLimit) || 50))
              if (!result.ok) throw new Error(result.error || uiText('email.syncFailed'))
              synced.set(freshKey(accountId, folder), Date.now())
            } catch (error) {
              errors.push(`${ports.accountLabel(accountId)}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        if (current()) {
          const refresh = latestRefresh as { key: string; promise: Promise<void> } | undefined
          await (refresh?.key === ports.messageKey() ? refresh.promise : ports.refreshMessages())
          if (current() && errors.length) ports.report([...new Set(errors)].join('\n'))
        }
      } catch (error) { if (current()) ports.report(error) }
      finally {
        latestRefresh = undefined
        if (active) ports.setSyncing(false)
      }
    }
  }
  const sync = (): Promise<void> => {
    if (!active) return draining ?? Promise.resolve()
    again = true
    if (!pending) pending = Promise.resolve().then(run).finally(() => {
      pending = undefined
      if (active && again) return sync()
    })
    return pending
  }
  const syncIfStale = (now = Date.now()): Promise<void> => {
    const scope = ports.scope()
    const fresh = scope.view === 'folder' && scope.accountIds.length > 0
      && scope.accountIds.every((accountId) => now - (synced.get(freshKey(accountId, scope.folder)) ?? Number.NEGATIVE_INFINITY) < FRESH_SYNC_MS)
    return fresh ? pending ?? Promise.resolve() : sync()
  }
  return {
    sync,
    syncIfStale,
    noteSynced(accountId: string, folder: string, at = Date.now()): void { synced.set(freshKey(accountId, folder), at) },
    recordRefresh(key: string, promise: Promise<void>): void { if (active && pending) latestRefresh = { key, promise } },
    dispose(): Promise<void> {
      if (draining) return draining
      active = false
      again = false
      latestRefresh = undefined
      draining = pending ?? Promise.resolve()
      return draining
    }
  }
}
