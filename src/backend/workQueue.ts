export const MAIL_WORK_LIMITS = { active: 4, queued: 32, queuedPerAccount: 8, inputBytes: 8 * 1024 * 1024 } as const

interface Work {
  keys: string[]
  bytes: number
  run(): Promise<unknown>
  resolve(value: unknown): void
  reject(error: unknown): void
}

export function createMailWorkQueue(errors: { busy(): string; stopped(): string }) {
  const queued: Work[] = []
  const activeKeys = new Set<string>()
  const running = new Set<Promise<void>>()
  let inputBytes = 0
  let closed = false
  let draining: Promise<void> | undefined

  const pump = (): void => {
    while (!closed && running.size < MAIL_WORK_LIMITS.active) {
      const blocked = new Set(activeKeys)
      const index = queued.findIndex(work => {
        if (!work.keys.some(key => blocked.has(key))) return true
        work.keys.forEach(key => blocked.add(key))
        return false
      })
      if (index < 0) return
      const work = queued.splice(index, 1)[0]
      work.keys.forEach(key => activeKeys.add(key))
      const finish = (): void => {
        inputBytes -= work.bytes
        work.keys.forEach(key => activeKeys.delete(key))
        running.delete(pending)
        pump()
      }
      const pending = Promise.resolve().then(() => {
        if (closed) throw new Error(errors.stopped())
        return work.run()
      }).then(value => { finish(); work.resolve(value) }, error => { finish(); work.reject(error) })
      running.add(pending)
    }
  }

  return {
    run<T>(keys: string[], bytes: number, run: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error(errors.stopped()))
      const unique = [...new Set(keys)]
      if (queued.length >= MAIL_WORK_LIMITS.queued || bytes > MAIL_WORK_LIMITS.inputBytes - inputBytes
        || unique.some(key => key.startsWith('account:') && queued.filter(work => work.keys.includes(key)).length >= MAIL_WORK_LIMITS.queuedPerAccount)) {
        return Promise.reject(new Error(errors.busy()))
      }
      inputBytes += bytes
      return new Promise<T>((resolve, reject) => {
        queued.push({ keys: unique, bytes, run, resolve: value => resolve(value as T), reject })
        pump()
      })
    },
    dispose(): Promise<void> {
      if (draining) return draining
      closed = true
      for (const work of queued.splice(0)) {
        inputBytes -= work.bytes
        work.reject(new Error(errors.stopped()))
      }
      draining = Promise.allSettled([...running]).then(() => {})
      return draining
    }
  }
}
