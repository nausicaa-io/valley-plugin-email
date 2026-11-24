import type { CSSProperties } from 'react'
import { paletteCssValue } from '@valley/plugin-sdk/palette'
import { React, api } from './runtime'
import { useEmail } from './hooks'
import { uiText } from './localization'
import { Plus, X } from './icons'
import { EmailGroupIcon } from './emailIcons'
import { findGroupPath, flattenGroups, groupDisplayColor, groupDisplayIcon, groupFilter, MAX_GROUPS_PER_MESSAGE, normalizeCategoryIds, type SmartGroup, type SmartGroupsConfig } from './smartGroups'
import type { EmailMessageDetail } from './mailTypes'

const groupKey = (accountId: string, groupId: string): string => `${accountId}\u0000${groupId}`

export function useSmartGroups(): SmartGroupsConfig {
  const { store } = useEmail()
  return React.useSyncExternalStore(store.smartGroups.subscribe, store.smartGroups.get)
}

export const EmailFilterControls: React.FC<{ settings?: boolean }> = ({ settings = false }) => {
  const { store, snap } = useEmail()
  const config = useSmartGroups()
  const selected = snap.selectedAccountIds.length ? snap.selectedAccountIds : snap.accounts.map(account => account.id)
  const groupAccounts = config.enabled ? snap.accounts.filter(account => selected.includes(account.id) && config.accounts[account.id]?.groups.length) : []
  const controls: { key: 'contact' | 'spam'; values: string[] }[] = [
    { key: 'contact', values: ['all', 'known', 'unknown'] },
    { key: 'spam', values: ['default', 'not-spam', 'spam', 'all'] }
  ]
  const { SelectField, Row, Button } = api.ui.settings
  const field = (title: string, control: React.ReactNode) => settings ? <Row key={title} title={title}>{control}</Row> : <div className="email-filter-row" key={title}><span>{title}</span>{control}</div>
  return <div className={`email-filter-controls${settings ? ' in-settings' : ''}`}>
    {controls.map(({ key, values }) => field(uiText(`email.filter.${key}`), <SelectField ariaLabel={uiText(`email.filter.${key}`)} value={snap.filters[key] ?? values[0]} onChange={value => store.setFilters({ ...snap.filters, [key]: value })} options={values.map(value => ({ value, label: uiText(`email.filter.${value}`) }))} />))}
    {field(uiText('email.group'), <SelectField ariaLabel={uiText('email.group')} value={snap.filters.categoryAccountId && snap.filters.categoryId ? groupKey(snap.filters.categoryAccountId, snap.filters.categoryId) : snap.filters.categoryId ?? ''}
      onChange={value => { const [accountId, groupId] = value.split('\u0000'); store.setFilters({ ...snap.filters, ...(groupId ? groupFilter(config, accountId, groupId) : { categoryId: value || undefined, categoryIds: undefined, categoryAccountId: undefined }) }) }}
      options={[{ value: '', label: uiText('email.filter.all') }, { value: 'uncategorized', label: uiText('email.uncategorized') }, ...groupAccounts.flatMap(account => flattenGroups(config.accounts[account.id]?.groups ?? []).map(entry => ({
        value: groupKey(account.id, entry.group.id), label: entry.path.join(' / '), color: groupDisplayColor(entry.group), ...(groupAccounts.length > 1 ? { description: account.address } : {}) })))]} />)}
    <Button className="email-filter-reset" variant="ghost" size="small" onClick={() => store.setFilters({})}>{uiText('email.resetFilters')}</Button>
  </div>
}

const GroupPickerPopover: React.FC<{
  groups: SmartGroup[]
  initialIds: string[]
  onSave(next: string[]): void
  close(): void
}> = ({ groups, initialIds, onSave, close }) => {
  const [selected, setSelected] = React.useState<string[]>(initialIds)
  const flat = React.useMemo(() => flattenGroups(groups), [groups])
  const atLimit = selected.length >= MAX_GROUPS_PER_MESSAGE
  const toggle = (groupId: string) => {
    const next = selected.includes(groupId)
      ? selected.filter((id) => id !== groupId)
      : selected.length < MAX_GROUPS_PER_MESSAGE
        ? [...selected, groupId]
        : selected
    setSelected(next)
    onSave(next)
  }
  return (
    <div className="email-group-picker-popover">
      <div className="email-popover-label">{uiText('email.smartGroups.groups')}</div>
      <div className="email-group-picker-list">
        {flat.map((entry) => {
          const active = selected.includes(entry.group.id)
          const disabled = !active && atLimit
          return (
            <button
              key={entry.group.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={active}
              disabled={disabled}
              className={`email-account-option email-group-option${active ? ' selected' : ''}`}
              style={{ paddingInlineStart: 8 + entry.depth * 16 }}
              onClick={() => toggle(entry.group.id)}
            >
              <span className="email-account-check" aria-hidden="true">{active ? '✓' : ''}</span>
              <EmailGroupIcon icon={groupDisplayIcon(entry.group)} color={groupDisplayColor(entry.group)} />
              <span className="email-row-label">{entry.group.name || '…'}</span>
            </button>
          )
        })}
      </div>
      <div className="email-popover-separator" />
      <div className="email-group-picker-foot">
        <span className="email-group-picker-hint">{uiText('email.smartGroups.maxGroupsHint', { count: MAX_GROUPS_PER_MESSAGE })}</span>
        {selected.length > 0 && (
          <button
            type="button"
            className="email-group-picker-clear"
            onClick={() => { setSelected([]); onSave([]); close() }}
          >
            {uiText('email.smartGroups.clearGroups')}
          </button>
        )}
      </div>
    </div>
  )
}

export const MessageOrganization: React.FC<{ message: EmailMessageDetail }> = ({ message }) => {
  const { store } = useEmail()
  const config = useSmartGroups()
  const addRef = React.useRef<HTMLButtonElement>(null)
  const [assignment, setAssignment] = React.useState<{
    categoryIds: string[]
    manual: boolean
    confidence: number | null
    source: string | null
    bestCategoryId: string | null
    bestConfidence: number | null
  }>({
    categoryIds: normalizeCategoryIds(message.categoryIds, message.categoryId),
    manual: false,
    confidence: null,
    source: null,
    bestCategoryId: null,
    bestConfidence: null
  })
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let active = true
    const read = () => {
      void api.data.dataset('assignments').get({ id: message.id }).then((row) => {
        if (!active) return
        setAssignment({
          categoryIds: normalizeCategoryIds(row?.categoryIds, row?.categoryId),
          manual: row?.manual === true,
          confidence: typeof row?.confidence === 'number' ? row.confidence : null,
          source: typeof row?.source === 'string' ? row.source : null,
          bestCategoryId: typeof row?.bestCategoryId === 'string' ? row.bestCategoryId : null,
          bestConfidence: typeof row?.bestConfidence === 'number' ? row.bestConfidence : null
        })
      })
    }
    read()
    const off = api.data.dataset('assignments').subscribe(read)
    return () => { active = false; off() }
  }, [message.id])
  const run = (promise: Promise<void>) => { setError(''); void promise.catch((reason) => setError(String(reason))) }
  const groups = config.enabled ? config.accounts[message.accountId]?.groups ?? [] : []
  const assignedPaths = assignment.categoryIds
    .map((id) => ({ id, path: findGroupPath(groups, id) }))
    .filter((entry): entry is { id: string; path: SmartGroup[] } => Boolean(entry.path?.length))
  const assignedIds = assignedPaths.map((entry) => entry.id)
  const primary = assignedPaths[0]
  const leaf = primary?.path[primary.path.length - 1]
  const known = assignedPaths.length > 0
  const allowMulti = config.multiGroup !== false
  const basis = !known ? '' : assignment.manual ? uiText('email.smartGroups.byYou') : assignment.source === 'rule' ? uiText('email.smartGroups.byAlways')
    : assignment.confidence !== null ? uiText('email.smartGroups.sureBasis', { percent: Math.round(assignment.confidence * 100) }) : ''
  // An ungrouped automatic result names its most likely group below the threshold, so the threshold can be tuned.
  const closest = known || assignment.manual || !assignment.bestCategoryId || assignment.bestConfidence === null ? undefined : findGroupPath(groups, assignment.bestCategoryId)
  const hint = closest ? uiText('email.smartGroups.closest', { name: closest.map((group) => group.name).join(' / '), percent: Math.round(assignment.bestConfidence! * 100) }) : ''
  const SelectField = api.ui.settings.SelectField

  const openPicker = () => {
    if (!addRef.current || !groups.length) return
    void api.ui.openPopover(
      ({ close }) => (
        <GroupPickerPopover
          groups={groups}
          initialIds={assignedIds}
          onSave={(next) => run(store.assignCategories(message.id, next))}
          close={close}
        />
      ),
      { anchor: addRef.current },
      { ariaLabel: uiText('email.group') }
    )
  }

  return <div className="email-message-organization">
    {groups.length > 0 && allowMulti && (
      <>
        {assignedPaths.map(({ id, path }) => {
          const item = path[path.length - 1]
          const label = path.map((group) => group.name || '…').join(' / ')
          const color = groupDisplayColor(item)
          return (
            <span
              key={id}
              className="email-org-chip"
              style={{ '--email-tag-color': paletteCssValue(color) } as CSSProperties}
            >
              <EmailGroupIcon icon={groupDisplayIcon(item)} className="email-org-icon" />
              <span className="email-org-chip-label">{label}</span>
              <button
                type="button"
                className="email-org-chip-remove"
                aria-label={uiText('email.smartGroups.removeFromGroup', { name: label })}
                onClick={() => run(store.assignCategories(message.id, assignedIds.filter((existing) => existing !== id)))}
              >
                <X />
              </button>
            </span>
          )
        })}
        <button
          ref={addRef}
          type="button"
          className="email-org-add"
          aria-label={uiText('email.smartGroups.addGroupToMessage')}
          onClick={openPicker}
        >
          <Plus />
          <span>{uiText('email.smartGroups.addGroupToMessage')}</span>
        </button>
      </>
    )}
    {groups.length > 0 && !allowMulti && (
      <>
        {leaf && <EmailGroupIcon icon={groupDisplayIcon(leaf)} color={groupDisplayColor(leaf)} className="email-org-icon" />}
        <div className="email-category-picker">
          <SelectField
            ariaLabel={uiText('email.group')}
            value={primary?.id ?? ''}
            onChange={(value) => run(store.assignCategory(message.id, value || null))}
            options={[{ value: '', label: uiText('email.uncategorized') }, ...flattenGroups(groups).map((entry) => ({ value: entry.group.id, label: entry.path.join(' / '), color: groupDisplayColor(entry.group) }))]}
          />
        </div>
      </>
    )}
    {(basis || hint) && <span className="email-category-basis">{basis || hint}</span>}
    {assignment.manual && <button type="button" onClick={() => run(store.resetCategory(message.id))}>{uiText('email.resetAutomatic')}</button>}
    {error && <span role="alert">{error}</span>}
  </div>
}

export const ClassificationStatus: React.FC = () => {
  const { store, snap } = useEmail()
  const status = snap.classification
  if (!status.pending && !status.failed && !status.paused && !status.error) return null
  return <div className="email-classification-status" role="status">
    <span>{status.paused === 'unavailable' ? uiText('email.classifierUnavailable') : status.paused === 'rate-limited' ? uiText('email.classificationThrottled') : status.error || uiText('email.classificationProgress', { pending: status.pending, completed: status.completed, failed: status.failed })}</span>
    {status.paused && <button onClick={store.retryClassification}>{uiText('email.retry')}</button>}
    {status.pending > 0 && <button onClick={() => { void store.cancelClassification() }}>{uiText('email.cancelClassification')}</button>}
  </div>
}
