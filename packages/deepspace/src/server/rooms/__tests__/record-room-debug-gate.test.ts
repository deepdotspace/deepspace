/**
 * RecordRoom debug-route gating tests.
 *
 * The HTTP debug API (`/api/debug/*`) runs arbitrary SQL and role changes
 * with no auth of its own. It must only answer when the deployment opts in
 * via `ALLOW_DEBUG_ROUTES=true`, enforced at the DO's own ingress so no
 * caller (app worker, platform worker, a future one) can forget the gate.
 *
 * Before this gate, any request that reached the DO ran debug unconditionally.
 * On the platform's shared-data DO that meant one authenticated user could
 * dump or mutate every app's records.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { RecordRoom } from '../record-room'

;(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair ??=
  class { constructor(_req: string, _resp: string) {} }

// ---------------------------------------------------------------------------
// SqlStorage shim over better-sqlite3 (same shape as canvas-room.test.ts)
// ---------------------------------------------------------------------------

function makeSql(db: Database.Database): SqlStorage {
  return {
    exec(query: string, ...bindings: unknown[]): { toArray: () => unknown[] } {
      const trimmed = query.trim()
      const isSelect = /^(SELECT|PRAGMA)/i.test(trimmed)
      if (bindings.length === 0 && !isSelect) {
        db.exec(query)
        return { toArray: () => [] }
      }
      const stmt = db.prepare(query)
      if (isSelect) {
        const rows = stmt.all(...(bindings as never[]))
        return { toArray: () => rows }
      }
      stmt.run(...(bindings as never[]))
      return { toArray: () => [] }
    },
    get databaseSize(): number {
      return 0
    },
  } as unknown as SqlStorage
}

function makeState(db: Database.Database): DurableObjectState {
  return {
    storage: {
      sql: makeSql(db),
      setAlarm() {},
    },
    setWebSocketAutoResponse() {},
    getWebSockets(): WebSocket[] {
      return []
    },
    acceptWebSocket() {},
  } as unknown as DurableObjectState
}

function makeRoom(env: unknown): RecordRoom {
  return new RecordRoom(makeState(new Database(':memory:')), env)
}

/** A RecordRoom that pins debug off regardless of env, mirroring GlobalRecordRoom. */
class ShieldedRoom extends RecordRoom {
  protected get debugRoutesEnabled(): boolean {
    return false
  }
}

const debugSql = () =>
  new Request('https://do/api/debug/sql?scopeId=workspace:default', { method: 'GET' })
const debugStatus = () =>
  new Request('https://do/api/debug/status?scopeId=workspace:default', { method: 'GET' })

// ---------------------------------------------------------------------------

describe('RecordRoom: debug route gating', () => {
  it('returns 404 for /api/debug/* when ALLOW_DEBUG_ROUTES is absent', async () => {
    const res = await makeRoom({}).fetch(debugSql())
    expect(res.status).toBe(404)
  })

  it('returns 404 when ALLOW_DEBUG_ROUTES is set to anything but "true"', async () => {
    const res = await makeRoom({ ALLOW_DEBUG_ROUTES: '1' }).fetch(debugSql())
    expect(res.status).toBe(404)
  })

  it('serves debug when ALLOW_DEBUG_ROUTES === "true"', async () => {
    const res = await makeRoom({ ALLOW_DEBUG_ROUTES: 'true' }).fetch(debugStatus())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: unknown[]; connections: unknown[] }
    expect(Array.isArray(body.users)).toBe(true)
    expect(Array.isArray(body.connections)).toBe(true)
  })

  it('a subclass that pins debug off returns 404 even with the flag set', async () => {
    const room = new ShieldedRoom(makeState(new Database(':memory:')), { ALLOW_DEBUG_ROUTES: 'true' })
    const res = await room.fetch(debugStatus())
    expect(res.status).toBe(404)
  })

  it('leaves non-debug /api/ routes reachable (gate is debug-only)', async () => {
    // /api/tools/list is unauthenticated-safe and returns the tool catalog.
    const res = await makeRoom({}).fetch(
      new Request('https://do/api/tools/list?scopeId=workspace:default', { method: 'GET' }),
    )
    expect(res.status).toBe(200)
  })
})
