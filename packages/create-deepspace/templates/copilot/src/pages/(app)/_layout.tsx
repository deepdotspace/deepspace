/**
 * Dynamic app boundary — the auth + realtime data layer.
 *
 * `(app)` is a Generouted route group: the parentheses mean it does NOT appear
 * in the URL, so (app)/home.tsx is served at /home. Every page under this
 * folder is wrapped in the DeepSpace providers below, so it may call `useAuth`,
 * `useQuery`, `useMutations`, presence/Yjs hooks, etc.
 *
 * Pages OUTSIDE this folder (top level of src/pages/) get none of this — they
 * render as static pages with no auth fetch and no records WebSocket. Move a
 * page in or out of (app)/ to flip it between dynamic and static. Require
 * sign-in on top of the data layer by nesting under (app)/(protected)/.
 *
 * This is where the three-panel shell lives: collapsible sidebar | main
 * panel | AI chat dock. Every (app) page renders into the main panel; the
 * static landing at `/` never inherits the shell.
 */

import { Suspense, useCallback, useState, type ReactNode } from 'react'
import { Outlet } from 'react-router-dom'
import { DeepSpaceAuthProvider, useAuthStatus } from 'deepspace'
import { RecordProvider, RecordScope } from 'deepspace'
import { AppSidebar, SidebarMobileHeader } from '../../components/sidebar/AppSidebar'
import { ChatDock } from '../../components/shell/ChatDock'
import { useToast } from '@/components/ui'
import { SCOPE_ID } from '../../constants'
import { schemas } from '../../schemas'

export default function AppLayout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), [])

  return (
    <DeepSpaceAuthProvider>
      <AuthBoot>
        <div className="flex h-screen overflow-hidden bg-shell">
          <AppSidebar mobileOpen={mobileNavOpen} onMobileClose={closeMobileNav} />
          <div className="flex min-w-0 flex-1 flex-col">
            <SidebarMobileHeader onOpenMenu={() => setMobileNavOpen(true)} />
            <div className="flex min-h-0 flex-1">
              {/* The main panel — the raised rectangle every (app) page renders into. */}
              <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-shell-panel md:my-2 md:mr-2 md:rounded-xl md:border md:border-border md:shadow-[var(--shadow-card)]">
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      Loading...
                    </div>
                  }
                >
                  <Outlet />
                </Suspense>
              </main>
              {/* The AI chat — a sibling of <main>, on the shell, outside the panel. */}
              <ChatDock />
            </div>
          </div>
        </div>
      </AuthBoot>
    </DeepSpaceAuthProvider>
  )
}

/**
 * Waits for auth to resolve, then mounts the data layer. Distinct from the SDK's `AuthGate`.
 *
 * While the initial session check is in flight, renders a fixed full-viewport
 * panel in the theme background — visually identical to the pre-JS page
 * (index.html primes <html> with the same color), so a cold load shows a
 * steady theme-colored screen until the shell appears. No spinner text: the
 * check is one round-trip, and in-flow placeholders read as a layout jump.
 */
function AuthBoot({ children }: { children: ReactNode }) {
  const { isLoaded } = useAuthStatus()
  // Record writes (`create`/`put`/`remove`) are fire-and-forget — they resolve
  // before the server answers, so a denied or invalid write only surfaces
  // through onWriteError. Route rejections to toasts so they're never a
  // silent no-op. Keep this wiring when customizing the layout.
  const { error, warning } = useToast()

  if (!isLoaded) {
    return <div aria-busy="true" className="fixed inset-0 bg-background" />
  }

  return (
    <RecordProvider
      allowAnonymous
      onWriteError={(e) =>
        e.kind === 'permission' ? warning(e.title, e.detail) : error(e.title, e.detail)
      }
    >
      <RecordScope roomId={SCOPE_ID} schemas={schemas}>
        {children}
      </RecordScope>
    </RecordProvider>
  )
}
