import * as p from '@clack/prompts'
import { parseLimitArg } from '../../lib/citty-args'
import { actorLabels } from '../../lib/actor-labels'
import { defineDeepspaceCommand, Refusal } from '../../lib/command'
import type { RemoteWorkspaceView } from '../../lib/repo-api'
import { createSpinner } from '../../lib/spinner'
import { formatCount, listOverlaps, type WorkspaceOverlap } from './analysis'
import { APP_ARG, resolveApiOnly } from './runtime'

export function withWorkspaceOverlaps(
  views: RemoteWorkspaceView[],
  overlapsById: Map<string, WorkspaceOverlap[]>,
) {
  return views.map((view) => ({
    ...view,
    overlaps: overlapsById.get(view.workspace.id) ?? [],
  }))
}

export const listWorkspacesCommand = defineDeepspaceCommand({
  meta: { name: 'list', description: 'List workspaces on the cloud repo' },
  args: {
    all: { type: 'boolean', description: 'Include landed/dropped workspaces', default: false },
    limit: { type: 'string', description: 'Max entries (default 50)', required: false },
    app: APP_ARG,
  },
  async run({ args }) {
    const { limit, error: limitError } = parseLimitArg(args.limit)
    if (limitError) throw new Refusal(limitError, 'invalid_limit')
    const spinner = args.json ? null : createSpinner()
    spinner?.start('Loading workspaces…')
    const { appId, api, token } = await resolveApiOnly(
      typeof args.app === 'string' ? args.app : undefined,
    )
    const all = Boolean(args.all)
    const { views } = await api.listWorkspaces({ all, limit })
    if (views.length === 0) {
      spinner?.stop('No workspaces found.')
      if (!args.json) {
        p.log.info(
          all
            ? 'No workspaces.'
            : 'No active workspaces. Create one with `deepspace workspace new -t "…"`.',
        )
      }
      return { data: { workspaces: views } }
    }

    spinner?.message('Checking workspace overlaps…')
    const overlapsPromise = listOverlaps(appId, token, api, views)
    if (args.json) {
      return {
        data: { workspaces: withWorkspaceOverlaps(views, await overlapsPromise) },
      }
    }
    const [actors, overlapsById] = await Promise.all([actorLabels(token, appId), overlapsPromise])
    const workspaces = withWorkspaceOverlaps(views, overlapsById)
    spinner?.stop(`Loaded ${views.length} ${views.length === 1 ? 'workspace' : 'workspaces'}.`)
    for (const view of workspaces) {
      const workspace = view.workspace
      const overlaps = view.overlaps
      const marker =
        workspace.status === 'active'
          ? overlaps.length > 0
            ? '⚠'
            : ' '
          : workspace.status === 'landed'
            ? '✓'
            : '✗'
      console.log(
        `${marker} ${workspace.id}  ${workspace.status}  ↑${formatCount(view.aheadOfBase)} ↓${formatCount(view.behindTrunk)}  ${actors.get(workspace.createdBy) ?? workspace.createdBy}  ${workspace.updatedAt}  ${workspace.task}`,
      )
      for (const overlap of overlaps) {
        console.log(
          `    overlaps ${overlap.workspaceId}: ${overlap.paths.slice(0, 3).join(', ')}${overlap.paths.length + overlap.morePaths > 3 ? ` (+${overlap.paths.length + overlap.morePaths - 3} more)` : ''}`,
        )
      }
    }
    p.log.info('↑ commits ahead of base · ↓ trunk commits since base (staleness)')
    return { data: { workspaces } }
  },
})
