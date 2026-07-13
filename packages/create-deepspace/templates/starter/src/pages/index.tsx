/**
 * Landing page — a STATIC page.
 *
 * It lives at the top level of src/pages/ (not under (app)/), so it renders
 * with no DeepSpace providers: no auth session fetch, no records WebSocket.
 * That makes it cheap to serve and safe for logged-out / crawler traffic.
 *
 * Need live data or auth here? Move this file to src/pages/(app)/index.tsx
 * and it becomes a dynamic page. Conversely, any page you want to keep static
 * (marketing, docs, legal) belongs at this top level.
 */

import { Link } from 'react-router-dom'
import { APP_NAME } from '../constants'

export default function Landing() {
  return (
    <div
      data-testid="static-landing"
      className="flex min-h-screen flex-col items-center justify-center px-6 text-center"
    >
      <p className="mb-3 text-sm uppercase tracking-widest text-muted-foreground">{APP_NAME}</p>
      <h1 className="mb-4 max-w-2xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
        A DeepSpace app with a static front door
      </h1>
      <p className="mb-8 max-w-md text-muted-foreground">
        This landing page ships no auth call and no realtime connection — it's a
        plain static page. The live app, with sign-in and synced data, lives
        behind the link below.
      </p>
      <Link
        to="/home"
        className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
      >
        Enter the app
      </Link>
    </div>
  )
}
