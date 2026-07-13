/**
 * GameRoom — Authoritative game loop Durable Object.
 *
 * Extends BaseRoom with:
 * - Alarm-based tick loop with configurable interval
 * - Player management (join, leave, ready state)
 * - Input collection per tick, authoritative state computation
 * - State broadcast to all connected players
 *
 * Subclasses implement game logic via lifecycle hooks:
 *   onTick, onPlayerJoin, onPlayerLeave, onGameStart, onGameEnd
 *
 * Message types: game.*
 */

/// <reference types="@cloudflare/workers-types" />

import { BaseRoom, type UserAttachment } from './base-room'
import { MSG } from '../../shared/protocol/constants'
import { ROLES } from '../../shared/roles'

// ============================================================================
// Types
// ============================================================================

export interface GameRoomConfig {
  /** Ticks per second (default: 20) */
  tickRate?: number
  /** Minimum players to start (default: 1) */
  minPlayers?: number
  /** Maximum players (default: unlimited) */
  maxPlayers?: number
}

export interface Player {
  userId: string
  userName: string
  ready: boolean
  connectedAt: string
  data: Record<string, unknown>
}

export interface GameInput {
  userId: string
  action: string
  data: Record<string, unknown>
  tick: number
}

interface GameAttachment extends UserAttachment {
  joinedAt: string
  /** True for member/admin roles; false for viewers, unauthenticated anon, spectators. */
  canWrite: boolean
}

// Game-control messages that mutate state. Viewers can still receive
// broadcast game ticks (they're spectators), but they can't drive the game.
const GAME_WRITE_TYPES: ReadonlySet<string> = new Set([
  MSG.GAME_INPUT,
  MSG.GAME_PLAYER_READY,
  MSG.GAME_START,
  MSG.GAME_END,
])

// ============================================================================
// GameRoom
// ============================================================================

export abstract class GameRoom<E = Record<string, unknown>> extends BaseRoom<E> {
  private config: Required<GameRoomConfig>
  private players: Map<string, Player> = new Map()
  private inputBuffer: GameInput[] = []
  private currentTick = 0
  private gameState: Record<string, unknown> = {}
  private running = false
  private initialized = false

  constructor(
    state: DurableObjectState,
    env: unknown,
    config: GameRoomConfig = {}
  ) {
    super(state, env)
    this.config = {
      tickRate: config.tickRate ?? 20,
      minPlayers: config.minPlayers ?? 1,
      maxPlayers: config.maxPlayers ?? Infinity,
    }
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS game_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL,
        tick INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `)
    // Load persisted state and give the subclass a chance to migrate it.
    // Subclasses with evolving schemas should override `onHydrateState`
    // to merge new fields, upgrade shapes, or discard stale blobs.
    const rows = this.sql.exec('SELECT state, tick FROM game_state WHERE id = 1').toArray()
    if (rows.length > 0) {
      try {
        const parsed = JSON.parse(rows[0].state as string) as Record<string, unknown>
        this.gameState = this.onHydrateState(parsed)
        this.currentTick = rows[0].tick as number
      } catch { /* fresh state */ }
    }
  }

  private persistState(): void {
    const now = new Date().toISOString()
    this.sql.exec(
      `INSERT INTO game_state (id, state, tick, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = ?, tick = ?, updated_at = ?`,
      JSON.stringify(this.gameState), this.currentTick, now,
      JSON.stringify(this.gameState), this.currentTick, now,
    )
  }

  // ==========================================================================
  // BaseRoom Lifecycle
  // ==========================================================================

  protected onConnect(ws: WebSocket, user: UserAttachment): GameAttachment {
    this.ensureInitialized()

    const role = (user.role as string | undefined) ?? ROLES.VIEWER
    const canWrite = role === ROLES.MEMBER || role === ROLES.ADMIN

    const attachment: GameAttachment = {
      ...user,
      joinedAt: new Date().toISOString(),
      canWrite,
    }

    // Sent before any state so the client knows from the first frame
    // whether to enable input controls. Both spectators and players get
    // it — the value differs by role.
    this.sendTo(ws, { type: MSG.AUTH, payload: { canWrite } })

    // Viewers and unauthenticated anon connections are spectators: they
    // receive game-state broadcasts but are NOT added to the players map.
    // Adding them would block auto-start (their never-ready entry keeps
    // readyCount < players.size) and let them appear in client UIs as
    // ghost players.
    if (!canWrite) {
      this.sendTo(ws, {
        type: MSG.GAME_STATE,
        payload: {
          state: this.gameState,
          tick: this.currentTick,
          players: Array.from(this.players.values()),
          running: this.running,
        },
      })
      return attachment
    }

    const player: Player = {
      userId: user.userId,
      userName: user.userName,
      ready: false,
      connectedAt: attachment.joinedAt,
      data: {},
    }

    if (this.config.maxPlayers !== Infinity && this.players.size >= this.config.maxPlayers) {
      this.sendTo(ws, { type: MSG.ERROR, payload: { error: 'Game is full' } })
      return attachment
    }

    this.players.set(user.userId, player)

    // Send current state to new player
    this.sendTo(ws, {
      type: MSG.GAME_STATE,
      payload: {
        state: this.gameState,
        tick: this.currentTick,
        players: Array.from(this.players.values()),
        running: this.running,
      },
    })

    // Notify others
    this.broadcast({ type: MSG.GAME_PLAYER_JOIN, payload: { player } }, ws)

    this.onPlayerJoin(player)

    return attachment
  }

  protected async onMessage(
    ws: WebSocket,
    user: UserAttachment,
    message: { type: string; [key: string]: unknown }
  ): Promise<void> {
    this.ensureInitialized()

    const { type, payload } = message as { type: string; payload: Record<string, unknown> }

    if (GAME_WRITE_TYPES.has(type) && !(user as GameAttachment).canWrite) {
      this.sendTo(ws, {
        type: MSG.ERROR,
        payload: { error: 'Write access denied: spectators cannot drive the game' },
      })
      return
    }

    switch (type) {
      case MSG.GAME_INPUT: {
        this.inputBuffer.push({
          userId: user.userId,
          action: payload.action as string,
          data: (payload.data ?? {}) as Record<string, unknown>,
          tick: this.currentTick,
        })
        break
      }

      case MSG.GAME_PLAYER_READY: {
        const player = this.players.get(user.userId)
        if (player) {
          player.ready = true
          this.broadcast({ type: MSG.GAME_PLAYER_READY, payload: { userId: user.userId } })
          this.checkAutoStart()
        }
        break
      }

      case MSG.GAME_START: {
        if (!this.running) {
          this.startGame()
        }
        break
      }

      case MSG.GAME_END: {
        if (this.running) {
          this.stopGame()
        }
        break
      }

      default:
        this.sendTo(ws, { type: MSG.ERROR, payload: { error: `Unknown game message type: ${type}` } })
    }
  }

  protected onDisconnect(ws: WebSocket, user: UserAttachment): void {
    const player = this.players.get(user.userId)
    if (player) {
      this.players.delete(user.userId)
      this.broadcast({ type: MSG.GAME_PLAYER_LEAVE, payload: { userId: user.userId } })
      this.onPlayerLeave(player)

      if (this.running && this.players.size === 0) {
        this.stopGame()
      }
    }
  }

  protected async onAlarm(): Promise<void> {
    if (!this.running) return

    // Collect inputs for this tick
    const inputs = this.inputBuffer.splice(0)
    this.currentTick++

    // Let subclass compute new state
    const newState = await this.onTick(this.gameState, inputs, this.currentTick)
    if (newState !== undefined) {
      this.gameState = newState
    }

    // Persist every 10 ticks
    if (this.currentTick % 10 === 0) {
      this.persistState()
    }

    // Broadcast tick to all players
    this.broadcast({
      type: MSG.GAME_TICK,
      payload: {
        state: this.gameState,
        tick: this.currentTick,
      },
    })

    // Schedule next tick
    if (this.running) {
      const intervalMs = 1000 / this.config.tickRate
      this.state.storage.setAlarm(Date.now() + intervalMs)
    }
  }

  // ==========================================================================
  // Game Control
  // ==========================================================================

  private checkAutoStart(): void {
    if (this.running) return
    const readyCount = Array.from(this.players.values()).filter(p => p.ready).length
    if (readyCount >= this.config.minPlayers && readyCount === this.players.size) {
      this.startGame()
    }
  }

  private startGame(): void {
    this.running = true
    this.currentTick = 0
    this.inputBuffer = []
    this.onGameStart()
    this.broadcast({ type: MSG.GAME_START, payload: { state: this.gameState, tick: 0 } })

    // Start tick loop
    const intervalMs = 1000 / this.config.tickRate
    this.state.storage.setAlarm(Date.now() + intervalMs)
  }

  private stopGame(): void {
    this.running = false
    this.persistState()
    this.onGameEnd(this.gameState)
    this.broadcast({ type: MSG.GAME_END, payload: { state: this.gameState, tick: this.currentTick } })
  }

  // ==========================================================================
  // Protected Accessors (for subclasses)
  // ==========================================================================

  protected getGameState(): Record<string, unknown> {
    return this.gameState
  }

  protected setGameState(state: Record<string, unknown>): void {
    this.gameState = state
  }

  protected getPlayers(): Player[] {
    return Array.from(this.players.values())
  }

  protected isRunning(): boolean {
    return this.running
  }

  protected getCurrentTick(): number {
    return this.currentTick
  }

  // ==========================================================================
  // Lifecycle Hooks (subclasses override)
  // ==========================================================================

  /**
   * Called each tick with current state and collected inputs.
   * Return the new game state, or undefined to keep current state.
   */
  protected abstract onTick(
    state: Record<string, unknown>,
    inputs: GameInput[],
    tick: number
  ): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>

  /** Called when a player connects */
  protected onPlayerJoin(_player: Player): void {}

  /** Called when a player disconnects */
  protected onPlayerLeave(_player: Player): void {}

  /** Called when the game starts */
  protected onGameStart(): void {}

  /** Called when the game ends */
  protected onGameEnd(_finalState: Record<string, unknown>): void {}

  /**
   * Called once when the DO first hydrates persisted state from storage.
   * Receives the parsed state blob as it was written by a previous build.
   * Return the state object to install as `gameState`.
   *
   * Subclasses with evolving schemas should override this hook to:
   *   - merge new fields onto a default template,
   *   - upgrade shapes across versioned states,
   *   - or discard stale blobs entirely by returning a fresh object.
   *
   * The default implementation is a pass-through, preserving the legacy
   * "stored blob is gospel" behavior for subclasses that don't care.
   *
   * If JSON parsing of the stored blob fails this hook is NOT called — the
   * DO starts with an empty state and the subclass's `onGameStart` (or
   * first `onTick`) is responsible for initializing.
   */
  protected onHydrateState(
    stored: Record<string, unknown>,
  ): Record<string, unknown> {
    return stored
  }
}
