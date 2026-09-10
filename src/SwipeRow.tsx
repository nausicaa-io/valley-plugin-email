import type { EmailMessageSummary } from './mailTypes'
import { React, api } from './runtime'
import { useEmail } from './hooks'
import { Archive, Eye, EyeOff, Flag, Trash } from './icons'
import { confirmTrash, messageMenu } from './MessageActions'
import { uiText } from './localization'

const OPEN = 116
let openRow: { id: symbol; close(): void } | null = null

export const SwipeRow: React.FC<{
  message: EmailMessageSummary
  className?: string
  children: React.ReactNode
  onOpen(event: React.MouseEvent<HTMLDivElement>): void
}> = ({ message, className = '', children, onOpen }) => {
  const { store, snap } = useEmail()
  const [offset, setOffset] = React.useState(0)
  const offsetRef = React.useRef(0)
  const root = React.useRef<HTMLDivElement>(null)
  const id = React.useRef(Symbol())
  const start = React.useRef<{ x: number; y: number; offset: number; engaged: boolean } | null>(null)
  const suppressClick = React.useRef(false)
  const resetTimer = React.useRef<ReturnType<typeof setTimeout>>()
  const seen = message.flags.includes('\\Seen')
  const flagged = message.flags.includes('\\Flagged')
  const busy = snap.actionUid !== null
  const move = React.useCallback((value: number): void => {
    offsetRef.current = value
    setOffset(value)
  }, [])
  const claim = React.useCallback((): void => {
    if (openRow?.id !== id.current) openRow?.close()
    openRow = { id: id.current, close: () => move(0) }
  }, [move])
  const close = (): void => { move(0); if (openRow?.id === id.current) openRow = null }
  const settle = React.useCallback((): void => {
    move(Math.abs(offsetRef.current) >= 42 ? Math.sign(offsetRef.current) * OPEN : 0)
    resetTimer.current = setTimeout(() => { suppressClick.current = false }, 0)
  }, [move])
  React.useEffect(() => {
    const element = root.current
    if (!element) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let base: number | null = null
    const wheel = (event: WheelEvent): void => {
      if (busy || Math.abs(event.deltaX) < 3 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
      event.preventDefault()
      if (base === null) base = offsetRef.current
      claim()
      suppressClick.current = true
      const value = offsetRef.current - event.deltaX
      move(base > 0 ? Math.max(0, Math.min(OPEN, value)) : base < 0 ? Math.min(0, Math.max(-OPEN, value)) : Math.max(-OPEN, Math.min(OPEN, value)))
      clearTimeout(timer)
      timer = setTimeout(() => { settle(); base = null }, 140)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { element.removeEventListener('wheel', wheel); clearTimeout(timer) }
  }, [busy, claim, move, settle])
  React.useEffect(() => () => {
    clearTimeout(resetTimer.current)
    if (openRow?.id === id.current) openRow = null
  }, [])
  const act = async (action: 'mark-read' | 'mark-unread' | 'flag' | 'unflag' | 'archive' | 'trash'): Promise<void> => {
    close()
    if (action !== 'trash' || await confirmTrash(message)) await store.act(message, action)
  }
  const end = (event: React.PointerEvent<HTMLDivElement>, cancel = false): void => {
    const gesture = start.current
    start.current = null
    if (!gesture?.engaged) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (cancel) { close(); suppressClick.current = false }
    else settle()
  }
  const canArchive = messageMenu(message).find((item) => item.id === 'archive')?.enabled
  const canTrash = messageMenu(message).find((item) => item.id === 'trash')?.enabled
  return <div ref={root} className={`email-swipe-row ${className}`} data-side={offset > 0 ? 'leading' : offset < 0 ? 'trailing' : 'closed'}
    onContextMenu={(event) => { event.preventDefault(); close(); void api.ui.openMenu(messageMenu(message), { x: event.clientX, y: event.clientY }) }}>
    <div className="email-swipe-tray leading" aria-hidden={offset <= 0}>
      <button className="email-swipe-read" disabled={offset <= 0 || busy} tabIndex={offset > 0 ? 0 : -1} title={uiText(seen ? 'auto.623bab0e0954' : 'auto.3bf98fa618b6')} onClick={() => { void act(seen ? 'mark-unread' : 'mark-read') }}>
        {seen ? <EyeOff /> : <Eye />}<span>{uiText(seen ? 'auto.07b032b56f7a' : 'auto.852b438f91ad')}</span></button>
      <button className="email-swipe-archive" disabled={offset <= 0 || !canArchive} tabIndex={offset > 0 ? 0 : -1} onClick={() => { void act('archive') }}><Archive /><span>{uiText('auto.2621c6fd51a5')}</span></button>
    </div>
    <div className="email-swipe-tray trailing" aria-hidden={offset >= 0}>
      <button className="email-swipe-flag" disabled={offset >= 0 || busy} tabIndex={offset < 0 ? 0 : -1} onClick={() => { void act(flagged ? 'unflag' : 'flag') }}><Flag filled={flagged} /><span>{uiText(flagged ? 'auto.b855c604e861' : 'auto.a774409a00c2')}</span></button>
      <button className="danger" disabled={offset >= 0 || !canTrash} tabIndex={offset < 0 ? 0 : -1} onClick={() => { void act('trash') }}><Trash /><span>{uiText('auto.e3bf62bb7f5a')}</span></button>
    </div>
    <div className="email-swipe-content" role="button" tabIndex={0} style={{ transform: `translate3d(${offset}px,0,0)` }}
      onPointerDown={(event) => { if (event.button === 0 && !busy) start.current = { x: event.clientX, y: event.clientY, offset: offsetRef.current, engaged: false } }}
      onPointerMove={(event) => {
        const gesture = start.current
        if (!gesture) return
        const dx = event.clientX - gesture.x
        const dy = event.clientY - gesture.y
        if (!gesture.engaged) {
          if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy) * 1.15) return
          gesture.engaged = true; claim(); suppressClick.current = true
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }
        event.preventDefault()
        const value = gesture.offset + dx
        move(gesture.offset > 0 ? Math.max(0, Math.min(OPEN, value)) : gesture.offset < 0 ? Math.min(0, Math.max(-OPEN, value)) : Math.max(-OPEN, Math.min(OPEN, value)))
      }} onPointerUp={(event) => end(event)} onPointerCancel={(event) => end(event, true)}
      onClick={(event) => { if (suppressClick.current) return; if (offsetRef.current) close(); else onOpen(event) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); close() }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (offsetRef.current) close(); else onOpen(event as unknown as React.MouseEvent<HTMLDivElement>) }
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); void api.ui.openMenu(messageMenu(message), { anchor: event.currentTarget })
        }
      }}>{children}</div>
  </div>
}
