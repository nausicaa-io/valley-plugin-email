import { EmailFilterControls, ClassificationStatus, useSmartGroups } from './Organization'
import { descendantIds, findGroupPath, flattenGroups } from './smartGroups'
import { React, api, opensInNewTab } from './runtime'
import type { EmailAccount, EmailMailbox } from './mailTypes'
import type { EmailMailboxView } from './mailTypes'
import { useEmail } from './hooks'
import { ErrorNotice } from './Notice'
import { Archive, ChevronDown, EyeOff, Flag, Google, Inbox, Mail, Microsoft, Plus, Reload, Search, Send, Trash, Paperclip, Filter, Tag } from './icons'
import type { SmartGroupsConfig } from './smartGroups'
import type { EmailMessageSummary } from './mailTypes'
import { SwipeRow } from './SwipeRow'
import { ContactAvatar, contactName } from './People'
import { folderLabel, uiText } from './localization'
import { formatEmailListDate, formatEmailTimestamp, messageKey, type ComposeDraft, type EmailSnapshot } from './store'
import { useEmailDateFormat } from './hooks'
import { emailTabs, revealEmailTab } from './tabs'

export function AccountIcon({ account }: { account: EmailAccount }): React.ReactElement {
  return account.provider === 'google' ? <Google /> : account.provider === 'microsoft' ? <Microsoft /> : <Mail />
}
export function FolderIcon({ mailbox }: { mailbox: EmailMailbox }): React.ReactElement {
  if (mailbox.specialUse === '\\Inbox' || mailbox.path.toUpperCase() === 'INBOX') return <Inbox />
  if (mailbox.specialUse === '\\Sent') return <Send />
  if (['\\Archive', '\\All'].includes(mailbox.specialUse ?? '')) return <Archive />
  if (mailbox.specialUse === '\\Trash') return <Trash />
  if (mailbox.specialUse === '\\Flagged') return <Flag />
  return <Mail />
}
export { folderLabel }

/** The account's Drafts mailbox: its special-use folder, else a folder named Drafts. */
export function draftsMailbox(mailboxes: EmailMailbox[]): EmailMailbox | undefined {
  return mailboxes.find((mailbox) => mailbox.specialUse === '\\Drafts')
    ?? mailboxes.find((mailbox) => /^drafts?$/i.test((mailbox.delimiter ? mailbox.path.split(mailbox.delimiter).pop() : mailbox.name) || mailbox.name))
}
/** Whether the mailbox list shows the local draft: in the Drafts mailbox of the draft's account (its Inbox when it has none), matching the search. */
export function showsDraft(snap: Pick<EmailSnapshot, 'compose' | 'view' | 'group' | 'selectedFolder' | 'selectedAccountIds' | 'accounts' | 'mailboxesByAccount' | 'query'>): snap is typeof snap & { compose: ComposeDraft } {
  const draft = snap.compose
  if (!draft || snap.view !== 'folder' || snap.group || !snap.accounts.some((account) => account.id === draft.accountId)) return false
  if (snap.selectedAccountIds.length && !snap.selectedAccountIds.includes(draft.accountId)) return false
  const mailboxes = snap.mailboxesByAccount[draft.accountId] ?? []
  const home = draftsMailbox(mailboxes) ?? mailboxes.find((mailbox) => mailbox.specialUse === '\\Inbox' || mailbox.path.toUpperCase() === 'INBOX')
  if (home?.path !== snap.selectedFolder) return false
  const query = snap.query.trim().toLowerCase()
  return !query || [draft.subject, draft.text, ...[...draft.to, ...draft.cc, ...draft.bcc].flatMap((entry) => [entry.name, entry.address])].some((value) => value.toLowerCase().includes(query))
}
// A draft's id is the time it was started; ids from before that rule may not be one.
const draftDate = (draft: ComposeDraft): string | null => draft.id >= Date.UTC(2000, 0, 1) && draft.id <= Date.now() + 86_400_000 ? new Date(draft.id).toISOString() : null

/** The local draft as the first entry of its account's Drafts mailbox; opening it shows it in the current Email tab. */
const DraftEntry: React.FC<{ draft: ComposeDraft }> = ({ draft }) => {
  const { store, snap } = useEmail()
  const { dateFormat, timeFormat } = useEmailDateFormat()
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc]
  const names = recipients.map((entry) => contactName(entry, snap.contacts)).join(', ') || uiText('email.noRecipients')
  const subject = draft.subject || uiText('email.noSubject')
  const date = draftDate(draft)
  const label = uiText('email.draftLabel')
  return <div className={`email-swipe-row email-draft-entry${snap.composing ? ' active' : ''}`}>
    <button type="button" className="email-swipe-content email-draft-open" disabled={snap.sending} aria-label={`${label}: ${subject}, ${names}`}
      onClick={() => { void store.startCompose().then(revealEmailTab) }}>
      <div className="email-message-row">
        <span className="email-message-avatar"><ContactAvatar address={recipients[0]} label={names} contacts={snap.contacts} /></span>
        <div className="email-message-copy">
          <div className="email-message-top"><strong title={recipients.map((entry) => entry.address).join(', ')}>{names}</strong>
            <span className="email-draft-label">{label}</span>
            {date && <time title={formatEmailTimestamp(date, dateFormat, timeFormat, api.ui.language(), true)}>{formatEmailListDate(date, dateFormat, api.ui.language())}</time>}</div>
          <div className="email-message-subject">{subject}</div>
          <div className="email-message-snippet">{draft.text.split('\n').find((line) => line.trim())?.trim() ?? ''}</div>
        </div>
      </div>
    </button>
  </div>
}

// Row pitch in the list: the row's fixed height and its 1px separator; a row with tags adds a 26px tag row.
const CARD_PITCH = 97
const TAGGED_CARD_PITCH = 123

/** The tags a message card shows under its preview: its smart group, then VIP, flagged and attachments. */
function messageTags(message: EmailMessageSummary, config: SmartGroupsConfig): { key: string; label: string; icon?: React.ReactElement; primary?: boolean }[] {
  const group = config.enabled && message.categoryId ? findGroupPath(config.accounts[message.accountId]?.groups ?? [], message.categoryId) : undefined
  return [
    ...(group ? [{ key: 'group', label: group.map((item) => item.name || '…').join(' / '), primary: true }] : []),
    ...(message.isVip ? [{ key: 'vip', label: uiText('email.filter.vip') }] : []),
    ...(message.flags.includes('\\Flagged') ? [{ key: 'flagged', label: uiText('auto.f8db8a172be6'), icon: <Flag filled /> }] : []),
    ...(message.hasAttachments ? [{ key: 'attachments', label: uiText('email.attachments'), icon: <Paperclip /> }] : [])
  ]
}

export const AccountPopover: React.FC = () => {
  const { store, snap } = useEmail()
  const selectedIds = snap.selectedAccountIds.length ? snap.selectedAccountIds : snap.accounts.map((account) => account.id)
  const allSelected = selectedIds.length === snap.accounts.length
  const selectedRows = snap.accounts.map((account) => selectedIds.includes(account.id))
  const selectionRunClass = (active: boolean, index: number): string => active
    ? ` active${!selectedRows[index - 1] ? ' selection-run-start' : ''}${!selectedRows[index + 1] ? ' selection-run-end' : ''}`
    : ''
  const toggleAccount = (accountId: string): void => {
    const next = selectedIds.includes(accountId)
      ? selectedIds.filter((id) => id !== accountId)
      : [...selectedIds, accountId]
    if (next.length) void store.selectAccounts(next)
  }
  return <div className="email-account-popover email-account-picker">
    <div className="email-account-picker-head"><span className="email-account-picker-title">{uiText('auto.225300411395')}</span>
      <button className="email-account-picker-all" disabled={allSelected} onClick={() => { void store.selectAccounts([]) }}>
        {uiText('email.selectAll')}
      </button>
    </div>
    <div className="email-account-picker-list">
    {snap.accounts.map((account, index) => {
      const active = selectedRows[index]
      return <button key={account.id} aria-pressed={active} disabled={active && selectedIds.length === 1} className={`email-account-picker-option${selectionRunClass(active, index)}`} onClick={() => { toggleAccount(account.id) }}>
      <span className="email-account-check" aria-hidden="true">{active ? '✓' : ''}</span>
      <AccountIcon account={account} /><span className="email-account-copy"><strong>{account.displayName || account.address}</strong>
      {account.displayName && <small>{account.address}</small>}</span>
      </button>
    })}</div>
  </div>
}

const smartViews: { view: EmailMailboxView; Icon: React.ComponentType }[] = [
  { view: 'recent', Icon: Mail }, { view: 'unread', Icon: EyeOff }, { view: 'flagged', Icon: Flag }
]
const GroupOptions: React.FC<{ close(): void }> = ({ close }) => {
  const { store, snap } = useEmail()
  const config = useSmartGroups()
  const selected = snap.selectedAccountIds.length ? snap.selectedAccountIds : snap.accounts.map((account) => account.id)
  const accounts = config.enabled ? snap.accounts.filter((account) => selected.includes(account.id) && config.accounts[account.id]?.groups.length) : []
  const accountKey = accounts.map((account) => account.id).join('\u0000')
  const [counts, setCounts] = React.useState<Record<string, Record<string, number>>>({})
  React.useEffect(() => {
    if (!accountKey) return
    let active = true
    const messages = api.data.dataset('messages')
    const load = (): void => { void Promise.all(accountKey.split('\u0000').map(async (accountId) => [accountId, Object.fromEntries((await messages.aggregate({
      where: { accountId, categoryId: { isNull: false }, exists: { dataset: 'folder_messages', on: { id: 'messageId', accountId: 'accountId' }, where: { excluded: false } } }, groupBy: ['categoryId'], metrics: { count: { operation: 'count' } }
    })).map((row) => [String(row.categoryId), Number(row.count)]))] as const)).then((entries) => { if (active) setCounts(Object.fromEntries(entries)) }, () => {}) }
    load()
    const off = messages.subscribe(load)
    return () => { active = false; off() }
  }, [accountKey])
  if (!accounts.length) return null
  return <>
    <div className="email-popover-separator" /><div className="email-popover-label">{uiText('email.smartGroups.groups')}</div>
    {accounts.map((account) => <div key={account.id} role="group" aria-label={account.displayName || account.address}>
      {accounts.length > 1 && <div className="email-popover-sublabel">{account.displayName || account.address}</div>}
      {flattenGroups(config.accounts[account.id].groups).map((entry) => {
        const active = snap.group?.accountId === account.id && snap.group.groupId === entry.group.id
        const count = descendantIds(entry.group).reduce((sum, id) => sum + (counts[account.id]?.[id] ?? 0), 0)
        return <button key={entry.group.id} role="menuitemradio" aria-checked={active} className={`email-account-option email-group-option${active ? ' selected' : ''}`} style={{ paddingInlineStart: 8 + entry.depth * 16 }}
          onClick={() => { void store.selectGroup(account.id, entry.group.id); close() }}>
          <span className="email-account-check">{active ? '✓' : ''}</span><Tag /><span className="email-row-label">{entry.group.name || '…'}</span><small>{count}</small>
        </button>
      })}
    </div>)}
  </>
}

export const FolderPopover: React.FC<{ close(): void }> = ({ close }) => {
  const { store, snap } = useEmail()
  const grouped = Boolean(snap.group)
  return <div className="email-account-popover">
    <div className="email-popover-label">{uiText('email.mailboxes')}</div>
    {smartViews.map(({ view, Icon }) => <button key={view} role="menuitemradio" aria-checked={snap.view === view && !grouped}
      className={`email-account-option${snap.view === view && !grouped ? ' selected' : ''}`} onClick={() => { void store.selectView(view); close() }}>
      <span className="email-account-check">{snap.view === view && !grouped ? '✓' : ''}</span><Icon /><span>{uiText(`email.view.${view}`)}</span>
    </button>)}
    <div className="email-popover-separator" /><div className="email-popover-label">{uiText('auto.19adc47be34b')}</div>
    {snap.mailboxes.map((mailbox) => {
      const active = snap.view === 'folder' && snap.selectedFolder === mailbox.path
      return <button key={mailbox.path} role="menuitemradio" aria-checked={active} className={`email-account-option${active ? ' selected' : ''}`}
        onClick={() => { void store.selectFolder(mailbox.path); close() }}>
        <span className="email-account-check">{active ? '✓' : ''}</span><FolderIcon mailbox={mailbox} />
        <span className="email-row-label">{folderLabel(mailbox)}</span>{mailbox.cachedUnread > 0 && <small>{mailbox.cachedUnread}</small>}
      </button>
    })}
    <GroupOptions close={close} />
  </div>
}

export const MailboxControls: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { store, snap } = useEmail()
  const [expanded, setExpanded] = React.useState<'accounts' | 'folders' | 'filters' | null>(null)
  const panelId = React.useId()
  const trigger = React.useRef<HTMLButtonElement | null>(null)
  const toggle = (section: 'accounts' | 'folders' | 'filters', button: HTMLButtonElement): void => {
    trigger.current = button
    setExpanded(current => current === section ? null : section)
  }
  const close = (): void => { setExpanded(null); trigger.current?.focus() }
  const account = snap.accounts.find((candidate) => candidate.id === snap.selectedAccountId)
  const mailbox = snap.mailboxes.find((candidate) => candidate.path === snap.selectedFolder)
  const config = useSmartGroups()
  const group = snap.group ? findGroupPath(config.accounts[snap.group.accountId]?.groups ?? [], snap.group.groupId) : undefined
  const label = group ? group.map((item) => item.name || '…').join(' / ') : snap.view === 'folder' ? mailbox ? folderLabel(mailbox) : snap.selectedFolder : uiText(`email.view.${snap.view}`)
  const accountLabel = snap.selectedAccountIds.length === 0 || snap.selectedAccountIds.length === snap.accounts.length ? uiText('email.allAccounts')
    : snap.selectedAccountIds.length === 1 ? account?.displayName || account?.address
      : uiText('email.selectedAccounts', { count: snap.selectedAccountIds.length })
  // A toolbar button focused by a pointer press shows no focus ring; keyboard focus does (drawn inside the button).
  const bar = React.useRef<HTMLDivElement | null>(null)
  const focusSource = (source: 'pointer' | 'keyboard'): void => {
    for (const button of bar.current?.querySelectorAll<HTMLButtonElement>('button') ?? []) {
      if (source === 'pointer') button.dataset.focusSource = 'pointer'
      else delete button.dataset.focusSource
    }
  }
  return <><div ref={bar} className={`email-mailbox-controls${compact ? ' compact' : ''}`} onPointerDownCapture={() => focusSource('pointer')} onKeyDownCapture={() => focusSource('keyboard')}
    onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close() } }}>
    <button className="email-selector email-account-selector" disabled={!account} title={accountLabel || uiText('auto.73e3e6e8e067')}
      aria-label={uiText('auto.73e3e6e8e067')} aria-expanded={expanded === 'accounts'} aria-controls={panelId} onClick={(event) => {
        toggle('accounts', event.currentTarget)
      }}>{account ? <AccountIcon account={account} /> : <Mail />}<span>{accountLabel}</span><ChevronDown /></button>
    <button className="email-selector" disabled={!account} title={label} aria-label={uiText('email.mailboxes')} aria-expanded={expanded === 'folders'} aria-controls={panelId} onClick={(event) => {
      toggle('folders', event.currentTarget)
    }}>{group ? <Tag /> : snap.view === 'folder' && mailbox ? <FolderIcon mailbox={mailbox} /> : snap.view === 'unread' ? <EyeOff /> : snap.view === 'flagged' ? <Flag /> : <Mail />}<span>{label}</span><ChevronDown /></button>
    <button className="email-icon-btn" title={uiText('email.filters')} aria-label={uiText('email.filters')} aria-expanded={expanded === 'filters'} aria-controls={panelId} onClick={event => toggle('filters', event.currentTarget)}><Filter /></button>
    <button className="email-icon-btn email-reload" title={uiText(snap.syncing ? 'email.reloading' : 'email.reload')} aria-label={uiText('email.reload')} aria-busy={snap.syncing} disabled={!account || snap.syncing} onClick={() => { void store.sync() }}><Reload /></button>
    <button className="email-icon-btn email-compose-action" title={uiText('auto.47da6f0838f0')} aria-label={uiText('auto.47da6f0838f0')} disabled={!account} onClick={() => {
      void store.startCompose().then(revealEmailTab)
    }}><Plus /></button>
  </div>{expanded && <section id={panelId} className="email-inline-options" aria-label={uiText(expanded === 'accounts' ? 'auto.225300411395' : expanded === 'filters' ? 'email.filters' : 'email.mailboxes')}
    onPointerDownCapture={() => focusSource('pointer')} onKeyDownCapture={() => focusSource('keyboard')}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); return }
      if (expanded === 'filters' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      if (!options.length) return
      event.preventDefault()
      const current = options.indexOf(event.target as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      options[next].focus()
    }}>
    {expanded === 'accounts' ? <AccountPopover /> : expanded === 'filters' ? <EmailFilterControls /> : <FolderPopover close={close} />}
  </section>}<ClassificationStatus /></>
}

export const Panel: React.FC = () => {
  const { store, snap } = useEmail()
  // The body is the one scroller: search, status and cards scroll together.
  const body = React.useRef<HTMLDivElement>(null)
  const list = React.useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = React.useState({ top: 0, height: 720 })
  React.useEffect(() => {
    const element = body.current
    const view = element?.ownerDocument.defaultView
    if (!element || !view) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      setViewport({ top: element.scrollTop - (list.current?.offsetTop ?? 0), height: element.clientHeight || 720 })
    }
    const schedule = (): void => { if (!frame) frame = view.requestAnimationFrame(measure) }
    const observer = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(schedule) : null
    observer?.observe(element)
    element.addEventListener('scroll', schedule, { passive: true })
    measure()
    return () => { observer?.disconnect(); element.removeEventListener('scroll', schedule); if (frame) view.cancelAnimationFrame(frame) }
  }, [snap.loading, snap.selectedAccountId])
  React.useEffect(() => {
    if (body.current) body.current.scrollTop = 0
    setViewport(current => ({ ...current, top: -(list.current?.offsetTop ?? 0) }))
  }, [snap.query, snap.view, snap.selectedFolder, snap.selectedAccountIds, snap.filters])
  const draft = showsDraft(snap) ? snap.compose : null
  const config = useSmartGroups()
  const tags = React.useMemo(() => snap.messages.map((message) => messageTags(message, config)), [snap.messages, config])
  // Each card's top within the list; the draft entry sits above the first message card.
  const tops = React.useMemo(() => {
    const result = [draft ? CARD_PITCH : 0]
    for (const entry of tags) result.push(result[result.length - 1] + (entry.length ? TAGGED_CARD_PITCH : CARD_PITCH))
    return result
  }, [tags, draft])
  const firstVisible = tops.findIndex((top, index) => index < snap.messages.length && tops[index + 1] > viewport.top)
  const first = Math.max(0, (firstVisible < 0 ? snap.messages.length : firstVisible) - 5)
  let last = first
  while (last < snap.messages.length && tops[last] < viewport.top + viewport.height) last++
  last = Math.min(snap.messages.length, last + 5)
  const { dateFormat, timeFormat } = useEmailDateFormat()
  const account = snap.accounts.find((candidate) => candidate.id === snap.selectedAccountId)
  const accountSelection = JSON.stringify(snap.selectedAccountIds.length ? snap.selectedAccountIds : snap.accounts.map((candidate) => candidate.id))
  React.useEffect(() => { void store.syncIfStale() }, [store, accountSelection, snap.view, snap.selectedFolder])
  return <div className="email-panel">
    <div className="panel-header"><span className="panel-title">{uiText('auto.84add5b29527')}</span></div>
    {!snap.loading && <div className="email-panel-toolbar">
      {account ? <MailboxControls compact /> : <button className="email-add-account" onClick={() => api.workspace.openOwnSettings()}><Plus />{uiText('auto.98b0ed858ae4')}</button>}
    </div>}
    <div ref={body} className="panel-body email-panel-body">
      <ErrorNotice onRetry={() => { void store.retry() }} />
      {snap.loading ? <api.ui.ContentLoader label={uiText('auto.33ce417454bf')} compact /> : account ? <>
        <div className="search-field-row">
          <label className="email-search search-field"><Search className="search-field-icon" /><input className="search-field-input" value={snap.query} aria-label={uiText('email.search')} onChange={(event) => store.setQuery(event.target.value)} placeholder={uiText('email.search')} /></label>
        </div>
        <div className="email-list-status"><span>{uiText('email.cachedMail')}</span><span>{snap.loadingMessages ? uiText('auto.33ce417454bf') : `${snap.messages.length}${snap.cursor ? '+' : ''}`}</span></div>
        <div ref={list} className="email-message-list" aria-busy={snap.loadingMessages}>
          {draft && <DraftEntry draft={draft} />}
          {!snap.loadingMessages && !snap.messages.length && !draft && (snap.syncing ? <api.ui.ContentLoader label={uiText('auto.33ce417454bf')} compact /> : <div className="email-empty">{uiText('auto.34e618e62f74')}</div>)}
          {first > 0 && <div aria-hidden="true" style={{ height: tops[first] - tops[0] }} />}
          {snap.messages.slice(first, last).map((message, offset) => {
            const messageTagList = tags[first + offset]
            const messageAccount = snap.accounts.find((candidate) => candidate.id === message.accountId)
            const fromOwn = message.addresses.from.some((entry) => entry.address.toLowerCase() === messageAccount?.address.toLowerCase())
            const person = (fromOwn ? message.addresses.to : message.addresses.from)[0]
            const sender = person ? contactName(person, snap.contacts) : message.from || message.to
            const selected = snap.selectedMessage && messageKey(snap.selectedMessage) === messageKey(message)
            return <SwipeRow key={message.id} message={message} className={selected ? 'active' : ''} onOpen={(event) => {
              if (opensInNewTab(event)) {
                emailTabs()?.openNew({ accountIds: [...snap.selectedAccountIds], view: snap.view, folder: snap.selectedFolder, query: snap.query, message: { accountId: message.accountId, folder: message.folder, uid: message.uid } }, message.subject || undefined)
                if (!message.flags.includes('\\Seen')) void store.act(message, 'mark-read', { wait: true })
                return
              }
              store.openMessage(message)
              revealEmailTab()
            }}>
              <div className={`email-message-row${message.flags.includes('\\Seen') ? '' : ' unread'}${messageTagList.length ? ' tagged' : ''}`}>
                <span className="email-message-avatar"><ContactAvatar address={person} label={sender} contacts={snap.contacts} /></span>
                <div className="email-message-copy">
                  <div className="email-message-top"><strong title={person?.address || message.from}>{sender}</strong>
                    {!message.flags.includes('\\Seen') && <span className="email-unread-dot" aria-label={uiText('auto.07b032b56f7a')} />}
                    <time title={formatEmailTimestamp(message.date, dateFormat, timeFormat, api.ui.language(), true)}>{formatEmailListDate(message.date, dateFormat, api.ui.language())}</time></div>
                  <div className="email-message-subject">{message.subject || uiText('email.noSubject')}</div>
                  <div className="email-message-snippet">{message.snippet}</div>
                  {messageTagList.length > 0 && <div className="email-message-tags">{messageTagList.map((tag) => <span key={tag.key} className={`email-tag${tag.primary ? ' primary' : ''}`} title={tag.label}>
                    {tag.icon}<span>{tag.label}</span>
                  </span>)}</div>}
                </div>
              </div>
            </SwipeRow>
          })}
          {last < snap.messages.length && <div aria-hidden="true" style={{ height: tops[snap.messages.length] - tops[last] }} />}
          {snap.cursor && <button className="email-load-more" disabled={snap.loadingMessages} onClick={() => { void store.loadMore() }}>{uiText('email.loadMore')}</button>}
        </div>
      </> : null}
    </div>
  </div>
}
