/**
 * Root shell — wraps every route, static and dynamic alike.
 *
 * This layout deliberately mounts NO DeepSpace providers, so a page placed at
 * the top level of src/pages/ (like index.tsx) renders as a plain static page:
 * no auth session fetch, no records WebSocket, no Durable Object connection.
 *
 * The auth + realtime data layer lives one level down, in (app)/_layout.tsx.
 * Any page that needs `useAuth`, `useQuery`, `useMutations`, etc. must live
 * under src/pages/(app)/ (or (app)/(protected)/ to also require sign-in).
 * See CLAUDE.md § "Static vs dynamic pages".
 *
 * ToastProvider is local UI state (src/components/ui), not a network surface,
 * so it's safe to mount here for every page.
 */

import { Suspense } from 'react'
import { Outlet, useRouteError } from 'react-router-dom'
import { ErrorScreen } from '../components/ErrorScreen'
import { ToastProvider } from '@/components/ui'

export default function App() {
  return (
    <ToastProvider>
      {/* data-testid="app-root" is the canonical "app shell mounted" hook,
          present on every page (static and dynamic). Don't rename without
          updating templates/tests. */}
      <div data-testid="app-root" className="min-h-screen bg-background text-foreground">
        <Suspense fallback={<div className="flex items-center justify-center min-h-screen text-muted-foreground">Loading...</div>}>
          <Outlet />
        </Suspense>
      </div>
    </ToastProvider>
  )
}

/**
 * Root error boundary. Generouted wires a `_app` `Catch` export to the root
 * route's errorElement, so any render-time crash in a page — a thrown error,
 * or a hooks-rule violation like React #310 — lands here instead of React
 * Router's raw minified screen. ErrorScreen decodes the error for the developer.
 */
export function Catch() {
  const error = useRouteError()
  return <ErrorScreen error={error} />
}
