/**
 * DeepSpaceNativeProvider and the hooks that read the bound native client.
 */
import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from 'react'
import type { DeepSpaceExpoClient, DeepSpaceExpoUser, ExpoAuthProvider } from '../expo'
import { bindNativeClient, useAuth, type NativeAuthState } from './session'

const NativeClientContext = createContext<DeepSpaceExpoClient | null>(null)

export interface DeepSpaceNativeProviderProps {
  /** The app's single client from `createDeepSpaceExpoClient`. Create it once, at module scope. */
  client: DeepSpaceExpoClient
  children?: ReactNode
}

/**
 * Binds the app's DeepSpace client for every hook below it. Render exactly one,
 * at the root, above `RecordProvider`.
 */
export function DeepSpaceNativeProvider({
  client,
  children,
}: DeepSpaceNativeProviderProps): ReactElement {
  bindNativeClient(client)
  return <NativeClientContext.Provider value={client}>{children}</NativeClientContext.Provider>
}

export function useNativeClient(): DeepSpaceExpoClient {
  const client = useContext(NativeClientContext)
  if (!client) {
    throw new Error('deepspace/native: useDeepSpace must be used inside <DeepSpaceNativeProvider>.')
  }
  return client
}

export interface DeepSpaceNative extends NativeAuthState {
  client: DeepSpaceExpoClient
  /** Opens the system sign-in sheet. Throws `sign_in_cancelled` when the person closes it. */
  signIn: (provider?: ExpoAuthProvider) => Promise<DeepSpaceExpoUser>
  signOut: () => Promise<void>
}

/** Auth state plus sign-in and sign-out for the bound client. */
export function useDeepSpace(): DeepSpaceNative {
  const client = useNativeClient()
  const auth = useAuth()
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
