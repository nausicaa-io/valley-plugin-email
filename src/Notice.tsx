import type { FC } from 'react'
import { useEmail } from './hooks'
import { Warning } from './icons'
import { uiText } from './localization'
import { React } from './runtime'

/**
 * The one way this plugin reports a failure: a bordered notice carrying what
 * failed, the driver's own message and a way out — never loose red body text,
 * and never a generic sentence that throws the real cause away.
 */
export const ErrorNotice: FC<{ onRetry?: () => void }> = ({ onRetry }) => {
  const { store, snap } = useEmail()
  if (!snap.error) return null

  return (
    <div className="email-notice" role="alert">
      <span className="email-notice-glyph"><Warning className="" /></span>
      <div className="email-notice-body">
        <span className="email-notice-title">{uiText('auto.d39931eb8f32')}</span>
        <span className="email-notice-detail">{snap.error || uiText('auto.06a8b55be555')}</span>
        <div className="email-notice-actions">
          {onRetry && (
            <button className="email-notice-btn" onClick={onRetry}>{uiText('auto.042c862e4467')}</button>
          )}
          <button className="email-notice-btn subtle" onClick={() => store.dismissError()}>
            {uiText('auto.70afe9eff3f2')}
          </button>
        </div>
      </div>
    </div>
  )
}
