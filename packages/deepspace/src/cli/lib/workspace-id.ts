/**
 * Workspace naming — the deterministic mapping between a server workspace id
 * (`ws_<26-char Crockford ULID>`) and its local git branch (`ws/<ulid,
 * lowercased>`). Deterministic both ways so `workspace sync`/`land`/`status`
 * can infer which workspace a worktree belongs to from nothing but the
 * checked-out branch, on any machine.
 */

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i
const WORKSPACE_ID_RE = /^ws_[0-9A-HJKMNP-TV-Z]{26}$/

export function isWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_RE.test(id)
}

export function workspaceBranchName(workspaceId: string): string {
  return `ws/${workspaceId.replace(/^ws_/, '').toLowerCase()}`
}

/** `ws/<ulid>` → `ws_<ULID>`, or null when the branch isn't workspace-shaped. */
export function workspaceIdFromBranch(branch: string | null): string | null {
  if (!branch || !branch.startsWith('ws/')) return null
  const ulid = branch.slice(3)
  if (!ULID_RE.test(ulid)) return null
  return `ws_${ulid.toUpperCase()}`
}

export function isSelectedWorkspaceCheckout(branch: string | null, workspaceId: string): boolean {
  return workspaceIdFromBranch(branch) === workspaceId
}

/** Find a workspace's checkout among the repository's linked worktrees. */
export function resolveWorkspaceWorktree(
  worktrees: readonly { path: string; branch: string | null }[],
  workspaceId: string,
): string | null {
  const branch = workspaceBranchName(workspaceId)
  return worktrees.find((worktree) => worktree.branch === branch)?.path ?? null
}
