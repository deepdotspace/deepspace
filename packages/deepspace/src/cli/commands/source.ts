/**
 * `deepspace app source` — report the app's source authority.
 *
 * Read-only: source is never registered or declared. An unclaimed app whose
 * checkout has a GitHub remote deploys as GitHub (the release ledger records
 * the observed repository per release); an app becomes DeepSpace-source by
 * publishing to it — the first `deepspace push` claims it — and that claim is
 * permanent. There is nothing to set here, so this command only answers.
 */

import { ensureToken } from '../auth'
import { findAppDir } from '../lib/app-context'
import { readAppId } from '../lib/app-identity'
import { resolveAppTarget } from '../lib/app-target'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import { getAppSource, type AppSourceState } from '../lib/source-api'
import { deployBaseUrl } from '../lib/vc-remote'

export default defineDeepspaceCommand({
  meta: {
    name: 'source',
    description: 'Show the app’s source authority (inferred from use, never declared)',
  },
  args: {
    provider: {
      type: 'positional',
      description: 'No longer accepted — source is inferred, not declared',
      required: false,
    },
    app: {
      type: 'string',
      alias: 'a',
      description: 'App id or subdomain name (default: current app)',
      required: false,
    },
  },
  async run({ args }) {
    if (typeof args.provider === 'string' && args.provider.trim()) {
      // The old setter. Refuse with the model instead of guessing at intent:
      // there is no declaration left to make, and the two ways an app gets a
      // source are both ordinary commands.
      throw new Refusal(
        "Source is no longer declared — it latches at the app's first release, permanently: " +
          'a first deploy from a checkout with a GitHub remote fixes GitHub source, and a ' +
          'first `deepspace push` (or a first deploy without one) fixes DeepSpace source. ' +
          'This command only reports.',
        'source_inferred',
      )
    }
    // Truly read-only: an id-less checkout is REPORTED, never minted. Every
    // other verb heals through the resolver because it needs the app to do
    // its work; this one only answers questions, so resolving it must not
    // register anything.
    const appArg = typeof args.app === 'string' ? args.app : undefined
    if (appArg === undefined) {
      const appDir = findAppDir()
      if (appDir && !readAppId(appDir)) {
        if (!args.json) {
          console.log('App: not registered yet — it registers on first use (deploy, secrets, dev…)')
          console.log('Source: unclaimed — a checkout with a GitHub remote deploys as GitHub; the first `deepspace push` claims DeepSpace source permanently.')
        }
        return { data: { appId: null, source: null, revision: 0, registered: false } }
      }
    }
    const token = await ensureToken()
    const deployUrl = deployBaseUrl()
    const appId = await resolveAppTarget(deployUrl, token, appArg)
    const state = await getAppSource(deployUrl, token, appId)
    reportSource(appId, state, args.json)
    return {
      data: {
        appId: state.appId,
        source: state.source,
        revision: state.revision,
        registered: state.registered,
      },
    }
  },
})

function reportSource(appId: string, state: AppSourceState, json: boolean): void {
  if (json) return
  console.log(`App: ${appId}`)
  if (state.source?.provider === 'github') {
    console.log(`Source: GitHub · ${state.source.repository}`)
  } else if (state.source?.provider === 'deepspace') {
    console.log('Source: DeepSpace')
  } else {
    console.log(
      'Source: unclaimed — a checkout with a GitHub remote deploys as GitHub; the first `deepspace push` claims DeepSpace source permanently.',
    )
  }
  console.log(`Revision: ${state.revision}`)
  // Parity with --json's `registered` (2026-08-28 lifecycle AX F1: every
  // fact the machine document carries appears in the sentences too).
  console.log(`Registered: ${state.registered ? 'yes' : 'no'}`)
}
