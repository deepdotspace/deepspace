/**
 * Process-wide auth state for `deepspace/native`.
 *
 * The shared client code (RecordProvider, RecordScope, integration) reads auth
 * through plain functions rather than React context, exactly as the browser
 * build reads its cookie session. The native bundle therefore binds one
 * DeepSpaceExpoClient for the whole app; DeepSpaceNativeProvider owns that
 * binding and this module turns the client's session into `useAuth` state.
 */
import { useSyncExternalStore } from 'react'
import type { DeepSpaceExpoClient, DeepSpaceExpoSession } from '../expo'
import { jwtClaims } from '../expo-jwt'

/** Same shape as the browser `useAuth`, so the shared storage layer reads it unchanged. */
export interface NativeAuthState {
  /** True once the stored session has been read. */
  isLoaded: boolean
  isSignedIn: boolean
  userId: string | null
  /** Native sessions are opaque to the app, so this is always null. */
  sessionId: string | null
}

const LOADING: NativeAuthState = {
  isLoaded: false,
  isSignedIn: false,
  userId: null,
  sessionId: null,
}

let boundClient: DeepSpaceExpoClient | null = null
let unsubscribeClient: (() => void) | null = null
let bindGeneration = 0
let state: NativeAuthState = LOADING
const listeners = new Set<() => void>()

function publish(next: NativeAuthState): void {
  if (
    next.isLoaded === state.isLoaded &&
    next.isSignedIn === state.isSignedIn &&
    next.userId === state.userId
  ) {
    return
  }
  state = next
  for (const listener of [...listeners]) listener()
}

function stateForSession(session: DeepSpaceExpoSession | null): NativeAuthState {
  if (!session) return { isLoaded: true, isSignedIn: false, userId: null, sessionId: null }
  return {
    isLoaded: true,
    isSignedIn: true,
    userId: subjectOf(session.accessToken),
    sessionId: null,
  }
}

function subjectOf(token: string): string | null {
  const sub = jwtClaims(token)?.sub
  return typeof sub === 'string' ? sub : null
}

/**
 * Bind the app's client. Idempotent for the same client, so it is safe to call
 * while rendering; binding a different client resets auth to loading.
 */
export function bindNativeClient(client: DeepSpaceExpoClient): void {
  if (boundClient === client) return
  unsubscribeClient?.()
  boundClient = client
  const generation = ++bindGeneration
  // Reset without notifying: this can run during a render.
  state = LOADING
  unsubscribeClient = client.subscribe((session) => {
    if (generation === bindGeneration) publish(stateForSession(session))
  })
  client.getSession().then(
    (session) => {
      if (generation === bindGeneration) publish(stateForSession(session))
    },
    (error: unknown) => {
      console.error('[deepspace/native] could not read the stored session', error)
      if (generation === bindGeneration) publish(stateForSession(null))
    },
  )
}

/** The bound client, or null before DeepSpaceNativeProvider renders. */
export function currentNativeClient(): DeepSpaceExpoClient | null {
  return boundClient
}

/** The bound client; throws a setup error when the provider is missing. */
export function requireNativeClient(): DeepSpaceExpoClient {
  if (!boundClient) {
    throw new Error(
      'deepspace/native: render <DeepSpaceNativeProvider client={...}> above any DeepSpace hook or call.',
    )
  }
  return boundClient
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): NativeAuthState {
  return state
}

/** Auth state for the signed-in DeepSpace user on this device. */
export function useAuth(): NativeAuthState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** A short-lived bearer for API and room requests, refreshed when it nears expiry. */
export async function getNativeAuthToken(): Promise<string | null> {
  return boundClient ? boundClient.getAuthToken() : null
}

/** Test hook: forget the bound client and auth state. Not part of the public API. */
export function __resetNativeSessionForTests(): void {
  unsubscribeClient?.()
  unsubscribeClient = null
  boundClient = null
  bindGeneration += 1
  state = LOADING
  listeners.clear()
}
