import { CONTACTS_DIRECTORY_V1, type ContactDirectoryEntry } from '@valley/plugin-sdk'
import type { AiConnectionStatus, AiModelInfo, AiModelRef } from '@valley/plugin-sdk/ai'
import { React, api } from './runtime'
import { useEmail } from './hooks'
import { uiText } from './localization'
import { Tag } from './icons'
import { addGroup, chipRule, newSmartGroup, removeGroup, ruleChip, SMART_GROUP_LIMITS, updateGroup, type SmartGroup, type SmartGroupsConfig } from './smartGroups'

type Edit = (change: (groups: SmartGroup[]) => SmartGroup[]) => void

const SentenceField: React.FC<{ group: SmartGroup; edit: Edit }> = ({ group, edit }) => {
  const [draft, setDraft] = React.useState(group.decision)
  React.useEffect(() => setDraft(group.decision), [group.decision])
  const { TextField } = api.ui.settings
  return <div className="email-smart-when"><span aria-hidden="true">{uiText('email.smartGroups.when')}</span>
    <TextField ariaLabel={uiText('email.smartGroups.whenFor', { name: group.name || uiText('email.smartGroups.unnamed') })} value={draft} style={{ width: '100%' }}
      onChange={value => setDraft(value.slice(0, SMART_GROUP_LIMITS.decision))} onCommit={value => { if (value.trim() !== group.decision) edit(groups => updateGroup(groups, group.id, { decision: value.trim() })) }} />
  </div>
}

const contactChip = async (value: string): Promise<string> => {
  const provider = api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0]
  if (!provider || chipRule(value) || value.trim().length < 2) return value.trim()
  const response = await provider.invoke('search', [value.trim(), 2])
  const found = response.ok ? response.value as ContactDirectoryEntry[] : []
  return found.length === 1 ? ruleChip({ kind: 'contact', contactId: found[0].id, label: found[0].displayName }) : value.trim()
}

const MoreFields: React.FC<{ group: SmartGroup; edit: Edit }> = ({ group, edit }) => {
  const name = group.name || uiText('email.smartGroups.unnamed')
  const [sure, setSure] = React.useState<number | null>(group.threshold)
  React.useEffect(() => setSure(group.threshold), [group.threshold])
  const { NumberField, ChipsField } = api.ui.settings
  return <div className="email-smart-more-body">
    <div className="email-smart-sure"><span>{uiText('email.smartGroups.sure')}</span>
      <NumberField ariaLabel={uiText('email.smartGroups.sureFor', { name })} min={0} max={100} step={1} value={sure} onChange={setSure} style={{ width: '100%' }}
        onCommit={value => { const next = Math.max(0, Math.min(100, Math.round(value ?? group.threshold))); setSure(next); if (next !== group.threshold) edit(groups => updateGroup(groups, group.id, { threshold: next })) }} />
      <span>{uiText('email.smartGroups.sureSuffix')}</span></div>
    <div className="email-smart-always"><span>{uiText('email.smartGroups.always')}</span>
      <ChipsField style={{ width: '100%' }} ariaLabel={uiText('email.smartGroups.alwaysFor', { name })} placeholder={uiText('email.smartGroups.alwaysPlaceholder')} commitOn={['enter', 'comma', 'blur']}
        items={group.rules.map(ruleChip)} normalize={contactChip}
        validate={value => chipRule(value) ? true : uiText('email.smartGroups.unknownSender', { value })}
        renderChip={item => { const rule = chipRule(item); return rule?.kind === 'contact' ? rule.label : item }}
        onChange={items => edit(groups => updateGroup(groups, group.id, { rules: items.map(chipRule).filter((rule): rule is NonNullable<typeof rule> => Boolean(rule)).slice(0, SMART_GROUP_LIMITS.rules) }))} />
    </div>
  </div>
}

const GroupItem: React.FC<{ group: SmartGroup; depth: number; edit: Edit; renaming: string | null; setRenaming(id: string | null): void }> = ({ group, depth, edit, renaming, setRenaming }) => {
  const [more, setMore] = React.useState(false)
  const name = group.name || uiText('email.smartGroups.unnamed')
  const addChild = () => { const child = newSmartGroup(); edit(groups => addGroup(groups, group.id, child)); setRenaming(child.id) }
  const menu = (x: number, y: number) => {
    void api.ui.openMenu([
      { id: 'rename', label: uiText('email.smartGroups.rename') },
      ...(depth < SMART_GROUP_LIMITS.depth - 1 ? [{ id: 'add', label: uiText('email.smartGroups.addSubgroup') }] : []),
      { type: 'separator' as const },
      { id: 'remove', label: uiText('email.smartGroups.remove'), danger: true }
    ], { x, y }).then(choice => {
      if (choice === 'rename') setRenaming(group.id)
      else if (choice === 'add') addChild()
      else if (choice === 'remove') edit(groups => removeGroup(groups, group.id))
    })
  }
  const indent = { paddingInlineStart: 6 + depth * 20 }
  return <li className="email-smart-item" data-depth={depth}>
    <div className="email-smart-row" style={indent} onContextMenu={event => { event.preventDefault(); menu(event.clientX, event.clientY) }}>
      <Tag />
      {renaming === group.id
        ? <input className="email-smart-rename" aria-label={uiText('email.smartGroups.name')} autoFocus defaultValue={group.name} maxLength={SMART_GROUP_LIMITS.name}
          onBlur={event => { const value = event.currentTarget.value.trim(); setRenaming(null); if (value !== group.name) edit(groups => updateGroup(groups, group.id, { name: value })) }}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); else if (event.key === 'Escape') { event.currentTarget.value = group.name; event.currentTarget.blur() } }} />
        : <button type="button" className="email-smart-name" title={uiText('email.smartGroups.rename')} onClick={() => setRenaming(group.id)}
          onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); const r = event.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom) } }}>{name}</button>}
      {depth < SMART_GROUP_LIMITS.depth - 1 && group.children.length < SMART_GROUP_LIMITS.siblings && <button type="button" className="email-smart-add" aria-label={uiText('email.smartGroups.addSubgroupTo', { name })} title={uiText('email.smartGroups.addSubgroup')} onClick={addChild}>+</button>}
    </div>
    <div className="email-smart-details" style={{ paddingInlineStart: 26 + depth * 20 }}>
      <SentenceField group={group} edit={edit} />
      <button type="button" className="email-smart-more" aria-expanded={more} onClick={() => setMore(open => !open)}><span aria-hidden="true">{more ? '▾' : '▸'}</span>{uiText('email.smartGroups.more')}</button>
      {more && <MoreFields group={group} edit={edit} />}
    </div>
    {group.children.length > 0 && <ul className="email-smart-list">{group.children.map(child => <GroupItem key={child.id} group={child} depth={depth + 1} edit={edit} renaming={renaming} setRenaming={setRenaming} />)}</ul>}
  </li>
}

const DailyLimit: React.FC<{ value: number; save(value: number): void }> = ({ value, save }) => {
  const [draft, setDraft] = React.useState<number | null>(value)
  React.useEffect(() => setDraft(value), [value])
  const { NumberField } = api.ui.settings
  return <NumberField ariaLabel={uiText('email.dailyAllowance')} min={0} max={10000} step={1} value={draft} onChange={setDraft}
    onCommit={next => { const clamped = Math.max(0, Math.min(10000, Math.round(next ?? value))); setDraft(clamped); if (clamped !== value) save(clamped) }} />
}

const modelValue = (ref: Pick<AiModelRef, 'provider' | 'connectionId'> | null | undefined): string => ref ? `${ref.connectionId ?? ''}\u0000${ref.provider}` : ''

export const SmartGroupsSettings: React.FC<{ footer?: React.ReactNode }> = ({ footer }) => {
  const { store, snap } = useEmail()
  const config = React.useSyncExternalStore(store.smartGroups.subscribe, store.smartGroups.get)
  const [connections, setConnections] = React.useState<AiConnectionStatus[]>([])
  const [fallback, setFallback] = React.useState<AiModelRef | undefined>()
  const [accountId, setAccountId] = React.useState('')
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const update = (mutate: (config: SmartGroupsConfig) => SmartGroupsConfig | void) => { setError(''); void store.smartGroups.update(mutate).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }
  React.useEffect(() => { void store.smartGroups.reload().catch(() => {}) }, [store])
  React.useEffect(() => {
    if (!config.enabled) return
    let active = true
    void Promise.all([api.ai.connections(), api.ai.defaults()]).then(([list, defaults]) => {
      if (!active) return
      setConnections(list.filter(connection => connection.providerCapabilities.includes('classification')))
      setFallback(defaults.classification)
    }, reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [config.enabled])
  const account = snap.accounts.find(item => item.id === accountId) ?? snap.accounts[0]
  const groups = account ? config.accounts[account.id]?.groups ?? [] : []
  const edit: Edit = change => { if (account) update(draft => { draft.accounts[account.id] = { groups: change(draft.accounts[account.id]?.groups ?? []) } }) }
  const chooseAi = async (value: string) => {
    if (!value) { update(draft => { draft.provider = null }); return }
    const connection = connections.find(item => modelValue({ provider: item.provider, connectionId: item.id }) === value)
    if (!connection) return
    const list = await api.ai.models({ provider: connection.provider, connectionId: connection.id }).catch(() => [] as AiModelInfo[])
    const model = fallback?.provider === connection.provider && list.some(item => item.id === fallback.model) ? fallback.model : list[0]?.id
    if (!model) { setError(uiText('email.smartGroups.noModels')); return }
    update(draft => { draft.provider = { provider: connection.provider, connectionId: connection.id, model } })
  }
  const aiName = (ref: AiModelRef | undefined) => ref ? connections.find(item => item.id === ref.connectionId)?.providerName ?? ref.provider : uiText('email.chooseClassifier')
  const { Section, Row, Toggle, SelectField, Button } = api.ui.settings
  return <Section title={uiText('email.smartGroups.title')}>
    <Row title={uiText('email.smartGroups.enable')} description={uiText('email.smartGroups.description')}>
      <Toggle label={uiText('email.smartGroups.enable')} checked={config.enabled} onChange={enabled => update(draft => { draft.enabled = enabled })} />
    </Row>
    {config.enabled && <div className="email-smart-groups">
      {account && <Row title={uiText('email.smartGroups.account')}>
        <SelectField ariaLabel={uiText('email.smartGroups.account')} value={account.id} onChange={id => { setRenaming(null); setAccountId(id) }}
          options={snap.accounts.map(item => ({ value: item.id, label: item.displayName || item.address, ...(item.displayName && item.displayName !== item.address ? { description: item.address } : {}) }))} />
      </Row>}
      <Row title={uiText('email.smartGroups.ai')} description={uiText('email.smartGroups.aiHint')}>
        <SelectField ariaLabel={uiText('email.smartGroups.ai')} value={modelValue(config.provider)} onChange={value => { void chooseAi(value) }}
          options={[{ value: '', label: uiText('email.smartGroups.aiDefault'), description: aiName(fallback) },
            ...connections.map(connection => ({ value: modelValue({ provider: connection.provider, connectionId: connection.id }), label: connection.label || connection.providerName, ...(connection.label ? { description: connection.providerName } : {}) }))]} />
      </Row>
      {account && <div className="email-smart-tree" role="group" aria-label={uiText('email.smartGroups.groupsFor', { account: account.address })}>
        {groups.length ? <ul className="email-smart-list">{groups.map(group => <GroupItem key={group.id} group={group} depth={0} edit={edit} renaming={renaming} setRenaming={setRenaming} />)}</ul>
          : <p className="email-settings-hint">{uiText('email.smartGroups.empty')}</p>}
        {groups.length < SMART_GROUP_LIMITS.siblings && <div className="email-smart-actions"><Button size="small" onClick={() => { const group = newSmartGroup(); edit(current => addGroup(current, null, group)); setRenaming(group.id) }}>{uiText('email.smartGroups.addGroup')}</Button></div>}
      </div>}
      <Row title={uiText('email.dailyAllowance')}><DailyLimit value={config.dailyLimit} save={dailyLimit => update(draft => { draft.dailyLimit = dailyLimit })} /></Row>
      {footer}
    </div>}
    {error && <p role="alert">{error}</p>}
  </Section>
}
