import { describe, expect, it } from 'vitest'
import {
  isSelectedWorkspaceCheckout,
  isWorkspaceId,
  resolveWorkspaceWorktree,
  workspaceBranchName,
  workspaceIdFromBranch,
} from '../workspace-id'

describe('workspace id ↔ branch mapping', () => {
  const id = 'ws_01J2K3M4N5P6Q7R8S9T0V1W2X3'

  it('round-trips deterministically', () => {
    const branch = workspaceBranchName(id)
    expect(branch).toBe('ws/01j2k3m4n5p6q7r8s9t0v1w2x3')
    expect(workspaceIdFromBranch(branch)).toBe(id)
  })

  it('rejects branches that are not workspace-shaped', () => {
    expect(workspaceIdFromBranch(null)).toBeNull()
    expect(workspaceIdFromBranch('main')).toBeNull()
    expect(workspaceIdFromBranch('ws/short')).toBeNull()
    // 26 chars but outside the Crockford alphabet (I, L, O, U excluded).
    expect(workspaceIdFromBranch('ws/iiiiiiiiiiiiiiiiiiiiiiiiii')).toBeNull()
    expect(workspaceIdFromBranch('feature/ws/01j2k3m4n5p6q7r8s9t0v1w2x3')).toBeNull()
  })

  it('validates canonical workspace ids', () => {
    expect(isWorkspaceId(id)).toBe(true)
    expect(isWorkspaceId(id.toLowerCase())).toBe(false)
    expect(isWorkspaceId('ws_short')).toBe(false)
  })
})

describe('workspace checkout selection', () => {
  const id = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const branch = workspaceBranchName(id)

  it('accepts only the branch belonging to the selected workspace', () => {
    expect(isSelectedWorkspaceCheckout(branch, id)).toBe(true)
    expect(isSelectedWorkspaceCheckout('main', id)).toBe(false)
    expect(isSelectedWorkspaceCheckout('ws/01differentworkspace0000000', id)).toBe(false)
    expect(isSelectedWorkspaceCheckout(null, id)).toBe(false)
  })

  it('finds a linked or main checkout by its workspace branch', () => {
    const worktrees = [
      { path: '/repo', branch: 'main' },
      { path: '/repo/.deepspace/ws/x', branch },
    ]
    expect(resolveWorkspaceWorktree(worktrees, id)).toBe('/repo/.deepspace/ws/x')
    expect(resolveWorkspaceWorktree([{ path: '/clone', branch }], id)).toBe('/clone')
  })

  it('matches ids regardless of case while rejecting unrelated or detached worktrees', () => {
    expect(
      resolveWorkspaceWorktree([{ path: '/w', branch }], 'ws_01arz3ndektsv4rrffq69g5fav'),
    ).toBe('/w')
    expect(resolveWorkspaceWorktree([{ path: '/repo', branch: 'main' }], id)).toBeNull()
    expect(resolveWorkspaceWorktree([{ path: '/repo', branch: null }], id)).toBeNull()
  })
})
