/**
 * PresenceTestPage — exercises real-time presence via PresenceRoom DO.
 *
 * Used by Playwright e2e tests to verify multi-user presence tracking.
 * Connects to a shared presence scope and displays peers + state updates.
 */

import { useState, useCallback } from 'react'
import { usePresenceRoom } from 'deepspace'
import { useAuth } from 'deepspace'

const SCOPE_ID = 'test-presence-room'

export default function PresenceTestPage() {
  const { isSignedIn } = useAuth()
  const { peers, connected, updateState } = usePresenceRoom(SCOPE_ID)
  const [cursorX, setCursorX] = useState(0)
  const [cursorY, setCursorY] = useState(0)

  const sendCursor = useCallback(() => {
    const x = Math.round(Math.random() * 1000)
    const y = Math.round(Math.random() * 1000)
    setCursorX(x)
    setCursorY(y)
    updateState({ cursor: { x, y } })
  }, [updateState])

  const sendTyping = useCallback(() => {
    updateState({ typing: true })
  }, [updateState])

  const sendStopTyping = useCallback(() => {
    updateState({ typing: false })
  }, [updateState])

  return (
    <div className="mx-auto max-w-3xl p-8" data-testid="presence-test-page">
      <div className="mb-8 rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold text-foreground mb-2">Connection</h2>
        <div className="space-y-1 text-sm">
          <div>Signed in: <span data-testid="presence-signed-in">{String(isSignedIn)}</span></div>
          <div>Connected: <span data-testid="presence-connected">{String(connected)}</span></div>
          <div>Scope: <span data-testid="presence-scope">{SCOPE_ID}</span></div>
          <div>Peer count: <span data-testid="presence-peer-count">{peers.length}</span></div>
        </div>
      </div>

      <div className="mb-8 rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold text-foreground mb-2">Actions</h2>
        <div className="flex flex-wrap gap-2">
          <button
            data-testid="presence-send-cursor"
            onClick={sendCursor}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
          >
            Send Cursor
          </button>
          <button
            data-testid="presence-send-typing"
            onClick={sendTyping}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
          >
            Start Typing
          </button>
          <button
            data-testid="presence-stop-typing"
            onClick={sendStopTyping}
            className="rounded bg-secondary px-3 py-1.5 text-sm text-secondary-foreground hover:opacity-90"
          >
            Stop Typing
          </button>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Last cursor: <span data-testid="presence-local-cursor">{cursorX},{cursorY}</span>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold text-foreground mb-2">
          Peers ({peers.length})
        </h2>
        <div data-testid="presence-peers-list" className="space-y-2">
          {peers.map((peer) => (
            <div
              key={peer.userId}
              data-testid={`presence-peer-${peer.userId}`}
              className="flex items-center justify-between rounded border border-border px-3 py-2"
            >
              <div className="text-sm">
                <span className="font-medium text-foreground" data-testid={`presence-peer-name-${peer.userId}`}>
                  {peer.userName}
                </span>
                <span className="ml-2 text-muted-foreground" data-testid={`presence-peer-email-${peer.userId}`}>
                  {peer.userEmail}
                </span>
              </div>
              <div className="text-xs text-muted-foreground space-x-2">
                {!!peer.state.cursor && (
                  <span data-testid={`presence-peer-cursor-${peer.userId}`}>
                    cursor: {(peer.state.cursor as { x: number; y: number }).x},{(peer.state.cursor as { x: number; y: number }).y}
                  </span>
                )}
                {peer.state.typing !== undefined && (
                  <span data-testid={`presence-peer-typing-${peer.userId}`}>
                    {peer.state.typing ? 'typing...' : 'idle'}
                  </span>
                )}
              </div>
            </div>
          ))}
          {peers.length === 0 && (
            <div data-testid="presence-peers-empty" className="text-sm text-muted-foreground">
              No other peers connected
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
