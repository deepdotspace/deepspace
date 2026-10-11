/**
 * `deepspace/native` in the browser: the web build of a React Native app
 * (React Native Web, `expo export --platform web`), served from the app's own
 * origin. Same names and shapes as the native bindings, so one import works on
 * iPhone, iPad, Mac and the web; underneath, the browser SDK's same-origin
 * cookie session replaces the keychain session and the system sign-in sheet.
 */
import { useMemo, type ReactElement } from 'react'
import { DeepSpaceAuthProvider } from '../client/auth/DeepSpaceAuthProvider'
import { useAuth as useBrowserAuth } from '../client/auth/hooks'
import { authClient, signOut as endBrowserSession } from '../client/auth/client'
import { getAuthToken } from '../client/auth/token'
import { KeyboardShortcutsRoot } from '../client/input/keyboard'
import { appFilePath } from '../shared/app-files'
import type {
  DeepSpaceExpoClient,
  DeepSpaceExpoClientOptions,
  DeepSpaceExpoSession,
  DeepSpaceExpoSessionListener,
  DeepSpaceExpoUser,
  ExpoAuthProvider,
} from '../expo'
import { AlertHost } from './web-alert'
import type { DeepSpaceNative, DeepSpaceNativeProviderProps } from './provider'
import type { NativeAuthState } from './session'
import type { FileSource, FileSourceOptions } from './files'
import type { ActionResult } from '../server/utils/action-types'

/**
 * The browser client: the page's own origin. `baseUrl` is ignored, because
 * the web build is served by the app's Worker and its session is that
 * origin's cookie. Methods that only exist for a keychain session behave as
 * the browser does (sign-in navigates to the provider and back).
 */
class DeepSpaceWebClient {
  // Same members the native client exposes to apps; see `DeepSpaceExpoClient`.
  get origin(): string {
    return window.location.origin
  }

  /** Calls `listener` whenever the cookie session changes (sign-in, sign-out, expiry). */
  subscribe(listener: DeepSpaceExpoSessionListener): () => void {
    const atom = authClient.$store.atoms.session
    let last: string | null | undefined
    // In order: a sign-in still minting its bearer must not land after the sign-out that followed it.
    let delivered = Promise.resolve()
    return atom.listen((value: SessionAtom) => {
      const token = value.data?.session?.token ?? null
      if (value.isPending || token === last) return
      last = token
      // A listener that throws must not turn every later change into null.
      delivered = delivered
        .then(() => sessionFor(token).catch(() => null))
        .then(listener)
        .catch((error: unknown) => console.error('[deepspace/native] session listener failed', error))
    })
  }

  /** The cookie session, with a fresh bearer; null when signed out. */
  async getSession(): Promise<DeepSpaceExpoSession | null> {
    const { data } = await authClient.getSession()
    return sessionFor(data?.session?.token ?? null)
  }

  async signIn(provider: ExpoAuthProvider = 'google'): Promise<DeepSpaceExpoUser> {
    window.location.assign(`/api/auth/social-redirect?provider=${encodeURIComponent(provider)}`)
    // The page navigates away; this never settles.
    return new Promise<DeepSpaceExpoUser>(() => {})
  }

  getAuthToken(): Promise<string | null> {
    return getAuthToken()
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    if (!headers.has('Content-Type') && typeof init.body === 'string') headers.set('Content-Type', 'application/json')
    const token = await getAuthToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
    const body = (await response.json().catch(() => ({}))) as T & { error?: string }
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `DeepSpace request failed (${response.status})`)
    return body
  }

  async signOut(): Promise<void> {
    await endBrowserSession()
  }
}

interface SessionAtom {
  isPending: boolean
  data?: { session?: { token?: string } } | null
}

async function sessionFor(sessionToken: string | null): Promise<DeepSpaceExpoSession | null> {
  if (!sessionToken) return null
  return { sessionToken, accessToken: (await getAuthToken()) ?? '' }
}

/** In the web build, `DeepSpaceExpoClient` is the browser client (the types stay the native class's). */
export { DeepSpaceWebClient as DeepSpaceExpoClient }

export function createDeepSpaceExpoClient(_options?: DeepSpaceExpoClientOptions): DeepSpaceExpoClient {
  return new DeepSpaceWebClient() as unknown as DeepSpaceExpoClient
}

let boundClient: DeepSpaceExpoClient | null = null

function requireClient(): DeepSpaceExpoClient {
  boundClient ??= createDeepSpaceExpoClient()
  return boundClient
}

export function DeepSpaceNativeProvider({ client, children }: DeepSpaceNativeProviderProps): ReactElement {
  boundClient = client
  return (
    <DeepSpaceAuthProvider>
      <KeyboardShortcutsRoot>
        {children}
        <AlertHost />
      </KeyboardShortcutsRoot>
    </DeepSpaceAuthProvider>
  )
}

export function useAuth(): NativeAuthState {
  const { isLoaded, isSignedIn, userId, sessionId } = useBrowserAuth()
  return useMemo(() => ({ isLoaded, isSignedIn, userId, sessionId }), [isLoaded, isSignedIn, userId, sessionId])
}

export function useDeepSpace(): DeepSpaceNative {
  const auth = useAuth()
  const client = requireClient()
  return useMemo(
    () => ({
      ...auth,
      client,
      signIn: (provider?: ExpoAuthProvider) => client.signIn(provider),
      signOut: () => client.signOut(),
    }),
    [auth, client],
  )
}

/** The page is on the app's origin, so the address alone is enough: the session cookie identifies the reader. */
export function useFileSource(key: string | null | undefined, options: FileSourceOptions = {}): FileSource | null {
  return key ? { uri: appFilePath(key, options.scope ?? 'self') } : null
}

export function callAction<TData = unknown>(name: string, params: Record<string, unknown> = {}): Promise<ActionResult<TData>> {
  return requireClient().request<ActionResult<TData>>(`/api/actions/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

/**
 * Opens a consent URL in a new window and resolves when the person has closed
 * it and is back on this page, as the native sheet does, so the caller
 * retries at the right moment.
 */
export async function openIntegrationConsent(authUrl: string): Promise<void> {
  if (new URL(authUrl).protocol !== 'https:') {
    throw new Error('deepspace/native: integration consent URLs must use https')
  }
  const consent = window.open('', '_blank')
  if (!consent) throw new Error('The browser blocked the consent window. Allow pop-ups for this site and try again.')
  // Cut the link back to this page before the provider loads (what noopener does).
  consent.opener = null
  consent.location.href = authUrl
  await new Promise<void>((done) => {
    const check = setInterval(() => {
      // A provider page sent with Cross-Origin-Opener-Policy (Google's sign-in
      // pages are) cuts this page's handle to the window, which then reads as
      // closed while the person is still in it; so also wait for this page to
      // have focus again.
      if (!consent.closed || !document.hasFocus()) return
      clearInterval(check)
      done()
    }, CONSENT_POLL_MS)
  })
}

const CONSENT_POLL_MS = 500

export { Alert } from './web-alert'
