import { mailApi } from './mailApi'
import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import type { EmailAccount } from './mailTypes'
import { emailDisplaySettingsKey, readEmailDisplaySettings, useEmail, useEmailDisplaySettings, type EmailDisplaySettings } from './hooks'
import { ChevronLeft, ChevronRight, Google, Mail, Microsoft, Plus, Trash, Warning } from './icons'
import { uiText } from './localization'

/**
 * Email settings as the same full-bleed list page AI Providers and Accounts use:
 * a header band with `+`, one row per mailbox, and a detail page behind each row.
 * Google/Microsoft sign-in is centralized in Settings → Accounts (one login powers
 * Mail + Calendar), so `+` only adds a local PureMail (generic IMAP/SMTP) mailbox
 * and an OAuth account's detail page points back at Accounts. The "where do
 * Google and Microsoft live" explanation belongs in the page-information card
 * (the manifest description), never as a paragraph above the list.
 */
type View = { kind: 'list' } | { kind: 'add' } | { kind: 'account'; id: string }

export const Settings: FC = () => {
  const { store, snap } = useEmail()
  const [view, setView] = React.useState<View>({ kind: 'list' })
  const backToList = (): void => setView({ kind: 'list' })

  if (view.kind === 'add') {
    return (
      <section className="settings-section email-settings">
        <CrumbBand current={uiText('auto.213989312d7f')} onBack={backToList} />
        <SmtpForm
          onAdded={() => {
            backToList()
            void store.refreshAccounts()
          }}
        />
      </section>
    )
  }

  if (view.kind === 'account') {
    const account = snap.accounts.find((a) => a.id === view.id)
    if (account) {
      return (
        <AccountDetail
          key={account.id}
          account={account}
          onBack={backToList}
          onRemove={() => {
            backToList()
            void store.removeAccount(account.id)
          }}
        />
      )
    }
  }

  return (
    <section className="settings-section email-settings settings-listpage">
      <div className="settings-listpage-header">
        <h4 className="settings-label">{uiText('auto.65b0d1700502')}</h4>
        <Button
          className="settings-listpage-add"
          size="small"
          aria-label={uiText('auto.213989312d7f')}
          title={uiText('auto.213989312d7f')}
          onClick={() => setView({ kind: 'add' })}
        >
          <Plus className="" />
        </Button>
      </div>

      {snap.accounts.length === 0 ? (
        <p className="email-settings-empty">{uiText('auto.ea9ca69a7a4b')}</p>
      ) : (
        <div className="settings-list">
          {snap.accounts.map((account) => (
            <AccountRow key={account.id} account={account} onOpen={() => setView({ kind: 'account', id: account.id })} />
          ))}
        </div>
      )}
    </section>
  )
}

const Button: typeof api.ui.settings.Button = (props) => React.createElement(api.ui.settings.Button, props)
const IconButton: typeof api.ui.settings.IconButton = (props) => React.createElement(api.ui.settings.IconButton, props)
const ReadOnlyValue: typeof api.ui.settings.ReadOnlyValue = (props) =>
  React.createElement(api.ui.settings.ReadOnlyValue, props)
const SettingsRow: typeof api.ui.settings.Row = (props) => React.createElement(api.ui.settings.Row, props)

const providerLabel = (p: string): string =>
  p === 'google' ? 'Google' : p === 'microsoft' ? 'Microsoft' : 'IMAP / SMTP'

/** The round glyph well: a brand mark where one exists, the mail glyph otherwise. */
const AccountGlyph: FC<{ account: EmailAccount; large?: boolean }> = ({ account, large }) => (
  <span className={`settings-list-glyph${large ? ' settings-list-glyph--lg' : ''}`}>
    {account.provider === 'google' ? (
      <Google className="" />
    ) : account.provider === 'microsoft' ? (
      <Microsoft className="" />
    ) : (
      <Mail className="email-glyph-mail" />
    )}
  </span>
)

/** The short state word on a row — what the user must do next, if anything. */
function badgeFor(account: EmailAccount): { label: string; ok: boolean } {
  if (account.provider !== 'pureemail') return { label: uiText('auto.e2262d7a63f5'), ok: true }
  if (account.secretState === 'unreadable') return { label: 'reconnect', ok: false }
  return { label: 'connected', ok: true }
}

const AccountRow: FC<{ account: EmailAccount; onOpen: () => void }> = ({ account, onOpen }) => {
  const badge = badgeFor(account)
  return (
    <div
      className="settings-list-row"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <AccountGlyph account={account} />
      <span className="settings-list-meta">
        <span className="settings-list-name">{account.address}</span>
        <span className="settings-list-sub">{providerLabel(account.provider)}</span>
      </span>
      {account.secretState === 'unreadable' && (
        <span className="email-reauth" title={uiText('auto.95037bb43b47')}>
          <Warning className="" />
        </span>
      )}
      <span className={`email-badge ${badge.ok ? 'ok' : 'off'}`}>
        <span className={`email-dot ${badge.ok ? 'ok' : 'off'}`} />
        {badge.label}
      </span>
      <ChevronRight className="settings-list-chevron" />
    </div>
  )
}

/** A sub-page band: a chevron back to the list, then this page's own name. */
const CrumbBand: FC<{ current: string; onBack: () => void }> = ({ current, onBack }) => {
  const label = uiText('auto.b70b6ab0baad', { p0: uiText('auto.65b0d1700502') })
  return (
    <div className="settings-listpage-crumbs">
      <button type="button" className="settings-listpage-back" aria-label={label} title={label} onClick={onBack}>
        <ChevronLeft className="" />
      </button>
      <span className="settings-crumb settings-crumb-current">{current}</span>
    </div>
  )
}

const AccountDetail: FC<{ account: EmailAccount; onBack: () => void; onRemove: () => void }> = ({
  account,
  onBack,
  onRemove
}) => (
  <section className="settings-section email-settings">
    <CrumbBand current={account.address} onBack={onBack} />

    <div className="email-detail-identity">
      <AccountGlyph account={account} large />
      <div className="settings-list-meta">
        <span className="settings-list-name">{account.address}</span>
        <span className="settings-list-sub">{providerLabel(account.provider)}</span>
      </div>
    </div>

    <DisplaySettings accountId={account.id} />

    {account.provider === 'pureemail' ? (
      <>
        <HostRow title={uiText('auto.b53c37515b60')} value={account.imap.host} />
        <HostRow title={uiText('auto.07f3793882a2')} value={String(account.imap.port)} />
        <HostRow title={uiText('auto.2d4a434baeea')} value={account.smtp.host} />
        <HostRow title={uiText('auto.65b5a10871b0')} value={String(account.smtp.port)} />
        {account.secretState === 'unreadable' && <div className="email-reauth">{uiText('auto.95037bb43b47')}</div>}
        <div className="settings-row-actions">
          <IconButton ariaLabel={uiText('auto.e556b5329b34')} title={uiText('auto.e556b5329b34')} onClick={onRemove}>
            <Trash className="" />
          </IconButton>
        </div>
      </>
    ) : (
      <p className="email-settings-empty">{uiText('auto.45ec84fc9b5b')}</p>
    )}
  </section>
)

const DisplaySettings: FC<{ accountId: string }> = ({ accountId }) => {
  const settings = useEmailDisplaySettings(accountId)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState(false)
  const { Row, Toggle, FieldError } = api.ui.settings
  const update = async (key: keyof EmailDisplaySettings, value: boolean): Promise<void> => {
    setSaving(true)
    setError(false)
    try {
      const result = await api.settings.set(emailDisplaySettingsKey(accountId), { ...readEmailDisplaySettings(accountId), [key]: value })
      setError(!result.ok)
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }
  return <>
    <Row title={uiText('email.settings.htmlContent')} description={uiText('email.settings.htmlContentDescription')}>
      <Toggle label={uiText('email.settings.htmlContent')} checked={settings.htmlContent} disabled={saving} onChange={(value) => { void update('htmlContent', value) }} />
    </Row>
    <Row title={uiText('email.settings.remoteImages')} description={uiText('email.settings.remoteImagesDescription')}>
      <Toggle label={uiText('email.settings.remoteImages')} checked={settings.remoteImages} disabled={saving} onChange={(value) => { void update('remoteImages', value) }} />
    </Row>
    {error && <FieldError>{uiText('email.settings.saveFailed')}</FieldError>}
  </>
}

const HostRow: FC<{ title: string; value: string }> = ({ title, value }) => (
  <SettingsRow title={title}>
    <ReadOnlyValue value={value} ariaLabel={title} monospace />
  </SettingsRow>
)

const SmtpForm: FC<{ onAdded: () => void }> = ({ onAdded }) => {
  const [address, setAddress] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [imapHost, setImapHost] = React.useState('')
  const [imapPort, setImapPort] = React.useState<number | null>(993)
  const [smtpHost, setSmtpHost] = React.useState('')
  const [smtpPort, setSmtpPort] = React.useState<number | null>(465)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const { TextField, NumberField } = api.ui.settings

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const res = await mailApi(api).addSmtpAccount({
      address: address.trim(),
      password,
      imap: { host: imapHost.trim(), port: imapPort ?? 993, secure: true },
      smtp: { host: smtpHost.trim(), port: smtpPort ?? 465, secure: smtpPort !== 587 }
    })
    setBusy(false)
    if (!res.ok) {
      setError(uiText('auto.d899c663b30c'))
      return
    }
    setAddress('')
    setPassword('')
    onAdded()
  }

  // Settings rows, not a boxed card: the label sits left and the field right,
  // exactly like every other setting on the page.
  return (
    <>
      {error && <div className="email-error">{error}</div>}
      <Field title={uiText('auto.c94d3175a656')}>
        <TextField
          value={address}
          onChange={setAddress}
          placeholder={uiText('auto.0013c7eb876f')}
          ariaLabel={uiText('auto.c94d3175a656')}
        />
      </Field>
      <Field title={uiText('auto.b78ff3963178')}>
        <TextField type="password" value={password} onChange={setPassword} ariaLabel={uiText('auto.b78ff3963178')} />
      </Field>
      <Field title={uiText('auto.b53c37515b60')}>
        <TextField
          value={imapHost}
          onChange={setImapHost}
          placeholder="imap.domain.com"
          ariaLabel={uiText('auto.b53c37515b60')}
        />
      </Field>
      <Field title={uiText('auto.07f3793882a2')}>
        <NumberField
          value={imapPort}
          onChange={setImapPort}
          min={1}
          max={65535}
          ariaLabel={uiText('auto.07f3793882a2')}
        />
      </Field>
      <Field title={uiText('auto.2d4a434baeea')}>
        <TextField
          value={smtpHost}
          onChange={setSmtpHost}
          placeholder="smtp.domain.com"
          ariaLabel={uiText('auto.2d4a434baeea')}
        />
      </Field>
      <Field title={uiText('auto.65b5a10871b0')}>
        <NumberField
          value={smtpPort}
          onChange={setSmtpPort}
          min={1}
          max={65535}
          ariaLabel={uiText('auto.65b5a10871b0')}
        />
      </Field>
      <div className="settings-row-actions">
        <Button
          variant="primary"
          disabled={busy || !address.trim() || !password || !imapHost.trim() || !smtpHost.trim()}
          onClick={() => void submit()}
        >
          {busy ? uiText('auto.691f4302fccf') : uiText('auto.98b0ed858ae4')}
        </Button>
      </div>
    </>
  )
}

const Field: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <SettingsRow title={title}>
    <div className="settings-row-control">{children}</div>
  </SettingsRow>
)
