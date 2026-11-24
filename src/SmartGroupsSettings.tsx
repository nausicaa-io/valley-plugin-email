import { CONTACTS_DIRECTORY_V1, type ContactDirectoryEntry } from '@valley/plugin-sdk'
import type { AiConnectionStatus, AiModelInfo, AiModelRef } from '@valley/plugin-sdk/ai'
import { paletteCssValue } from '@valley/plugin-sdk/palette'
import type { CSSProperties, ReactElement } from 'react'
import { React, api } from './runtime'
import { useEmail } from './hooks'
import { uiText } from './localization'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Sparkles, Trash, X } from './icons'
import { EMAIL_ICON_FOLDER, EmailGroupIcon, EmailIconPicker, useEmailIcons } from './emailIcons'
import { ClassificationStatus } from './Organization'
import {
  addGroup, chipRule, countGroupedMessages, DEFAULT_THRESHOLD, flattenGroups, groupDisplayColor, groupDisplayIcon, moveGroup,
  newGroupId, newSmartGroup, nextSmartGroupColor, removeGroup, ruleChip, SMART_GROUP_LIMITS, starterGroups,
  updateGroup, type SmartGroup, type SmartGroupsConfig
} from './smartGroups'

type Edit = (change: (groups: SmartGroup[]) => SmartGroup[]) => void

/** Uncontrolled text input with shared Valley control styling so fast typing never drops characters across the bridge. */
function CommitTextField({ initial, onCommit, placeholder, ariaLabel, autoFocus, maxLength, className = '' }: {
  initial: string
  onCommit: (value: string) => void
  placeholder?: string
  ariaLabel: string
  autoFocus?: boolean
  maxLength?: number
  className?: string
}): ReactElement {
  const skip = React.useRef(false)
  return (
    <input
      className={`settings-control email-commit-input${className ? ` ${className}` : ''}`}
      type="text"
      defaultValue={initial}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      maxLength={maxLength}
      autoComplete="off"
      onBlur={(event) => {
        if (skip.current) { skip.current = false; return }
        const value = event.currentTarget.value.trim()
        if (value !== initial) onCommit(value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          const value = event.currentTarget.value.trim()
          skip.current = true
          if (value !== initial) onCommit(value)
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.currentTarget.value = initial
          skip.current = true
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function CommitTextArea({ initial, onCommit, placeholder, ariaLabel, maxLength }: {
  initial: string
  onCommit: (value: string) => void
  placeholder?: string
  ariaLabel: string
  maxLength?: number
}): ReactElement {
  const skip = React.useRef(false)
  return (
    <textarea
      className="settings-control email-commit-textarea"
      rows={2}
      defaultValue={initial}
      placeholder={placeholder}
      aria-label={ariaLabel}
      maxLength={maxLength}
      onBlur={(event) => {
        if (skip.current) { skip.current = false; return }
        const value = event.currentTarget.value.trim()
        if (value !== initial) onCommit(value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.currentTarget.value = initial
          skip.current = true
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function ConfirmRemoveButton({ onDelete, label }: { onDelete: () => void; label: string }): ReactElement {
  const [confirm, setConfirm] = React.useState(false)
  React.useEffect(() => {
    if (!confirm) return
    const timer = window.setTimeout(() => setConfirm(false), 3500)
    return () => window.clearTimeout(timer)
  }, [confirm])
  return (
    <button
      type="button"
      className={`email-group-action email-group-remove${confirm ? ' confirm' : ''}`}
      onClick={(event) => {
        event.stopPropagation()
        if (confirm) { setConfirm(false); onDelete() }
        else setConfirm(true)
      }}
      onBlur={() => setConfirm(false)}
      aria-label={confirm ? uiText('email.smartGroups.confirmRemove', { name: label }) : uiText('email.smartGroups.removeGroup', { name: label })}
      title={confirm ? uiText('email.smartGroups.clickToConfirm') : uiText('email.smartGroups.remove')}
    >
      {confirm ? <Trash /> : <X />}
    </button>
  )
}

function cloneWithFreshIds(group: SmartGroup, takenIds: Set<string>): SmartGroup {
  const id = takenIds.has(group.id) ? newGroupId() : group.id
  takenIds.add(id)
  return {
    ...group,
    id,
    rules: group.rules.map((rule) => ({ ...rule })),
    children: group.children.map((child) => cloneWithFreshIds(child, takenIds))
  }
}

const GroupCard: React.FC<{
  group: SmartGroup
  depth: number
  index: number
  siblingCount: number
  allGroups: SmartGroup[]
  counts: Readonly<Record<string, number>>
  expanded: ReadonlySet<string>
  focusNameId: string | null
  toggleExpanded(id: string): void
  expandAndFocus(id: string): void
  edit: Edit
  resolveContactChip(value: string): Promise<string>
}> = ({ group, depth, index, siblingCount, allGroups, counts, expanded, focusNameId, toggleExpanded, expandAndFocus, edit, resolveContactChip }) => {
  const isOpen = expanded.has(group.id)
  const name = group.name || uiText('email.smartGroups.unnamed')
  const displayIcon = groupDisplayIcon(group)
  const displayColor = groupDisplayColor(group)
  const messageCount = counts[group.id] ?? 0
  const [sure, setSure] = React.useState(String(group.threshold))
  React.useEffect(() => setSure(String(group.threshold)), [group.threshold])
  const { ColorField, ChipsField } = api.ui.settings

  const commitSure = (raw: string): void => {
    const parsed = Number(raw)
    const next = Number.isFinite(parsed) && raw.trim() !== '' ? Math.max(0, Math.min(100, Math.round(parsed))) : group.threshold
    setSure(String(next))
    if (next !== group.threshold) edit((groups) => updateGroup(groups, group.id, { threshold: next }))
  }

  const addChild = (): void => {
    const child = newSmartGroup('', { color: nextSmartGroupColor(allGroups) })
    edit((groups) => addGroup(groups, group.id, child))
    expandAndFocus(child.id)
  }

  const openMenu = (x: number, y: number): void => {
    void api.ui.openMenu([
      { id: 'edit', label: isOpen ? uiText('email.smartGroups.collapse') : uiText('email.smartGroups.edit') },
      ...(depth < SMART_GROUP_LIMITS.depth - 1 && group.children.length < SMART_GROUP_LIMITS.siblings ? [{ id: 'add', label: uiText('email.smartGroups.addSubgroup') }] : []),
      ...(index > 0 ? [{ id: 'up', label: uiText('email.smartGroups.moveUp') }] : []),
      ...(index < siblingCount - 1 ? [{ id: 'down', label: uiText('email.smartGroups.moveDown') }] : []),
      { type: 'separator' as const },
      { id: 'remove', label: uiText('email.smartGroups.remove'), danger: true }
    ], { x, y }).then((choice) => {
      if (choice === 'edit') toggleExpanded(group.id)
      else if (choice === 'add') addChild()
      else if (choice === 'up') edit((groups) => moveGroup(groups, group.id, -1))
      else if (choice === 'down') edit((groups) => moveGroup(groups, group.id, 1))
      else if (choice === 'remove') edit((groups) => removeGroup(groups, group.id))
    })
  }

  const cardStyle = { '--email-group-color': paletteCssValue(displayColor) } as CSSProperties

  return (
    <li className="email-smart-item" data-depth={depth}>
      <div
        className={`email-group-card${isOpen ? ' open' : ''}${depth > 0 ? ' nested' : ''}`}
        style={cardStyle}
      >
        <div
          className="email-group-card-head"
          onContextMenu={(event) => { event.preventDefault(); openMenu(event.clientX, event.clientY) }}
        >
          <button
            type="button"
            className="email-group-chevron"
            aria-expanded={isOpen}
            aria-label={isOpen ? uiText('email.smartGroups.collapseGroup', { name }) : uiText('email.smartGroups.expandGroup', { name })}
            onClick={() => toggleExpanded(group.id)}
          >
            {isOpen ? <ChevronDown /> : <ChevronRight />}
          </button>

          <EmailIconPicker
            name={name}
            icon={displayIcon}
            color={displayColor}
            onChange={(icon) => edit((groups) => updateGroup(groups, group.id, { icon }))}
          />

          <span className="email-group-color-slot" onClick={(event) => event.stopPropagation()}>
            <ColorField
              value={displayColor}
              onChange={(color) => edit((groups) => updateGroup(groups, group.id, { color }))}
              ariaLabel={uiText('email.smartGroups.colorFor', { name })}
            />
          </span>

          <button
            type="button"
            className="email-group-main"
            onClick={() => toggleExpanded(group.id)}
            onKeyDown={(event) => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault()
                const r = event.currentTarget.getBoundingClientRect()
                openMenu(r.left, r.bottom)
              }
            }}
          >
            <span className="email-group-copy">
              <span className="email-group-title">{name}</span>
              {!isOpen && group.decision && <span className="email-group-summary">{group.decision}</span>}
            </span>
          </button>

          <div className="email-group-badges">
            {messageCount > 0 && <span className="email-group-pill email-group-pill-count" title={uiText('email.smartGroups.messagesInGroup', { count: messageCount })}>{messageCount}</span>}
            {group.rules.length > 0 && <span className="email-group-pill">{uiText('email.smartGroups.sendersCount', { count: group.rules.length })}</span>}
            {group.threshold !== DEFAULT_THRESHOLD && <span className="email-group-pill">{group.threshold}%</span>}
          </div>

          <div className="email-group-actions">
            {index > 0 && (
              <button
                type="button"
                className="email-group-action"
                aria-label={uiText('email.smartGroups.moveUp')}
                title={uiText('email.smartGroups.moveUp')}
                onClick={(event) => { event.stopPropagation(); edit((groups) => moveGroup(groups, group.id, -1)) }}
              >
                <ArrowUp />
              </button>
            )}
            {index < siblingCount - 1 && (
              <button
                type="button"
                className="email-group-action"
                aria-label={uiText('email.smartGroups.moveDown')}
                title={uiText('email.smartGroups.moveDown')}
                onClick={(event) => { event.stopPropagation(); edit((groups) => moveGroup(groups, group.id, 1)) }}
              >
                <ArrowDown />
              </button>
            )}
            {depth < SMART_GROUP_LIMITS.depth - 1 && group.children.length < SMART_GROUP_LIMITS.siblings && (
              <button
                type="button"
                className="email-group-action"
                aria-label={uiText('email.smartGroups.addSubgroupTo', { name })}
                title={uiText('email.smartGroups.addSubgroup')}
                onClick={(event) => { event.stopPropagation(); addChild() }}
              >
                <Plus />
              </button>
            )}
            <ConfirmRemoveButton label={name} onDelete={() => edit((groups) => removeGroup(groups, group.id))} />
          </div>
        </div>

        {isOpen && (
          <div className="email-group-card-body">
            <div className="email-group-field">
              <label className="email-group-field-label">{uiText('email.smartGroups.name')}</label>
              <CommitTextField
                key={`name:${group.id}:${group.name}`}
                initial={group.name}
                ariaLabel={uiText('email.smartGroups.name')}
                placeholder={uiText('email.smartGroups.unnamed')}
                autoFocus={focusNameId === group.id}
                maxLength={SMART_GROUP_LIMITS.name}
                onCommit={(value) => edit((groups) => updateGroup(groups, group.id, { name: value }))}
              />
            </div>

            <div className="email-group-field">
              <label className="email-group-field-label">{uiText('email.smartGroups.when')}</label>
              <CommitTextArea
                key={`decision:${group.id}:${group.decision}`}
                initial={group.decision}
                ariaLabel={uiText('email.smartGroups.whenFor', { name })}
                placeholder={uiText('email.smartGroups.whenPlaceholder')}
                maxLength={SMART_GROUP_LIMITS.decision}
                onCommit={(value) => edit((groups) => updateGroup(groups, group.id, { decision: value }))}
              />
            </div>

            <div className="email-group-field-row">
              <div className="email-group-field email-group-sure-field">
                <label className="email-group-field-label">{uiText('email.smartGroups.sureLabel')}</label>
                <div className="email-smart-sure">
                  <span>{uiText('email.smartGroups.sure')}</span>
                  <input
                    type="number"
                    className="settings-control email-sure-input"
                    aria-label={uiText('email.smartGroups.sureFor', { name })}
                    min={0}
                    max={100}
                    step={1}
                    value={sure}
                    onChange={(event) => setSure(event.currentTarget.value)}
                    onBlur={(event) => commitSure(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); commitSure(event.currentTarget.value); event.currentTarget.blur() }
                      else if (event.key === 'Escape') { event.preventDefault(); setSure(String(group.threshold)); event.currentTarget.blur() }
                    }}
                  />
                  <span>{uiText('email.smartGroups.sureSuffix')}</span>
                </div>
              </div>

              <div className="email-group-field email-group-always-field">
                <label className="email-group-field-label">{uiText('email.smartGroups.always')}</label>
                <ChipsField
                  style={{ width: '100%' }}
                  ariaLabel={uiText('email.smartGroups.alwaysFor', { name })}
                  placeholder={uiText('email.smartGroups.alwaysPlaceholder')}
                  commitOn={['enter', 'comma', 'blur']}
                  items={group.rules.map(ruleChip)}
                  normalize={resolveContactChip}
                  validate={(value) => chipRule(value) ? true : uiText('email.smartGroups.unknownSender', { value })}
                  renderChip={(item) => { const parsed = chipRule(item); return parsed?.kind === 'contact' ? parsed.label : item }}
                  onChange={(items) => edit((groups) => updateGroup(groups, group.id, {
                    rules: items.map(chipRule).filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, SMART_GROUP_LIMITS.rules)
                  }))}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {group.children.length > 0 && (
        <ul className="email-smart-list email-smart-sublist">
          {group.children.map((child, childIndex) => (
            <GroupCard
              key={child.id}
              group={child}
              depth={depth + 1}
              index={childIndex}
              siblingCount={group.children.length}
              allGroups={allGroups}
              counts={counts}
              expanded={expanded}
              focusNameId={focusNameId}
              toggleExpanded={toggleExpanded}
              expandAndFocus={expandAndFocus}
              edit={edit}
              resolveContactChip={resolveContactChip}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

const DailyLimit: React.FC<{ value: number; save(value: number): void }> = ({ value, save }) => {
  const [draft, setDraft] = React.useState<number | null>(value)
  React.useEffect(() => setDraft(value), [value])
  const { NumberField } = api.ui.settings
  return <NumberField ariaLabel={uiText('email.dailyAllowance')} min={0} max={10000} step={1} value={draft} onChange={setDraft}
    onCommit={next => { const clamped = Math.max(0, Math.min(10000, Math.round(next ?? value))); setDraft(clamped); if (clamped !== value) save(clamped) }} />
}

const modelValue = (ref: Pick<AiModelRef, 'provider' | 'connectionId'> | null | undefined): string => ref ? `${ref.connectionId ?? ''}\u0000${ref.provider}` : ''

const SortExistingSection: React.FC<{ accountId: string; accountCount: number; ready: boolean; anyReady: boolean; groupedCount: number; totalCount: number }> = ({
  accountId, accountCount, ready, anyReady, groupedCount, totalCount
}) => {
  const { store, snap } = useEmail()
  const [selection, setSelection] = React.useState<string[] | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [error, setError] = React.useState('')
  const { Section, Button } = api.ui.settings

  const runSort = async (work: () => Promise<number>, emptyKey: string): Promise<void> => {
    setBusy(true); setError(''); setNotice('')
    try {
      const count = await work()
      setNotice(count > 0 ? uiText('email.smartGroups.queuedCount', { count }) : uiText(emptyKey))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={uiText('email.classifyExisting')}>
      <div className="email-sort-existing-header">
        <p className="email-settings-hint">
          {uiText('email.selectExisting')}
          {totalCount > 0 && ` ${uiText('email.smartGroups.groupedProgress', { grouped: groupedCount, total: totalCount })}`}
        </p>
        <div className="email-sort-existing-actions">
          <Button variant="primary" size="small" disabled={!anyReady || busy} onClick={() => { void runSort(() => store.classifyAllAccounts('reclassify'), 'email.smartGroups.nothingToRegroup') }}>
            {uiText('email.smartGroups.regroupEverything')}
          </Button>
          {accountCount > 1 && (
            <Button size="small" disabled={!ready || busy} onClick={() => { void runSort(() => store.classifyAccount(accountId, 'reclassify'), 'email.smartGroups.nothingToRegroup') }}>
              {uiText('email.smartGroups.regroupAccount')}
            </Button>
          )}
          <Button size="small" disabled={!ready || busy} onClick={() => { void runSort(() => store.classifyAccount(accountId, 'inbox-ungrouped'), 'email.smartGroups.nothingToSort') }}>
            {uiText('email.smartGroups.sortInbox')}
          </Button>
          <Button variant="ghost" size="small" disabled={!ready || busy} onClick={() => setSelection(selection ? null : [])}>
            {uiText('email.smartGroups.pickMessages')}
          </Button>
        </div>
      </div>
      {notice && <p className="email-settings-hint email-sort-notice" role="status">{notice}</p>}
      {selection && (
        <div className="email-classification-selection">
          <div className="email-classification-selection-bar">
            <Button size="small" onClick={() => setSelection(snap.messages.slice(0, 2000).map(message => message.id))}>{uiText('email.selectLoaded')}</Button>
            {snap.cursor && snap.messages.length < 2000 && <Button size="small" onClick={() => { void store.loadMore() }}>{uiText('email.loadMoreSelection')}</Button>}
          </div>
          <div className="email-classification-selection-list">
            {snap.messages.length === 0 ? <span className="email-settings-hint">{uiText('auto.34e618e62f74')}</span>
              : snap.messages.slice(0, 2000).map(message => (
                <label key={message.id}>
                  <input type="checkbox" checked={selection.includes(message.id)} onChange={event => setSelection(current => event.target.checked ? [...current!, message.id] : current!.filter(id => id !== message.id))} />
                  <span>{message.subject || uiText('email.noSubject')}</span>
                </label>
              ))}
          </div>
          <div className="email-organization-actions">
            <Button variant="primary" size="small" disabled={!selection.length} onClick={() => { const ids = selection; setSelection(null); void store.classifyExisting(ids).catch(reason => setError(String(reason))) }}>
              {uiText('email.classifySelected', { count: selection.length })}
            </Button>
            <Button size="small" onClick={() => setSelection(null)}>{uiText('email.cancelClassification')}</Button>
          </div>
        </div>
      )}
      <ClassificationStatus />
      {error && <p className="email-error" role="alert">{error}</p>}
    </Section>
  )
}

export const SmartGroupsSettings: React.FC = () => {
  useEmailIcons()
  const { store, snap } = useEmail()
  const config = React.useSyncExternalStore(store.smartGroups.subscribe, store.smartGroups.get)
  const vcfSnap = React.useSyncExternalStore(store.vcfContacts.subscribe, store.vcfContacts.getSnapshot)
  const [connections, setConnections] = React.useState<AiConnectionStatus[]>([])
  const [models, setModels] = React.useState<AiModelInfo[]>([])
  const [fallback, setFallback] = React.useState<AiModelRef | undefined>()
  const [accountId, setAccountId] = React.useState('')
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  const [focusNameId, setFocusNameId] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const presetBtnRef = React.useRef<HTMLSpanElement>(null)

  const update = (mutate: (config: SmartGroupsConfig) => SmartGroupsConfig | void) => {
    setError('')
    void store.smartGroups.update(mutate).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }

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

  React.useEffect(() => {
    if (!config.enabled || !config.provider) { setModels([]); return }
    let active = true
    void api.ai.models({ provider: config.provider.provider, connectionId: config.provider.connectionId })
      .then((list) => { if (active) setModels(list) }, () => { if (active) setModels([]) })
    return () => { active = false }
  }, [config.enabled, config.provider?.provider, config.provider?.connectionId])

  const account = snap.accounts.find(item => item.id === accountId) ?? snap.accounts[0]
  const accountGroups = account ? config.accounts[account.id]?.groups : undefined
  const groups = React.useMemo(() => accountGroups ?? [], [accountGroups])
  const flat = React.useMemo(() => flattenGroups(groups), [groups])
  const subgroupCount = flat.length - groups.length
  const allExpanded = flat.length > 0 && flat.every((entry) => expanded.has(entry.group.id))
  const [groupCounts, setGroupCounts] = React.useState<Record<string, number>>({})
  const [accountTotals, setAccountTotals] = React.useState<{ grouped: number; total: number }>({ grouped: 0, total: 0 })

  React.useEffect(() => {
    if (!config.enabled || !account) { setGroupCounts({}); setAccountTotals({ grouped: 0, total: 0 }); return }
    let active = true
    const messages = api.data.dataset('messages')
    const targetAccountId = account.id
    const load = (): void => {
      void Promise.all([
        countGroupedMessages(api, targetAccountId, groups),
        messages.count({ accountId: targetAccountId, isSpam: false, exists: { dataset: 'folder_messages', on: { id: 'messageId', accountId: 'accountId' }, where: { excluded: false, spam: false } } })
      ]).then(([counted, total]) => {
        if (!active) return
        setGroupCounts(counted.byGroup)
        setAccountTotals({ grouped: counted.grouped, total })
      }, () => {})
    }
    load()
    const off = messages.subscribe(load)
    return () => { active = false; off() }
  }, [config.enabled, account?.id, groups])

  const edit: Edit = change => {
    if (account) update(draft => { draft.accounts[account.id] = { groups: change(draft.accounts[account.id]?.groups ?? []) } })
  }

  const toggleExpanded = (id: string): void => {
    setFocusNameId(null)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const expandAndFocus = (id: string): void => {
    setFocusNameId(id)
    setExpanded((current) => new Set(current).add(id))
  }

  const resolveContactChip = React.useCallback(async (value: string): Promise<string> => {
    const trimmed = value.trim()
    if (chipRule(trimmed) || trimmed.length < 2) return trimmed
    const vcfMatches = store.vcfContacts.search(trimmed, 2)
    if (vcfMatches.length === 1) return ruleChip({ kind: 'contact', contactId: vcfMatches[0].id, label: vcfMatches[0].displayName })
    const provider = api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0]
    if (!provider) return trimmed
    const response = await provider.invoke('search', [trimmed, 2])
    const found = response.ok ? response.value as ContactDirectoryEntry[] : []
    return found.length === 1 ? ruleChip({ kind: 'contact', contactId: found[0].id, label: found[0].displayName }) : trimmed
  }, [store.vcfContacts])

  const chooseAi = async (value: string) => {
    if (!value) { update(draft => { draft.provider = null }); return }
    const connection = connections.find(item => modelValue({ provider: item.provider, connectionId: item.id }) === value)
    if (!connection) return
    const list = await api.ai.models({ provider: connection.provider, connectionId: connection.id }).catch(() => [] as AiModelInfo[])
    setModels(list)
    const model = fallback?.provider === connection.provider && list.some(item => item.id === fallback.model) ? fallback.model : list[0]?.id
    if (!model) { setError(uiText('email.smartGroups.noModels')); return }
    update(draft => { draft.provider = { provider: connection.provider, connectionId: connection.id, model } })
  }

  const openPresetPopover = (): void => {
    if (!presetBtnRef.current || !account) return
    const presets = starterGroups((key) => uiText(key))
    const existingNames = new Set(flat.map((entry) => entry.group.name.trim().toLowerCase()))
    const existingIds = new Set(flat.map((entry) => entry.group.id))
    void api.ui.openPopover(({ close }) => (
      <div className="email-preset-popover">
        <div className="email-popover-label">{uiText('email.smartGroups.addPresetTitle')}</div>
        {presets.map((preset) => {
          const already = existingNames.has(preset.name.trim().toLowerCase())
          return (
            <button
              key={preset.id}
              type="button"
              className="email-account-option"
              disabled={already}
              onClick={() => {
                const clone = cloneWithFreshIds(preset, new Set(existingIds))
                edit((current) => [...current, clone])
                close()
              }}
            >
              <EmailGroupIcon icon={groupDisplayIcon(preset)} color={groupDisplayColor(preset)} />
              <span className="email-account-copy">
                <strong>{preset.name}</strong>
                <small>{preset.decision}</small>
              </span>
            </button>
          )
        })}
        <div className="email-popover-separator" />
        <button
          type="button"
          className="email-account-option"
          onClick={() => {
            const ids = new Set(existingIds)
            const additions = presets
              .filter((preset) => !existingNames.has(preset.name.trim().toLowerCase()))
              .map((preset) => cloneWithFreshIds(preset, ids))
            if (additions.length) edit((current) => [...current, ...additions])
            close()
          }}
        >
          <Sparkles />
          <span className="email-account-copy"><strong>{uiText('email.smartGroups.addAllPresets')}</strong></span>
        </button>
      </div>
    ), { anchor: presetBtnRef.current }, { ariaLabel: uiText('email.smartGroups.addPreset') })
  }

  const aiName = (ref: AiModelRef | undefined) => ref ? connections.find(item => item.id === ref.connectionId)?.providerName ?? ref.provider : uiText('email.chooseClassifier')
  const { Section, Row, Toggle, SelectField, Button } = api.ui.settings
  const ready = Boolean(account && groups.length > 0)
  const anyReady = snap.accounts.some((item) => (config.accounts[item.id]?.groups.length ?? 0) > 0)

  return (
    <>
      <Section title={uiText('email.smartGroups.title')}>
        <Row title={uiText('email.smartGroups.enable')} description={uiText('email.smartGroups.description')}>
          <Toggle label={uiText('email.smartGroups.enable')} checked={config.enabled} onChange={enabled => update(draft => { draft.enabled = enabled })} />
        </Row>
        {config.enabled && (
          <div className="email-smart-groups">
            <Row title={uiText('email.smartGroups.ai')} description={uiText('email.smartGroups.aiHint')}>
              <SelectField ariaLabel={uiText('email.smartGroups.ai')} value={modelValue(config.provider)} onChange={value => { void chooseAi(value) }}
                options={[{ value: '', label: uiText('email.smartGroups.aiDefault'), description: aiName(fallback) },
                  ...connections.map(connection => ({ value: modelValue({ provider: connection.provider, connectionId: connection.id }), label: connection.label || connection.providerName, ...(connection.label ? { description: connection.providerName } : {}) }))]} />
            </Row>
            {config.provider && models.length > 1 && (
              <Row title={uiText('email.smartGroups.model')}>
                <SelectField
                  ariaLabel={uiText('email.smartGroups.model')}
                  value={config.provider.model}
                  onChange={(model) => update((draft) => { if (draft.provider) draft.provider = { ...draft.provider, model } })}
                  options={models.map((item) => ({ value: item.id, label: item.label || item.id }))}
                />
              </Row>
            )}
            <Row title={uiText('email.smartGroups.multiGroup')} description={uiText('email.smartGroups.multiGroupDesc')}>
              <Toggle
                label={uiText('email.smartGroups.multiGroup')}
                checked={config.multiGroup !== false}
                onChange={(multiGroup) => update((draft) => { draft.multiGroup = multiGroup })}
              />
            </Row>
            <Row title={uiText('email.dailyAllowance')}>
              <DailyLimit value={config.dailyLimit} save={dailyLimit => update(draft => { draft.dailyLimit = dailyLimit })} />
            </Row>
            {vcfSnap.count > 0 && (
              <p className="email-settings-hint email-vcf-context-note">
                {uiText('email.smartGroups.contactsContextActive', { count: vcfSnap.count, emails: vcfSnap.emailCount })}
              </p>
            )}
          </div>
        )}
        {error && <p className="email-error" role="alert">{error}</p>}
      </Section>

      {config.enabled && account && (
        <Section title={uiText('email.smartGroups.groups')}>
          <Row title={uiText('email.smartGroups.account')}>
            <SelectField
              ariaLabel={uiText('email.smartGroups.account')}
              value={account.id}
              onChange={(id) => { setFocusNameId(null); setExpanded(new Set()); setAccountId(id) }}
              options={snap.accounts.map((item) => ({
                value: item.id,
                label: item.displayName || item.address,
                ...(item.displayName && item.displayName !== item.address ? { description: item.address } : {})
              }))}
            />
          </Row>

          <div className="email-smart-overview-bar">
            <span className="email-smart-overview-meta">
              {subgroupCount > 0
                ? uiText('email.smartGroups.summaryWithSubgroups', { groups: groups.length, subgroups: subgroupCount })
                : uiText('email.smartGroups.summaryCount', { groups: groups.length })}
            </span>
            <div className="email-smart-overview-actions">
              {flat.length > 0 && (
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => setExpanded(allExpanded ? new Set() : new Set(flat.map((entry) => entry.group.id)))}
                >
                  {uiText(allExpanded ? 'email.smartGroups.collapseAll' : 'email.smartGroups.expandAll')}
                </Button>
              )}
              <span ref={presetBtnRef} className="email-preset-anchor">
                <Button size="small" onClick={openPresetPopover}>
                  {uiText('email.smartGroups.addPreset')}
                </Button>
              </span>
              {groups.length < SMART_GROUP_LIMITS.siblings && (
                <Button
                  size="small"
                  onClick={() => {
                    const group = newSmartGroup('', { color: nextSmartGroupColor(groups) })
                    edit((current) => addGroup(current, null, group))
                    expandAndFocus(group.id)
                  }}
                >
                  {uiText('email.smartGroups.addGroup')}
                </Button>
              )}
            </div>
          </div>

          <div className="email-smart-tree" role="group" aria-label={uiText('email.smartGroups.groupsFor', { account: account.address })}>
            {groups.length ? (
              <ul className="email-smart-list">
                {groups.map((group, index) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    depth={0}
                    index={index}
                    siblingCount={groups.length}
                    allGroups={groups}
                    counts={groupCounts}
                    expanded={expanded}
                    focusNameId={focusNameId}
                    toggleExpanded={toggleExpanded}
                    expandAndFocus={expandAndFocus}
                    edit={edit}
                    resolveContactChip={resolveContactChip}
                  />
                ))}
              </ul>
            ) : (
              <p className="email-settings-hint">{uiText('email.smartGroups.empty')}</p>
            )}
            <p className="email-settings-hint email-icon-folder-note">
              {uiText('email.smartGroups.iconFolderHint', { path: EMAIL_ICON_FOLDER })}
            </p>
          </div>
        </Section>
      )}

      {config.enabled && account && (
        <SortExistingSection
          accountId={account.id}
          accountCount={snap.accounts.length}
          ready={ready}
          anyReady={anyReady}
          groupedCount={accountTotals.grouped}
          totalCount={accountTotals.total}
        />
      )}
    </>
  )
}
