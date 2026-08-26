/**
 * `deepspace releases` — the app's immutable deploy history.
 *
 * Every deploy (and rollback) records a release: who shipped it, when, the
 * commit it was built from, and the retained bundle rollback re-ships. What
 * `deepspace rollback` reads its targets from.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug, and the exit codes come from there, not from this file.
 */

import * as p from '@clack/prompts'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { resolveAppTarget, assertAppTargetResolvable, parseWranglerEnvArg } from '../lib/app-target'
import { releaseSourceLabel, repoApi } from '../lib/repo-api'
import { displayText } from '../lib/cli-format'
import { actorLabels } from '../lib/actor-labels'
import { parseLimitArg } from '../lib/citty-args'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import { createSpinner } from '../lib/spinner'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

export default defineDeepspaceCommand({
  meta: {
    name: 'releases',
    description: "List the app's deploy history (immutable releases)",
  },
  args: {
    app: {
      type: 'string',
      alias: 'a',
      description: 'App id or subdomain name (default: the surrounding app directory)',
      required: false,
    },
    env: {
      type: 'string',
      alias: 'e',
      description: "wrangler.toml [env.<name>] slot — selects that environment's app id",
      required: false,
    },
    limit: {
      type: 'string',
      description: 'Max entries (default 20)',
      required: false,
    },
  },
  async run({ args }) {
    const appArg = args.app as string | undefined
    const envArg = args.env as string | undefined
    const { limit, error: limitError } = parseLimitArg(args.limit)
    if (limitError) throw new Refusal(limitError, 'invalid_limit')
    // Blank --app / missing app context is a client-side error — reject it
    // BEFORE the token read so it never surfaces as not_authenticated.
    assertAppTargetResolvable(appArg, { wranglerEnv: envArg })
    const { wranglerEnv } = parseWranglerEnvArg(envArg)
    const spinner = args.json ? null : createSpinner()
    spinner?.start('Loading release history…')
    const token = await ensureToken()
    const appId = await resolveAppTarget(DEPLOY_URL, token, appArg, { wranglerEnv: envArg })
    const { releases } = await repoApi(DEPLOY_URL, token, appId).listReleases(limit)
    spinner?.stop(`Loaded ${releases.length} ${releases.length === 1 ? 'release' : 'releases'}.`)

    if (!args.json) {
      if (releases.length === 0) {
        p.log.info('No releases yet — the history starts with the next `deepspace deploy`.')
      } else {
        // Same resolution `activity` uses, for the same reason: a row that
        // names an email is readable, a row that names Kr7JX… is not.
        const actors = await actorLabels(token, appId)
        for (const r of releases) {
          // displayText like every other server-string sink: the repository
          // half of the label is deployer-supplied evidence, and the input
          // regex upstream is a bound, not a substitute for escaping here.
          const source = displayText(releaseSourceLabel(r))
          const rollback = r.rollbackAvailable ? 'rollback available' : 'rollback unavailable'
          console.log(
            `#${r.seq}  ${r.id}  ${r.kind.padEnd(8)}  ${r.createdAt}  ${actors.get(r.actor) ?? r.actor}  ${source}  ${rollback}`,
          )
        }
        p.log.info(
          `Roll back an available release with: deepspace rollback <release-id>${wranglerEnv ? ` --env ${wranglerEnv}` : ''}`,
        )
      }
    }
    // No `next`: a listing is terminal — the follow-up depends on which row you
    // pick, and the human path already names `deepspace rollback <release-id>`.
    return { data: { appId, wranglerEnv: wranglerEnv ?? null, releases } }
  },
})
