/**
 * DeepSpace Expo client.
 *
 * This entry is intentionally separate from `deepspace`: the browser client
 * uses Better Auth cookies and browser globals, while an Expo app needs the
 * system browser, a custom-scheme callback, and SecureStore-backed sessions.
 * The Worker still owns auth and JWT issuance; this package only transports the
 * one-time OAuth code and refreshes the short-lived bearer.
 */
import * as Linking from 'expo-linking'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import * as WebBrowser from 'expo-web-browser'
import {
  buildExpoOAuthStartUrl,
  codeFromExpoRedirect,
  normalizeExpoBaseUrl,
  stateFromExpoRedirect,
} from './expo-url'

export type ExpoAuthProvider = 'google' | (string & {})

export interface DeepSpaceExpoSession {
  sessionToken: string
  accessToken: string
}

export interface DeepSpaceExpoUser {
  userId: string
  claims: Record<string, unknown>
}

export interface ExpoAuthStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  deleteItem(key: string): Promise<void>
}

export interface DeepSpaceExpoClientOptions {
  /** Deployed app origin, for example `https://veriluma.app.space`. */
  baseUrl: string
  /** Defaults to Expo's `createURL('auth/callback')`. */
  redirectUri?: string
  /** SecureStore-backed by default; inject a test store when unit testing. */
  storage?: ExpoAuthStorage
  /** Namespaced storage key so multiple apps can share one device. */
  storageKey?: string
  /** Worker endpoint overrides for apps with a custom auth route. */
  paths?: Partial<ExpoAuthPaths>
  fetch?: typeof globalThis.fetch
  /** Abort stalled auth/API requests after this many milliseconds. */
  timeoutMs?: number
}

export interface ExpoAuthPaths {
  start: string
  exchange: string
  token: string
  me: string
  signOut: string
}

export class DeepSpaceExpoError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'DeepSpaceExpoError'
    this.status = status
    this.body = body
  }
}

const DEFAULT_PATHS: ExpoAuthPaths = {
  start: '/api/auth/native-start',
  exchange: '/api/auth/native-exchange',
  token: '/api/auth/native-token',
  me: '/api/auth/native-me',
  signOut: '/api/auth/native-signout',
}

const defaultStorage: ExpoAuthStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
}

export function createDeepSpaceExpoClient(options: DeepSpaceExpoClientOptions): DeepSpaceExpoClient {
  return new DeepSpaceExpoClient(options)
}

export class DeepSpaceExpoClient {
  private readonly baseUrl: string
  private readonly redirectUri: string
  private readonly storage: ExpoAuthStorage
  private readonly storageKey: string
  private readonly paths: ExpoAuthPaths
  private readonly fetcher: typeof globalThis.fetch
  private readonly timeoutMs: number
  private session: DeepSpaceExpoSession | null | undefined

  constructor(options: DeepSpaceExpoClientOptions) {
    if (!options.baseUrl) throw new Error('DeepSpace Expo client requires baseUrl')
    this.baseUrl = normalizeExpoBaseUrl(options.baseUrl)
    this.redirectUri = options.redirectUri ?? Linking.createURL('auth/callback')
    this.storage = options.storage ?? defaultStorage
    this.storageKey = options.storageKey ?? `deepspace.session.${encodeURIComponent(this.baseUrl)}`
    this.paths = { ...DEFAULT_PATHS, ...options.paths }
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async getSession(): Promise<DeepSpaceExpoSession | null> {
    if (this.session !== undefined) return this.session
    const raw = await this.storage.getItem(this.storageKey)
    if (!raw) return (this.session = null)
    try {
      const value = JSON.parse(raw) as Partial<DeepSpaceExpoSession>
      if (typeof value.sessionToken !== 'string' || typeof value.accessToken !== 'string') throw new Error('invalid session')
      return (this.session = value as DeepSpaceExpoSession)
    } catch {
      await this.storage.deleteItem(this.storageKey)
      return (this.session = null)
    }
  }

  async signIn(provider: ExpoAuthProvider = 'google', state?: string): Promise<DeepSpaceExpoUser> {
    const expectedState = state ?? createOAuthState()
    const codeVerifier = createCodeVerifier()
    const codeChallenge = await createCodeChallenge(codeVerifier)
    const startUrl = buildExpoOAuthStartUrl(
      this.baseUrl,
      provider,
      this.redirectUri,
      expectedState,
      this.paths.start,
      codeChallenge,
    )
    const result = await WebBrowser.openAuthSessionAsync(startUrl, this.redirectUri)
    if (result.type !== 'success' || !result.url) throw new Error('DeepSpace sign-in was cancelled')
    const code = codeFromExpoRedirect(result.url)
    if (!code) throw new Error('DeepSpace sign-in returned no exchange code')
    if (stateFromExpoRedirect(result.url) !== expectedState) {
      throw new Error('DeepSpace sign-in returned an invalid state')
    }
    const session = await this.json<DeepSpaceExpoSession>(this.paths.exchange, {
      method: 'POST',
      body: JSON.stringify({ code, code_verifier: codeVerifier }),
    })
    await this.saveSession(session)
    return this.me()
  }

  signInWithGoogle(state?: string): Promise<DeepSpaceExpoUser> { return this.signIn('google', state) }

  async refresh(): Promise<string | null> {
    const session = await this.getSession()
    if (!session) return null
    try {
      const next = await this.json<{ accessToken?: string; token?: string }>(this.paths.token, { method: 'POST', body: JSON.stringify({ sessionToken: session.sessionToken }) })
      const accessToken = next.accessToken ?? next.token
      if (!accessToken) throw new Error('DeepSpace did not issue an access token')
      await this.saveSession({ ...session, accessToken })
      return accessToken
    } catch (error) {
      if (error instanceof DeepSpaceExpoError && error.status === 401) await this.clearSession()
      return null
    }
  }

  async getAuthToken(): Promise<string | null> {
    const session = await this.getSession()
    return session?.accessToken || (await this.refresh())
  }

  async me(): Promise<DeepSpaceExpoUser> {
    const result = await this.request<DeepSpaceExpoUser>(this.paths.me)
    return result
  }

  async request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const token = await this.getAuthToken()
    const headers = new Headers(init.headers)
    if (!headers.has('Content-Type') && init.body != null && isJsonBody(init.body)) {
      headers.set('Content-Type', 'application/json')
    }
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, { ...init, headers })
    const body = await response.json().catch(() => ({})) as T & { error?: string }
    if (response.status === 401 && !retried && isReplayableBody(init.body) && (await this.getSession())?.sessionToken) {
      const refreshed = await this.refresh()
      if (refreshed) return this.request<T>(path, init, true)
    }
    if (!response.ok) throw new DeepSpaceExpoError(typeof body.error === 'string' ? body.error : `DeepSpace request failed (${response.status})`, response.status, body)
    return body
  }

  async signOut(): Promise<void> {
    const session = await this.getSession()
    if (session) {
      await this.fetchWithTimeout(`${this.baseUrl}${this.paths.signOut}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionToken: session.sessionToken }) }).catch(() => undefined)
    }
    await this.clearSession()
  }

  private async json<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
    const body = await response.json().catch(() => ({})) as T & { error?: string }
    if (!response.ok) throw new DeepSpaceExpoError(typeof body.error === 'string' ? body.error : `DeepSpace auth failed (${response.status})`, response.status, body)
    return body
  }

  private async saveSession(session: DeepSpaceExpoSession) { this.session = session; await this.storage.setItem(this.storageKey, JSON.stringify(session)) }
  private async clearSession() { this.session = null; await this.storage.deleteItem(this.storageKey) }

  private async fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    if (!this.timeoutMs || this.timeoutMs <= 0) return this.fetcher(input, init)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const signal = init.signal
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      return await this.fetcher(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

export {
  buildExpoOAuthStartUrl,
  codeFromExpoRedirect,
  normalizeExpoBaseUrl,
  stateFromExpoRedirect,
}

function createOAuthState(): string {
  return Crypto.randomUUID()
}

function createCodeVerifier(): string {
  return `${Crypto.randomUUID().replaceAll('-', '')}${Crypto.randomUUID().replaceAll('-', '')}`
}

async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  )
  return digest.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function isJsonBody(body: BodyInit): boolean {
  return typeof body === 'string'
}

function isReplayableBody(body: BodyInit | null | undefined): boolean {
  if (body == null || typeof body === 'string') return true
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true
  return false
}
