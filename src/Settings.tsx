import { SmartGroupsSettings } from './SmartGroupsSettings'
import { mailApi } from './mailApi'
import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import type { EmailAccount, EmailConnectionResult } from './mailTypes'
import { emailDisplaySettingsKey, readEmailDisplaySettings, useEmail, useEmailDisplaySettings, type EmailDisplaySettings } from './hooks'
import { ChevronLeft, ChevronRight, Google, Mail, Microsoft, Plus, Trash, Warning } from './icons'
import { uiText } from './localization'
import { readContactsRoot } from './vcfContacts'

/**
 * Email settings:
 * - Main page (`section === undefined`): Mail accounts list/detail, Contacts (.vcf folder),
 *   and Sync & offline mail settings — clean Valley-style sections.
 * - Sub-page (`section === 'grouping'`): Dedicated Grouping & AI sorting page with overviewable
 *   icon/colour groups, presets (Marketing & Promotions, Receipts, Orders, etc.) and batch sorting.
 */
type View = { kind: 'list' } | { kind: 'add' } | { kind: 'account'; id: string }

export const Settings: FC<{ section?: string }> = ({ section }) => {
  if (section === 'grouping') return <SmartGroupsSettings />
  return <GeneralSettings />
}

const GeneralSettings: FC = () => {
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
    <>
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

      <ContactsFolderSettings />
      <SyncSettings />
    </>
  )
}

const ContactsFolderSettings: FC = () => {
  const { store } = useEmail()
  const vcf = React.useSyncExternalStore(store.vcfContacts.subscribe, store.vcfContacts.getSnapshot)
  const [contactsRoot, setContactsRoot] = React.useState(() => readContactsRoot(api))
  React.useEffect(() => api.settings.subscribe(() => { setContactsRoot(readContactsRoot(api)) }), [])
  const { Section, Row, RealmFolderField } = api.ui.settings

  return (
    <Section title={uiText('email.contacts')}>
      <Row title={uiText('email.settings.contactsRoot')} description={uiText('email.settings.contactsRootDescription')}>
        <RealmFolderField
          value={contactsRoot}
          onChange={setContactsRoot}
          onCommit={(value) => { void api.settings.set('contactsRoot', value) }}
          ariaLabel={uiText('email.settings.contactsRoot')}
        />
      </Row>
      <p className="email-settings-hint email-vcf-status" role="status">
        {vcf.loading
          ? uiText('auto.33ce417454bf')
          : vcf.count > 0
            ? uiText('email.settings.contactsLoaded', { count: vcf.count, emails: vcf.emailCount })
            : uiText('email.settings.contactsEmpty')}
      </p>
    </Section>
  )
}

const SyncSettings: FC = () => {
  const readNum = (key: string, fallback: number, min: number, max: number): number => {
    const value = Number(api.settings.get()[key])
    return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback
  }
  const [syncLimit, setSyncLimit] = React.useState<number | null>(() => readNum('syncLimit', 50, 1, 500))
  const [cacheDays, setCacheDays] = React.useState<number | null>(() => readNum('cacheDays', 180, 1, 3650))
  React.useEffect(() => api.settings.subscribe(() => {
    setSyncLimit(readNum('syncLimit', 50, 1, 500))
    setCacheDays(readNum('cacheDays', 180, 1, 3650))
  }), [])
  const { Section, Row, NumberField } = api.ui.settings

  return (
    <Section title={uiText('email.settings.syncSection')}>
      <Row title={uiText('plugin.email.field.perSync')} description={uiText('auto.62e474963a01')}>
        <NumberField
          ariaLabel={uiText('plugin.email.field.perSync')}
          min={1}
          max={500}
          step={1}
          value={syncLimit}
          onChange={setSyncLimit}
          onCommit={(next) => {
            const clamped = Math.max(1, Math.min(500, Math.round(next ?? 50)))
            setSyncLimit(clamped)
            void api.settings.set('syncLimit', clamped)
          }}
        />
      </Row>
      <Row title={uiText('plugin.email.field.cacheDays')} description={uiText('plugin.email.field.cacheDaysDesc')}>
        <NumberField
          ariaLabel={uiText('plugin.email.field.cacheDays')}
          min={1}
          max={3650}
          step={1}
          value={cacheDays}
          onChange={setCacheDays}
          onCommit={(next) => {
            const clamped = Math.max(1, Math.min(3650, Math.round(next ?? 180)))
            setCacheDays(clamped)
            void api.settings.set('cacheDays', clamped)
          }}
        />
      </Row>
    </Section>
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
  if (account.secretState === 'stored') return { label: uiText('credentials.saved'), ok: false }
  if (account.secretState === 'unreadable') return { label: uiText('credentials.unreadable'), ok: false }
  if (account.secretState === 'ok') return { label: uiText('credentials.available'), ok: false }
  if (account.secretState === 'absent') return { label: uiText('credentials.missing'), ok: false }
  return { label: uiText('credentials.unchecked'), ok: false }
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
        <AccountCredentials account={account} />
        <AccountConnectionTest account={account} />
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

const AccountCredentials: FC<{ account: EmailAccount }> = ({ account }) => {
  const { store } = useEmail()
  const [address, setAddress] = React.useState(account.address)
  const [login, setLogin] = React.useState(account.login || account.address)
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [failed, setFailed] = React.useState(false)
  const { TextField } = api.ui.settings
  const save = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    setFailed(false)
    try {
      const result = await mailApi(api).updateSmtpAccount({ accountId: account.id, address: address.trim(), login: login.trim(), password })
      setFailed(!result.ok)
      setMessage(result.ok ? uiText('email.settings.reconnected') : result.error || uiText('email.settings.reconnectFailed'))
      await store.refreshAccounts()
    } catch {
      setFailed(true)
      setMessage(uiText('email.settings.reconnectFailed'))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }
  return <>
    <Field title={uiText('auto.c94d3175a656')}><TextField value={address} onChange={setAddress} ariaLabel={uiText('auto.c94d3175a656')} disabled={busy} /></Field>
    <Field title={uiText('email.settings.login')}><TextField value={login} onChange={setLogin} ariaLabel={uiText('email.settings.login')} disabled={busy} /></Field>
    <Field title={uiText('auto.b78ff3963178')}><TextField type="password" value={password} onChange={setPassword} ariaLabel={uiText('auto.b78ff3963178')} disabled={busy} placeholder={uiText('email.settings.passwordPlaceholder')} /></Field>
    <div className="settings-row-actions"><Button variant="primary" disabled={busy || !address.trim() || !login.trim() || !password} onClick={() => { void save() }}>{busy ? uiText('auto.691f4302fccf') : uiText('email.settings.saveReconnect')}</Button></div>
    {message && <div role="status" className={failed ? 'email-error' : 'settings-description'}>{message}</div>}
  </>
}

const AccountConnectionTest: FC<{ account: EmailAccount }> = ({ account }) => {
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<EmailConnectionResult | undefined>()
  const cancellation = React.useRef<AbortController | undefined>()
  React.useEffect(() => () => { cancellation.current?.abort() }, [])
  const test = async (): Promise<void> => {
    cancellation.current?.abort()
    const controller = new AbortController(); cancellation.current = controller
    setBusy(true); setResult(undefined)
    try { const result = await mailApi(api).testAccount(account.id, controller.signal); if (!controller.signal.aborted) setResult(result) }
    catch { if (!controller.signal.aborted) setResult({ ok: false, error: uiText('email.settings.connectionFailed') }) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <>
    <SettingsRow title={uiText('email.settings.testConnection')} description={uiText('email.settings.testConnectionDescription')}>
      <Button disabled={busy} onClick={() => { void test() }}>{uiText(busy ? 'email.settings.connectionChecking' : 'email.settings.testConnection')}</Button>
    </SettingsRow>
    {result && <div role="status" className="settings-description">
      {result.data ? <>{(['imap', 'smtp'] as const).map(kind => <div key={kind} className={result.data![kind].ok ? '' : 'email-error'}>{kind.toUpperCase()}: {result.data![kind].ok ? uiText('email.settings.connectionOk') : result.data![kind].error || uiText('email.settings.connectionFailed')}</div>)}</> : <span className="email-error">{result.error || uiText('email.settings.connectionFailed')}</span>}
    </div>}
  </>
}

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
