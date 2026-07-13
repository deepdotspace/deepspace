/**
 * Wire protocol constants.
 *
 * The JSON WebSocket protocol uses dotted string identifiers (e.g.
 * `"game.input"`) as the `type` discriminator. All message types are
 * grouped under a single `MSG` object so imports stay tidy:
 *
 *     import { MSG, dispatch, clientBuild } from 'deepspace'
 *
 *     dispatch<ServerMessage>(raw, {
 *       [MSG.GAME_STATE]: (p) => { ... },
 *       [MSG.GAME_TICK]:  (p) => { ... },
 *     })
 *
 * Each key's value is the on-wire string — grep-friendly, self-
 * documenting, and infinite per namespace. Adding a new message is one
 * line here plus one arm in the discriminated union in `./messages.ts`.
 *
 * Yjs binary protocol constants (`MSG_YJS_SYNC`, `MSG_YJS_AWARENESS`) are
 * intentionally kept numeric and separate from `MSG` — they ride a
 * binary WebSocket frame format and aren't part of the JSON dispatcher.
 */

export const MSG = {
  // ---- Records / CRUD --------------------------------------------------
  SUBSCRIBE: 'core.subscribe',
  UNSUBSCRIBE: 'core.unsubscribe',
  QUERY_RESULT: 'core.query_result',
  RECORD_CHANGE: 'core.record_change',
  PUT: 'core.put',
  DELETE: 'core.delete',
  ERROR: 'core.error',

  // ---- Users -----------------------------------------------------------
  USER_INFO: 'user.info',
  USER_LIST: 'user.list',
  SET_ROLE: 'user.set_role',
  USER_UPDATE: 'user.update',

  // ---- Auth signal -----------------------------------------------------
  // Server → client one-shot on connect from rooms that enforce role-based
  // writes (Canvas, Game, Cron). Tells the client whether this connection
  // can write so its hook can disable local write APIs and the UI can
  // render controls accordingly. Without this, a viewer's click would
  // round-trip to the server and silently come back as ERROR.
  AUTH: 'auth',

  // ---- Yjs JSON control frames (binary sync lives in ./yjs.ts) ---------
  YJS_JOIN: 'yjs.join',
  YJS_LEAVE: 'yjs.leave',

  // ---- Records room misc -----------------------------------------------
  ACK: 'records.ack',
  LIST_SCHEMAS: 'records.list_schemas',
  RESUBSCRIBE: 'records.resubscribe',

  // ---- GameRoom --------------------------------------------------------
  GAME_STATE: 'game.state',
  GAME_INPUT: 'game.input',
  GAME_PLAYER_JOIN: 'game.player_join',
  GAME_PLAYER_LEAVE: 'game.player_leave',
  GAME_PLAYER_READY: 'game.player_ready',
  GAME_START: 'game.start',
  GAME_END: 'game.end',
  GAME_TICK: 'game.tick',

  // ---- CanvasRoom ------------------------------------------------------
  CANVAS_SHAPES: 'canvas.shapes',
  CANVAS_ADD: 'canvas.add',
  CANVAS_MOVE: 'canvas.move',
  CANVAS_RESIZE: 'canvas.resize',
  CANVAS_DELETE: 'canvas.delete',
  CANVAS_UPDATE: 'canvas.update',
  CANVAS_VIEWPORT: 'canvas.viewport',
  CANVAS_UNDO: 'canvas.undo',
  CANVAS_REDO: 'canvas.redo',

  // ---- CronRoom --------------------------------------------------------
  CRON_TASKS: 'cron.tasks',
  CRON_HISTORY: 'cron.history',
  CRON_TRIGGER: 'cron.trigger',
  CRON_PAUSE: 'cron.pause',
  CRON_RESUME: 'cron.resume',
  CRON_STATUS: 'cron.status',

  // ---- JobRoom ---------------------------------------------------------
  // Background-job queue with durable, alarm-driven execution. See
  // server/rooms/job-room.ts. Clients enqueue and subscribe to updates;
  // the room broadcasts JOB_UPDATE for every status transition.
  JOB_ENQUEUE: 'job.enqueue',
  JOB_CANCEL: 'job.cancel',
  JOB_RETRY: 'job.retry',
  JOB_UPDATE: 'job.update',

  // ---- PresenceRoom ----------------------------------------------------
  PRESENCE_SYNC: 'presence.sync',
  PRESENCE_JOIN: 'presence.join',
  PRESENCE_LEAVE: 'presence.leave',
  PRESENCE_UPDATE: 'presence.update',

  // ---- Gateway multiplexing --------------------------------------------
  GW_SCOPE_CONNECT: 'gateway.scope_connect',
  GW_SCOPE_DISCONNECT: 'gateway.scope_disconnect',
  GW_SCOPE_ERROR: 'gateway.scope_error',
  GW_TOKEN_REFRESH: 'gateway.token_refresh',
  GW_USER_UPDATE: 'gateway.user_update',
} as const

/**
 * Type of any message type constant — the union of every string literal
 * stored in `MSG`. Useful when declaring functions that accept "any known
 * message type" without enumerating all 54 strings by hand.
 */
export type MsgType = (typeof MSG)[keyof typeof MSG]

// ---------------------------------------------------------------------------
// Yjs binary protocol (NOT part of MSG — see header comment)
// ---------------------------------------------------------------------------

/** Outer envelope id for binary-framed yjs sync messages. Varuint-encoded. */
export const MSG_YJS_SYNC = 22
/** Outer envelope id for binary-framed yjs awareness messages. Varuint-encoded. */
export const MSG_YJS_AWARENESS = 23

// ---------------------------------------------------------------------------
// Role names — not wire messages, just the string values the auth layer uses
// as role identifiers.
// ---------------------------------------------------------------------------

/** Role assigned to unauthenticated WebSocket connections */
export const ROLE_ANONYMOUS = 'viewer'
/** Default role for newly registered authenticated users */
export const ROLE_DEFAULT = 'member'
/** Admin role */
export const ROLE_ADMIN = 'admin'
