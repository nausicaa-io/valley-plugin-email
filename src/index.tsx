import { AGENT_TOOL_PROVIDER_V1, type ValleyPluginApi, type ValleyPluginModule } from '@valley/plugin-sdk'
import { initRuntime } from './runtime'
import { injectStyles } from './styles'
import { getStore, disposeStore } from './store'
import { registerEmailFence } from './fence'
import { Panel } from './Panel'
import { Preview } from './Preview'
import { Page } from './Page'
import { Settings } from './Settings'
import { initLocalization } from './localization'
import { emailAgentTools, registerEmailAgentCommands } from './agentTools'
import { registerEmailSurfaces } from './surfaces'

export function register(api: ValleyPluginApi): () => Promise<void> {
  initLocalization(api)
  initRuntime(api)
  const disposeStyles = injectStyles()
  // Instantiate the window-anchored store eagerly so account state loads.
  const store = getStore(api)
  const offFlush = api.runtime.onBeforeUnload(() => store.flushDraft())
  const offCommands = registerEmailAgentCommands(api)
  const offSurfaces = registerEmailSurfaces(api)

  api.registerView('email.panel', Panel)
  api.registerView('email.preview', Preview)
  api.registerView('email.page', Page)
  api.registerView('email.settings', Settings)

  const offCompose = api.commands.register({
    id: 'compose',
    label: 'Email: Compose', labelKey: 'auto.0a3f4e087378',
    sideEffect: 'read',
    run: () => {
      getStore(api).startCompose()
      api.workspace.openMainTab()
      return undefined
    }
  })
  const offOpen = api.commands.register({
    id: 'open-mailbox',
    label: 'Email: Open mailbox', labelKey: 'auto.ddf53deccb65',
    sideEffect: 'read',
    run: () => {
      api.workspace.openMainTab()
      return undefined
    }
  })
  const offSync = api.commands.register({
    id: 'sync',
    label: 'Email: Sync folder', labelKey: 'auto.03820524c5cb',
    sideEffect: 'write',
    run: async () => {
      await getStore(api).sync()
      return { value: undefined, revert: null }
    }
  })
  const offFence = registerEmailFence()
  const offAgentTools = api.interop.services.provide(AGENT_TOOL_PROVIDER_V1, emailAgentTools(api))

  return () => {
    offFlush()
    offCompose()
    offOpen()
    offSync()
    offFence()
    offAgentTools()
    offCommands()
    offSurfaces()
    const drained = disposeStore(api)
    disposeStyles()
    return drained
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
