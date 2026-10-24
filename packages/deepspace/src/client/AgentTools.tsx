import { useEffect } from 'react'
import { useAuth } from './auth/hooks'
import { getAuthToken } from './auth/token'
import { useRecordContext } from './storage/context'
import { connectAgentTools } from './agent-tools'

/** Mount once inside RecordScope. The room must finish enrolling the signed-in
 * user before discovery. Sign-out/account changes revoke browser registrations. */
export function AgentTools() {
  const { userId, sessionId, isSignedIn } = useAuth()
  const { ready } = useRecordContext()
  useEffect(() => {
    if (!isSignedIn || !ready) return
    const controller = new AbortController()
    void connectAgentTools({ getToken: getAuthToken, signal: controller.signal }).catch(() => {
      // Server refusals stay authoritative. Optional browser tools must never
      // prevent the app itself from rendering or retry a denied mutation.
    })
    return () => controller.abort()
  }, [isSignedIn, userId, sessionId, ready])
  return null
}
