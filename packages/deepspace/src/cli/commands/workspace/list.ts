import * as p from '@clack/prompts'
import { parseLimitArg } from '../../lib/citty-args'
import { actorLabels } from '../../lib/actor-labels'
import { defineDeepspaceCommand, Refusal } from '../../lib/command'
import { createSpinner } from '../../lib/spinner'
import { formatCount } from './analysis'
import { APP_ARG, resolveApiOnly } from './runtime'

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
    const { views, truncated } = await api.listWorkspaces({ all, limit })
    if (views.length === 0) {
      spinner?.stop('No workspaces found.')
      if (!args.json) {
        p.log.info(
          all
            ? 'No workspaces.'
            : 'No active workspaces. Create one with `deepspace workspace new -t "…"`.',
        )
      }
      // `truncated` here too: an empty page is exactly where a caller checks
      // whether there is more. Always present — a key that appears only when
      // true reads as "absent = unknown".
      return { data: { workspaces: views, truncated: truncated === true } }
    }

    // No overlap report here: computing it cost two extra `git fetch`es plus
    // a refs call per in-clone invocation, on the most frequently run
    // workspace verb (outside the app's clone it was silently skipped).
    // `workspace status` and `workspace sync` carry the advisory overlap
    // report at the moments it can change a decision.
    if (args.json) {
      return { data: { workspaces: views, truncated: truncated === true } }
    }
    const actors = await actorLabels(token, appId)
    spinner?.stop(`Loaded ${views.length} ${views.length === 1 ? 'workspace' : 'workspaces'}.`)
    for (const view of views) {
      const workspace = view.workspace
      const marker = workspace.status === 'active' ? ' ' : workspace.status === 'landed' ? '✓' : '✗'
      console.log(
        `${marker} ${workspace.id}  ${workspace.status}  ↑${formatCount(view.aheadOfBase)} ↓${formatCount(view.behindTrunk)}  ${actors.get(workspace.createdBy) ?? workspace.createdBy}  ${workspace.updatedAt}  ${workspace.task}`,
      )
    }
    if (truncated) {
      // "Not here" is a conclusion agents draw from this list — say so when
      // the list is a page rather than the whole set.
      p.log.warn(
        `More workspaces exist than shown — this is the first ${views.length}. ` +
          `Raise it with \`--limit\` (up to 200); past that, narrow with \`--all\` off or land/drop finished work.`,
      )
    }
    p.log.info('↑ commits ahead of base · ↓ trunk commits since base (staleness)')
    return { data: { workspaces: views, truncated: truncated === true } }
  },
})
