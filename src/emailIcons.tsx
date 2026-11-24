import type { CSSProperties, ReactElement } from 'react'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { paletteCssValue } from '@valley/plugin-sdk/palette'
import { React, api } from './runtime'
import { uiText } from './localization'
import { DEFAULT_EMAIL_ICONS } from './backend/iconDefaults'

/** Realm-relative folder of Email grouping icons (seeded by the backend); add an SVG there to offer it. */
export const EMAIL_ICON_FOLDER = '.valley/assets/icons/email-icon'

function iconKey(name: string | undefined): string {
  return (name ?? '').trim().toLowerCase().replace(/\.svg$/, '').replace(/[^\p{L}\p{N}]/gu, '')
}

const ELEMENTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'defs', 'clipPath', 'title', 'desc'])
const ATTRIBUTES = new Set([
  'xmlns', 'viewBox', 'width', 'height', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'points', 'fill', 'fill-rule', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity',
  'stroke-dasharray', 'clip-rule', 'clip-path', 'opacity', 'transform', 'id'
])

export function sanitizeEmailSvg(source: string): string | null {
  if (source.length > 64_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) return null
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return null
  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = document.documentElement
  if (root.localName !== 'svg' || document.querySelector('parsererror')) return null
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (!ELEMENTS.has(node.tagName)) { node.remove(); continue }
    for (const attribute of Array.from(node.attributes)) {
      if (!ATTRIBUTES.has(attribute.name) || /url\s*\(|javascript:|expression\s*\(/i.test(attribute.value)) node.removeAttribute(attribute.name)
    }
  }
  if (!root.querySelector('path,circle,ellipse,rect,line,polyline,polygon')) return null
  root.setAttribute('width', '100%')
  root.setAttribute('height', '100%')
  return new XMLSerializer().serializeToString(root)
}

interface Registry {
  svgs: Record<string, string>
  keys: Map<string, string>
  revision: number
  loaded: boolean
  listeners: Set<() => void>
  pending: Promise<void> | null
}

function buildKeyMap(svgs: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>()
  for (const name of Object.keys(svgs).sort()) {
    const k = iconKey(name)
    if (k && !map.has(k)) map.set(k, name)
  }
  return map
}

function registry(owner = api): Registry {
  return owner.runtime.getOrCreate('email.icons', () => {
    const svgs = { ...DEFAULT_EMAIL_ICONS }
    return {
      svgs,
      keys: buildKeyMap(svgs),
      revision: 0,
      loaded: false,
      listeners: new Set<() => void>(),
      pending: null
    } as Registry
  })
}

const sanitized = new Map<string, string | null>()
function clean(source: string): string | null {
  let value = sanitized.get(source)
  if (value === undefined) {
    try { value = sanitizeEmailSvg(source) } catch { value = null }
    sanitized.set(source, value)
  }
  return value
}

export function refreshEmailIcons(owner = api): Promise<void> {
  const current = registry(owner)
  if (current.pending) return current.pending
  current.pending = owner.backend.call<{ icons?: Record<string, string> }>('emailIcons', {}).then((result) => {
    const svgs: Record<string, string> = { ...DEFAULT_EMAIL_ICONS }
    for (const [name, source] of Object.entries(result?.icons ?? {})) {
      const svg = typeof source === 'string' ? clean(source) : null
      if (svg) svgs[name] = svg
    }
    current.svgs = svgs
    current.keys = buildKeyMap(svgs)
    current.loaded = true
    current.revision += 1
    for (const listener of [...current.listeners]) listener()
  }).catch(() => {
    current.loaded = true
  }).finally(() => { current.pending = null })
  return current.pending
}

/** Re-render when the icon folder is read again; the first caller in a document loads it. */
export function useEmailIcons(): Record<string, string> {
  const current = registry(api)
  React.useEffect(() => { if (!current.loaded) void refreshEmailIcons() }, [current])
  React.useSyncExternalStore(
    React.useCallback((listener: () => void) => { current.listeners.add(listener); return () => { current.listeners.delete(listener) } }, [current]),
    () => current.revision
  )
  return current.svgs
}

/** Load icons on start and reload whenever a file in `.valley/assets/icons/email-icon/` changes. */
export function initializeEmailIcons(owner: ValleyPluginApi): () => void {
  void refreshEmailIcons(owner)
  let timer: ReturnType<typeof setTimeout> | undefined
  const off = owner.realm.onChanged((info) => {
    if (!info.full && !info.changes.some((change) => change.relPath.startsWith(`${EMAIL_ICON_FOLDER}/`))) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void refreshEmailIcons(owner) }, 150)
  })
  return () => { if (timer) clearTimeout(timer); off() }
}

export function emailIconSvg(name: string | undefined, owner = api): string {
  const current = registry(owner)
  const key = current.keys.get(iconKey(name)) ?? 'tag'
  return current.svgs[key] ?? DEFAULT_EMAIL_ICONS.tag
}

export const EmailGroupIcon: React.FC<{ icon?: string; color?: string; className?: string }> = ({ icon, color, className }) => {
  useEmailIcons()
  const svg = emailIconSvg(icon)
  const style: CSSProperties | undefined = color ? { color: paletteCssValue(color) } : undefined
  return <span className={`email-group-icon${className ? ` ${className}` : ''}`} style={style} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
}

export function EmailIconPicker({ name, icon, color, onChange }: {
  name: string
  icon?: string
  color?: string
  onChange: (icon: string | undefined) => void
}): ReactElement {
  const ref = React.useRef<HTMLButtonElement>(null)
  const label = uiText('email.smartGroups.chooseIcon', { name })
  return (
    <button
      ref={ref}
      type="button"
      className="email-icon-picker-btn"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        if (!ref.current) return
        void api.ui.openPopover(
          (ctx) => <EmailIconGrid current={icon} color={color} onPick={(next) => { onChange(next); ctx.close() }} />,
          { anchor: ref.current },
          { className: 'email-icon-picker', ariaLabel: label }
        )
      }}
    >
      <EmailGroupIcon icon={icon} color={color} />
    </button>
  )
}

function EmailIconGrid({ current, color, onPick }: { current?: string; color?: string; onPick: (icon: string | undefined) => void }): ReactElement {
  const svgs = useEmailIcons()
  const [query, setQuery] = React.useState('')
  const shown = Object.keys(svgs).sort().filter((name) => iconKey(name).includes(iconKey(query)))
  const tint: CSSProperties | undefined = color ? { color: paletteCssValue(color) } : undefined
  return (
    <div className="email-icon-picker-body">
      <input
        className="settings-control email-icon-picker-search"
        autoFocus
        value={query}
        placeholder={uiText('email.smartGroups.searchIcons')}
        aria-label={uiText('email.smartGroups.searchIcons')}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && shown[0]) { event.preventDefault(); onPick(shown[0]) }
        }}
      />
      <button type="button" className="email-icon-picker-default" aria-pressed={!current} onClick={() => onPick(undefined)}>
        {uiText('email.smartGroups.defaultIcon')}
      </button>
      <div className="email-icon-picker-grid">
        {shown.map((name) => (
          <button
            key={name}
            type="button"
            className={`email-icon-picker-tile${name === current ? ' selected' : ''}`}
            style={name === current ? tint : undefined}
            title={`${name}.svg`}
            aria-label={`${name}.svg`}
            aria-pressed={name === current}
            onClick={() => onPick(name)}
          >
            <span className="email-group-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svgs[name] }} />
          </button>
        ))}
      </div>
      {!shown.length && <span className="settings-empty-text">{uiText('email.smartGroups.noIcons')}</span>}
      <span className="email-icon-picker-hint">{uiText('email.smartGroups.iconFolderHint', { path: EMAIL_ICON_FOLDER })}</span>
    </div>
  )
}
