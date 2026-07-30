/**
 * Gated routes. Any file under src/pages/(app)/(protected)/ requires sign-in.
 * The `(protected)` folder is a Generouted route group — parentheses mean
 * it doesn't appear in the URL. For a dynamic page that does NOT require
 * sign-in, put it directly under src/pages/(app)/; for a static page, put it
 * at the top level of src/pages/.
 *
 * Children may call data hooks like `useUser()` safely because the parent
 * (app)/_layout.tsx mounts <RecordProvider> above this layout.
 */

import { Outlet } from 'react-router-dom'
import { AuthGate } from 'deepspace'

export default function ProtectedLayout() {
  return (
    <AuthGate>
      <Outlet />
    </AuthGate>
  )
}
