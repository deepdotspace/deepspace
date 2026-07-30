/**
 * Placeholder home page — replace this with the app's real home.
 *
 * This is intentionally unstyled scaffolding, not a design to build on.
 * Design the app's own look (layout, theme tokens, typography) from your
 * product's point of view instead of extending this page.
 */

import { useAuthProfileReady } from 'deepspace'
import { APP_NAME } from '../../constants'

export default function HomePage() {
  const { isSignedIn, user } = useAuthProfileReady({ requireUser: true })

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
      <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        This is a placeholder page. Replace <code>src/pages/(app)/home.tsx</code>{' '}
        with the app&apos;s real home, and give the app its own theme in{' '}
        <code>src/themes.css</code>.
      </p>
      {isSignedIn && user && (
        <p className="text-sm text-muted-foreground">Signed in as {user.name ?? user.email}</p>
      )}
    </div>
  )
}
