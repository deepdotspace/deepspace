/**
 * App files in React Native: an image or video source for a stored key.
 *
 * In a browser a private (`self`) file URL renders in `<img>` because the
 * app-origin session cookie identifies the load. A native app has no cookie
 * jar for that origin, so every private read must carry the bearer, which is
 * what React Native's `<Image source>` and expo-video's `{ uri, headers }`
 * sources accept. Public (`app`) files need no header at all.
 */
import { useEffect, useState } from 'react'
import { appFilePath, type AppFileScope } from '../shared/app-files'
import { useAuth, requireNativeClient } from './session'
import { jwtClaims } from '../expo-jwt'
import { subscribeToForeground } from '../client/platform/foreground'

/** `{ uri, headers }`, the source shape `<Image>` and expo-video take. */
export interface FileSource {
  uri: string
  headers?: Record<string, string>
}

export interface FileSourceOptions {
  /** Same meaning as `useR2Files`: `self` (default) is the user's private folder, `app` is public. */
  scope?: AppFileScope
}

/**
 * The source for a stored file key (the `key` an upload returned), or null
 * while there is no key or, for a private file, no signed-in bearer yet. The
 * source is rebuilt when the session changes, so an image loaded after a
 * token refresh carries the new bearer.
 */
export function useFileSource(
  key: string | null | undefined,
  options: FileSourceOptions = {},
): FileSource | null {
  const scope = options.scope ?? 'self'
  const client = requireNativeClient()
  const { userId } = useAuth()
  const [bearer, setBearer] = useState<{
    client: typeof client
    userId: string
    token: string
  } | null>(null)

  useEffect(() => {
    if (scope === 'app' || !userId || !key) {
      setBearer(null)
      return
    }
    let live = true
    let request = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const current = ++request
      clearTimeout(timer)
      const token = await client.getAuthToken().catch(() => null)
      if (!live || request !== current) return
      const exp = token ? jwtClaims(token)?.exp : undefined
      const expiresAt = typeof exp === 'number' ? exp * 1000 : undefined
      setBearer(
        token && (expiresAt === undefined || expiresAt > Date.now()) ? { client, userId, token } : null,
      )
      // Refresh before expiry even if files are the only authenticated traffic.
      // A failed refresh retries at a bounded rate; foreground also retries.
      if (!token || expiresAt !== undefined) {
        const delay = Math.max(10_000, (expiresAt ?? Date.now()) - Date.now() - 30_000)
        timer = setTimeout(() => void load(), delay)
      }
    }
    void load()
    const unsubscribe = client.subscribe(() => void load())
    const foreground = subscribeToForeground(() => void load())
    return () => {
      live = false
      clearTimeout(timer)
      unsubscribe()
      foreground()
    }
  }, [client, scope, userId, key])

  if (!key) return null
  const uri = `${client.origin}${appFilePath(key, scope)}`
  if (scope === 'app') return { uri }
  const token = bearer?.client === client && bearer.userId === userId ? bearer.token : null
  const exp = token ? jwtClaims(token)?.exp : undefined
  return token && (typeof exp !== 'number' || exp * 1000 > Date.now())
    ? { uri, headers: { Authorization: `Bearer ${token}` } }
    : null
}
