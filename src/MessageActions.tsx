import { mailApi } from './mailApi'
import type { UiMenuItem } from '@valley/plugin-sdk'
import type { EmailMessageDetail, EmailMessageSummary } from './mailTypes'
import type { CachedMessage } from './mailTypes'
import { api, React } from './runtime'
import { getStore, messageKey } from './store'
import { readEmailDisplaySettings } from './hooks'
import { Archive, Eye, EyeOff, Flag, Forward, Junk, Reply, ReplyAll, Trash } from './icons'
import { uiText } from './localization'

export async function confirmTrash(message: CachedMessage): Promise<boolean> {
  return await api.ui.confirm({ title: uiText('auto.253157581e26'), message: message.subject, actions: [
    { label: uiText('auto.77dfd2135f4d'), value: 'cancel', variant: 'ghost' },
    { label: uiText('auto.dffd3b9a8af6'), value: 'trash', variant: 'danger' }
  ] }) === 'trash'
}

export function messageMenu(message: EmailMessageSummary | EmailMessageDetail): UiMenuItem[] {
  const store = getStore()
  const snap = store.getSnapshot()
  const seen = message.flags.includes('\\Seen')
  const flagged = message.flags.includes('\\Flagged')
  const ready = snap.actionUid === null && !snap.sending
  const mailboxes = snap.mailboxesByAccount[message.accountId] ?? []
  const compose = async (mode: 'reply' | 'reply-all' | 'forward'): Promise<void> => {
    const result = await mailApi(api).readMessage(message)
    if (!result.ok || !result.data?.message) return
    await store.startCompose(mode, result.data.message)
    api.workspace.openMainTab()
  }
  const { htmlContent } = readEmailDisplaySettings(message.accountId)
  const plainText = snap.bodyOverride?.key === messageKey(message) && snap.bodyOverride.htmlContent === htmlContent ? snap.bodyOverride.plainText : !htmlContent
  return [
    { id: 'reply', label: uiText('auto.6c2bb735a46a'), icon: <Reply />, enabled: ready, onSelect: () => compose('reply') },
    { id: 'reply-all', label: uiText('email.replyAll'), icon: <ReplyAll />, enabled: ready, onSelect: () => compose('reply-all') },
    { id: 'forward', label: uiText('auto.ba4e72261283'), icon: <Forward />, enabled: ready, onSelect: () => compose('forward') },
    { id: 'read', label: uiText(seen ? 'auto.623bab0e0954' : 'auto.3bf98fa618b6'), icon: seen ? <EyeOff /> : <Eye />, enabled: ready,
      onSelect: () => store.act(message, seen ? 'mark-unread' : 'mark-read') },
    { id: 'flag', label: uiText(flagged ? 'auto.b855c604e861' : 'auto.a774409a00c2'), icon: <Flag filled={flagged} />, enabled: ready,
      onSelect: () => store.act(message, flagged ? 'unflag' : 'flag') },
    { id: 'archive', label: uiText('auto.2621c6fd51a5'), icon: <Archive />, enabled: ready && mailboxes.some((mailbox) => ['\\Archive', '\\All'].includes(mailbox.specialUse ?? '') && mailbox.path !== message.folder),
      onSelect: () => store.act(message, 'archive') },
    { id: 'junk', label: uiText('email.moveToJunk'), icon: <Junk />, enabled: ready && mailboxes.some((mailbox) => mailbox.specialUse === '\\Junk' && mailbox.path !== message.folder),
      onSelect: () => store.act(message, 'junk') },
    { id: 'trash', label: uiText('auto.dffd3b9a8af6'), icon: <Trash />, danger: true, enabled: ready && mailboxes.some((mailbox) => mailbox.specialUse === '\\Trash' && mailbox.path !== message.folder),
      onSelect: async () => { if (await confirmTrash(message)) await store.act(message, 'trash') } },
    ...('html' in message && message.html ? [{ id: 'body-format', label: uiText(plainText ? 'email.showHtml' : 'email.showText'), icon: <Eye />, enabled: true,
      onSelect: () => store.setPlainText(message, htmlContent, !plainText) }] : [])
  ]
}

export const MessageActions: React.FC<{ message: EmailMessageDetail; compact?: boolean }> = ({ message, compact = false }) => {
  const items = messageMenu(message)
  const flagged = message.flags.includes('\\Flagged')
  const groups = [['reply', 'reply-all', 'forward'], ['flag'], ['junk', 'trash']]
  return <div className={`email-message-actions${compact ? ' compact' : ''}`}>
    {groups.map((group, index) => <div className="email-action-group" key={index}>
      {group.map((id) => {
        const item = items.find((candidate) => candidate.id === id)!
        return <button key={id} className={`email-icon-btn${id === 'flag' && flagged ? ' email-flagged' : ''}`} title={item.label} aria-label={item.label}
          aria-pressed={id === 'flag' ? flagged : undefined} disabled={!item.enabled} onClick={() => { void item.onSelect?.() }}>{item.icon}</button>
      })}

    </div>)}
  </div>
}
