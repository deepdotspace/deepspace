/**
 * deepspace invoke <integration>/<endpoint> [options]
 *
 * Top-level alias for `deepspace integrations invoke ...`. Calls a platform
 * integration as the currently logged-in user — the same identity shown by
 * `deepspace whoami`. That user is billed.
 *
 *   deepspace invoke openai/chat-completion --body '{"messages":[...]}'
 *   deepspace invoke openai/chat-completion --body-file req.json
 *   cat req.json | deepspace invoke openai/chat-completion --body-file -
 *   deepspace invoke openai/chat-completion --info
 *   deepspace invoke --list
 */

import { defineCommand } from 'citty'
import { runInvoke, runInfo, runList } from './_invoke-impl'

export default defineCommand({
  meta: {
    name: 'invoke',
    description: 'Invoke a platform integration as the logged-in user',
  },
  args: {
    target: {
      type: 'positional',
      description: "<integration>/<endpoint> (e.g. 'openai/chat-completion')",
      required: false,
    },
    body: {
      type: 'string',
      alias: 'd',
      description: 'Inline JSON body',
      required: false,
    },
    'body-file': {
      type: 'string',
      alias: 'f',
      description: 'Read JSON body from file (use - for stdin)',
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Print only the response JSON (machine-readable)',
      default: false,
    },
    info: {
      type: 'boolean',
      description: 'Print schema + example body for the endpoint, then exit',
      default: false,
    },
    list: {
      type: 'boolean',
      description: 'Print all available integrations, then exit',
      default: false,
    },
    timeout: {
      type: 'string',
      description: 'Request timeout in milliseconds (default: 120000)',
      required: false,
    },
    yes: {
      type: 'boolean',
      alias: 'y',
      description: 'Skip the paid-call cost confirmation',
      default: false,
    },
  },
  async run({ args }) {
    try {
      if (args.list) {
        await runList({ json: args.json })
        return
      }
      if (args.info) {
        await runInfo({ target: args.target as string, json: args.json })
        return
      }
      const timeout = args.timeout != null ? Number(args.timeout) : undefined
      if (timeout != null && (!Number.isFinite(timeout) || timeout <= 0)) {
        throw new Error(`Invalid --timeout '${args.timeout}'. Must be a positive number of milliseconds.`)
      }
      await runInvoke({
        target: args.target as string,
        body: args.body,
        bodyFile: args['body-file'],
        json: args.json,
        timeout,
        yes: args.yes,
      })
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  },
})
