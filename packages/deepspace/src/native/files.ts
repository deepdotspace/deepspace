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
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    if (scope === 'app' || !userId) {
      setToken(null)
      return
    }
    let live = true
    const load = () => {
      void client.getAuthToken().then(
        (next) => {
          if (live) setToken(next)
        },
        () => {
          if (live) setToken(null)
        },
      )
    }
    load()
    const unsubscribe = client.subscribe(load)
    return () => {
      live = false
      unsubscribe()
    }
  }, [client, scope, userId])

  if (!key) return null
  const uri = `${client.origin}${appFilePath(key, scope)}`
  if (scope === 'app') return { uri }
  return token ? { uri, headers: { Authorization: `Bearer ${token}` } } : null
}
