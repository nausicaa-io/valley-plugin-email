import { CONTACTS_DIRECTORY_V1, type ContactDirectoryEntry } from '@valley/plugin-sdk'
import type { EmailAddress } from './mailTypes'
import { React, api } from './runtime'
import { useEmail } from './hooks'
import { uiText } from './localization'

export function contactName(address: EmailAddress, contacts: Record<string, ContactDirectoryEntry[]>): string {
  const matches = contacts[address.address.trim().toLowerCase()] ?? []
  return matches.length === 1 ? matches[0].displayName : address.name || address.address
}

export function contactInitials(label: string): string {
  const words = label.trim().replace(/^([^@]+)@.*$/, '$1').split(/[\s._-]+/).filter(Boolean)
  return (words.length > 1 ? words.slice(0, 2) : words.slice(0, 1)).map((word) => word[0].toLocaleUpperCase()).join('') || '?'
}

export const ContactAvatar: React.FC<{ address?: EmailAddress; label: string; contacts: Record<string, ContactDirectoryEntry[]>; className?: string }> = ({ address, label, contacts, className }) => {
  const matches = address ? contacts[address.address.trim().toLowerCase()] ?? [] : []
  const avatarUrl = matches.length === 1 ? matches[0].avatarUrl : undefined
  const classes = `email-avatar${className ? ` ${className}` : ''}`
  return avatarUrl
    ? <img className={classes} src={avatarUrl} alt="" />
    : <span className={`${classes} email-avatar-initials`} aria-hidden="true">{contactInitials(label)}</span>
}

export const Person: React.FC<{ address: EmailAddress; showAddress?: boolean }> = ({ address, showAddress = false }) => {
  const { snap } = useEmail()
  const matches = snap.contacts[address.address.trim().toLowerCase()] ?? []
  const label = contactName(address, snap.contacts)
  const content = <><span>{label}</span>{showAddress && label !== address.address && <small>{address.address}</small>}</>
  if (!matches.length) return <span className="email-person" title={address.address}>{content}</span>
  return <button className="email-person linked" title={address.address} onClick={(event) => {
    event.stopPropagation()
    const provider = api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0]
    if (!provider) return
    void api.ui.openPopover(({ close }) => <div className="email-contact-card">
      <div className="email-popover-label">{address.address}</div>
      {matches.map((contact) => <button key={contact.id} className="email-account-option" onClick={() => {
        close()
        void provider.invoke('open', [contact.id, { newTab: true }])
      }}>
        {contact.avatarUrl && <img className="email-avatar" src={contact.avatarUrl} alt="" />}
        <span className="email-account-copy"><strong>{contact.displayName}</strong><small>{uiText('email.openContact')}</small></span>
      </button>)}
    </div>, { anchor: event.currentTarget }, { ariaLabel: uiText('email.contacts') })
  }}>{content}</button>
}
