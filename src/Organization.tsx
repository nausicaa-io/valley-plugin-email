import { React, api } from './runtime'
import { useEmail } from './hooks'
import { uiText } from './localization'
import { SmartGroupsSettings } from './SmartGroupsSettings'
import { findGroupPath, flattenGroups, groupFilter, type SmartGroupsConfig } from './smartGroups'
import type { EmailFilters, EmailMessageDetail } from './mailTypes'

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
  const controls: { key: 'contact' | 'vip' | 'spam'; values: string[] }[] = [
    { key: 'contact', values: ['all', 'known', 'unknown'] }, { key: 'vip', values: ['all', 'vip', 'others'] }, { key: 'spam', values: ['default', 'not-spam', 'spam', 'all'] }
  ]
  const { SelectField, Row, Button } = api.ui.settings
  const field = (title: string, control: React.ReactNode) => settings ? <Row key={title} title={title}>{control}</Row> : <div className="email-filter-row" key={title}><span>{title}</span>{control}</div>
  return <div className={`email-filter-controls${settings ? ' in-settings' : ''}`}>
    {controls.map(({ key, values }) => field(uiText(`email.filter.${key}`), <SelectField ariaLabel={uiText(`email.filter.${key}`)} value={snap.filters[key] ?? values[0]} onChange={value => store.setFilters({ ...snap.filters, [key]: value })} options={values.map(value => ({ value, label: uiText(`email.filter.${value}`) }))} />))}
    {field(uiText('email.group'), <SelectField ariaLabel={uiText('email.group')} value={snap.filters.categoryAccountId && snap.filters.categoryId ? groupKey(snap.filters.categoryAccountId, snap.filters.categoryId) : snap.filters.categoryId ?? ''}
      onChange={value => { const [accountId, groupId] = value.split('\u0000'); store.setFilters({ ...snap.filters, ...(groupId ? groupFilter(config, accountId, groupId) : { categoryId: value || undefined, categoryIds: undefined, categoryAccountId: undefined }) }) }}
      options={[{ value: '', label: uiText('email.filter.all') }, { value: 'uncategorized', label: uiText('email.uncategorized') }, ...groupAccounts.flatMap(account => flattenGroups(config.accounts[account.id]?.groups ?? []).map(entry => ({
        value: groupKey(account.id, entry.group.id), label: entry.path.join(' / '), ...(groupAccounts.length > 1 ? { description: account.address } : {}) })))]} />)}
    <Button className="email-filter-reset" variant="ghost" size="small" onClick={() => store.setFilters({})}>{uiText('email.resetFilters')}</Button>
  </div>
}

export const MessageOrganization: React.FC<{ message: EmailMessageDetail }> = ({ message }) => {
  const { store } = useEmail()
  const config = useSmartGroups()
  const [assignment, setAssignment] = React.useState<{ categoryId: string; manual: boolean; confidence: number | null; source: string | null; bestCategoryId: string | null; bestConfidence: number | null }>({ categoryId: message.categoryId ?? '', manual: false, confidence: null, source: null, bestCategoryId: null, bestConfidence: null })
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let active = true
    const read = () => { void api.data.dataset('assignments').get({ id: message.id }).then(row => { if (active) setAssignment({ categoryId: typeof row?.categoryId === 'string' ? row.categoryId : '', manual: row?.manual === true, confidence: typeof row?.confidence === 'number' ? row.confidence : null, source: typeof row?.source === 'string' ? row.source : null,
      bestCategoryId: typeof row?.bestCategoryId === 'string' ? row.bestCategoryId : null, bestConfidence: typeof row?.bestConfidence === 'number' ? row.bestConfidence : null }) }) }
    read(); const off = api.data.dataset('assignments').subscribe(read)
    return () => { active = false; off() }
  }, [message.id])
  const run = (promise: Promise<void>) => { setError(''); void promise.catch(reason => setError(String(reason))) }
  const groups = config.enabled ? config.accounts[message.accountId]?.groups ?? [] : []
  const known = Boolean(assignment.categoryId && findGroupPath(groups, assignment.categoryId))
  const basis = !known ? '' : assignment.manual ? uiText('email.smartGroups.byYou') : assignment.source === 'rule' ? uiText('email.smartGroups.byAlways')
    : assignment.confidence !== null ? uiText('email.smartGroups.sureBasis', { percent: Math.round(assignment.confidence * 100) }) : ''
  // An ungrouped automatic result names its most likely group below the threshold, so the threshold can be tuned.
  const closest = known || assignment.manual || !assignment.bestCategoryId || assignment.bestConfidence === null ? undefined : findGroupPath(groups, assignment.bestCategoryId)
  const hint = closest ? uiText('email.smartGroups.closest', { name: closest.map(group => group.name).join(' / '), percent: Math.round(assignment.bestConfidence! * 100) }) : ''
  const SelectField = api.ui.settings.SelectField
  return <div className="email-message-organization">
    {groups.length > 0 && <div className="email-category-picker"><SelectField ariaLabel={uiText('email.group')} value={known ? assignment.categoryId : ''} onChange={value => run(store.assignCategory(message.id, value || null))}
      options={[{ value: '', label: uiText('email.uncategorized') }, ...flattenGroups(groups).map(entry => ({ value: entry.group.id, label: entry.path.join(' / ') }))]} /></div>}
    {(basis || hint) && <span className="email-category-basis">{basis || hint}</span>}
    {assignment.manual && <button onClick={() => run(store.resetCategory(message.id))}>{uiText('email.resetAutomatic')}</button>}
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

const ExistingMail: React.FC<{ ready: boolean }> = ({ ready }) => {
  const { store, snap } = useEmail()
  const [selection, setSelection] = React.useState<string[] | null>(null)
  const [error, setError] = React.useState('')
  const { Button } = api.ui.settings
  return <>
    <div className="email-organization-actions"><Button disabled={!ready} onClick={() => setSelection([])}>{uiText('email.classifyExisting')}</Button></div>
    {selection && <div className="email-classification-selection">
      <p>{uiText('email.selectExisting')}</p>
      <Button size="small" onClick={() => setSelection(snap.messages.slice(0, 2000).map(message => message.id))}>{uiText('email.selectLoaded')}</Button>
      <div>{snap.messages.slice(0, 2000).map(message => <label key={message.id}><input type="checkbox" checked={selection.includes(message.id)} onChange={event => setSelection(current => event.target.checked ? [...current!, message.id] : current!.filter(id => id !== message.id))} /><span>{message.subject}</span></label>)}</div>
      {snap.cursor && snap.messages.length < 2000 && <Button size="small" onClick={() => { void store.loadMore() }}>{uiText('email.loadMoreSelection')}</Button>}
      <div className="email-organization-actions"><Button variant="primary" disabled={!selection.length} onClick={() => { const ids = selection; setSelection(null); void store.classifyExisting(ids).catch(reason => setError(String(reason))) }}>{uiText('email.classifySelected', { count: selection.length })}</Button>
      <Button onClick={() => setSelection(null)}>{uiText('email.cancelClassification')}</Button></div>
    </div>}
    <ClassificationStatus />{error && <p role="alert">{error}</p>}
  </>
}

export const OrganizationSettings: React.FC = () => {
  const config = useSmartGroups()
  const { Section } = api.ui.settings
  const ready = Object.values(config.accounts).some(account => account.groups.length > 0)
  return <div className="email-organization-settings">
    <Section title={uiText('email.filters')}><EmailFilterControls settings /></Section>
    <SmartGroupsSettings footer={<ExistingMail ready={ready} />} />
  </div>
}
