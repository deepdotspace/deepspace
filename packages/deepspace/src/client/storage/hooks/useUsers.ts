/**
 * useUsers Hook
 *
 * Access all users in the current room.
 * User data (name, email, imageUrl, role) comes from the RecordRoom's users collection.
 */

import { useEffect, useMemo } from 'react'
import { useRecordContext } from '../context'
import type { RoomUser } from '../types'

export function useUsers(): {
  users: RoomUser[]
  usersLoaded: boolean
  setRole: (userId: string, role: string) => void
  refresh: () => void
} {
  const { allUsers, usersLoaded, setUserRole, requestUserList, ready } = useRecordContext()

  useEffect(() => {
    if (ready) requestUserList()
  }, [ready, requestUserList])

  const users = useMemo(() => allUsers, [allUsers])

  return { users, usersLoaded, setRole: setUserRole, refresh: requestUserList }
}
