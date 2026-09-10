import { React } from './runtime'
import type { ReactElement, ReactNode } from 'react'

/**
 * Inline SVG icons (Lucide-style), drawn with the host's React. Plugins cannot
 * bundle react-icons (it would drag in a second React instance), so the glyphs
 * are hand-rolled and stay monochrome via currentColor.
 */
type IconProps = { className?: string; title?: string }

const Svg = (props: IconProps & { children: ReactNode }): ReactElement =>
  React.createElement(
    'svg',
    {
      className: props.className,
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true
    },
    props.title ? React.createElement('title', null, props.title) : null,
    props.children
  )

export const Mail = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-10 5L2 7" />
  </Svg>
)

export const Inbox = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </Svg>
)

export const Send = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </Svg>
)


export const Reload = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M20 7v5h-5" />
    <path d="M20 12a8 8 0 1 1-2.34-5.66L20 9" />
  </Svg>
)

export const Plus = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </Svg>
)

export const ChevronLeft = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
)

export const ChevronRight = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
)

export const ChevronDown = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
)

export const Search = (p: IconProps): ReactElement => (
  <Svg {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Svg>
)

export const Archive = (p: IconProps): ReactElement => (
  <Svg {...p}><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11h14V8" /><path d="M10 12h4" /></Svg>
)

export const Junk = (p: IconProps): ReactElement => (
  <Svg {...p}><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11h14V8m-9 3 4 5m0-5-4 5" /></Svg>
)

export const ReplyAll = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="m7 17-5-5 5-5m5 10-5-5 5-5" /><path d="M7 12h8a6 6 0 0 1 6 6v1" /></Svg>
)

export const Flag = (p: IconProps & { filled?: boolean }): ReactElement => (
  <svg className={p.className} width="16" height="16" viewBox="0 0 24 24" fill={p.filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 21V4" /><path d="M5 4h11l-1 4 3 4H5" />
  </svg>
)

export const Reply = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="m9 17-5-5 5-5" /><path d="M4 12h10a6 6 0 0 1 6 6v1" /></Svg>
)

export const Forward = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="m15 17 5-5-5-5" /><path d="M20 12H10a6 6 0 0 0-6 6v1" /></Svg>
)

export const Eye = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12" /><circle cx="12" cy="12" r="3" /></Svg>
)

export const EyeOff = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="m3 3 18 18" /><path d="M10.6 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2 3" /><path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1" /></Svg>
)

export const Warning = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Svg>
)

export const Trash = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Svg>
)


/** Full-color brand glyphs (own fills, not the monochrome Svg wrapper). */
const BrandSvg = (props: IconProps & { children: ReactNode }): ReactElement =>
  React.createElement(
    'svg',
    { className: props.className, width: 20, height: 20, viewBox: '0 0 24 24', 'aria-hidden': true },
    props.children
  )

export const Google = (p: IconProps): ReactElement => (
  <BrandSvg {...p}>
    <path fill="#4285F4" d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.86c2.26-2.09 3.57-5.17 3.57-8.87z" />
    <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24z" />
    <path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09z" />
    <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
  </BrandSvg>
)

export const Microsoft = (p: IconProps): ReactElement => (
  <BrandSvg {...p}>
    <rect x="2" y="2" width="9.5" height="9.5" fill="#F25022" />
    <rect x="12.5" y="2" width="9.5" height="9.5" fill="#7FBA00" />
    <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00A4EF" />
    <rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#FFB900" />
  </BrandSvg>
)

export const Paperclip = (p: IconProps): ReactElement => <Svg {...p}><path d="m21 11-9 9a6 6 0 0 1-8-8L14 2a4 4 0 0 1 6 6L9 19a2 2 0 0 1-3-3L16 6" /></Svg>
