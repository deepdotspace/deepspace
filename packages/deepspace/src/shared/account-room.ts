/**
 * The room id a client asks for to open its own account store
 * (`accountStores` in deepspace/worker). The server decides which store
 * actually opens from the verified token, never from this name; the user id
 * in it only keeps each account's local cache apart on a shared device.
 */
export function accountRoomId(userId: string): string {
  return `${ACCOUNT_ROOM_PREFIX}${userId}`
}

export const ACCOUNT_ROOM_PREFIX = 'me:'
