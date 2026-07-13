/**
 * Shared WebSocket connection logger with active connection count.
 * Silent unless DEEPSPACE_DEBUG is set (see ../debug).
 */

import { debugLog } from '../debug'

let activeCount = 0

export function wsLog(
  event: 'connecting' | 'connected' | 'disconnected' | 'closing',
  label: string,
) {
  if (event === 'connected') activeCount++
  if (event === 'closing') activeCount--

  debugLog(`[ds:ws] ${event} → ${label} (${activeCount} active)`)
}
