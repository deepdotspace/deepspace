/**
 * Playwright global setup — warms up external services before tests run.
 *
 * The DeepSpace auth worker (deployed at deepspace-auth.*.workers.dev) is
 * the same one used by every environment — there is no separate dev/local
 * auth worker. `npx deepspace dev` only runs Vite + the app worker
 * locally; auth requests are proxied through the app worker's /api/auth/*
 * route to the deployed auth worker.
 *
 * Cold-start latency on that deployed worker can fail the first test, so
 * we ping it here to warm it up. Port comes from $DEEPSPACE_PORT to match
 * the playwright config + dev server.
 */

const PORT = Number(process.env.DEEPSPACE_PORT ?? 5173)
const BASE_URL = `http://localhost:${PORT}`

export default async function globalSetup() {
  const maxRetries = 5

  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/auth/ok`)
      if (res.ok) return
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  // Don't fail — tests will catch real issues
}
