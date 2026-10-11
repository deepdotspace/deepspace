/**
 * `createDeepSpaceExpoClient` as `deepspace/native` exports it: the Expo
 * client, plus one test aid for debug builds.
 *
 * Simulator tests can't drive Google's sign-in page, so a debug build on iOS
 * accepts a DeepSpace session token as the launch argument
 * `-DeepSpaceSessionToken <token>` (for example `xcrun simctl launch booted
 * <bundle id> -DeepSpaceSessionToken <token>`). It is used only while the
 * device holds no session: the client mints an access token from it and then
 * stores the session as usual. Release builds never read it.
 */
import { Platform, Settings } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import {
  createDeepSpaceExpoClient as createExpoClient,
  type DeepSpaceExpoClient,
  type DeepSpaceExpoClientOptions,
  type ExpoAuthStorage,
} from '../expo'

export const LAUNCH_ARGUMENT_SESSION_TOKEN = 'DeepSpaceSessionToken'

function launchArgumentStorage(): ExpoAuthStorage | undefined {
  if (typeof __DEV__ === 'undefined' || !__DEV__ || Platform.OS !== 'ios') return undefined
  const sessionToken: unknown = Settings.get(LAUNCH_ARGUMENT_SESSION_TOKEN)
  if (typeof sessionToken !== 'string' || sessionToken.length === 0) return undefined
  const seeded = JSON.stringify({ sessionToken, accessToken: '' })
  return {
    getItem: async (key) => (await SecureStore.getItemAsync(key)) ?? seeded,
    setItem: (key, value) => SecureStore.setItemAsync(key, value),
    deleteItem: (key) => SecureStore.deleteItemAsync(key),
  }
}

export function createDeepSpaceExpoClient(options: DeepSpaceExpoClientOptions): DeepSpaceExpoClient {
  return createExpoClient({ ...options, storage: options.storage ?? launchArgumentStorage() })
}
