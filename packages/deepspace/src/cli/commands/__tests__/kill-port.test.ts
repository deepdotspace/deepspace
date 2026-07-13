/**
 * DEV-2: `kill`'s no-arg port must mirror `dev`'s binding precedence
 * (explicit > worktree > $DEEPSPACE_PORT > launch.json > default). These would
 * fail if any source were dropped — e.g. the earlier regression that ignored
 * $DEEPSPACE_PORT.
 */
import { describe, it, expect } from 'vitest'
import { pickKillPort } from '../kill'
import { DEFAULT_PORT } from '../../lib/port'

describe('pickKillPort (DEV-2)', () => {
  it('explicit --port wins over everything', () => {
    expect(pickKillPort({ explicit: 3000, worktree: 5190, env: 9090, appLaunch: 8790 })).toBe(3000)
  })
  it('worktree port wins over env + launch.json (dev ignores $DEEPSPACE_PORT in a worktree)', () => {
    expect(pickKillPort({ explicit: null, worktree: 5190, env: 9090, appLaunch: 8790 })).toBe(5190)
  })
  it('$DEEPSPACE_PORT wins over launch.json outside a worktree', () => {
    expect(pickKillPort({ explicit: null, worktree: null, env: 9090, appLaunch: 8790 })).toBe(9090)
  })
  it('falls to the launch.json port when no explicit/worktree/env', () => {
    expect(pickKillPort({ explicit: null, worktree: null, env: null, appLaunch: 8790 })).toBe(8790)
  })
  it('falls to the default when nothing else is known', () => {
    expect(pickKillPort({ explicit: null, worktree: null, env: null, appLaunch: null })).toBe(DEFAULT_PORT)
  })
})
