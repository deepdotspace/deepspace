const RELOAD_KEY = 'deepspace:reloaded-for-stale-chunk'

interface RouterState {
  initialized: boolean
  errors: unknown
}

interface RouterInitialization {
  readonly state: RouterState
  subscribe(listener: (state: RouterState) => void): () => void
}

interface RecoveryOptions {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  reload: () => void
  onPreloadError: (listener: (event: Pick<Event, 'preventDefault'>) => void) => void
}

function browserRecovery(): RecoveryOptions {
  let storage: RecoveryOptions['storage'] = null
  try {
    storage = sessionStorage
  } catch {
    // Storage can be unavailable under hardened privacy settings. Without a
    // durable attempt marker, reloading could loop forever, so fail closed.
  }
  return {
    storage,
    reload: () => window.location.reload(),
    onPreloadError: (listener) => window.addEventListener('vite:preloadError', listener),
  }
}

function readReloadAttempt(storage: RecoveryOptions['storage']): boolean {
  if (!storage) return true
  try {
    const attempted = storage.getItem(RELOAD_KEY) === '1'
    storage.removeItem(RELOAD_KEY)
    return attempted
  } catch {
    return true
  }
}

function rememberReloadAttempt(storage: RecoveryOptions['storage']): boolean {
  if (!storage) return false
  try {
    storage.setItem(RELOAD_KEY, '1')
    return true
  } catch {
    return false
  }
}

function clearReloadAttempt(storage: RecoveryOptions['storage']): void {
  try {
    storage?.removeItem(RELOAD_KEY)
  } catch {
    // A successful route load is enough to reset this tab's in-memory guard.
  }
}

/** Reload a stale tab once, then surface a persistent route-chunk failure. */
export function installStaleChunkRecovery(
  router: RouterInitialization,
  { storage, reload, onPreloadError }: RecoveryOptions = browserRecovery(),
): void {
  let reloadAttempted = readReloadAttempt(storage)

  onPreloadError((event) => {
    if (reloadAttempted) return
    if (!rememberReloadAttempt(storage)) return
    reloadAttempted = true
    event.preventDefault()
    reload()
  })

  let unsubscribe = () => {}
  const clearAfterSuccessfulRouteLoad = (state: RouterState) => {
    if (!state.initialized || state.errors) return
    reloadAttempted = false
    clearReloadAttempt(storage)
    unsubscribe()
  }
  unsubscribe = router.subscribe(clearAfterSuccessfulRouteLoad)
  clearAfterSuccessfulRouteLoad(router.state)
}
