import { mailApi } from './mailApi'
import { CONTACTS_DIRECTORY_V1, CONTACTS_DIRECTORY_REVISION_V1, type ContactDirectoryEntry } from '@valley/plugin-sdk'
import type { EmailAddress } from './mailTypes'
import { React, api } from './runtime'
import { useEmail } from './hooks'
import { Person } from './People'
import { Plus, Search, Send } from './icons'
import { uiText } from './localization'

type RecipientKind = 'to' | 'cc' | 'bcc'
const kindLabel = (kind: RecipientKind): string => kind === 'to' ? uiText('auto.ae79ea1e9c63') : kind === 'cc' ? 'Cc' : 'Bcc'

function RecipientPicker({ kind, close }: { kind: RecipientKind; close(): void }): React.ReactElement {
  const { store, snap } = useEmail()
  const draft = snap.compose
  const query = draft?.pending[kind] ?? ''
  const [results, setResults] = React.useState<{ contact: ContactDirectoryEntry; email: EmailAddress; label?: string }[]>([])
  const [active, setActive] = React.useState(0)
  const [error, setError] = React.useState('')
  const [revision, setRevision] = React.useState(0)
  const [parsing, setParsing] = React.useState(false)
  const listId = React.useId()
  React.useEffect(() => {
    const refresh = (): void => setRevision((value) => value + 1)
    const offService = api.interop.services.subscribe(CONTACTS_DIRECTORY_V1, refresh)
    const offRevision = api.interop.state.subscribe(CONTACTS_DIRECTORY_REVISION_V1, refresh)
    return () => { offService(); offRevision() }
  }, [])
  React.useEffect(() => {
    let live = true
    setResults([]); setActive(0)
    const timer = setTimeout(() => {
      const provider = api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0]
      if (!provider || !query.trim()) return
      void provider.invoke('search', [query, 20]).then((response) => {
        if (!live || !response.ok) return
        setResults((response.value as ContactDirectoryEntry[]).flatMap((contact) => contact.emails.map((email) => ({
          contact, email: { name: contact.displayName, address: email.address }, label: email.label
        }))))
      })
    }, 120)
    return () => { live = false; clearTimeout(timer) }
  }, [query, revision])
  const add = (addresses: EmailAddress[]): void => {
    const current = store.getSnapshot().compose
    if (!current || current.id !== draft?.id) return
    const seen = new Set(current[kind].map((entry) => entry.address.toLowerCase()))
    const next = [...current[kind]]
    for (const address of addresses) if (!seen.has(address.address.toLowerCase())) { seen.add(address.address.toLowerCase()); next.push(address) }
    store.updateDraft({ [kind]: next, pending: { ...current.pending, [kind]: '' } })
    close()
  }
  const commit = async (value = query): Promise<void> => {
    if (!value.trim() || parsing) return
    setParsing(true); setError('')
    try {
      const response = await mailApi(api).parseAddresses(value.replace(/[\r\n]+/g, ','))
      if (!response.ok || !response.data?.addresses.length) { setError(uiText('email.invalidRecipient')); return }
      add(response.data.addresses)
    } finally { setParsing(false) }
  }
  return <div className="email-recipient-popover">
    <div className="email-popover-label">{kindLabel(kind)}</div>
    <label className="email-search search-field"><Search className="search-field-icon" /><input className="search-field-input" autoFocus role="combobox" aria-label={uiText('email.recipientSearch')} aria-expanded={results.length > 0}
      aria-controls={listId} aria-activedescendant={results.length ? `${listId}-${active}` : undefined} autoComplete="off" value={query}
      placeholder={uiText('email.recipientSearch')} disabled={parsing || snap.sending}
      onChange={(event) => { if (draft) store.updateDraft({ pending: { ...draft.pending, [kind]: event.target.value } }); setError('') }}
      onPaste={(event) => {
        const value = event.clipboardData.getData('text')
        if (/[,;\r\n]/.test(value)) { event.preventDefault(); if (draft) store.updateDraft({ pending: { ...draft.pending, [kind]: value } }); void commit(value) }
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, Math.min(results.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)))) }
        if (event.key === 'Enter') { event.preventDefault(); if (results[active]) add([results[active].email]); else void commit() }
      }} /></label>
    <div id={listId} role="listbox" className="email-recipient-results" aria-label={uiText('email.contacts')}>
      {results.map(({ contact, email, label }, index) => <button key={`${contact.id}-${email.address}`} id={`${listId}-${index}`} role="option" aria-selected={index === active}
        className={`email-account-option${index === active ? ' selected' : ''}`} onClick={() => add([email])}>
        {contact.avatarUrl && <img className="email-avatar" src={contact.avatarUrl} alt="" />}
        <span className="email-account-copy"><strong>{contact.displayName}</strong><small>{email.address}{label ? ` · ${label}` : ''}</small></span>
      </button>)}
    </div>
    {error && <div className="email-recipient-error" role="alert">{error}</div>}
    <button className="email-btn" disabled={!query.trim() || parsing || snap.sending} onClick={() => { void commit() }}><Plus />{uiText('email.addAddress')}</button>
  </div>
}

function RecipientField({ kind }: { kind: RecipientKind }): React.ReactElement {
  const { store, snap } = useEmail()
  const draft = snap.compose!
  return <div className="email-recipient-field"><span className="email-field-label">{kindLabel(kind)}</span><div className="email-recipient-chips">
    {draft[kind].map((address) => <span className="email-recipient-chip" key={address.address.toLowerCase()}><Person address={address} />
      <button disabled={snap.sending} aria-label={`${uiText('email.removeRecipient')} ${address.address}`} onClick={() => store.updateDraft({ [kind]: draft[kind].filter((entry) => entry !== address) })}>×</button></span>)}
    <button className="email-recipient-add" disabled={snap.sending} aria-label={`${uiText('email.addRecipient')} ${kindLabel(kind)}`} onClick={(event) => {
      void api.ui.openPopover(({ close }) => <RecipientPicker kind={kind} close={close} />, { anchor: event.currentTarget }, { ariaLabel: uiText('email.recipientSearch') })
    }}>{draft.pending[kind] || uiText('email.recipientSearch')}</button>
  </div></div>
}

export const Compose: React.FC = () => {
  const { store, snap } = useEmail()
  const draft = snap.compose!
  const sender = snap.accounts.find((account) => account.id === draft.accountId)
  const SelectField = api.ui.settings.SelectField
  return <div className="email-form">
    <header className="email-compose-header"><h2>{uiText(draft.mode === 'reply-all' ? 'email.replyAll' : draft.mode === 'reply' ? 'auto.6c2bb735a46a' : draft.mode === 'forward' ? 'auto.ba4e72261283' : 'auto.1ed2e7b50fa1')}</h2>
      <div className="email-form-actions"><button className="email-btn primary" disabled={snap.sending || !sender || !draft.to.length || Object.values(draft.pending).some((value) => value.trim())} onClick={() => { void store.send() }}>
        <Send />{uiText(snap.sending ? 'auto.cf765512cc6d' : 'auto.9bc2575c3930')}</button>
        <button className="email-btn" disabled={snap.sending} onClick={() => { void store.saveDraft() }}>{uiText('email.saveDraft')}</button>
        <button className="email-btn" disabled={snap.sending} onClick={() => { void store.cancelCompose() }}>{uiText('email.discard')}</button>
      </div>
    </header>
    <div className="email-recipient-field"><span className="email-field-label">{uiText('auto.3f66052a107e')}</span><SelectField value={draft.accountId}
      options={snap.accounts.map((account) => ({ value: account.id, label: account.address }))} ariaLabel={uiText('auto.3f66052a107e')}
      disabled={snap.sending} onChange={(accountId) => store.updateDraft({ accountId })} /></div>
    {!sender && <div role="alert">{uiText('email.senderUnavailable')}</div>}
    <RecipientField kind="to" /><RecipientField kind="cc" /><RecipientField kind="bcc" />
    <label className="email-compose-subject"><span className="email-field-label">{uiText('auto.8d183dbdcea3')}</span><input value={draft.subject} disabled={snap.sending} onChange={(event) => store.updateDraft({ subject: event.target.value })} /></label>
    <textarea className="email-compose-body" aria-label={uiText('auto.68f4145fee7d')} value={draft.text} disabled={snap.sending} onChange={(event) => store.updateDraft({ text: event.target.value })} />
  </div>
}
