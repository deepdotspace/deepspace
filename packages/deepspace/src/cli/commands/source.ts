/** `deepspace app source` — inspect, claim, or transfer source authority. */

import * as p from '@clack/prompts'
import { ensureToken } from '../auth'
import { findAppDir } from '../lib/app-context'
import { resolveAppTarget } from '../lib/app-target'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import {
  assertSyncableRepo,
  currentBranch,
  isAncestor,
  isWorkTreeClean,
  resolveCommit,
} from '../lib/git/repository'
import { runGit } from '../lib/git/process'
import { repoApi, type RemoteRelease } from '../lib/repo-api'
import {
  localTransferRefs,
  remoteBranchOid,
  remotePublicRefs,
  selectGitHubRemote,
  type GitHubRemote,
  type GitRef,
} from '../lib/source-control'
import { getAppSource, setAppSource, type AppSource, type AppSourceState } from '../lib/source-api'
import {
  deployBaseUrl,
  ensureSpaceRemote,
  gitSourceImportEnv,
  runGitRemote,
  SPACE_REMOTE,
} from '../lib/vc-remote'

const TRANSFER_PREFIX = 'refs/deepspace/source-transfer'

export default defineDeepspaceCommand({
  meta: {
    name: 'source',
    description: 'Show or change the app’s one authoritative Git repository',
  },
  args: {
    provider: {
      type: 'positional',
      description: 'Source provider: github or deepspace (omit to show)',
      required: false,
    },
    app: {
      type: 'string',
      alias: 'a',
      description: 'App id or subdomain name (default: current app)',
      required: false,
    },
    remote: {
      type: 'string',
      description: 'GitHub remote name when it cannot be inferred (default: origin)',
      required: false,
    },
  },
  async run({ args }) {
    const requested = typeof args.provider === 'string' ? args.provider.trim().toLowerCase() : ''
    if (requested && requested !== 'github' && requested !== 'deepspace') {
      throw new Refusal('Source must be `github` or `deepspace`.', 'invalid_source')
    }
    const token = await ensureToken()
    const deployUrl = deployBaseUrl()
    const appId = await resolveAppTarget(
      deployUrl,
      token,
      typeof args.app === 'string' ? args.app : undefined,
    )
    const state = await getAppSource(deployUrl, token, appId)
    if (!requested) {
      reportSource(appId, state, args.json)
      return { data: sourceData(state) }
    }

    const appDir = findAppDir()
    if (!appDir) {
      throw new Refusal(
        'Changing source requires a local app checkout with wrangler.toml and Git history.',
        'not_in_app_repo',
      )
    }
    assertSyncableRepo(appDir)
    const remoteArg = typeof args.remote === 'string' ? args.remote.trim() : undefined
    const result =
      requested === 'github'
        ? await moveToGitHub({ appDir, appId, token, deployUrl, state, remoteArg })
        : await moveToDeepSpace({ appDir, appId, token, deployUrl, state, remoteArg })
    if (!args.json) {
      p.log.success(
        result.source.provider === 'github'
          ? `Source: GitHub · ${result.source.repository} (revision ${result.revision})`
          : `Source: DeepSpace (revision ${result.revision})`,
      )
    }
    return { data: { appId, source: result.source, revision: result.revision } }
  },
})

function sourceData(state: AppSourceState): Record<string, unknown> {
  return {
    appId: state.appId,
    source: state.source,
    revision: state.revision,
    registered: state.registered,
  }
}

function reportSource(appId: string, state: AppSourceState, json: boolean): void {
  if (json) return
  console.log(`App: ${appId}`)
  if (state.source?.provider === 'github') {
    console.log(`Source: GitHub · ${state.source.repository}`)
  } else if (state.source?.provider === 'deepspace') {
    console.log('Source: DeepSpace')
  } else {
    console.log('Source: unclaimed (the first normal deploy defaults to DeepSpace)')
  }
  console.log(`Revision: ${state.revision}`)
}

async function moveToGitHub(input: {
  appDir: string
  appId: string
  token: string
  deployUrl: string
  state: AppSourceState
  remoteArg?: string
}): Promise<{ source: AppSource; revision: number }> {
  const { appDir, appId, token, deployUrl, state, remoteArg } = input
  const selected = requireGitHubRemote(appDir, remoteArg)
  const target: AppSource = { provider: 'github', repository: selected.repository }
  if (sameSource(state.source, target)) return { source: target, revision: state.revision }

  if (state.source?.provider === 'deepspace') {
    requireLocalHead(appDir)
    const api = repoApi(deployUrl, token, appId)
    const { views } = await api.listWorkspaces()
    if (views.length > 0) {
      throw new Refusal(
        'Land or drop every active DeepSpace workspace before moving source to GitHub.',
        'active_workspaces',
      )
    }
    ensureSpaceRemote(appDir, appId)
    runGitRemote(appDir, token, [
      'fetch',
      '--quiet',
      '--prune',
      SPACE_REMOTE,
      `+refs/heads/*:${TRANSFER_PREFIX}/heads/*`,
      `+refs/tags/*:${TRANSFER_PREFIX}/tags/*`,
    ])
    const { refs } = await api.getRefs().then((value) => {
      if (!value)
        throw new Refusal('The DeepSpace source repository is unavailable.', 'source_unavailable')
      return value
    })
    const wanted = refs.filter(isPublicRef).map(({ name, oid }) => ({ name, oid }))
    const fetched = transferRefs(appDir)
    if (!sameRefs(fetched, wanted)) {
      throw new Refusal(
        'DeepSpace branches or tags changed while they were being fetched. Retry the transfer from fresh refs.',
        'source_changed',
      )
    }
    const latest = await api.latestRelease().then((value) => value.release)
    requireReleaseReachable(appDir, latest, wanted)
    const remote = new Map(
      remotePublicRefs(appDir, selected.name).map((ref) => [ref.name, ref.oid]),
    )
    const missing = wanted.filter((ref) => remote.get(ref.name) !== ref.oid)
    if (missing.length > 0) {
      const refspecs = missing.map((ref) => transferRefspec(ref.name))
      throw new Refusal(
        `GitHub ${selected.repository} is missing ${missing.length} authoritative branch/tag ref(s). Push them manually, then rerun this command.`,
        'github_push_required',
        {
          actionRequired: true,
          action: { cwd: appDir, argv: ['git', 'push', '--atomic', selected.name, ...refspecs] },
          extra: {
            appId,
            repository: selected.repository,
            missing: missing.map((ref) => ref.name),
          },
        },
      )
    }
    return setAppSource(deployUrl, token, appId, {
      source: target,
      expectedRevision: state.revision,
      refs: wanted,
      ...releaseExpectation(latest),
    })
  }

  // An initial GitHub claim has no DeepSpace ref inventory; exact HEAD is the
  // minimum proof that deploy can subsequently verify without writing GitHub.
  requirePublishedHead(appDir, selected, appId)
  return setAppSource(deployUrl, token, appId, {
    source: target,
    expectedRevision: state.revision,
  })
}

async function moveToDeepSpace(input: {
  appDir: string
  appId: string
  token: string
  deployUrl: string
  state: AppSourceState
  remoteArg?: string
}): Promise<{ source: AppSource; revision: number }> {
  const { appDir, appId, token, deployUrl, state, remoteArg } = input
  const target: AppSource = { provider: 'deepspace' }
  if (sameSource(state.source, target)) return { source: target, revision: state.revision }
  if (state.source?.provider !== 'github') {
    return setAppSource(deployUrl, token, appId, {
      source: target,
      expectedRevision: state.revision,
    })
  }

  const selected = requireGitHubRemote(appDir, remoteArg, state.source.repository)
  const { branch, oid } = requirePublishedHead(appDir, selected)
  fetchGitHubTransferRefs(appDir, selected.name)
  const refs = transferRefs(appDir)
  const latest = await repoApi(deployUrl, token, appId)
    .latestRelease()
    .then((value) => value.release)
  requireReleaseReachable(appDir, latest, refs)
  ensureSpaceRemote(appDir, appId)
  if (refs.length === 0) {
    throw new Refusal('GitHub has no branches or tags to import.', 'source_empty')
  }
  const pushed = runGit(
    appDir,
    [
      'push',
      '--force',
      '--atomic',
      '--prune',
      SPACE_REMOTE,
      `${TRANSFER_PREFIX}/heads/*:refs/heads/*`,
      `${TRANSFER_PREFIX}/tags/*:refs/tags/*`,
    ],
    { allowFail: true, env: gitSourceImportEnv(token, state.revision, deployUrl) },
  )
  if (pushed.status !== 0) {
    throw new Refusal(
      `DeepSpace source import failed: ${pushed.stderr.toString('utf-8').trim() || 'git push failed'}`,
      'source_import_failed',
    )
  }
  return setAppSource(deployUrl, token, appId, {
    source: target,
    expectedRevision: state.revision,
    branch,
    commitOid: oid,
    refs,
    ...releaseExpectation(latest),
  })
}

function requireGitHubRemote(
  appDir: string,
  remoteArg?: string,
  repository?: string,
): GitHubRemote {
  const selected = selectGitHubRemote(appDir, { name: remoteArg, repository })
  if (selected) return selected
  throw new Refusal(
    remoteArg
      ? `Remote "${remoteArg}" is not a GitHub repository${repository ? ` for ${repository}` : ''}.`
      : repository
        ? `No local GitHub remote points at ${repository}. Add one or pass --remote <name>.`
        : 'No unambiguous GitHub remote was found. Add `origin` or pass --remote <name>.',
    'github_remote_required',
  )
}

function requirePublishedHead(
  appDir: string,
  remote: GitHubRemote,
  appId = '',
): { branch: string; oid: string } {
  const head = requireLocalHead(appDir)
  if (remoteBranchOid(appDir, remote.name, head.branch) !== head.oid) {
    throw githubPushRequired(appDir, appId, remote, head.branch, head.oid)
  }
  return head
}

function requireLocalHead(appDir: string): { branch: string; oid: string } {
  if (!isWorkTreeClean(appDir)) {
    throw new Refusal('Commit or discard local changes before changing source.', 'dirty_worktree')
  }
  const branch = currentBranch(appDir)
  if (!branch) throw new Refusal('HEAD is detached; switch to a branch first.', 'detached_head')
  const oid = resolveCommit(appDir, 'HEAD')
  if (!oid) throw new Refusal('The repository has no commit to publish.', 'no_commits')
  return { branch, oid }
}

function githubPushRequired(
  appDir: string,
  appId: string,
  remote: GitHubRemote,
  branch: string,
  oid: string,
): Refusal {
  return new Refusal(
    `GitHub ${remote.repository} does not have ${branch} at ${oid.slice(0, 10)}. Push it manually, then rerun.`,
    'github_push_required',
    {
      actionRequired: true,
      action: { cwd: appDir, argv: ['git', 'push', remote.name, branch] },
      extra: { ...(appId ? { appId } : {}), repository: remote.repository, branch, oid },
    },
  )
}

function fetchGitHubTransferRefs(appDir: string, remote: string): void {
  runGit(appDir, [
    'fetch',
    '--quiet',
    '--prune',
    remote,
    `+refs/heads/*:${TRANSFER_PREFIX}/heads/*`,
    `+refs/tags/*:${TRANSFER_PREFIX}/tags/*`,
  ])
}

function transferRefs(appDir: string): GitRef[] {
  return localTransferRefs(appDir, `${TRANSFER_PREFIX}/heads`, 'refs/heads').concat(
    localTransferRefs(appDir, `${TRANSFER_PREFIX}/tags`, 'refs/tags'),
  )
}

function transferRefspec(ref: string): string {
  if (ref.startsWith('refs/heads/')) {
    return `${TRANSFER_PREFIX}/heads/${ref.slice('refs/heads/'.length)}:${ref}`
  }
  return `${TRANSFER_PREFIX}/tags/${ref.slice('refs/tags/'.length)}:${ref}`
}

function isPublicRef(ref: GitRef): boolean {
  return ref.name.startsWith('refs/heads/') || ref.name.startsWith('refs/tags/')
}

function requireReleaseReachable(
  appDir: string,
  release: RemoteRelease | null,
  refs: GitRef[],
): void {
  if (!release?.commitOid) return
  const known = resolveCommit(appDir, release.commitOid) !== null
  const reachable =
    known && refs.some((ref) => isAncestor(appDir, release.commitOid as string, ref.oid))
  if (!reachable) {
    throw new Refusal(
      `Live release #${release.seq} (${release.commitOid.slice(0, 10)}) is not reachable from a public branch or tag. Redeploy a public branch before changing source.`,
      'release_not_public',
    )
  }
}

function releaseExpectation(release: RemoteRelease | null): {
  expectedReleaseId: string | null
  expectedReleaseCommitOid: string | null
} {
  return {
    expectedReleaseId: release?.id ?? null,
    expectedReleaseCommitOid: release?.commitOid ?? null,
  }
}

function sameSource(left: AppSource | null, right: AppSource): boolean {
  return (
    left?.provider === right.provider &&
    (left.provider !== 'github' ||
      (right.provider === 'github' && left.repository === right.repository))
  )
}

function sameRefs(left: GitRef[], right: GitRef[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Map(right.map((ref) => [ref.name, ref.oid]))
  return left.every((ref) => expected.get(ref.name) === ref.oid)
}
