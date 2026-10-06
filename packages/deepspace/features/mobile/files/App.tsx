import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import Constants from 'expo-constants'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import {
  createDeepSpaceExpoClient,
  DeepSpaceNativeProvider,
  RecordProvider,
  RecordScope,
  useDeepSpace,
  useUser,
  type CollectionSchema,
} from 'deepspace/native'

const { appId, baseUrl } = Constants.expoConfig?.extra?.deepspace as {
  appId: string
  baseUrl: string
}

/** One client for the whole app. Sign-in returns through <scheme>://auth/callback. */
const deepSpace = createDeepSpaceExpoClient({ baseUrl })

/**
 * The collections this screen reads. Pass the same array the Worker uses, for
 * example `import { schemas } from '../src/schemas'`, once the app has its own.
 */
const schemas: CollectionSchema[] = []

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <DeepSpaceNativeProvider client={deepSpace}>
        <Root />
      </DeepSpaceNativeProvider>
    </SafeAreaProvider>
  )
}

function Root() {
  const { isLoaded, isSignedIn } = useDeepSpace()
  if (!isLoaded) return <View style={styles.screen} />
  if (!isSignedIn) return <SignIn />
  return (
    <RecordProvider>
      <RecordScope roomId={`app:${appId}`} schemas={schemas}>
        <Home />
      </RecordScope>
    </RecordProvider>
  )
}

function SignIn() {
  const { signIn } = useDeepSpace()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await signIn('google')
    } catch (caught) {
      // Closing the sheet is not an error.
      if ((caught as { code?: string }).code !== 'sign_in_cancelled') {
        setError(caught instanceof Error ? caught.message : 'Sign-in failed')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={[styles.screen, styles.centered]}>
      <Text style={styles.title}>{Constants.expoConfig?.name}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable accessibilityRole="button" onPress={start} disabled={busy} style={styles.button}>
        {busy ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.buttonText}>Continue with Google</Text>
        )}
      </Pressable>
    </SafeAreaView>
  )
}

function Home() {
  const { signOut } = useDeepSpace()
  const { user } = useUser()
  return (
    <SafeAreaView style={[styles.screen, styles.centered]}>
      <Text style={styles.title}>{user?.name || 'Signed in'}</Text>
      {user?.email ? <Text style={styles.muted}>{user.email}</Text> : null}
      <Pressable accessibilityRole="button" onPress={() => void signOut()} style={styles.button}>
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  centered: { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  title: { fontSize: 28, fontWeight: '700', color: '#111827' },
  muted: { fontSize: 15, color: '#6B7280' },
  error: { color: '#DC2626', textAlign: 'center' },
  button: {
    minHeight: 48,
    minWidth: 240,
    borderRadius: 8,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  buttonText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
})
