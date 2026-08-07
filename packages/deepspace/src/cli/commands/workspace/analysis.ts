import * as p from '@clack/prompts'
import { findAppDir } from '../../lib/app-context'
import { readAppId } from '../../lib/app-identity'
import {
  assertSyncableRepo,
  diffNameOnly,
  isAncestor,
  mergeBase,
  resolveCommit,
} from '../../lib/git/repository'
import type { RemoteRefsResult, RemoteWorkspaceView, RepoApi } from '../../lib/repo-api'
import {
  ensureSpaceRemote,
  runGitRemote,
  SPACE_REMOTE,
  spacePrivateRef,
  spaceTrackingRef,
} from '../../lib/vc-remote'

const MAX_OVERLAP_PATHS = 20
const PEER_REF_PREFIX = `${spacePrivateRef('peers')}/`

export function peerWorkspaceRef(workspaceId: string): string {
  return `${PEER_REF_PREFIX}${workspaceId}`
}

/** How a checkout's tip stands against the workspace's published tip — one
 *  word, shared by `workspace status` (human + `--json syncRelation`) and
 *  `attach`, so every surface prescribes the recovery this relation actually
 *  admits (`sync` when ahead; `git pull` first when behind or diverged).
 *  `unknown` when either side is missing or the published tip is not a local
 *  object — fail toward the generic advice, never a wrong specific one. */
export function workspaceSyncRelation(
  dir: string,
  localOid: string | null,
  publishedOid: string | null,
): 'in_sync' | 'ahead' | 'behind' | 'diverged' | 'unknown' {
  if (localOid !== null && localOid === publishedOid) return 'in_sync'
  if (localOid === null || publishedOid === null) return 'unknown'
  if (resolveCommit(dir, publishedOid) === null) return 'unknown'
  if (isAncestor(dir, localOid, publishedOid)) return 'behind'
  if (isAncestor(dir, publishedOid, localOid)) return 'ahead'
  return 'diverged'
}

export interface WorkspaceOverlap {
  workspaceId: string
  task: string
  paths: string[]
  morePaths: number
}

export function formatCount(count: { count: number; capped: boolean } | null): string {
  if (!count) return '?'
  return count.capped ? `${count.count}+` : String(count.count)
}

export function fetchTrunk(
  appDir: string,
  token: string,
  head: string | null,
): { branch: string; ref: string; oid: string } | null {
  if (!head?.startsWith('refs/heads/')) return null
  const branch = head.slice('refs/heads/'.length)
  const remoteRef = spaceTrackingRef(branch)
  runGitRemote(appDir, token, ['fetch', '--quiet', SPACE_REMOTE, `+${head}:${remoteRef}`])
  const oid = resolveCommit(appDir, remoteRef)
  return oid ? { branch, ref: remoteRef, oid } : null
}

export function localTrunkOid(appDir: string, refs: RemoteRefsResult | null): string | null {
  const head = refs?.head
  if (!head?.startsWith('refs/heads/')) return null
  const advertised = refs?.refs.find((ref) => ref.name === head)?.oid ?? null
  if (advertised && resolveCommit(appDir, advertised)) return advertised
  return resolveCommit(appDir, spaceTrackingRef(head.slice('refs/heads/'.length)))
}

function fetchPeerWorkspaceRefs(appDir: string, token: string): void {
  try {
    runGitRemote(appDir, token, [
      'fetch',
      '--quiet',
      '--prune',
      SPACE_REMOTE,
      `+refs/deepspace/ws/*:${PEER_REF_PREFIX}*`,
    ])
  } catch {
    // Overlap reporting is advisory and can use already-fetched refs offline.
  }
}

export function lineChangedPaths(
  appDir: string,
  baseOid: string,
  tipOid: string,
  trunkOid: string | null,
): { diffBase: string; paths: string[] } | null {
  if (!resolveCommit(appDir, baseOid) || !resolveCommit(appDir, tipOid)) return null
  let diffBase = baseOid
  if (trunkOid && resolveCommit(appDir, trunkOid)) {
    const candidate = mergeBase(appDir, tipOid, trunkOid)
    if (candidate && candidate !== diffBase && isAncestor(appDir, diffBase, candidate)) {
      diffBase = candidate
    }
  }
  return { diffBase, paths: diffNameOnly(appDir, diffBase, tipOid) }
}

export function trunkOverlapPaths(
  appDir: string,
  diffBase: string,
  trunkOid: string | null,
  myPaths: string[],
): string[] {
  if (!trunkOid || trunkOid === diffBase || myPaths.length === 0) return []
  if (!resolveCommit(appDir, trunkOid) || !isAncestor(appDir, diffBase, trunkOid)) return []
  const trunkChanged = new Set(diffNameOnly(appDir, diffBase, trunkOid))
  return myPaths.filter((path) => trunkChanged.has(path))
}

function changedPathsByWorkspace(
  appDir: string,
  views: RemoteWorkspaceView[],
  trunkOid: string | null,
): Map<string, { task: string; paths: string[] }> {
  const lines = new Map<string, { task: string; paths: string[] }>()
  for (const view of views) {
    const workspace = view.workspace
    if (workspace.status !== 'active') continue
    const tip = resolveCommit(appDir, peerWorkspaceRef(workspace.id)) ?? view.tipOid
    if (!tip) continue
    const line = lineChangedPaths(appDir, workspace.baseOid, tip, trunkOid)
    if (line?.paths.length) lines.set(workspace.id, { task: workspace.task, paths: line.paths })
  }
  return lines
}

export function overlapsWith(
  myPaths: string[],
  lines: Map<string, { task: string; paths: string[] }>,
  selfId: string | null,
): WorkspaceOverlap[] {
  const mine = new Set(myPaths)
  const overlaps: WorkspaceOverlap[] = []
  for (const [workspaceId, line] of lines) {
    if (workspaceId === selfId) continue
    const shared = line.paths.filter((path) => mine.has(path))
    if (!shared.length) continue
    overlaps.push({
      workspaceId,
      task: line.task,
      paths: shared.slice(0, MAX_OVERLAP_PATHS),
      morePaths: Math.max(0, shared.length - MAX_OVERLAP_PATHS),
    })
  }
  return overlaps
}

export async function loadWorkspaceLines(
  appDir: string,
  token: string,
  api: RepoApi,
  trunkOid: string | null,
): Promise<Map<string, { task: string; paths: string[] }>> {
  try {
    const { views } = await api.listWorkspaces()
    fetchPeerWorkspaceRefs(appDir, token)
    return changedPathsByWorkspace(appDir, views, trunkOid)
  } catch {
    return new Map()
  }
}

export async function listOverlaps(
  appId: string,
  token: string,
  api: RepoApi,
  views: RemoteWorkspaceView[],
): Promise<Map<string, WorkspaceOverlap[]>> {
  const appDir = findAppDir()
  if (!appDir || readAppId(appDir) !== appId) return new Map()
  try {
    assertSyncableRepo(appDir)
    ensureSpaceRemote(appDir, appId)
    const refs = await api.getRefs().catch(() => null)
    try {
      fetchTrunk(appDir, token, refs?.head ?? null)
    } catch {
      // localTrunkOid tolerates a stale tracking ref.
    }
    fetchPeerWorkspaceRefs(appDir, token)
    const lines = changedPathsByWorkspace(appDir, views, localTrunkOid(appDir, refs))
    return new Map([...lines].map(([id, line]) => [id, overlapsWith(line.paths, lines, id)]))
  } catch {
    return new Map()
  }
}

export function printOverlaps(overlaps: WorkspaceOverlap[], json: boolean): void {
  if (json) return
  for (const overlap of overlaps) {
    const sample = overlap.paths.slice(0, 5).join(', ')
    const more = overlap.paths.length - 5 + overlap.morePaths
    p.log.warn(
      `Overlap: ${overlap.workspaceId} ("${overlap.task}") also modified ${sample}${more > 0 ? ` (+${more} more)` : ''} — coordinate before landing.`,
    )
  }
}
