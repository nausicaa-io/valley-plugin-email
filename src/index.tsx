import { commandRegistrar, emailResults } from './commandResults'
import { AGENT_TOOL_PROVIDER_V1, SEARCH_RESULT_ACTION_V1, type ValleyPluginApi, type ValleyPluginModule } from '@valley/plugin-sdk'
import { initRuntime, React } from './runtime'
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
import { createEmailTabs, revealEmailTab } from './tabs'
import { mailApi } from './mailApi'
import { uiText } from './localization'

export function register(api: ValleyPluginApi): () => Promise<void> {
  initLocalization(api)
  initRuntime(api)
  const disposeStyles = injectStyles()
  // Instantiate the window-anchored store eagerly so account state loads.
  const store = getStore(api)
  const tabs = createEmailTabs(api, store)
  const offLinkHandler = api.links.register({
    id: 'compose',
    label: api.ui.t('manifest.name'), version: '1.0.0', categories: ['email'], schemes: ['mailto'],
    open: async ({ value }, options) => {
      await store.whenReady
      const url = new URL(value)
      const addresses = (raw: string) => raw.split(',').map(address => address.trim()).filter(address => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)).map(address => ({ address, name: '' }))
      const previous = store.getSnapshot().compose
      const compose = () => store.startCompose('new', undefined, { to: addresses(decodeURIComponent(url.pathname)), cc: addresses(url.searchParams.get('cc') ?? ''), bcc: addresses(url.searchParams.get('bcc') ?? ''), subject: (url.searchParams.get('subject') ?? '').replace(/[\r\n]/g, ' '), text: url.searchParams.get('body') ?? '' })
      if (options?.newTab) {
        // A Mod or middle click opens compose in a new Email tab once that tab has the live mailbox; the current tab stays as it is.
        const { selection } = store.captureNavigation()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10_000)
          tabs.openNew({ accountIds: selection.accountIds, view: selection.view, folder: selection.folder, query: selection.query }, uiText('auto.47da6f0838f0'), async () => {
            try { await compose() } finally { clearTimeout(timer); resolve() }
          })
        })
      } else {
        await compose()
        revealEmailTab()
      }
      return { status: store.getSnapshot().compose !== previous ? 'opened' : store.getSnapshot().selectedAccountId ? 'cancelled' : 'unavailable' }
    }
  })
  const offNotification = api.notifications.onAction(event => {
    if (event.action !== 'click' || !event.targetItemId) return
    void (async () => {
      await store.whenReady
      if (event.eventId.endsWith('.newMail')) {
        const message = JSON.parse(event.targetItemId!) as { accountId: string; folder: string; uid: number }
        await store.restoreSelection({ accountIds: [message.accountId], view: 'folder', folder: message.folder, message })
      }
      revealEmailTab()
    })().catch(() => {})
  })
  const offFlush = api.runtime.onBeforeUnload(() => store.flushDraft())
  const offCommands = registerEmailAgentCommands(api)
  const offSurfaces = registerEmailSurfaces(api)
  const offSearch = api.interop.extensions.provide(SEARCH_RESULT_ACTION_V1, {
    cardKind: 'email',
    open: async (record, context) => {
      if (typeof record.id !== 'string' || !record.id || typeof record.accountId !== 'string' || !record.accountId) return false
      const memberships = api.data.dataset('folder_messages')
      const where = { accountId: record.accountId, messageId: record.id }
      const inbox = await memberships.query({ where: { ...where, folder: 'INBOX' }, limit: 1 })
      const membership = inbox.rows[0] ?? (await memberships.query({ where, orderBy: [{ field: 'folder', direction: 'asc' }, { field: 'uid', direction: 'asc' }], limit: 1 })).rows[0]
      if (!membership || typeof membership.folder !== 'string' || typeof membership.uid !== 'number' || !Number.isSafeInteger(membership.uid) || membership.uid < 1) return false
      const target = { accountIds: [record.accountId], view: 'folder' as const, folder: membership.folder,
        message: { accountId: record.accountId, folder: membership.folder, uid: membership.uid } }
      if (context.newTab) {
        const result = await mailApi(api).readMessage(target.message)
        if (!result.ok) throw new Error(result.error || uiText('email.error.readMessage'))
        if (!result.data?.message) throw new Error(uiText('email.error.messageMissing'))
        tabs.openNew(target, result.data.message.subject || undefined)
        return true
      }
      const restored = await store.restoreSelection(target)
      if (restored) revealEmailTab()
      return restored
    }
  })

  api.registerView('email.panel', Panel)
  api.registerView('email.preview', Preview)
  api.registerView('email.page', Page)
  api.registerView('email.settings', Settings)

  const notApplied = (code: string, message: string): never => { throw Object.assign(new Error(message), { code, outcome: 'not-applied' as const }) }
  const offCompose = commandRegistrar(api)({
    id: 'compose',
    outputSchema: emailResults['compose'],
    label: 'Email: Compose', labelKey: 'auto.0a3f4e087378',
    sideEffect: 'write',
    run: async () => {
      const composer = getStore(api)
      await composer.whenReady.catch(() => undefined)
      const before = composer.getSnapshot()
      if (before.sending) notApplied('COMPOSE_SENDING', 'The open email draft is being sent.')
      if (!before.compose && !before.selectedAccountId) notApplied('ACCOUNT_UNAVAILABLE', 'No email account is available for composing.')
      const previous = { compose: before.compose, composing: before.composing, error: before.error }
      await composer.startCompose()
      const after = composer.getSnapshot()
      if (!after.composing || !after.compose) notApplied('COMPOSE_UNAVAILABLE', 'The email draft could not be opened.')
      const created = after.compose!.id !== before.compose?.id ? after.compose!.id : null
      revealEmailTab()
      return { value: null, revert: { label: 'Email: Compose', run: () => composer.revertCompose(previous, created) } }
    }
  })
  const offCloseCompose = commandRegistrar(api)({
    id: 'close-compose',
    outputSchema: emailResults['close-compose'],
    label: 'Email: Close compose', labelKey: 'email.command.closeCompose',
    sideEffect: 'execute',
    run: async () => {
      const composer = getStore(api)
      await composer.whenReady.catch(() => undefined)
      return composer.closeCompose()
    }
  })
  const offOpen = commandRegistrar(api)({
    id: 'open-mailbox',
    outputSchema: emailResults['open-mailbox'],
    label: 'Email: Open mailbox', labelKey: 'auto.ddf53deccb65',
    sideEffect: 'read',
    run: () => {
      revealEmailTab()
      return null
    }
  })
  const offSync = commandRegistrar(api)({
    id: 'sync',
    outputSchema: emailResults['sync'],
    label: 'Email: Sync folder', labelKey: 'auto.03820524c5cb',
    sideEffect: 'write',
    run: async () => {
      await getStore(api).sync()
      return { value: null, revert: null }
    }
  })
  const offFence = registerEmailFence()
  const offAgentTools = api.interop.services.provide(AGENT_TOOL_PROVIDER_V1, emailAgentTools(api))

  return () => {
    offLinkHandler()
    offNotification()
    offFlush()
    offCompose()
    offCloseCompose()
    offOpen()
    offSync()
    offFence()
    offAgentTools()
    offCommands()
    offSurfaces()
    offSearch()
    tabs.dispose()
    const drained = disposeStore(api)
    disposeStyles()
    return drained
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
