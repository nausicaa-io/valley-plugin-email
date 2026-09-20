import type { EmailDriver, EmailMessageAction, EmailMessageRef } from './mailTypes'
import type { EmailSnapshot } from './store'
import { uiText } from './localization'

interface MessagePorts {
  snapshot(): EmailSnapshot
  active(): boolean
  activeAccountIds(): string[]
  set(patch: Partial<EmailSnapshot>): void
  report(error: unknown): void
  updateTitle(): void
  pushHistory(): void
  removeFromHistory(key: string): void
  resolveContacts(): Promise<void>
}

export const messageKey = (message: EmailMessageRef): string => JSON.stringify([message.accountId, message.folder, message.uid])

export function createMessageController(mail: EmailDriver, ports: MessagePorts) {
  let requestId = 0
  let messageRevision = 0
  let pendingMessages: { key: string; revision: number; token: number; promise: Promise<void> } | null = null
  let detailId = 0
  const messageQuery = (append = false) => ({ accountId: ports.snapshot().selectedAccountId!, view: ports.snapshot().view, folder: ports.snapshot().selectedFolder,
    accountIds: ports.activeAccountIds(), query: ports.snapshot().query, cursor: append ? ports.snapshot().cursor : undefined })
  function loadMessages(append = false): Promise<void> {
    const accountIds = ports.activeAccountIds()
    if (!ports.active() || !ports.snapshot().selectedAccountId || !accountIds.length || (append && (!ports.snapshot().cursor || ports.snapshot().loadingMessages))) return Promise.resolve()
    const input = messageQuery(append)
    const key = JSON.stringify(input)
    if (pendingMessages?.key === key && pendingMessages.revision === messageRevision && pendingMessages.token === requestId) return pendingMessages.promise
    const token = ++requestId
    ports.set({ loadingMessages: true })
    const promise = read()
    pendingMessages = { key, revision: messageRevision, token, promise }
    const clear = (): void => { if (pendingMessages?.token === token) pendingMessages = null }
    void promise.then(clear, clear)
    return promise
    async function read(): Promise<void> {
      try {
        const result = await mail.queryMessages(input)
        if (token !== requestId || !ports.active()) return
        if (!result.ok || !result.data) throw new Error(result.error || uiText('email.loadFailed'))
        const messages = append ? [...ports.snapshot().messages, ...result.data.messages.filter((message) => !ports.snapshot().messages.some((current) => current.id === message.id))] : result.data.messages
        ports.set({ messages, cursor: result.data.cursor, loadingMessages: false })
        void ports.resolveContacts()
      } catch (error) {
        if (token === requestId) { ports.set({ loadingMessages: false }); ports.report(error) }
      }
    }
  }
  async function readSelected(ref: EmailMessageRef, recordHistory = true): Promise<void> {
    const token = ++detailId
    const summary = ports.snapshot().messages.find((message) => messageKey(message) === messageKey(ref))
    ports.set({ selectedUid: ref.uid, selectedMessage: summary ?? null, loadingMessage: true, composing: false })
    try {
      const result = await mail.readMessage(ref)
      if (token !== detailId || !ports.active()) return
      if (!result.ok) throw new Error(result.error || uiText('email.loadFailed'))
      const message = result.data?.message ?? null
      if (!message) throw new Error(uiText('email.selectionMissing'))
      ports.set({ selectedMessage: message, selectedUid: message?.uid ?? null, bodyOverride: null, loadingMessage: false })
      ports.updateTitle()
      if (recordHistory) ports.pushHistory()
      void ports.resolveContacts()
      if (message && !message.flags.includes('\\Seen')) void act(message, 'mark-read')
    } catch (error) { if (token === detailId) { ports.set({ loadingMessage: false }); ports.report(error) } }
  }
  function openMessage(input: EmailMessageRef | null): void {
    if (!ports.active()) return
    if (input === null) { ++detailId; ports.set({ selectedMessage: null, selectedUid: null, composing: false }); ports.updateTitle(); return }
    void readSelected(input)
  }
  async function act(ref: EmailMessageRef, action: EmailMessageAction): Promise<boolean> {
    if (!ports.active() || ports.snapshot().actionUid !== null) return false
    const key = messageKey(ref)
    const previous = ports.snapshot().selectedMessage
    const generation = detailId
    ports.set({ actionUid: ref.uid, error: null })
    try {
      const result = await mail.applyMessageAction({ accountId: ref.accountId, folder: ref.folder, uid: ref.uid, action })
      if (!result.ok) throw new Error(result.error || uiText('email.actionFailed'))
      if (!ports.active()) return true
      ++messageRevision
      if (generation === detailId && previous && messageKey(previous) === key) {
        if (action === 'trash' || action === 'archive' || action === 'junk') {
          ports.set({ selectedMessage: null, selectedUid: null })
          ports.removeFromHistory(key)
        } else {
          const changed = result.data?.messages.find((message) => message.uid === ref.uid)
          if (changed) ports.set({ selectedMessage: { ...previous, ...changed } })
        }
      }
      if (ports.activeAccountIds().includes(ref.accountId)) await loadMessages()
      ports.updateTitle()
      return true
    } catch (error) { ports.report(error); return false }
    finally { ports.set({ actionUid: null }) }
  }
  return {
    loadMessages, openMessage, act,
    invalidateDetail: () => ++detailId,
    invalidateSelection: () => { ++detailId; ++requestId },
    invalidateMessages: () => { ++messageRevision },
    selectionVersion: () => detailId,
    queryKey: () => JSON.stringify([messageRevision, requestId, messageQuery()])
  }
}
