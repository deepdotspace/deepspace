/**
 * RecordRoom Durable Object
 *
 * SQLite-based storage with query-based real-time subscriptions.
 * Extends BaseRoom for WebSocket/connection infrastructure.
 *
 * Architecture:
 * - Data stored in SQLite (single `records` table)
 * - Clients subscribe to QUERIES, not collections
 * - On record change, server evaluates which subscriptions match
 * - Only matching subscribers receive updates
 *
 * Protocol:
 * - SUBSCRIBE { subscriptionId, query } → QUERY_RESULT { subscriptionId, records }
 * - UNSUBSCRIBE { subscriptionId }
 * - PUT { collection, recordId, data } → broadcasts RECORD_CHANGE to matching
 * - DELETE { collection, recordId } → broadcasts RECORD_CHANGE to matching
 */

/// <reference types="@cloudflare/workers-types" />

import * as Y from 'yjs'
import { BaseRoom, type UserAttachment } from './base-room'
import type { ConnectionAttachment } from '../../shared/protocol/types'
import type {
  YjsDocKey,
  SubscribePayload,
  UnsubscribePayload,
  PutPayload,
  DeletePayload,
  SetRolePayload,
  YjsJoinPayload,
  YjsLeavePayload,
} from '../../shared/types'
import { ROLE_ANONYMOUS, MSG } from '../../shared/protocol/constants'
import type { ServerMessage } from '../../shared/protocol/messages'
import {
  type CollectionSchema,
  type PermissionContext,
  SchemaRegistry,
  BASE_USERS_SCHEMA,
  resolveColumn,
  collectionTableName,
  dataToColumnValues,
} from '../schemas/registry'
import { ensureCollectionTable as ensureCollectionTableImpl } from './collection-table-migration'
import {
  handleSubscribe,
  handleUnsubscribe,
  handlePut,
  handleDelete,
  handleUserList,
  handleUserUpdate,
  handleSetRole,
  registerUser,
  handleYjsJoin,
  handleYjsLeave,
  handleYjsBinaryMessage,
  handleApiRequest,
} from '../handlers'
import { SYSTEM_COLLECTION_SCHEMAS, broadcastAwarenessRemoval } from '../handlers/yjs'

/**
 * RecordRoom configuration options
 */
export interface RecordRoomConfig {
  /**
   * User ID of the app owner.
   * This user automatically gets 'admin' role on connect.
   */
  ownerUserId?: string
}

/**
 * RecordRoom Durable Object
 */
export class RecordRoom<E = Record<string, unknown>> extends BaseRoom<E> {
  private schemaRegistry: SchemaRegistry
  private initPromise: Promise<void> | null = null
  /** Yjs docs loaded in memory (key: collection:recordId:fieldName) */
  private yjsDocs: Map<YjsDocKey, Y.Doc> = new Map()
  /** Next Yjs client ID counter */
  private nextYjsClientId = 1
  /** Owner user ID — gets admin role automatically */
  private ownerUserId: string | null
  /** True until the first fetch() completes — detects hibernation wake-up */
  private freshConstruct = true

  /**
   * Per-connection `[DO Perf]` timing logs are noisy on every hot path, so
   * they're gated behind a `DEEPSPACE_DO_PERF` env binding (set it to any
   * truthy value on the worker to opt in). Off by default.
   */
  private get perfLogEnabled(): boolean {
    return !!(this.env as { DEEPSPACE_DO_PERF?: unknown })?.DEEPSPACE_DO_PERF
  }

  /**
   * The HTTP debug API (`/api/debug/*`) runs arbitrary SQL and role changes
   * with no auth of its own, so it is gated here at the DO's single ingress.
   * Off unless a deployment opts in with `ALLOW_DEBUG_ROUTES=true`
   * (`deepspace dev`/`test` set it automatically). Deployments holding shared
   * data override this to always return false.
   */
  protected get debugRoutesEnabled(): boolean {
    return (this.env as { ALLOW_DEBUG_ROUTES?: unknown })?.ALLOW_DEBUG_ROUTES === 'true'
  }

  constructor(
    state: DurableObjectState,
    env: unknown,
    schemas: CollectionSchema[] = [],
    config: RecordRoomConfig = {},
  ) {
    super(state, env)
    this.schemaRegistry = new SchemaRegistry([
      ...SYSTEM_COLLECTION_SCHEMAS,
      BASE_USERS_SCHEMA,
      ...schemas,
    ])
    this.ownerUserId = config.ownerUserId ?? null

    // Log hibernation wake-up (WebSockets preserved but memory cleared)
    const wsCount = this.state.getWebSockets().length
    if (wsCount > 0) {
      console.log('[DO] Woke from hibernation:', wsCount, 'connections')
    }
  }

  // ============================================================================
  // Permission Context
  // ============================================================================

  private getPermissionContext(): PermissionContext {
    const teamMembersSchema = this.schemaRegistry.get('team_members')
    const hasTeamMembers = !!teamMembersSchema?.columns?.length

    return {
      isTeamMember: (teamId: string, userId: string): boolean => {
        if (!hasTeamMembers) return false
        const cursor = this.sql.exec(
          `SELECT 1 FROM c_team_members WHERE col_teamid = ? AND col_userid = ? AND (col_status = 'active' OR col_status IS NULL) LIMIT 1`,
          teamId,
          userId,
        )
        return cursor.toArray().length > 0
      },
    }
  }

  // ============================================================================
  // HTTP Entry Point (overrides BaseRoom.fetch)
  // ============================================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Internal control-plane endpoints (e.g. POST /internal/disconnect-sockets)
    // are shared by every room type via BaseRoom. Handle them first — before
    // the DB-init + WS path — since closing sockets needs no schema init.
    // Only reachable via DO stub fetch from the app worker (see BaseRoom.fetch).
    if (url.pathname.startsWith('/internal/')) {
      const internal = await this.handleInternalRequest(request, url)
      if (internal) return internal
    }

    const fetchStart = Date.now()
    const isColdStart = this.freshConstruct
    const needsInit = !this.initPromise
    this.freshConstruct = false

    await this.ensureInitialized()
    const initMs = Date.now() - fetchStart

    // HTTP API endpoints (tools, debug, etc.)
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.startsWith('/api/debug/') && !this.debugRoutesEnabled) {
        return new Response('Not Found', { status: 404 })
      }
      return handleApiRequest(this.createHandlerContext(), request, url)
    }

    // WebSocket upgrade — delegate to BaseRoom
    if (request.headers.get('Upgrade') === 'websocket') {
      // Store timing info for logging in onConnect
      this._fetchTiming = { fetchStart, isColdStart, needsInit, initMs }
      return super.fetch(request)
    }

    return new Response('Not Found', { status: 404 })
  }

  /** Timing info from the current fetch(), used by onConnect for logging */
  private _fetchTiming: {
    fetchStart: number
    isColdStart: boolean
    needsInit: boolean
    initMs: number
  } | null = null

  // ============================================================================
  // Database
  // ============================================================================

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeDatabase()
    }
    return this.initPromise
  }

  private async initializeDatabase(): Promise<void> {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS yjs_docs (
        doc_key TEXT PRIMARY KEY,
        state BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    this.ensureAllCollectionTables()

    await this.migrateUsersTableIfExists()
    await this.migrateRecordsTable()
  }

  private async migrateUsersTableIfExists(): Promise<void> {
    try {
      const tableCheck = this.sql.exec(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='users'`,
      )
      if (tableCheck.toArray().length === 0) {
        return
      }

      const oldUsers = this.sql.exec(`SELECT * FROM users`).toArray()
      if (oldUsers.length === 0) {
        this.sql.exec(`DROP TABLE IF EXISTS users`)
        return
      }

      const now = new Date().toISOString()
      for (const row of oldUsers) {
        const r = row as {
          user_id: string
          email: string
          name: string
          image_url?: string
          role: string
          created_at: string
          last_seen_at: string
        }

        const existing = this.sql
          .exec(`SELECT 1 FROM c_users WHERE _row_id = ?`, r.user_id)
          .toArray()
        if (existing.length > 0) continue

        this.sql.exec(
          `INSERT INTO c_users (_row_id, _created_by, _created_at, _updated_at, col_email, col_name, col_imageurl, col_role, col_createdat, col_lastseenat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.user_id,
          r.user_id,
          r.created_at,
          now,
          r.email,
          r.name,
          r.image_url || null,
          r.role,
          r.created_at,
          r.last_seen_at,
        )
      }

      this.sql.exec(`DROP TABLE IF EXISTS users`)
    } catch (error) {
      console.error(`[RecordRoom] Users table migration error:`, error)
    }
  }

  private async migrateRecordsTable(): Promise<void> {
    try {
      const tableCheck = this.sql.exec(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='records'`,
      )
      if (tableCheck.toArray().length === 0) return

      const rows = this.sql.exec(`SELECT * FROM records`).toArray()
      if (rows.length === 0) {
        this.sql.exec(`DROP TABLE IF EXISTS records`)
        return
      }

      let migrated = 0
      let skipped = 0

      for (const row of rows) {
        const r = row as {
          collection: string
          record_id: string
          data: string
          created_by: string
          created_at: string
          updated_at: string
        }
        const schema = this.schemaRegistry.get(r.collection)

        if (!schema || !schema.columns) {
          skipped++
          continue
        }

        const tbl = collectionTableName(r.collection)

        const tblExists =
          this.sql
            .exec(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl)
            .toArray().length > 0
        if (!tblExists) {
          this.ensureCollectionTable(schema)
        }

        const existing = this.sql
          .exec(`SELECT 1 FROM "${tbl}" WHERE _row_id = ?`, r.record_id)
          .toArray()
        if (existing.length > 0) {
          skipped++
          continue
        }

        let data: Record<string, unknown>
        try {
          data = JSON.parse(r.data) as Record<string, unknown>
        } catch {
          skipped++
          continue
        }

        const columns = schema.columns.map(resolveColumn)
        const colValues = dataToColumnValues(data, columns)

        const colIds = Object.keys(colValues)
        const allCols = [
          '_row_id',
          '_created_by',
          '_created_at',
          '_updated_at',
          ...colIds.map((c) => `"${c}"`),
        ]
        const placeholders = allCols.map(() => '?').join(', ')
        const params = [
          r.record_id,
          r.created_by,
          r.created_at,
          r.updated_at,
          ...colIds.map((c) => colValues[c]),
        ]

        this.sql.exec(
          `INSERT INTO "${tbl}" (${allCols.join(', ')}) VALUES (${placeholders})`,
          ...params,
        )
        migrated++
      }

      if (migrated > 0 || skipped > 0) {
        console.log(
          `[RecordRoom] Migrated ${migrated} records from document-mode, ${skipped} skipped`,
        )
      }

      this.sql.exec(`DROP TABLE IF EXISTS records`)
    } catch (error) {
      console.error(`[RecordRoom] Records table migration error:`, error)
    }
  }

  // ============================================================================
  // Table-Mode Schema Management
  // ============================================================================

  private ensureCollectionTable(schema: CollectionSchema): void {
    ensureCollectionTableImpl(this.sql, schema, console)
  }

  private ensureAllCollectionTables(): void {
    for (const schema of this.schemaRegistry.all()) {
      this.ensureCollectionTable(schema)
    }
  }

  // ============================================================================
  // BaseRoom Lifecycle Hooks
  // ============================================================================

  protected async onConnect(ws: WebSocket, user: UserAttachment): Promise<ConnectionAttachment> {
    await this.ensureInitialized()

    const timing = this._fetchTiming ?? {
      fetchStart: Date.now(),
      isColdStart: false,
      needsInit: false,
      initMs: 0,
    }

    const userId = user.userId
    const userName = user.userName
    const userEmail = user.userEmail
    const userImageUrl = user.userImageUrl
    const isAuthenticated = !userId.startsWith('anon-')

    let attachment: ConnectionAttachment

    if (isAuthenticated) {
      const isOwner = this.ownerUserId != null && userId === this.ownerUserId
      const regStart = Date.now()
      const defaultRole = this.schemaRegistry.get('users')?.defaultRole ?? 'member'
      const registeredUser = await registerUser(
        this.sql,
        userId,
        userName,
        userEmail,
        userImageUrl,
        isOwner,
        defaultRole,
        this.schemaRegistry,
      )
      const regMs = Date.now() - regStart

      attachment = {
        userId: registeredUser.id,
        userName,
        userEmail,
        userImageUrl,
        role: registeredUser.role,
        subscriptions: [],
        yjsSubscriptions: [],
        yjsClientId: this.nextYjsClientId++,
      }

      this.send(ws, { type: MSG.USER_INFO, payload: registeredUser })

      const totalMs = Date.now() - timing.fetchStart
      if (this.perfLogEnabled)
        console.log(
          `[DO Perf] cold=${timing.isColdStart} | init: ${timing.initMs}ms reg: ${regMs}ms | total: ${totalMs}ms`,
        )
    } else {
      attachment = {
        userId,
        userName: 'Anonymous',
        userEmail: '',
        role: ROLE_ANONYMOUS,
        subscriptions: [],
        yjsSubscriptions: [],
        yjsClientId: this.nextYjsClientId++,
      }

      this.send(ws, {
        type: MSG.USER_INFO,
        payload: {
          id: userId,
          name: 'Anonymous',
          email: '',
          role: ROLE_ANONYMOUS,
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      })

      const totalMs = Date.now() - timing.fetchStart
      if (this.perfLogEnabled)
        console.log(`[DO Perf] cold=${timing.isColdStart} anon | total: ${totalMs}ms`)
    }

    this._fetchTiming = null
    return attachment
  }

  /**
   * Required to satisfy BaseRoom's abstract contract, but never invoked:
   * RecordRoom overrides `webSocketMessage`/`webSocketClose` directly (below),
   * so the BaseRoom dispatch path that would call this never runs. All real
   * message handling lives in `handleRecordMessage`.
   */
  protected onMessage(): void {
    throw new Error('RecordRoom.onMessage is unreachable; use webSocketMessage')
  }

  // ============================================================================
  // Hibernation API — RecordRoom overrides these directly (rather than using
  // BaseRoom's onMessage/onBinaryMessage/onDisconnect hooks) so it can run
  // ensureInitialized() before every message after a hibernation wake-up.
  // ============================================================================

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.ensureInitialized()

    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment) {
      this.send(ws, { type: MSG.ERROR, payload: { error: 'Connection not found' } })
      return
    }

    // Handle binary messages (Yjs sync)
    if (message instanceof ArrayBuffer) {
      try {
        await handleYjsBinaryMessage(
          this.createYjsContext(),
          ws,
          attachment,
          new Uint8Array(message),
        )
      } catch (e) {
        console.error('[RecordRoom] Yjs binary message error:', e)
      }
      return
    }

    // Handle JSON messages
    try {
      const msg = JSON.parse(message)
      await this.handleRecordMessage(ws, attachment, msg)
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      const msgPreview = typeof message === 'string' ? message.slice(0, 200) : '(non-string)'
      console.error(`[RecordRoom] Message handler error: ${errMsg}`, { message: msgPreview })
      this.send(ws, { type: MSG.ERROR, payload: { error: `Invalid message: ${errMsg}` } })
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    console.log(`[RecordRoom] webSocketClose code=${code} reason=${reason}`)
    try {
      const attachment = ws.deserializeAttachment() as ConnectionAttachment | null
      if (attachment) {
        broadcastAwarenessRemoval(this.createYjsContext(), attachment)
      }
    } catch {
      /* best-effort */
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error(`[RecordRoom] webSocketError:`, error)
  }

  // ============================================================================
  // Message Routing
  // ============================================================================

  private async handleRecordMessage(
    ws: WebSocket,
    attachment: ConnectionAttachment,
    msg: { type: string; payload: unknown },
  ): Promise<void> {
    const { type, payload } = msg
    const ctx = this.createHandlerContext()
    const recordCtx = this.createRecordContext()
    const userCtx = this.createUserContext()
    const yjsCtx = this.createYjsContext()

    switch (type) {
      case MSG.SUBSCRIBE:
        handleSubscribe(ctx, ws, attachment, payload as SubscribePayload)
        break

      case MSG.UNSUBSCRIBE:
        handleUnsubscribe(ctx, ws, attachment, payload as UnsubscribePayload)
        break

      case MSG.PUT:
        await handlePut(recordCtx, ws, attachment, payload as PutPayload)
        break

      case MSG.DELETE:
        await handleDelete(recordCtx, ws, attachment, payload as DeletePayload)
        break

      case MSG.USER_LIST:
        handleUserList(userCtx, ws, attachment)
        break

      case MSG.USER_UPDATE:
        handleUserUpdate(
          recordCtx,
          ws,
          attachment,
          payload as { name?: string; email?: string; imageUrl?: string },
        )
        break

      case MSG.SET_ROLE:
        await handleSetRole(userCtx, ws, attachment, payload as SetRolePayload)
        break

      case MSG.YJS_JOIN:
        await handleYjsJoin(yjsCtx, ws, attachment, payload as YjsJoinPayload)
        break

      case MSG.YJS_LEAVE:
        handleYjsLeave(ws, attachment, payload as YjsLeavePayload)
        break

      case MSG.LIST_SCHEMAS:
        this.handleListSchemas(ws)
        break

      default:
        this.send(ws, { type: MSG.ERROR, payload: { error: `Unknown message type: ${type}` } })
    }
  }

  // ============================================================================
  // Schema Discovery
  // ============================================================================

  private handleListSchemas(ws: WebSocket): void {
    const schemas = this.schemaRegistry.all()
    this.send(ws, {
      type: MSG.LIST_SCHEMAS,
      payload: { schemas },
    })
  }

  // ============================================================================
  // Context Factory Methods
  // ============================================================================

  private createHandlerContext() {
    return {
      sql: this.sql,
      state: this.state,
      schemaRegistry: this.schemaRegistry,
      getPermissionContext: () => this.getPermissionContext(),
      send: (ws: WebSocket, msg: ServerMessage) => this.send(ws, msg),
      sendBinary: (ws: WebSocket, data: Uint8Array) => this.sendBinaryHelper(ws, data),
      yjsDocs: this.yjsDocs,
      ownerUserId: this.ownerUserId ?? undefined,
    }
  }

  private createRecordContext() {
    return {
      ...this.createHandlerContext(),
      state: this.state,
    }
  }

  private createUserContext() {
    return {
      sql: this.sql,
      state: this.state,
      schemaRegistry: this.schemaRegistry,
      send: (ws: WebSocket, msg: ServerMessage) => this.send(ws, msg),
    }
  }

  private createYjsContext() {
    return {
      sql: this.sql,
      state: this.state,
      yjsDocs: this.yjsDocs,
      schemaRegistry: this.schemaRegistry,
      getPermissionContext: () => this.getPermissionContext(),
      send: (ws: WebSocket, msg: ServerMessage) => this.send(ws, msg),
      sendBinary: (ws: WebSocket, data: Uint8Array) => this.sendBinaryHelper(ws, data),
    }
  }

  // ============================================================================
  // Utilities (preserves original API that handlers expect)
  // ============================================================================

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message))
      }
    } catch {
      // Ignore send errors
    }
  }

  private sendBinaryHelper(ws: WebSocket, data: Uint8Array): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    } catch {
      // Ignore send errors
    }
  }
}
