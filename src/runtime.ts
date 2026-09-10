import type { ValleyPluginApi } from '@valley/plugin-sdk'

/**
 * Module-global handles to the host's React instance and plugin API, set once in
 * `register(api)` before any view renders — same pattern as the music/sideNotes
 * plugins. Components import these instead of bundling their own `react`.
 */
export let React!: typeof import('react')
export let api!: ValleyPluginApi

export function initRuntime(a: ValleyPluginApi): void {
  api = a
  React = a.React
}
