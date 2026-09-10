import { api, React } from './runtime'
import type { MainWorkspaceViewProps } from '@valley/plugin-sdk'
import { useEmail, useEmailDateFormat, useEmailDisplaySettings } from './hooks'
import { Compose } from './Compose'
import { ErrorNotice } from './Notice'
import { MessageActions } from './MessageActions'
import { ContactAvatar, contactName } from './People'
import { MessageBody } from './MessageBody'
import { Inbox, Plus, Mail } from './icons'
import { uiText } from './localization'
import { formatEmailTimestamp, messageKey } from './store'

export const Page: React.FC<MainWorkspaceViewProps> = ({ navigation }) => {
  const { store, snap } = useEmail()
  const { dateFormat, timeFormat } = useEmailDateFormat()
  const selected = snap.selectedMessage
  const senderAddress = selected?.addresses.from[0]
  const sender = selected ? senderAddress ? contactName(senderAddress, snap.contacts) : selected.from : ''
  const addressFields = selected ? [
    { label: uiText('auto.3f66052a107e'), addresses: selected.addresses.from, fallback: selected.from },
    { label: uiText('auto.ae79ea1e9c63'), addresses: selected.addresses.to, fallback: selected.to },
    { label: uiText('email.header.cc'), addresses: selected.addresses.cc, fallback: selected.cc }
  ].filter((field) => field.addresses.length || field.fallback?.trim()) : []
  const { htmlContent } = useEmailDisplaySettings(selected?.accountId)
  const selectedKey = selected ? messageKey(selected) : null
  const bodyOverride = snap.bodyOverride
  const plainText = bodyOverride?.key === selectedKey && bodyOverride.htmlContent === htmlContent ? bodyOverride.plainText : !htmlContent
  React.useEffect(() => {
    navigation.setController({ canGoBack: snap.canGoBack, canGoForward: snap.canGoForward, goBack: store.goBack, goForward: store.goForward })
    return () => navigation.setController(null)
  }, [navigation, snap.canGoBack, snap.canGoForward, store])
  return <div className="email-page">
    <header className="email-toolbar">{selected && !snap.composing && <>
      <span className="email-toolbar-title" title={selected.subject || uiText('email.noSubject')}>{selected.subject || uiText('email.noSubject')}</span>
      <MessageActions message={selected} />
    </>}</header>
    {snap.error && <div className="email-notice-slot"><ErrorNotice onRetry={() => { void store.refreshAccounts() }} /></div>}
    {!snap.selectedAccountId ? <div className="email-placeholder"><div className="email-placeholder-content">
      <div className="email-placeholder-icon"><Mail /></div>
      <p className="email-placeholder-title">{uiText('auto.ea9ca69a7a4b')}</p>
      <button className="email-btn email-placeholder-action" onClick={() => api.workspace.openOwnSettings()}><Plus />{uiText('auto.98b0ed858ae4')}</button>
    </div></div>
      : snap.composing && snap.compose ? <Compose /> : selected ? <article className={`email-reader${selected.html && !plainText ? ' html' : ''}`}>
        <div className="email-reader-inner">
          <header className="email-reader-header">
            <span className="email-reader-avatar"><ContactAvatar address={senderAddress} label={sender} contacts={snap.contacts} /></span>
            <div className="email-reader-summary">
              <h1 className="email-reader-subject">{selected.subject || uiText('email.noSubject')}</h1>
              <dl className="email-reader-addresses">{addressFields.map((field) => <div className="email-reader-meta" key={field.label}>
                <dt>{field.label}:</dt><dd>{field.addresses.length ? <span className="email-property-people">{field.addresses.map((address, index) => {
                  const name = contactName(address, snap.contacts)
                  return <span className="email-property-person" key={`${address.address}:${index}`}>
                    {name !== address.address ? <><span className="email-property-name">{name}</span><small>{address.address}</small></> : <span>{address.address}</span>}
                  </span>
                })}</span> : field.fallback}</dd>
              </div>)}</dl>
            </div>
            <div className="email-reader-context">
              <time className="email-reader-date">{formatEmailTimestamp(selected.date, dateFormat, timeFormat, api.ui.language(), true)}</time>
            </div>
          </header>
          <div className="email-reader-body">{snap.loadingMessage ? uiText('auto.33ce417454bf') : <MessageBody message={selected} plain={plainText} />}</div>
        </div>
      </article> : <div className="email-placeholder"><div className="email-placeholder-content">
        <div className="email-placeholder-icon"><Mail /></div>
        <p className="email-placeholder-title">{snap.loadingMessage ? uiText('auto.33ce417454bf') : uiText('auto.0a64fb0e930b')}</p>
        <button className="email-btn email-placeholder-action" onClick={() => api.workspace.revealOwnPanel('left_sidebar')}><Inbox />{uiText('email.showMail')}</button>
      </div></div>}
  </div>
}
