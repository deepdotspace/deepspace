/**
 * usePresence — Derives online/offline from lastSeenAt in users collection.
 *
 * Two mechanisms keep presence working:
 * 1. Heartbeat: Sends MSG.USER_UPDATE every 60s so the server refreshes
 *    our lastSeenAt in the c_users table and broadcasts the change.
 * 2. Tick: A re-render trigger every 30s so isOnline() re-evaluates
 *    Date.now() and users who stopped heartbeating transition to offline.
 */

import { useEffect, useCallback, useState } from 'react'
import { useUser } from './useUser'
import { useUsers } from './useUsers'
import { useRecordContext } from '../context'
import { MSG } from '@/shared/protocol/constants'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const HEARTBEAT_INTERVAL_MS = 60 * 1000 // 1 minute
const TICK_INTERVAL_MS = 30 * 1000 // 30 seconds

interface UsePresenceOptions {
  timeoutMs?: number
}

export function usePresence(opts?: UsePresenceOptions) {
  const { user } = useUser()
  const { users } = useUsers()
  const { sendMessage, ready } = useRecordContext()
  const [tick, setTick] = useState(0)

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Heartbeat: periodically send MSG.USER_UPDATE to refresh our lastSeenAt
  useEffect(() => {
    if (!user || !ready) return
    const interval = setInterval(() => {
      sendMessage({ type: MSG.USER_UPDATE, payload: {} })
    }, HEARTBEAT_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [user, ready, sendMessage])

  // Tick: force re-render so isOnline() re-evaluates stale timestamps
  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1)
    }, TICK_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  const isOnline = useCallback(
    (userId: string): boolean => {
      // tick is captured to ensure this callback refreshes on each tick
      void tick
      const u = users.find((u) => u.id === userId)
      if (!u?.lastSeenAt) return false
      return Date.now() - new Date(u.lastSeenAt).getTime() < timeoutMs
    },
    [users, timeoutMs, tick],
  )

  const getLastSeen = useCallback(
    (userId: string): string | null => {
      const u = users.find((u) => u.id === userId)
      return u?.lastSeenAt ?? null
    },
    [users],
  )

  return { isOnline, getLastSeen, users }
}
