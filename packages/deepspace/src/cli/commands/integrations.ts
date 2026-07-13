/**
 * deepspace integrations <subcommand>
 *
 * Namespace for working with platform integrations from the command line.
 *
 *   deepspace integrations                                  # prints help
 *   deepspace integrations list                             # list all
 *   deepspace integrations info openai/chat-completion      # schema + example
 *   deepspace integrations invoke openai/chat-completion --body '{...}'
 *
 * `deepspace invoke ...` is a top-level alias for `integrations invoke ...`.
 * `deepspace invoke --list` is a shortcut for `integrations list`.
 *
 * All calls are made as the currently logged-in user (`deepspace whoami`).
 * That user is billed.
 *
 * No `run()` is defined on the parent — that matches the convention used
 * by `test-accounts` and prevents citty from firing both the parent and
 * a matched subcommand. Bare `deepspace integrations` (no subcommand)
 * prints citty's auto-generated help.
 */

import { defineCommand } from 'citty'
import { runInvoke, runInfo, runList } from './_invoke-impl'

const list = defineCommand({
  meta: {
    name: 'list',
    description: 'List all available integrations',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Print raw JSON (machine-readable)',
      default: false,
    },
  },
  async run({ args }) {
    try {
      await runList({ json: args.json })
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  },
})

const info = defineCommand({
  meta: {
    name: 'info',
    description: 'Print schema + example body for an integration endpoint',
  },
  args: {
    target: {
      type: 'positional',
      description: "<integration>/<endpoint> (e.g. 'openai/chat-completion')",
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Print raw JSON (machine-readable)',
      default: false,
    },
  },
  async run({ args }) {
    try {
      await runInfo({ target: args.target as string, json: args.json })
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  },
})

const invoke = defineCommand({
  meta: {
    name: 'invoke',
    description: 'Invoke a platform integration as the logged-in user',
  },
  args: {
    target: {
      type: 'positional',
      description: "<integration>/<endpoint> (e.g. 'openai/chat-completion')",
      required: true,
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

export default defineCommand({
  meta: {
    name: 'integrations',
    description: 'List, inspect, and invoke platform integrations',
  },
  subCommands: {
    list,
    info,
    invoke,
  },
})
