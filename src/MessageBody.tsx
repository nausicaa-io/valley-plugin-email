import DOMPurify from 'dompurify'
import type { EmailMessageDetail } from './mailTypes'
import { api, React } from './runtime'
import { uiText } from './localization'
import { useEmailDisplaySettings } from './hooks'

export function emailDocument(html: string, remoteImages = true): { document: string; blockedImages: boolean } {
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'base', 'link', 'audio', 'video', 'source'],
    FORBID_ATTR: ['srcset', 'ping', 'download', 'autofocus', 'contenteditable'],
    ALLOW_DATA_ATTR: false
  })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  let blockedImages = false
  for (const image of doc.querySelectorAll('img')) {
    const src = image.getAttribute('src')?.trim() ?? ''
    const embedded = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(src)
    const remote = /^(https?:)?\/\//i.test(src)
    image.setAttribute('referrerpolicy', 'no-referrer')
    if (remote && remoteImages) {
      image.setAttribute('src', src.startsWith('//') ? `https:${src}` : src)
    } else if (!embedded) {
      image.removeAttribute('src')
      if (remote) blockedImages = true
    }
  }
  for (const link of doc.querySelectorAll('a')) {
    const href = link.getAttribute('href')?.trim() ?? ''
    link.removeAttribute('href')
    link.removeAttribute('target')
    if (/^(https?:\/\/|mailto:)/i.test(href)) {
      link.dataset.emailHref = href
      link.setAttribute('role', 'link')
      link.setAttribute('tabindex', '0')
      link.setAttribute('title', href)
    }
  }
  const policy = doc.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:${remoteImages ? ' https: http:' : ''}; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`
  doc.head.prepend(policy)
  const referrer = doc.createElement('meta')
  referrer.name = 'referrer'
  referrer.content = 'no-referrer'
  doc.head.append(referrer)
  const style = doc.createElement('style')
  style.textContent = `
    html,body{height:auto!important;min-height:0!important;max-height:none!important}
    html{color-scheme:light;background:#fff;color:#202124;overflow-wrap:anywhere}
    body{display:flow-root;box-sizing:border-box;margin:0!important;padding:24px;min-width:0!important;width:auto!important;font:15px/1.6 system-ui,sans-serif}
    img{max-width:100%!important;height:auto!important;object-fit:contain}
    table{max-width:100%!important}td,th{overflow-wrap:anywhere}
    a[data-email-href]{cursor:pointer}a[data-email-href]:not([style]){color:#1769aa;text-decoration:underline}
    pre{white-space:pre-wrap;overflow-wrap:anywhere}
    @media(max-width:480px){body{padding:16px}}
  `
  doc.head.append(style)
  return { document: `<!doctype html>${doc.documentElement.outerHTML}`, blockedImages }
}

export const MessageBody: React.FC<{ message: EmailMessageDetail; plain?: boolean; remoteImages?: boolean }> = ({ message, plain: plainOverride, remoteImages: remoteImagesOverride }) => {
  const settings = useEmailDisplaySettings(message.accountId)
  const plain = plainOverride ?? !settings.htmlContent
  const remoteImages = remoteImagesOverride ?? settings.remoteImages
  const [height, setHeight] = React.useState(320)
  const frame = React.useRef<HTMLIFrameElement>(null)
  const content = React.useMemo(() => message.html && !plain ? emailDocument(message.html, remoteImages) : null, [message.html, plain, remoteImages])
  React.useEffect(() => {
    const element = frame.current
    if (!element || !content) return
    setHeight(320)
    let pending: number | null = null
    let disconnect: (() => void) | undefined
    const connect = (): void => {
      pending = null
      const doc = element.contentDocument
      if (!doc?.body || doc.URL !== 'about:srcdoc' || doc.readyState === 'loading') {
        pending = requestAnimationFrame(connect)
        return
      }
      const measure = (): void => {
        pending = null
        const body = doc.body
        const bounds = body.getBoundingClientRect()
        const margin = parseFloat(doc.defaultView!.getComputedStyle(body).marginBottom) || 0
        const next = Math.min(30000, Math.max(120, Math.ceil(bounds.top + Math.max(bounds.height, body.scrollHeight) + margin)))
        setHeight((previous) => previous === next ? previous : next)
      }
      const resize = (): void => {
        if (pending === null) pending = requestAnimationFrame(measure)
      }
      const activate = (event: MouseEvent | KeyboardEvent): void => {
        if ('key' in event && event.key !== 'Enter') return
        const target = event.target as Element | null
        const href = target?.closest('a[data-email-href]')?.getAttribute('data-email-href')
        if (!href) return
        event.preventDefault()
        void api.files.openExternalUrl(href)
      }
      doc.addEventListener('click', activate)
      doc.addEventListener('keydown', activate)
      doc.addEventListener('load', resize, true)
      doc.addEventListener('error', resize, true)
      const Observer = (doc.defaultView as typeof window | null)?.ResizeObserver ?? globalThis.ResizeObserver
      const observer = Observer ? new Observer(resize) : null
      observer?.observe(doc.body)
      measure()
      disconnect = () => {
        observer?.disconnect()
        doc.removeEventListener('click', activate)
        doc.removeEventListener('keydown', activate)
        doc.removeEventListener('load', resize, true)
        doc.removeEventListener('error', resize, true)
      }
    }
    pending = requestAnimationFrame(connect)
    return () => {
      if (pending !== null) cancelAnimationFrame(pending)
      disconnect?.()
    }
  }, [content])
  return <div className="email-body-content">
    {content && !plain && content.blockedImages && <div className="email-body-options"><span>{uiText('email.imagesBlocked')}</span></div>}
    {content && !plain ? <iframe key={content.document} ref={frame} className="email-html-body" title={uiText('email.htmlBody')} sandbox="allow-same-origin" referrerPolicy="no-referrer"
      srcDoc={content.document} style={{ height }} /> : message.text || message.snippet || uiText('auto.d141aa8bcb1f')}
  </div>
}
