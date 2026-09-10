import { mailApi } from './mailApi'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1, type PluginInspectionSubject, type PluginProperty, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { EmailMessageDetail, EmailMessageRef } from './mailTypes'
import type { PluginLinkState } from '@valley/plugin-sdk/paths'
import { api, React } from './runtime'
import { formatEmailTimestamp, getStore, messageKey, type EmailSelection, type EmailSnapshot } from './store'
import { useEmailDateFormat } from './hooks'
import { messageMenu } from './MessageActions'
import { uiText } from './localization'
import { folderLabel } from './Panel'

function selection(raw: unknown): EmailSelection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(uiText('email.error.input'))
  const value = raw as Record<string, unknown>
  const accountIds = value.accountIds ?? []
  if (!Array.isArray(accountIds) || !accountIds.every((id) => typeof id === 'string' && id)) throw new Error(uiText('email.error.accountIds'))
  const view = value.view ?? 'folder'
  if (!['folder', 'recent', 'unread', 'flagged'].includes(String(view))) throw new Error(uiText('email.error.view'))
  const folder = value.folder ?? 'INBOX'
  if (typeof folder !== 'string' || !folder) throw new Error(uiText('email.error.folder'))
  if (value.query !== undefined && typeof value.query !== 'string') throw new Error(uiText('email.error.query'))
  let message: EmailMessageRef | undefined
  if (value.message !== undefined) {
    const ref = value.message as Partial<EmailMessageRef>
    if (!ref || typeof ref.accountId !== 'string' || typeof ref.folder !== 'string' || !ref.accountId || !ref.folder || !Number.isSafeInteger(ref.uid) || Number(ref.uid) < 1) throw new Error(uiText('email.error.messageFields'))
    message = { accountId: ref.accountId, folder: ref.folder, uid: ref.uid! }
  }
  return { accountIds, view: view as EmailSelection['view'], folder, query: typeof value.query === 'string' ? value.query : '', ...(message ? { message } : {}) }
}

const targetOf = (subject?: PluginInspectionSubject): EmailSelection => selection(subject?.item?.state ?? subject?.view ?? {})
const viewState = (): PluginLinkState => {
  const snap = getStore().getSnapshot()
  return { accountIds: [...snap.selectedAccountIds], view: snap.view, folder: snap.selectedFolder, query: snap.query }
}

async function readMessage(ref: EmailMessageRef): Promise<EmailMessageDetail> {
  const result = await mailApi(api).readMessage(ref)
  if (!result.ok) throw new Error(result.error || uiText('email.error.readMessage'))
  if (!result.data?.message) throw new Error(uiText('email.error.messageMissing'))
  return result.data.message
}

function overviewProperties(subject?: PluginInspectionSubject, snapshot: EmailSnapshot = getStore().getSnapshot()): PluginProperty[] {
  const target = selection(subject?.view ?? viewState())
  const mailbox = snapshot.mailboxes.find((item) => item.path === target.folder)
  return [
    { id: 'accounts', label: uiText('email.surface.accounts'), value: snapshot.accounts.map((account) => account.address).join('\n') || '—', readOnly: true },
    { id: 'view', label: uiText('email.surface.view'), value: target.view === 'folder' ? uiText('auto.30baa24967e0') : uiText(`email.view.${target.view}`), readOnly: true },
    ...(target.view === 'folder' ? [{ id: 'folder', label: uiText('auto.30baa24967e0'), value: mailbox ? folderLabel(mailbox) : target.folder, readOnly: true }] : []),
    ...(target.query ? [{ id: 'query', label: uiText('email.surface.query'), value: target.query, readOnly: true }] : []),
    { id: 'cachedMail', label: uiText('email.cachedMail'), value: snapshot.loadingMessages ? uiText('auto.33ce417454bf') : `${snapshot.messages.length}${snapshot.cursor ? '+' : ''}`, readOnly: true }
  ]
}

function messageSubject(subject?: PluginInspectionSubject, message = getStore().getSnapshot().selectedMessage): PluginInspectionSubject | undefined {
  if (subject?.item) return subject
  if (!message) return undefined
  const view = subject?.view ?? viewState()
  return { pluginId: api.pluginId, surface: 'main_workspace', view,
    item: { id: messageKey(message), title: message.subject, state: { ...view, message: { accountId: message.accountId, folder: message.folder, uid: message.uid } } } }
}

async function inspect(subject?: PluginInspectionSubject): Promise<PluginProperty[]> {
  const target = targetOf(messageSubject(subject))
  return target.message ? messageProperties(await readMessage(target.message)) : []
}

function Overview({ subject }: { subject?: PluginInspectionSubject }): React.ReactElement {
  const store = getStore()
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  return <div className="right-panel-body props-info email-overview"><dl className="props-info-table">
    {overviewProperties(subject, snapshot).map((field) => <div className="props-info-row" key={field.id}>
      <dt className="props-info-key">{field.label}</dt><dd className="props-info-value email-property-lines">{String(field.value)}</dd>
    </div>)}
  </dl></div>
}

function messageProperties(message: EmailMessageDetail): PluginProperty[] {
  return [
    { id: 'subject', label: uiText('auto.8d183dbdcea3'), value: message.subject, readOnly: true },
    { id: 'from', label: uiText('auto.3f66052a107e'), value: message.from, readOnly: true },
    { id: 'to', label: uiText('auto.ae79ea1e9c63'), value: message.to, readOnly: true },
    ...(message.cc || message.addresses.cc.length ? [{ id: 'cc', label: uiText('email.header.cc'), value: message.cc || message.addresses.cc.map((address) => address.address).join(', '), readOnly: true }] : []),
    ...(message.replyTo || message.addresses.replyTo.length ? [{ id: 'replyTo', label: uiText('email.header.replyTo'), value: message.replyTo || message.addresses.replyTo.map((address) => address.address).join(', '), readOnly: true }] : []),
    { id: 'date', label: uiText('auto.eb9a4bc1c0c1'), value: message.date, readOnly: true },
    { id: 'read', label: uiText('auto.852b438f91ad'), value: message.flags.includes('\\Seen'), type: 'boolean' },
    { id: 'flagged', label: uiText('auto.f8db8a172be6'), value: message.flags.includes('\\Flagged'), type: 'boolean' },
    { id: 'uid', label: uiText('auto.d946adf52a47'), value: message.uid, readOnly: true }
  ]
}

function parsePropertyUpdate(raw: unknown): { target: EmailSelection; values: Record<string, unknown> } {
  const value = raw as { subject?: PluginInspectionSubject; values?: Record<string, unknown> }
  if (value?.subject?.pluginId !== api.pluginId || !value.values || typeof value.values !== 'object' || Array.isArray(value.values)) throw new Error(uiText('email.error.properties'))
  const target = targetOf(value.subject)
  const allowed = target.message ? ['read', 'flagged'] : []
  if (!Object.keys(value.values).length || Object.keys(value.values).some((key) => !allowed.includes(key))) throw new Error(uiText('email.error.readOnly'))
  if (target.message && Object.values(value.values).some((item) => typeof item !== 'boolean')) throw new Error(uiText('email.error.flags'))
  return { target, values: structuredClone(value.values) }
}

async function updateProperties({ target, values }: ReturnType<typeof parsePropertyUpdate>) {
  const store = getStore()
  if (target.message) {
    await readMessage(target.message)
    const applied: string[] = []
    for (const [key, value] of Object.entries(values)) {
      if (!(await store.act(target.message, key === 'read' ? value ? 'mark-read' : 'mark-unread' : value ? 'flag' : 'unflag'))) throw new Error(`${store.getSnapshot().error || uiText('email.actionFailed')}${applied.length ? uiText('email.error.partial', { value: applied.join(', ') }) : uiText('email.error.retry')}`)
      applied.push(key)
    }
  }
  return { value: values, revert: null }
}

function Properties({ subject }: { subject?: PluginInspectionSubject }): React.ReactElement {
  const { dateFormat, timeFormat } = useEmailDateFormat()
  const { Toggle } = api.ui.settings
  const store = getStore()
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  const inspectedSubject = React.useMemo(() => messageSubject(subject, snapshot.selectedMessage), [subject, snapshot.selectedMessage])
  const [fields, setFields] = React.useState<PluginProperty[]>([])
  const [addresses, setAddresses] = React.useState<EmailMessageDetail['addresses'] | null>(null)
  const [error, setError] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      const target = targetOf(inspectedSubject)
      const message = target.message ? await readMessage(target.message) : null
      const value = message ? messageProperties(message) : []
      if (active) { setFields(value); setAddresses(message?.addresses ?? null); setError('') }
    }
    void load().catch(() => { if (active) setError(uiText('email.selectionMissing')) })
    return () => { active = false }
  }, [inspectedSubject])
  const commit = async (id: string, value: unknown): Promise<void> => {
    if (!inspectedSubject) return
    setSaving(true)
    try {
      await updateProperties(parsePropertyUpdate({ subject: inspectedSubject, values: { [id]: value } }))
      setFields(await inspect(inspectedSubject))
      setError('')
    } catch { setError(api.ui.t('error.commandFailed')) }
    finally { setSaving(false) }
  }
  return <div className="right-panel-body props-info email-properties">{error && <p role="alert">{error}</p>}<dl className="props-info-table">{fields.map((field) => <div className={`props-info-row${field.type === 'boolean' ? ' email-property-toggle' : ''}`} key={field.id}>
    <dt className="props-info-key">{field.label}</dt><dd className="props-info-value">
    {field.readOnly ? addresses?.[field.id as keyof typeof addresses]?.length ? <span className="email-property-people">{addresses[field.id as keyof typeof addresses].map((address, index) => <span className="email-property-person" key={`${address.address}:${index}`}>
      {address.name && address.name !== address.address ? <><span className="email-property-name">{address.name}</span><small>{address.address}</small></> : <span>{address.address}</span>}
    </span>)}</span> : field.id === 'date' ? formatEmailTimestamp(String(field.value ?? ''), dateFormat, timeFormat, api.ui.language(), true) : String(field.value ?? '') : field.type === 'boolean' ? <Toggle label={field.label} checked={field.value === true} disabled={saving} onChange={(value) => void commit(field.id, value)} />
      : String(field.value ?? '')}
    </dd>
  </div>)}</dl></div>
}

export function registerEmailSurfaces(pluginApi: ValleyPluginApi): () => void {
  const store = getStore()
  const surfaces = ['main_workspace', 'left_sidebar', 'right_sidebar'] as const
  const offs = surfaces.map((surface) => pluginApi.interop.extensions.provide(PLUGIN_SURFACE_V1, {
    id: `email.${surface}`, surface, subscribe: store.subscribe,
    getSnapshot: () => {
      const snap = store.getSnapshot()
      const message = snap.selectedMessage
      const view = viewState()
      return { title: message?.subject || uiText('manifest.name'), view,
        ...(message ? { item: { id: messageKey(message), title: message.subject || uiText('email.noSubject'), state: { ...view, message: { accountId: message.accountId, folder: message.folder, uid: message.uid } } }, actions: messageMenu(message) } : {}),
        navigation: { canGoBack: snap.canGoBack, canGoForward: snap.canGoForward, goBack: store.goBack, goForward: store.goForward }
      }
    },
    restore: async (state, _instanceId, options) => {
      if (options?.background && store.getSnapshot().compose?.dirty) return
      await store.restoreSelection(selection(state))
    }
  }))
  offs.push(pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, { id: 'email.properties', label: 'Email', labelKey: 'manifest.name', icon: 'mail', pluginSurfaces: ['main_workspace'], inspect: ({ subject }) => overviewProperties(subject), render: ({ subject }) => <Overview subject={subject} /> }))
  let offMessage: (() => void) | undefined
  const syncMessageSegment = (): void => {
    const snapshot = store.getSnapshot()
    if (snapshot.selectedMessage && !snapshot.composing) {
      offMessage ??= pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, {
        id: 'email.message', label: 'Message', labelKey: 'email.surface.message', icon: 'text-align-left', pluginSurfaces: ['main_workspace'],
        inspect: ({ subject }) => inspect(subject), editCommand: 'update-properties', render: ({ subject }) => <Properties subject={subject} />
      })
    } else { offMessage?.(); offMessage = undefined }
  }
  offs.push(store.subscribe(syncMessageSegment), () => offMessage?.())
  syncMessageSegment()
  offs.push(pluginApi.commands.register({
    id: 'open-selection', label: 'Email: Open a mailbox or message', labelKey: 'email.command.openSelection', sideEffect: 'read', paletteSafe: false,
    input: { schema: { type: 'object', properties: { accountIds: { type: 'array', items: { type: 'string' } }, view: { type: 'string', enum: ['folder', 'recent', 'unread', 'flagged'] }, folder: { type: 'string' }, query: { type: 'string' }, message: { type: 'object', properties: { accountId: { type: 'string' }, folder: { type: 'string' }, uid: { type: 'integer', minimum: 1 } }, required: ['accountId', 'folder', 'uid'] } }, additionalProperties: false }, parse: selection },
    run: async (target) => { await store.restoreSelection(target); pluginApi.workspace.openMainTab(); return { ...target } }
  }))
  offs.push(pluginApi.commands.register({
    id: 'update-properties', label: 'Email: Edit Properties', labelKey: 'email.command.updateProperties', sideEffect: 'write', paletteSafe: false,
    input: { schema: { type: 'object', properties: { subject: { type: 'object' }, values: { type: 'object', additionalProperties: true } }, required: ['subject', 'values'], additionalProperties: false }, parse: parsePropertyUpdate },
    revision: async ({ target }) => target.message ? readMessage(target.message) : target,
    preview: (input) => input,
    run: updateProperties
  }))
  return () => offs.forEach((off) => off())
}
