/**
 * ```email``` code block — recent inbox messages embedded in a note.
 *
 *   ```email
 *   from: alice@example.com    (substring match on sender)
 *   subject: invoice           (substring match)
 *   unread: true
 *   limit: 5
 *   ```
 *
 * Rows open the message in the Email page.
 */
import codeBlockExamples from './codeBlockExamples.json'
import { React, api } from './runtime'
import type { FC } from 'react'
import type { EmailMessageRef } from './mailTypes'
import type { CachedMessage } from './mailTypes'
import { fenceInt, parseFenceParams } from '@valley/plugin-sdk/fenceParams'
import { getStore } from './store'
import { uiText } from './localization'

const STYLE_ID = 'notes-email-fence-styles'

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.email-fence { margin: 0.75em 0; border: 1px solid var(--border-light); border-radius: var(--radius); background: var(--container-color); overflow: hidden; }
.email-fence-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--border-light); cursor: pointer; }
.email-fence-head .t { font-weight: 600; color: var(--title-color); }
.email-fence-head .c { font-size: var(--small-font-size); color: var(--text-secondary); }
.email-fence-row { padding: 7px 12px; cursor: pointer; border-bottom: 1px solid var(--border-light); }
.email-fence-row:last-child { border-bottom: none; }
.email-fence-row:hover { background: var(--hover-bg); }
.email-fence-row .top { display: flex; gap: 8px; align-items: baseline; }
.email-fence-row .from { flex: none; max-width: 40%; font-weight: 500; color: var(--text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.email-fence-row.unread .from { font-weight: 700; color: var(--title-color); }
.email-fence-row .subject { flex: 1; min-width: 0; color: var(--text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.email-fence-row .date { flex: none; font-size:0.6875rem; color: var(--text-secondary); }
.email-fence-row .snippet { margin-top: 1px; font-size: var(--small-font-size); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.email-fence-empty { padding: 10px 12px; color: var(--text-secondary); font-size: var(--small-font-size); }
`
  document.head.appendChild(style)
}

const isUnread = (message: CachedMessage): boolean => !message.flags.includes('\\Seen')

export function filterFenceMessages<T extends CachedMessage>(
  messages: T[],
  from: string | null,
  subject: string | null,
  unread: boolean,
  limit: number
): T[] {
  const wantedFrom = from?.toLowerCase() ?? null
  const wantedSubject = subject?.toLowerCase() ?? null
  return messages
    .filter((message) => {
      if (wantedFrom && !message.from.toLowerCase().includes(wantedFrom)) return false
      if (wantedSubject && !message.subject.toLowerCase().includes(wantedSubject)) return false
      if (unread && !isUnread(message)) return false
      return true
    })
    .slice(0, limit)
}

const dateLabel = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(api.ui.language(), { day: 'numeric', month: 'short' })
}

const EmailFence: FC<{ code: string }> = ({ code }) => {
  const store = getStore()
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  const params = parseFenceParams(code)
  const limit = fenceInt(params, 'limit', 50) ?? 5

  const open = (message: EmailMessageRef | null): void => {
    if (message !== null) store.openMessage(message)
    api.workspace.openMainTab()
  }

  if (snap.accounts.length === 0) {
    return <div className="email-fence-empty">{uiText('auto.45866d6e437a')}</div>
  }

  const shown = filterFenceMessages(
    snap.messages,
    params.values.from ?? null,
    params.values.subject ?? params.bare ?? null,
    (params.values.unread ?? '').toLowerCase() === 'true',
    limit
  )

  return (
    <>
      <div className="email-fence-head" onClick={() => open(null)} title={uiText('auto.aa14c20ab180')}>
        <span className="t">{uiText('auto.be36d4779772')}{' '}{snap.selectedFolder}</span>
        <span className="c">
          {snap.syncing ? uiText('auto.f8b9f13e52cc') : uiText('auto.3791d49b494b', { p0: shown.length })}
        </span>
      </div>
      {shown.length === 0 && <div className="email-fence-empty">{uiText('auto.6cb4e8e1b080')}</div>}
      {shown.map((message) => (
        <div
          key={message.id}
          className={`email-fence-row ${isUnread(message) ? 'unread' : ''}`}
          onClick={() => open(message)}
          title={message.subject}
        >
          <div className="top">
            <span className="from">{message.from.replace(/<.*>/, '').trim() || message.from}</span>
            <span className="subject">{message.subject || uiText('auto.49b20da0bf73')}</span>
            <span className="date">{dateLabel(message.date)}</span>
          </div>
          {message.snippet && <div className="snippet">{message.snippet}</div>}
        </div>
      ))}
    </>
  )
}

/** Register the ```email``` fence; returns the unregister fn. */
export function registerEmailFence(): () => void {
  const off = api.markdown.registerCodeBlockRenderer('email', (code, el) => {
    ensureStyles()
    el.classList.add('email-fence')
    return api.ui.renderReact(el, <EmailFence code={code} />)
  }, { examples: codeBlockExamples.email })
  return () => {
    off()
    document.getElementById(STYLE_ID)?.remove()
  }
}
