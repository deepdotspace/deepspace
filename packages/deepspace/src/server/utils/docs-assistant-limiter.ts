const WINDOW_MS = 60_000
const CLIENT_REQUESTS_PER_WINDOW = 12
const APP_REQUESTS_PER_WINDOW = 120
const MAX_CONCURRENT_REQUESTS = 4
const LEASE_TTL_MS = 2 * 60_000

interface AcquireBody {
  clientKey?: unknown
}
interface ReleaseBody {
  leaseId?: unknown
}

/**
 * Durable, per-app abuse boundary for the public documentation assistant.
 * Bind one SQLite Durable Object instance per immutable app id.
 */
export class DocsAssistantLimiter {
  private readonly sql: SqlStorage

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS request_windows (
        scope TEXT NOT NULL,
        client_key TEXT NOT NULL,
        window INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (scope, client_key, window)
      );
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 })
    if (url.pathname === '/acquire') return this.acquire(request)
    if (url.pathname === '/release') return this.release(request)
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  private async acquire(request: Request): Promise<Response> {
    const body = await request.json<AcquireBody>().catch(() => null)
    if (!body || typeof body.clientKey !== 'string' || body.clientKey.length !== 64) {
      return Response.json({ error: 'invalid_client_key' }, { status: 400 })
    }

    const now = Date.now()
    const window = Math.floor(now / WINDOW_MS)
    this.sql.exec('DELETE FROM request_windows WHERE window < ?', window - 1)
    this.sql.exec('DELETE FROM leases WHERE expires_at <= ?', now)

    if (!this.consumeWindow('client', body.clientKey, window, CLIENT_REQUESTS_PER_WINDOW)) {
      return Response.json({ ok: false, reason: 'client_rate' }, { status: 429 })
    }
    if (!this.consumeWindow('app', 'all', window, APP_REQUESTS_PER_WINDOW)) {
      return Response.json({ ok: false, reason: 'app_rate' }, { status: 429 })
    }

    const concurrent = this.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM leases')
      .one().count
    if (concurrent >= MAX_CONCURRENT_REQUESTS) {
      return Response.json({ ok: false, reason: 'app_concurrency' }, { status: 429 })
    }

    const leaseId = crypto.randomUUID()
    this.sql.exec('INSERT INTO leases (id, expires_at) VALUES (?, ?)', leaseId, now + LEASE_TTL_MS)
    return Response.json({ ok: true, leaseId })
  }

  private async release(request: Request): Promise<Response> {
    const body = await request.json<ReleaseBody>().catch(() => null)
    if (!body || typeof body.leaseId !== 'string') {
      return Response.json({ error: 'invalid_lease_id' }, { status: 400 })
    }
    this.sql.exec('DELETE FROM leases WHERE id = ?', body.leaseId)
    return Response.json({ ok: true })
  }

  private consumeWindow(scope: string, clientKey: string, window: number, limit: number): boolean {
    const existing = this.sql
      .exec<{ count: number }>(
        'SELECT count FROM request_windows WHERE scope = ? AND client_key = ? AND window = ?',
        scope,
        clientKey,
        window,
      )
      .toArray()[0]?.count ?? 0
    if (existing >= limit) return false
    this.sql.exec(
      `INSERT INTO request_windows (scope, client_key, window, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(scope, client_key, window) DO UPDATE SET count = count + 1`,
      scope,
      clientKey,
      window,
    )
    return true
  }
}
