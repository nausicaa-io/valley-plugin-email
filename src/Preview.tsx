import type { FC } from 'react'
import { useEmail } from './hooks'
import { Person } from './People'
import { MessageActions } from './MessageActions'
import { MessageBody } from './MessageBody'
import { Flag, Mail } from './icons'
import { uiText } from './localization'
import { api, React } from './runtime'

export const Preview: FC = () => {
  const { snap } = useEmail()
  const message = snap.selectedMessage
  const account = snap.accounts.find((candidate) => candidate.id === snap.selectedAccountId)
  if (!message) {
    const unread = snap.messages.filter((candidate) => !candidate.flags.includes('\\Seen')).length
    const flagged = snap.messages.filter((candidate) => candidate.flags.includes('\\Flagged')).length
    return (
      <div className="email-preview email-preview-overview">
        <div className="email-preview-glyph"><Mail /></div>
        <h3>{snap.view === 'folder' ? snap.selectedFolder : uiText(`email.view.${snap.view}`)}</h3>
        <p>{account?.address ?? uiText('auto.a6275288ec62')}</p>
        <div className="email-overview-stats">
          <div><strong>{snap.messages.length}</strong><span>{uiText('auto.f1702b468627')}</span></div>
          <div><strong>{unread}</strong><span>{uiText('auto.07b032b56f7a')}</span></div>
          <div><strong>{flagged}</strong><span>{uiText('auto.f8db8a172be6')}</span></div>
        </div>
      </div>
    )
  }
  return (
    <div className="email-preview">
      <div className="email-preview-title-row"><h3 className="email-preview-subject">{message.subject}</h3>{message.flags.includes('\\Flagged') && <Flag filled />}</div>
      <div className="email-preview-meta">{message.addresses.from.map((address) => <Person key={address.address} address={address} showAddress />)}</div>
      <div className="email-preview-meta">{uiText('auto.ae79ea1e9c63')} {message.addresses.to.map((address) => <Person key={address.address} address={address} showAddress />)}</div>
      {message.cc && <div className="email-preview-meta">Cc {message.addresses.cc.map((address) => <Person key={address.address} address={address} showAddress />)}</div>}
      <div className="email-preview-meta">{new Date(message.date).toLocaleString(api.ui.language())}</div>
      <MessageActions message={message} compact />
      <div className="email-preview-body"><MessageBody message={message} /></div>
    </div>
  )
}
