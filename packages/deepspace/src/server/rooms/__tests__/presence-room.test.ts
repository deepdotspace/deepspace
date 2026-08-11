import { describe, expect, it } from 'vitest'
import { PresenceRoom } from '../presence-room'
import type { UserAttachment } from '../base-room'
import { MSG } from '../../../shared/protocol/constants'
import type { ServerMessage } from '../../../shared/protocol/messages'
;(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair ??= class {
  constructor(_request: string, _response: string) {}
}

function makeState(): DurableObjectState {
  return {
    storage: { sql: { exec: () => ({ toArray: () => [] }) } },
    setWebSocketAutoResponse() {},
    getWebSockets: () => [],
  } as unknown as DurableObjectState
}

class TestPresenceRoom extends PresenceRoom {
  direct: ServerMessage[] = []
  broadcasts: ServerMessage[] = []

  protected sendTo(_ws: WebSocket, message: ServerMessage): void {
    this.direct.push(message)
  }

  protected broadcast(message: ServerMessage): void {
    this.broadcasts.push(message)
  }

  connect(user: UserAttachment): UserAttachment {
    return (
      this as unknown as {
        onConnect(ws: WebSocket, user: UserAttachment): UserAttachment
      }
    ).onConnect({} as WebSocket, user)
  }

  message(user: UserAttachment, payload: unknown): Promise<void> {
    return Promise.resolve(
      (
        this as unknown as {
          onMessage(
            ws: WebSocket,
            user: UserAttachment,
            message: { type: string; payload: unknown },
          ): void | Promise<void>
        }
      ).onMessage({} as WebSocket, user, { type: MSG.PRESENCE_UPDATE, payload }),
    )
  }
}

const signedInUser: UserAttachment = {
  userId: 'user-1',
  userName: 'Ada',
  userEmail: 'ada@example.test',
  userImageUrl: 'https://images.example.test/ada.png',
}

describe('PresenceRoom privacy and bounds', () => {
  it('never places email or avatar data on the presence wire', () => {
    const room = new TestPresenceRoom(makeState(), {})
    room.connect(signedInUser)
    room.direct = []
    room.connect({
      userId: 'anon-2',
      userName: 'Anonymous',
      userEmail: '',
    })

    const sync = room.direct.find((message) => message.type === MSG.PRESENCE_SYNC)
    expect(sync).toBeDefined()
    const [peer] = (sync!.payload as { peers: Array<Record<string, unknown>> }).peers
    expect(peer).toMatchObject({ userId: 'user-1', userName: 'Ada', state: {} })
    expect(peer).not.toHaveProperty('userEmail')
    expect(peer).not.toHaveProperty('userImageUrl')

    const joins = room.broadcasts.filter((message) => message.type === MSG.PRESENCE_JOIN)
    expect(JSON.stringify(joins)).not.toContain('ada@example.test')
    expect(JSON.stringify(joins)).not.toContain('images.example.test')
  })

  it('rejects a merged state larger than 16 KiB without broadcasting it', async () => {
    const room = new TestPresenceRoom(makeState(), {})
    const attachment = room.connect(signedInUser)
    room.direct = []
    room.broadcasts = []

    await room.message(attachment, { cursor: 'x'.repeat(17 * 1024) })

    expect(room.direct).toContainEqual({
      type: MSG.ERROR,
      payload: { error: 'Presence state exceeds 16 KiB' },
    })
    expect(room.broadcasts).toEqual([])
  })
})
