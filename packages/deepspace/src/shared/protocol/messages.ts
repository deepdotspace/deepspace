/**
 * Typed wire-protocol layer — discriminated unions, typed builders, and a
 * type-safe dispatcher for every `MSG.*` the SDK understands.
 *
 * Why this exists
 * ---------------
 *
 * The string `MSG.*` constants in `./constants.ts` are the authoritative
 * wire protocol, but using them directly is error-prone: a typo picks the
 * wrong message with the wrong payload shape and fails silently at
 * runtime. This module pairs every constant with its payload type, so
 * that:
 *
 *   1. Building a message with `clientBuild.gameInput(...)` is payload-
 *      checked at the call site — the compiler refuses to ship a wrong
 *      shape.
 *
 *   2. Parsing an inbound message via `dispatch(raw, handlers)` narrows the
 *      payload type inside each handler automatically, replacing the
 *      unsafe `switch (msg.type) { case MSG.X: (payload as any).foo }`
 *      pattern.
 *
 *   3. Tightening `BaseRoom.sendTo` / `BaseRoom.broadcast` /
 *      `HandlerContext.send` / `SubscriptionContext.send` to accept
 *      `ServerMessage` turns the type layer into enforcement: any room
 *      that ships a payload inconsistent with its declared arm fails to
 *      compile. Without that, the discriminated union is documentation,
 *      not contract.
 *
 *   4. Adding a new `MSG.*` is localized: one entry in the discriminated
 *      union, one builder function, one handler key in every dispatcher
 *      that cares. No grep-and-fix across the codebase.
 *
 *   5. Apps can extend the SDK protocol without forking: `dispatch<M>` is
 *      generic over any `M extends ProtocolMessage`, and builders are
 *      plain objects so apps compose via spread (`{ ...clientBuild,
 *      myMessage: ... }`).
 *
 * Direction split
 * ---------------
 *
 * Some message types carry different payloads depending on who's sending.
 * `MSG.GAME_START`, for example, is `{}` when the client requests a start
 * but `{ state, tick }` when the server broadcasts the start event.
 * `MSG.CANVAS_ADD` is a flat shape dict on the way in and a `{ shape }`
 * wrapper on the way out. Modelling these with one union would force
 * handlers to juggle a union payload — clunky and error-prone. Instead we
 * split by direction:
 *
 *   - `ClientMessage` — what the client sends to the server
 *   - `ServerMessage` — what the server sends to the client
 *   - `ProtocolMessage = ClientMessage | ServerMessage` (for code that
 *     really doesn't care — avoid when possible)
 *
 * Each side gets its own builder (`clientBuild` / `serverBuild`) and each
 * side's dispatcher is parameterised with the union it expects.
 *
 * Payload strictness
 * ------------------
 *
 * Where payload shapes are stable + narrow (ids, flags), we type them
 * precisely. Where they're opaque or escape the protocol layer (record
 * data blobs, Yjs binary frames, game-engine state), we use `unknown` and
 * defer narrowing to the caller. This is intentional: over-typing opaque
 * payloads would require the protocol layer to import application types
 * and defeat the "thin wire contract" goal.
 */

import { MSG } from './constants'

// =============================================================================
// Envelope + helpers
// =============================================================================

/**
 * The outer shape of every wire message. `T` is the string discriminator
 * (e.g. `"game.input"`) — keeping it as a generic literal type lets the
 * discriminated-union narrowing in `dispatch()` pick the right payload.
 *
 * Callers extending the protocol should pass a string-literal type for
 * `T`, not the widened `string`. `BaseMessage<string, P>` collapses the
 * discriminated union and handler-map key inference falls back to a
 * single untyped `string` key, losing all narrowing.
 */
export interface BaseMessage<T extends string, P> {
  type: T
  payload: P
}

/** Matches when a payload is intentionally empty — `{}` on the wire. */
type EmptyPayload = Record<string, never>

/**
 * Frozen empty payload reused by every "no args" builder. Frozen so a
 * runaway consumer mutating `.payload` can't corrupt the shared instance
 * that every other call site sees.
 */
const EMPTY: EmptyPayload = Object.freeze({}) as EmptyPayload

// =============================================================================
// Client → Server messages
// =============================================================================

/**
 * Every message the client can legitimately send. Extend in app code with
 * a string-literal union arm:
 *
 *     type MyClientMessage = ClientMessage | BaseMessage<'myapp.foo', { x: number }>
 */
export type ClientMessage =
  // ---- Records / CRUD ---------------------------------------------------
  | BaseMessage<typeof MSG.SUBSCRIBE, { subscriptionId: string; query: unknown }>
  | BaseMessage<typeof MSG.UNSUBSCRIBE, { subscriptionId: string }>
  | BaseMessage<
      typeof MSG.PUT,
      { collection: string; recordId: string; data: Record<string, unknown>; requestId?: string }
    >
  | BaseMessage<
      typeof MSG.DELETE,
      { collection: string; recordId: string; requestId?: string }
    >
  // ---- Users ------------------------------------------------------------
  | BaseMessage<typeof MSG.USER_LIST, EmptyPayload>
  | BaseMessage<typeof MSG.SET_ROLE, { userId: string; role: string }>
  | BaseMessage<typeof MSG.USER_UPDATE, EmptyPayload>
  | BaseMessage<typeof MSG.LIST_SCHEMAS, EmptyPayload>
  // ---- Yjs --------------------------------------------------------------
  | BaseMessage<typeof MSG.YJS_JOIN, { collection: string; recordId: string; fieldName: string }>
  | BaseMessage<typeof MSG.YJS_LEAVE, { collection: string; recordId: string; fieldName: string }>
  // Binary yjs sync/awareness frames use numeric `MSG_YJS_SYNC` /
  // `MSG_YJS_AWARENESS` envelope ids from `./constants.ts` and ride the
  // binary WebSocket channel. They bypass this typed layer entirely.
  // ---- Game -------------------------------------------------------------
  | BaseMessage<typeof MSG.GAME_INPUT, { action: string; data: Record<string, unknown> }>
  | BaseMessage<typeof MSG.GAME_PLAYER_READY, EmptyPayload>
  | BaseMessage<typeof MSG.GAME_START, EmptyPayload>
  | BaseMessage<typeof MSG.GAME_END, EmptyPayload>
  // ---- Canvas -----------------------------------------------------------
  // `CANVAS_ADD` sends a flat shape dict as the payload (not `{ shape }`);
  // the server wraps it in `{ shape }` on its rebroadcast. Keep the types
  // aligned with the real wire or `clientBuild` lies. See
  // server/rooms/canvas-room.ts for the server side of this asymmetry.
  // `unknown` here (rather than `Record<string, unknown>`) so closed
  // concrete shape types pass assignability without index signatures.
  | BaseMessage<typeof MSG.CANVAS_ADD, unknown>
  | BaseMessage<typeof MSG.CANVAS_MOVE, { shapeId: string; x: number; y: number }>
  | BaseMessage<
      typeof MSG.CANVAS_RESIZE,
      { shapeId: string; width: number; height: number; x?: number; y?: number }
    >
  | BaseMessage<typeof MSG.CANVAS_DELETE, { shapeId: string }>
  | BaseMessage<
      typeof MSG.CANVAS_UPDATE,
      { shapeId: string; props: Record<string, unknown> }
    >
  // Flat payload in the client→server direction, matching `CANVAS_ADD`.
  | BaseMessage<typeof MSG.CANVAS_VIEWPORT, unknown>
  | BaseMessage<typeof MSG.CANVAS_UNDO, EmptyPayload>
  | BaseMessage<typeof MSG.CANVAS_REDO, EmptyPayload>
  // ---- Cron -------------------------------------------------------------
  | BaseMessage<typeof MSG.CRON_TRIGGER, { taskName: string }>
  | BaseMessage<typeof MSG.CRON_PAUSE, { taskName: string }>
  | BaseMessage<typeof MSG.CRON_RESUME, { taskName: string }>
  // ---- Jobs -------------------------------------------------------------
  // `JOB_ENQUEUE` uses requestId/JOB_UPDATE-ack so the caller learns the
  // newly-assigned jobId.
  | BaseMessage<
      typeof MSG.JOB_ENQUEUE,
      {
        requestId: string
        type: string
        payload?: unknown
        maxAttempts?: number
      }
    >
  | BaseMessage<typeof MSG.JOB_CANCEL, { jobId: string }>
  | BaseMessage<typeof MSG.JOB_RETRY, { jobId: string }>
  // ---- Presence ---------------------------------------------------------
  // Flat state object — the server merges incoming fields into the peer's
  // stored state; there's no `{ state }` wrapper in the client direction.
  | BaseMessage<typeof MSG.PRESENCE_UPDATE, Record<string, unknown>>
  // ---- Gateway ----------------------------------------------------------
  | BaseMessage<typeof MSG.GW_SCOPE_CONNECT, { scopeType: string; scopeId: string }>
  | BaseMessage<typeof MSG.GW_SCOPE_DISCONNECT, { scopeType: string; scopeId: string }>
  | BaseMessage<typeof MSG.GW_TOKEN_REFRESH, { token: string }>

// =============================================================================
// Server → Client messages
// =============================================================================

/**
 * Every message the server can send. Room and handler `send` / `broadcast`
 * signatures are tightened to this union so outbound payloads are
 * compile-checked against the wire contract. As with `ClientMessage`,
 * extend via a string-literal union arm in app code when adding new
 * server-side broadcasts.
 */
export type ServerMessage =
  // ---- Records / CRUD ---------------------------------------------------
  | BaseMessage<
      typeof MSG.QUERY_RESULT,
      { subscriptionId: string; records: unknown[] }
    >
  | BaseMessage<
      typeof MSG.RECORD_CHANGE,
      {
        collection: string
        record: unknown
        // Real wire values are `create`/`update`/`delete`, not the
        // underlying storage op name. See `server/handlers/subscriptions.ts`.
        changeType: 'create' | 'update' | 'delete'
      }
    >
  // `subscriptionId` is optional because generic transport errors (bad
  // envelope, missing connection) have no subscription context. Specific
  // query failures include the id so the client can correlate.
  | BaseMessage<typeof MSG.ERROR, { error: string; subscriptionId?: string }>
  // ACK is a mutation ack — it carries the correlation `requestId` from
  // the inbound PUT/DELETE plus a success flag. Server/handlers/records.ts
  // is the authoritative send site.
  | BaseMessage<
      typeof MSG.ACK,
      | { requestId: string; success: true; recordId?: string }
      | { requestId: string; success: false; error: string }
    >
  | BaseMessage<typeof MSG.RESUBSCRIBE, EmptyPayload>
  | BaseMessage<typeof MSG.LIST_SCHEMAS, { schemas: unknown }>
  // ---- Auth -------------------------------------------------------------
  // Emitted once per connection by rooms that enforce role-based writes
  // (Canvas, Game, Cron). Client hooks store `canWrite` in state and
  // disable write APIs when false. See useCanvas / useGameRoom /
  // useCronMonitor for the consumer side.
  | BaseMessage<typeof MSG.AUTH, { canWrite: boolean }>
  // ---- Users ------------------------------------------------------------
  // `USER_INFO` carries an app-specific user object (column-shape varies
  // per deployment), so the wire type is opaque. Narrow at the consumer.
  | BaseMessage<typeof MSG.USER_INFO, unknown>
  | BaseMessage<typeof MSG.USER_LIST, { users: unknown[] }>
  // ---- Yjs (JSON frames; binary sync/awareness bypass this layer) -------
  | BaseMessage<
      typeof MSG.YJS_JOIN,
      { collection: string; recordId: string; fieldName: string; canWrite: boolean }
    >
  // ---- Game -------------------------------------------------------------
  | BaseMessage<
      typeof MSG.GAME_STATE,
      { state: unknown; tick: number; players: unknown[]; running: boolean }
    >
  | BaseMessage<typeof MSG.GAME_TICK, { state: unknown; tick: number }>
  | BaseMessage<typeof MSG.GAME_START, { state: unknown; tick: number }>
  | BaseMessage<typeof MSG.GAME_END, { state: unknown; tick: number }>
  | BaseMessage<typeof MSG.GAME_PLAYER_JOIN, { player: unknown }>
  | BaseMessage<typeof MSG.GAME_PLAYER_LEAVE, { userId: string }>
  | BaseMessage<typeof MSG.GAME_PLAYER_READY, { userId: string }>
  // ---- Canvas -----------------------------------------------------------
  // `CANVAS_SHAPES` carries both the shape list and the viewports snapshot
  // so new connections can restore a multi-user view in one message. See
  // server/rooms/canvas-room.ts:onConnect.
  | BaseMessage<
      typeof MSG.CANVAS_SHAPES,
      { shapes: unknown[]; viewports: unknown[] }
    >
  | BaseMessage<typeof MSG.CANVAS_ADD, { shape: unknown }>
  | BaseMessage<typeof MSG.CANVAS_MOVE, { shapeId: string; x: number; y: number }>
  | BaseMessage<
      typeof MSG.CANVAS_RESIZE,
      { shapeId: string; width: number; height: number; x?: number; y?: number }
    >
  | BaseMessage<typeof MSG.CANVAS_DELETE, { shapeId: string }>
  | BaseMessage<
      typeof MSG.CANVAS_UPDATE,
      { shapeId: string; props: Record<string, unknown> }
    >
  | BaseMessage<
      typeof MSG.CANVAS_VIEWPORT,
      { viewport: unknown } | { userId: string; removed: true }
    >
  // ---- Cron -------------------------------------------------------------
  // `CRON_STATUS` server broadcasts carry both tasks and recent history;
  // see server/rooms/cron-room.ts.
  | BaseMessage<typeof MSG.CRON_TASKS, { tasks: unknown }>
  | BaseMessage<typeof MSG.CRON_HISTORY, { history: unknown }>
  | BaseMessage<typeof MSG.CRON_STATUS, { tasks: unknown; recentHistory: unknown }>
  // ---- Jobs -------------------------------------------------------------
  // `JOB_UPDATE` is the single push channel — same payload shape carries
  // initial-snapshot, enqueue, progress, success, failure, cancel, and
  // retry events. `kind` discriminates client-side. See useJobs.
  | BaseMessage<
      typeof MSG.JOB_UPDATE,
      {
        kind: 'snapshot' | 'enqueued' | 'progress' | 'succeeded' | 'failed' | 'canceled' | 'retried'
        job?: unknown
        jobs?: unknown[]
        /** Echoes the enqueue requestId when the update is the enqueue ack. */
        requestId?: string
      }
    >
  // ---- Presence ---------------------------------------------------------
  | BaseMessage<typeof MSG.PRESENCE_SYNC, { peers: unknown[] }>
  | BaseMessage<typeof MSG.PRESENCE_JOIN, { peer: unknown }>
  | BaseMessage<typeof MSG.PRESENCE_LEAVE, { userId: string }>
  | BaseMessage<
      typeof MSG.PRESENCE_UPDATE,
      { userId: string; state: Record<string, unknown> }
    >
  // ---- Gateway ----------------------------------------------------------
  | BaseMessage<
      typeof MSG.GW_SCOPE_ERROR,
      { scopeType: string; scopeId: string; error: string }
    >
  | BaseMessage<typeof MSG.GW_USER_UPDATE, unknown>

/**
 * Any wire message, regardless of direction. Use this only when the code
 * path genuinely doesn't care — otherwise pick `ClientMessage` or
 * `ServerMessage` so the handler's payload type is narrower.
 */
export type ProtocolMessage = ClientMessage | ServerMessage

// =============================================================================
// Typed builders
// =============================================================================
//
// Each builder returns a `{ type, payload }` object typed as a specific arm
// of `ClientMessage` / `ServerMessage`. Call sites that hand the result to
// `JSON.stringify` ship exactly what the wire protocol expects.
//
// `as const` on every return preserves the literal string `type` value
// (e.g. `"game.input"`), which is what the discriminated-union narrowing
// in `dispatch` keys on. Without it TS widens to `string` and the handler
// map collapses to a single untyped key.
// =============================================================================

/** Factories for every client → server message. */
export const clientBuild = {
  // Records / CRUD
  subscribe: (subscriptionId: string, query: unknown) =>
    ({ type: MSG.SUBSCRIBE, payload: { subscriptionId, query } }) as const,
  unsubscribe: (subscriptionId: string) =>
    ({ type: MSG.UNSUBSCRIBE, payload: { subscriptionId } }) as const,
  put: (
    collection: string,
    recordId: string,
    data: Record<string, unknown>,
    requestId?: string,
  ) =>
    ({
      type: MSG.PUT,
      payload: { collection, recordId, data, requestId },
    }) as const,
  remove: (collection: string, recordId: string, requestId?: string) =>
    ({ type: MSG.DELETE, payload: { collection, recordId, requestId } }) as const,
  // Users
  userList: () => ({ type: MSG.USER_LIST, payload: EMPTY }) as const,
  setRole: (userId: string, role: string) =>
    ({ type: MSG.SET_ROLE, payload: { userId, role } }) as const,
  userUpdate: () => ({ type: MSG.USER_UPDATE, payload: EMPTY }) as const,
  listSchemas: () => ({ type: MSG.LIST_SCHEMAS, payload: EMPTY }) as const,
  // Yjs
  yjsJoin: (collection: string, recordId: string, fieldName: string) =>
    ({ type: MSG.YJS_JOIN, payload: { collection, recordId, fieldName } }) as const,
  yjsLeave: (collection: string, recordId: string, fieldName: string) =>
    ({ type: MSG.YJS_LEAVE, payload: { collection, recordId, fieldName } }) as const,
  // Game
  gameInput: (action: string, data: Record<string, unknown> = {}) =>
    ({ type: MSG.GAME_INPUT, payload: { action, data } }) as const,
  gamePlayerReady: () => ({ type: MSG.GAME_PLAYER_READY, payload: EMPTY }) as const,
  gameStart: () => ({ type: MSG.GAME_START, payload: EMPTY }) as const,
  gameEnd: () => ({ type: MSG.GAME_END, payload: EMPTY }) as const,
  // Canvas — `CANVAS_ADD` / `CANVAS_VIEWPORT` payloads are flat (the shape
  // or viewport object is the whole payload).
  canvasAdd: (shape: Record<string, unknown>) =>
    ({ type: MSG.CANVAS_ADD, payload: shape }) as const,
  canvasMove: (shapeId: string, x: number, y: number) =>
    ({ type: MSG.CANVAS_MOVE, payload: { shapeId, x, y } }) as const,
  canvasResize: (
    shapeId: string,
    width: number,
    height: number,
    x?: number,
    y?: number,
  ) =>
    ({ type: MSG.CANVAS_RESIZE, payload: { shapeId, width, height, x, y } }) as const,
  canvasDelete: (shapeId: string) =>
    ({ type: MSG.CANVAS_DELETE, payload: { shapeId } }) as const,
  canvasUpdate: (shapeId: string, props: Record<string, unknown>) =>
    ({ type: MSG.CANVAS_UPDATE, payload: { shapeId, props } }) as const,
  canvasViewport: (viewport: Record<string, unknown>) =>
    ({ type: MSG.CANVAS_VIEWPORT, payload: viewport }) as const,
  canvasUndo: () => ({ type: MSG.CANVAS_UNDO, payload: EMPTY }) as const,
  canvasRedo: () => ({ type: MSG.CANVAS_REDO, payload: EMPTY }) as const,
  // Cron
  cronTrigger: (taskName: string) =>
    ({ type: MSG.CRON_TRIGGER, payload: { taskName } }) as const,
  cronPause: (taskName: string) =>
    ({ type: MSG.CRON_PAUSE, payload: { taskName } }) as const,
  cronResume: (taskName: string) =>
    ({ type: MSG.CRON_RESUME, payload: { taskName } }) as const,
  // Jobs
  jobEnqueue: (
    requestId: string,
    type: string,
    payload?: unknown,
    maxAttempts?: number,
  ) =>
    ({
      type: MSG.JOB_ENQUEUE,
      payload: { requestId, type, payload, maxAttempts },
    }) as const,
  jobCancel: (jobId: string) =>
    ({ type: MSG.JOB_CANCEL, payload: { jobId } }) as const,
  jobRetry: (jobId: string) =>
    ({ type: MSG.JOB_RETRY, payload: { jobId } }) as const,
  // Presence
  presenceUpdate: (state: Record<string, unknown>) =>
    ({ type: MSG.PRESENCE_UPDATE, payload: state }) as const,
  // Gateway
  gwScopeConnect: (scopeType: string, scopeId: string) =>
    ({ type: MSG.GW_SCOPE_CONNECT, payload: { scopeType, scopeId } }) as const,
  gwScopeDisconnect: (scopeType: string, scopeId: string) =>
    ({ type: MSG.GW_SCOPE_DISCONNECT, payload: { scopeType, scopeId } }) as const,
  gwTokenRefresh: (token: string) =>
    ({ type: MSG.GW_TOKEN_REFRESH, payload: { token } }) as const,
}

/** Factories for every server → client message. Used by room DOs and
 *  handler modules so server broadcasts are payload-checked too. Opaque
 *  slots (`record`, `shape`, `peer`, etc.) take `unknown` so concrete
 *  domain types — `RecordResult`, `CanvasShape`, `MediaPeer` — can be
 *  passed without casts. */
export const serverBuild = {
  // Records / CRUD
  queryResult: (subscriptionId: string, records: unknown[]) =>
    ({ type: MSG.QUERY_RESULT, payload: { subscriptionId, records } }) as const,
  recordChange: (
    collection: string,
    record: unknown,
    changeType: 'create' | 'update' | 'delete',
  ) =>
    ({ type: MSG.RECORD_CHANGE, payload: { collection, record, changeType } }) as const,
  error: (error: string, subscriptionId?: string) =>
    ({ type: MSG.ERROR, payload: { error, subscriptionId } }) as const,
  ackSuccess: (requestId: string, recordId?: string) =>
    ({
      type: MSG.ACK,
      payload: { requestId, success: true as const, recordId },
    }) as const,
  ackFailure: (requestId: string, error: string) =>
    ({
      type: MSG.ACK,
      payload: { requestId, success: false as const, error },
    }) as const,
  resubscribe: () => ({ type: MSG.RESUBSCRIBE, payload: EMPTY }) as const,
  schemas: (schemas: unknown) =>
    ({ type: MSG.LIST_SCHEMAS, payload: { schemas } }) as const,
  // Users
  userInfo: (user: unknown) =>
    ({ type: MSG.USER_INFO, payload: user }) as const,
  userList: (users: unknown[]) =>
    ({ type: MSG.USER_LIST, payload: { users } }) as const,
  // Yjs
  yjsJoin: (collection: string, recordId: string, fieldName: string, canWrite: boolean) =>
    ({
      type: MSG.YJS_JOIN,
      payload: { collection, recordId, fieldName, canWrite },
    }) as const,
  // Game
  gameState: (state: unknown, tick: number, players: unknown[], running: boolean) =>
    ({ type: MSG.GAME_STATE, payload: { state, tick, players, running } }) as const,
  gameTick: (state: unknown, tick: number) =>
    ({ type: MSG.GAME_TICK, payload: { state, tick } }) as const,
  gameStart: (state: unknown, tick: number) =>
    ({ type: MSG.GAME_START, payload: { state, tick } }) as const,
  gameEnd: (state: unknown, tick: number) =>
    ({ type: MSG.GAME_END, payload: { state, tick } }) as const,
  gamePlayerJoin: (player: unknown) =>
    ({ type: MSG.GAME_PLAYER_JOIN, payload: { player } }) as const,
  gamePlayerLeave: (userId: string) =>
    ({ type: MSG.GAME_PLAYER_LEAVE, payload: { userId } }) as const,
  gamePlayerReady: (userId: string) =>
    ({ type: MSG.GAME_PLAYER_READY, payload: { userId } }) as const,
  // Canvas
  canvasShapes: (shapes: unknown[], viewports: unknown[]) =>
    ({ type: MSG.CANVAS_SHAPES, payload: { shapes, viewports } }) as const,
  canvasAdd: (shape: unknown) =>
    ({ type: MSG.CANVAS_ADD, payload: { shape } }) as const,
  canvasMove: (shapeId: string, x: number, y: number) =>
    ({ type: MSG.CANVAS_MOVE, payload: { shapeId, x, y } }) as const,
  canvasResize: (
    shapeId: string,
    width: number,
    height: number,
    x?: number,
    y?: number,
  ) =>
    ({ type: MSG.CANVAS_RESIZE, payload: { shapeId, width, height, x, y } }) as const,
  canvasDelete: (shapeId: string) =>
    ({ type: MSG.CANVAS_DELETE, payload: { shapeId } }) as const,
  canvasUpdate: (shapeId: string, props: Record<string, unknown>) =>
    ({ type: MSG.CANVAS_UPDATE, payload: { shapeId, props } }) as const,
  canvasViewport: (viewport: unknown) =>
    ({ type: MSG.CANVAS_VIEWPORT, payload: { viewport } }) as const,
  canvasViewportRemoved: (userId: string) =>
    ({
      type: MSG.CANVAS_VIEWPORT,
      payload: { userId, removed: true as const },
    }) as const,
  // Cron
  cronTasks: (tasks: unknown) =>
    ({ type: MSG.CRON_TASKS, payload: { tasks } }) as const,
  cronHistory: (history: unknown) =>
    ({ type: MSG.CRON_HISTORY, payload: { history } }) as const,
  cronStatus: (tasks: unknown, recentHistory: unknown) =>
    ({ type: MSG.CRON_STATUS, payload: { tasks, recentHistory } }) as const,
  // Jobs
  jobSnapshot: (jobs: unknown[]) =>
    ({ type: MSG.JOB_UPDATE, payload: { kind: 'snapshot' as const, jobs } }) as const,
  jobEnqueued: (job: unknown, requestId?: string) =>
    ({
      type: MSG.JOB_UPDATE,
      payload: { kind: 'enqueued' as const, job, requestId },
    }) as const,
  jobProgress: (job: unknown) =>
    ({ type: MSG.JOB_UPDATE, payload: { kind: 'progress' as const, job } }) as const,
  jobSucceeded: (job: unknown) =>
    ({ type: MSG.JOB_UPDATE, payload: { kind: 'succeeded' as const, job } }) as const,
  jobFailed: (job: unknown) =>
    ({ type: MSG.JOB_UPDATE, payload: { kind: 'failed' as const, job } }) as const,
  jobCanceled: (job: unknown) =>
    ({ type: MSG.JOB_UPDATE, payload: { kind: 'canceled' as const, job } }) as const,
  jobRetried: (job: unknown) =>
    ({ type: MSG.JOB_UPDATE, payload: { kind: 'retried' as const, job } }) as const,
  // Presence
  presenceSync: (peers: unknown[]) =>
    ({ type: MSG.PRESENCE_SYNC, payload: { peers } }) as const,
  presenceJoin: (peer: unknown) =>
    ({ type: MSG.PRESENCE_JOIN, payload: { peer } }) as const,
  presenceLeave: (userId: string) =>
    ({ type: MSG.PRESENCE_LEAVE, payload: { userId } }) as const,
  presenceUpdate: (userId: string, state: Record<string, unknown>) =>
    ({ type: MSG.PRESENCE_UPDATE, payload: { userId, state } }) as const,
  // Gateway
  gwScopeError: (scopeType: string, scopeId: string, error: string) =>
    ({
      type: MSG.GW_SCOPE_ERROR,
      payload: { scopeType, scopeId, error },
    }) as const,
  gwUserUpdate: (user: unknown) =>
    ({ type: MSG.GW_USER_UPDATE, payload: user }) as const,
}

// =============================================================================
// Typed dispatch
// =============================================================================
//
// `dispatch` parses a raw WebSocket frame (or takes an already-parsed
// object) and routes it to the right handler. Handlers are indexed by the
// message's string `type`, and TS narrows the `payload` argument to the
// correct arm of the message union automatically thanks to the
// discriminated-union lookup.
//
// The generic `M` defaults to `ProtocolMessage` so ad-hoc uses get the
// full SDK vocabulary for free, but apps can pass a narrower (or extended)
// union:
//
//     dispatch<ServerMessage>(raw, {
//       [MSG.GAME_STATE]: (p) => { /* p is narrowed */ },
//       [MSG.GAME_TICK]:  (p) => { /* p is narrowed */ },
//     })
//
//     // With an app-defined message (use a STRING LITERAL for the type
//     // parameter — `string` widens the union and kills narrowing):
//     type MyMsg =
//       | ServerMessage
//       | BaseMessage<'myapp.boss_spawn', { hp: number }>
//     dispatch<MyMsg>(raw, {
//       'myapp.boss_spawn': (p) => { console.log(p.hp) },
//     })
//
// =============================================================================

/**
 * Handler map keyed by a message's string `type`. Every key maps to the
 * payload type of the matching arm in `M`, so handlers get automatic
 * payload narrowing with no runtime checks.
 *
 * Narrowing requires each `M` arm to use a string-literal `T`; widening
 * `M` to `BaseMessage<string, unknown>` collapses all keys to a single
 * untyped `string` and the map becomes a plain `Record<string, (p: unknown)
 * => void>`.
 */
export type MessageHandlers<M extends BaseMessage<string, unknown> = ProtocolMessage> = {
  [K in M as K['type']]?: (payload: K['payload']) => void
}

/**
 * Parse and route an incoming wire message. Accepts either the raw JSON
 * string (directly from `ws.onmessage`'s `event.data`) or an already-
 * parsed object. Returns `true` if a handler ran, `false` otherwise
 * (unrecognised type, parse failure, or malformed envelope).
 *
 * Defaults `M` to `ProtocolMessage` so callers who don't care about
 * direction can just do `dispatch(raw, handlers)`; narrow with
 * `dispatch<ClientMessage>` / `dispatch<ServerMessage>` to restrict which
 * arms the handler map is allowed to cover.
 */
export function dispatch<M extends BaseMessage<string, unknown> = ProtocolMessage>(
  raw: unknown,
  handlers: MessageHandlers<M>,
): boolean {
  let msg: { type?: unknown; payload?: unknown }
  if (typeof raw === 'string') {
    try {
      msg = JSON.parse(raw) as { type?: unknown; payload?: unknown }
    } catch {
      return false
    }
  } else if (raw && typeof raw === 'object') {
    msg = raw as { type?: unknown; payload?: unknown }
  } else {
    return false
  }
  if (typeof msg.type !== 'string') return false
  const handler = (handlers as Record<string, ((payload: unknown) => void) | undefined>)[
    msg.type
  ]
  if (!handler) return false
  handler(msg.payload)
  return true
}

/**
 * Serialise a typed-built message for `ws.send`. A tiny wrapper around
 * `JSON.stringify` kept around so call sites read as
 * `ws.send(encode(clientBuild.gameInput(...)))` rather than paying
 * attention to stringify arguments.
 */
export function encode<M extends BaseMessage<string, unknown>>(message: M): string {
  return JSON.stringify(message)
}
