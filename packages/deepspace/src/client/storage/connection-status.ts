/**
 * ConnectionStatus type and utility for domain hooks.
 *
 * Maps useQuery() status to a simpler connection state
 * used by app-level platform providers.
 */

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'error'

/**
 * Map a useQuery() status string to a ConnectionStatus.
 *
 * useQuery returns: 'pending' | 'ready' | 'error'
 * This maps to the simplified connection states used by platform providers.
 */
export function toConnectionStatus(queryStatus: string): ConnectionStatus {
  if (queryStatus === 'ready') return 'connected'
  if (queryStatus === 'error') return 'error'
  return 'connecting'
}
