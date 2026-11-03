import type { BundledPluginTranslationCatalogs, ValleyPluginApi } from '@valley/plugin-sdk'
import en from '../locales/en.json'
import de from '../locales/de.json'
import es from '../locales/es.json'
import fr from '../locales/fr.json'
import zhCN from '../locales/zh-CN.json'
import type { EmailMailbox } from './mailTypes'

const catalogs = { en, de, es, fr, 'zh-CN': zhCN } satisfies BundledPluginTranslationCatalogs

function english(key: string, params?: Parameters<ValleyPluginApi['ui']['t']>[1]): string {
  const fallback = (catalogs.en as Record<string, string>)[key] ?? key
  return fallback.replace(/\{\{([^}]+)\}\}/g, (_match: string, name: string) => String(params?.[name] ?? ''))
}

let translate: ValleyPluginApi['ui']['t'] = english

export function initLocalization(api: ValleyPluginApi): void {
  api.ui.registerCatalogs(catalogs)
  translate = (key, params) => {
    const value = api.ui.t(key, params)
    return value === key ? english(key, params) : value
  }
}

export function uiText(key: string, params?: Parameters<ValleyPluginApi['ui']['t']>[1]): string {
  return translate(key, params)
}

/** A mailbox's display name: the translated name of a special-use mailbox (INBOX → Inbox), else its own name. */
export function folderLabel(mailbox: Pick<EmailMailbox, 'path' | 'name' | 'specialUse'>): string {
  const kind = mailbox.specialUse?.replace('\\', '').toLowerCase() || (mailbox.path.toUpperCase() === 'INBOX' ? 'inbox' : '')
  return ['inbox', 'sent', 'drafts', 'archive', 'all', 'trash', 'junk', 'flagged'].includes(kind) ? uiText(`email.folder.${kind}`) : mailbox.name || mailbox.path
}

/**
 * A folder's display name in the accounts a selection names (all accounts when it names none): their loaded mailboxes
 * first, then the account's cached mailbox list, so a tab or panel of another account shows that account's name.
 */
export async function accountFolderLabel(api: Pick<ValleyPluginApi, 'data'>, loaded: Record<string, EmailMailbox[]>, accountIds: string[], folder: string): Promise<string> {
  const known = loadedFolderLabel(loaded, accountIds, folder)
  if (known !== undefined) return known
  try {
    const where = accountIds.length ? { accountId: { in: accountIds.slice(0, 100) }, path: folder } : { path: folder }
    const row = (await api.data.dataset('mailboxes').query({ where, limit: 1 })).rows[0]
    if (row) return folderLabel({ path: folder, name: typeof row.name === 'string' ? row.name : folder, ...(typeof row.specialUse === 'string' ? { specialUse: row.specialUse } : {}) })
  } catch { /* The cached list is unavailable: the folder's own name stands. */ }
  return folderLabel({ path: folder, name: folder })
}

/** The display name from the loaded mailboxes of the named accounts, when one of them has the folder. */
export function loadedFolderLabel(loaded: Record<string, EmailMailbox[]>, accountIds: string[], folder: string): string | undefined {
  for (const accountId of accountIds) {
    const mailbox = loaded[accountId]?.find((entry) => entry.path === folder)
    if (mailbox) return folderLabel(mailbox)
  }
  return undefined
}
