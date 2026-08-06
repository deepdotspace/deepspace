import { createRoot } from 'react-dom/client'
import { Routes } from '@generouted/react-router'
import './styles.css'

/**
 * Recover a tab that outlived a deploy: its index.html names chunks the deploy
 * deleted, so the next lazy route fails to import. One reload picks up the
 * current build. The session flag stops a loop when the cause is not staleness.
 */
const RELOAD_KEY = 'deepspace:reloaded-for-stale-chunk'
window.addEventListener('vite:preloadError', (event) => {
  if (sessionStorage.getItem(RELOAD_KEY)) return
  event.preventDefault()
  sessionStorage.setItem(RELOAD_KEY, '1')
  window.location.reload()
})
// Got here, so the current chunks load: clear the guard for the next deploy.
sessionStorage.removeItem(RELOAD_KEY)

createRoot(document.getElementById('root')!).render(<Routes />)
