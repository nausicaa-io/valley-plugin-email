import { React, api } from './runtime'
import { getStore, type EmailSnapshot, type EmailStore } from './store'

export interface EmailDisplaySettings {
  htmlContent: boolean
  remoteImages: boolean
}

export const emailDisplaySettingsKey = (accountId: string): string => `accountDisplay:${accountId}`

export function readEmailDisplaySettings(accountId?: string): EmailDisplaySettings {
  const value = accountId ? api.settings.get()[emailDisplaySettingsKey(accountId)] : undefined
  const settings = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<EmailDisplaySettings> : {}
  return { htmlContent: settings.htmlContent !== false, remoteImages: settings.remoteImages !== false }
}

export function useEmailDisplaySettings(accountId?: string): EmailDisplaySettings {
  const htmlContent = React.useSyncExternalStore(api.settings.subscribe, () => readEmailDisplaySettings(accountId).htmlContent)
  const remoteImages = React.useSyncExternalStore(api.settings.subscribe, () => readEmailDisplaySettings(accountId).remoteImages)
  return { htmlContent, remoteImages }
}

/** Subscribe a view to the window-anchored store (live across hot reloads). */
export function useEmail(): { store: EmailStore; snap: EmailSnapshot } {
  const store = getStore()
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  return { store, snap }
}

export function useEmailDateFormat(): { dateFormat: string; timeFormat: '24h' | '12h' } {
  const state = React.useSyncExternalStore(api.subscribe, api.getState, api.getState)
  return { dateFormat: state.dateFormat, timeFormat: state.timeFormat }
}
