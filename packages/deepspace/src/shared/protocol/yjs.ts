/**
 * Yjs Sync Protocol Implementation
 * 
 * This implements the y-protocols sync and awareness protocols without
 * depending on y-websocket internal paths. Makes it easier to bundle
 * and template.
 * 
 * Protocol spec: https://github.com/yjs/y-protocols
 */

import * as Y from 'yjs'

// Message type constants
export const MSG_SYNC = 0
export const MSG_AWARENESS = 1

// Sync message subtypes
export const MSG_SYNC_STEP1 = 0  // Send state vector
export const MSG_SYNC_STEP2 = 1  // Send diff based on received state vector
export const MSG_SYNC_UPDATE = 2 // Send incremental update

// ============================================================================
// Binary Encoding Utilities (lib0 compatible)
// ============================================================================

export function createEncoder(): { data: number[] } {
  return { data: [] }
}

export function toUint8Array(encoder: { data: number[] }): Uint8Array {
  return new Uint8Array(encoder.data)
}

export function writeVarUint(encoder: { data: number[] }, num: number): void {
  while (num > 0x7f) {
    encoder.data.push((num & 0x7f) | 0x80)
    num = Math.floor(num / 128)
  }
  encoder.data.push(num & 0x7f)
}

export function writeVarUint8Array(encoder: { data: number[] }, arr: Uint8Array): void {
  writeVarUint(encoder, arr.length)
  for (let i = 0; i < arr.length; i++) {
    encoder.data.push(arr[i])
  }
}

export function createDecoder(data: Uint8Array): { data: Uint8Array; pos: number } {
  return { data, pos: 0 }
}

export function readVarUint(decoder: { data: Uint8Array; pos: number }): number {
  let num = 0
  let mult = 1
  const len = decoder.data.length
  while (decoder.pos < len) {
    const byte = decoder.data[decoder.pos++]
    num += (byte & 0x7f) * mult
    mult *= 128
    if (byte < 0x80) {
      return num
    }
  }
  throw new Error('Unexpected end of buffer')
}

export function readVarUint8Array(decoder: { data: Uint8Array; pos: number }): Uint8Array {
  const len = readVarUint(decoder)
  const arr = decoder.data.subarray(decoder.pos, decoder.pos + len)
  decoder.pos += len
  return arr
}

export function hasContent(decoder: { data: Uint8Array; pos: number }): boolean {
  return decoder.pos < decoder.data.length
}

// ============================================================================
// Sync Protocol
// ============================================================================

/**
 * Encode sync step 1: our state vector
 */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = createEncoder()
  writeVarUint(encoder, MSG_SYNC)
  writeVarUint(encoder, MSG_SYNC_STEP1)
  writeVarUint8Array(encoder, Y.encodeStateVector(doc))
  return toUint8Array(encoder)
}

/**
 * Encode sync step 2: diff based on received state vector
 */
export function encodeSyncStep2(doc: Y.Doc, stateVector: Uint8Array): Uint8Array {
  const encoder = createEncoder()
  writeVarUint(encoder, MSG_SYNC)
  writeVarUint(encoder, MSG_SYNC_STEP2)
  writeVarUint8Array(encoder, Y.encodeStateAsUpdate(doc, stateVector))
  return toUint8Array(encoder)
}

/**
 * Encode an incremental update
 */
export function encodeUpdate(update: Uint8Array): Uint8Array {
  const encoder = createEncoder()
  writeVarUint(encoder, MSG_SYNC)
  writeVarUint(encoder, MSG_SYNC_UPDATE)
  writeVarUint8Array(encoder, update)
  return toUint8Array(encoder)
}

export interface SyncResult {
  type: 'step1' | 'step2' | 'update'
  response?: Uint8Array
  stateVector?: Uint8Array
  update?: Uint8Array
}

/**
 * Handle an incoming sync message
 * Returns response to send (if any) and whether this was an update
 */
export function handleSyncMessage(doc: Y.Doc, data: Uint8Array): SyncResult {
  const decoder = createDecoder(data)
  const messageType = readVarUint(decoder)
  
  if (messageType !== MSG_SYNC) {
    throw new Error(`Expected sync message (${MSG_SYNC}), got ${messageType}`)
  }
  
  const syncType = readVarUint(decoder)
  
  switch (syncType) {
    case MSG_SYNC_STEP1: {
      // Received state vector, send our diff
      const stateVector = readVarUint8Array(decoder)
      const response = encodeSyncStep2(doc, stateVector)
      return { type: 'step1', response, stateVector }
    }
    
    case MSG_SYNC_STEP2: {
      // Received diff, apply it
      const update = readVarUint8Array(decoder)
      Y.applyUpdate(doc, update)
      return { type: 'step2', update }
    }
    
    case MSG_SYNC_UPDATE: {
      // Received incremental update, apply it
      const update = readVarUint8Array(decoder)
      Y.applyUpdate(doc, update)
      return { type: 'update', update }
    }
    
    default:
      throw new Error(`Unknown sync type: ${syncType}`)
  }
}

// ============================================================================
// Awareness Protocol
// ============================================================================

export interface AwarenessState {
  [key: string]: unknown
}

export interface AwarenessStates {
  [clientId: number]: AwarenessState
}

/**
 * Simple awareness implementation for presence/cursors
 */
export class Awareness {
  doc: Y.Doc
  clientID: number
  states: Map<number, AwarenessState> = new Map()
  private meta: Map<number, { clock: number; lastUpdated: number }> = new Map()
  private updateListeners: Set<(changes: { added: number[]; updated: number[]; removed: number[] }) => void> = new Set()
  private changeListeners: Set<(changes: { added: number[]; updated: number[]; removed: number[] }) => void> = new Set()

  constructor(doc: Y.Doc) {
    this.doc = doc
    this.clientID = doc.clientID
  }
  
  getStates(): Map<number, AwarenessState> {
    return this.states
  }
  
  getLocalState(): AwarenessState | null {
    return this.states.get(this.clientID) || null
  }
  
  setLocalState(state: AwarenessState | null): void {
    const clientID = this.clientID
    const prevState = this.states.get(clientID)
    
    if (state === null) {
      this.states.delete(clientID)
      this.meta.delete(clientID)
      if (prevState) {
        this.emit({ added: [], updated: [], removed: [clientID] })
      }
    } else {
      const meta = this.meta.get(clientID) || { clock: 0, lastUpdated: Date.now() }
      meta.clock++
      meta.lastUpdated = Date.now()
      this.meta.set(clientID, meta)
      this.states.set(clientID, state)
      this.emit({
        added: prevState ? [] : [clientID],
        updated: prevState ? [clientID] : [],
        removed: [],
      })
    }
  }
  
  setLocalStateField(field: string, value: unknown): void {
    const state = this.getLocalState() || {}
    state[field] = value
    this.setLocalState(state)
  }
  
  on(event: 'update' | 'change', handler: (changes: { added: number[]; updated: number[]; removed: number[] }) => void): void {
    if (event === 'update') {
      this.updateListeners.add(handler)
    } else if (event === 'change') {
      this.changeListeners.add(handler)
    }
  }

  off(event: 'update' | 'change', handler: (changes: { added: number[]; updated: number[]; removed: number[] }) => void): void {
    if (event === 'update') {
      this.updateListeners.delete(handler)
    } else if (event === 'change') {
      this.changeListeners.delete(handler)
    }
  }

  private emit(changes: { added: number[]; updated: number[]; removed: number[] }): void {
    for (const handler of this.updateListeners) {
      handler(changes)
    }
    if (changes.added.length > 0 || changes.updated.length > 0 || changes.removed.length > 0) {
      for (const handler of this.changeListeners) {
        handler(changes)
      }
    }
  }
  
  /**
   * Encode awareness update for specific clients
   */
  encodeUpdate(clientIds?: number[]): Uint8Array {
    const ids = clientIds || Array.from(this.states.keys())
    const encoder = createEncoder()
    writeVarUint(encoder, ids.length)
    
    for (const clientId of ids) {
      const state = this.states.get(clientId)
      const meta = this.meta.get(clientId) || { clock: 0, lastUpdated: Date.now() }
      
      writeVarUint(encoder, clientId)
      writeVarUint(encoder, meta.clock)
      
      const stateStr = state ? JSON.stringify(state) : 'null'
      const stateBytes = new TextEncoder().encode(stateStr)
      writeVarUint8Array(encoder, stateBytes)
    }
    
    return toUint8Array(encoder)
  }
  
  /**
   * Apply awareness update from another client
   */
  applyUpdate(data: Uint8Array): { added: number[]; updated: number[]; removed: number[] } {
    const decoder = createDecoder(data)
    const len = readVarUint(decoder)
    
    const added: number[] = []
    const updated: number[] = []
    const removed: number[] = []
    
    for (let i = 0; i < len; i++) {
      const clientId = readVarUint(decoder)
      const clock = readVarUint(decoder)
      const stateBytes = readVarUint8Array(decoder)
      const stateStr = new TextDecoder().decode(stateBytes)
      const state = stateStr === 'null' ? null : JSON.parse(stateStr) as AwarenessState
      
      const prevMeta = this.meta.get(clientId)
      const prevState = this.states.get(clientId)
      
      // Only apply if this is a newer update
      if (!prevMeta || prevMeta.clock < clock) {
        this.meta.set(clientId, { clock, lastUpdated: Date.now() })
        
        if (state === null) {
          this.states.delete(clientId)
          if (prevState) {
            removed.push(clientId)
          }
        } else {
          this.states.set(clientId, state)
          if (prevState) {
            updated.push(clientId)
          } else {
            added.push(clientId)
          }
        }
      }
    }
    
    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      this.emit({ added, updated, removed })
    }
    
    return { added, updated, removed }
  }
  
  /**
   * Remove awareness states for disconnected clients
   */
  removeStates(clientIds: number[]): void {
    const removed: number[] = []
    for (const clientId of clientIds) {
      if (this.states.has(clientId)) {
        this.states.delete(clientId)
        this.meta.delete(clientId)
        removed.push(clientId)
      }
    }
    if (removed.length > 0) {
      this.emit({ added: [], updated: [], removed })
    }
  }
}

/**
 * Encode a full awareness message
 */
export function encodeAwarenessMessage(awareness: Awareness, clientIds?: number[]): Uint8Array {
  const encoder = createEncoder()
  writeVarUint(encoder, MSG_AWARENESS)
  writeVarUint8Array(encoder, awareness.encodeUpdate(clientIds))
  return toUint8Array(encoder)
}

/**
 * Decode and apply awareness message
 */
export function handleAwarenessMessage(
  awareness: Awareness, 
  data: Uint8Array
): { added: number[]; updated: number[]; removed: number[] } {
  const decoder = createDecoder(data)
  const messageType = readVarUint(decoder)
  
  if (messageType !== MSG_AWARENESS) {
    throw new Error(`Expected awareness message (${MSG_AWARENESS}), got ${messageType}`)
  }
  
  const update = readVarUint8Array(decoder)
  return awareness.applyUpdate(update)
}

/**
 * Get message type from raw data
 */
export function getMessageType(data: Uint8Array): number {
  const decoder = createDecoder(data)
  return readVarUint(decoder)
}

