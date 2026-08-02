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
 * All calls are made as the currently logged-in user (`deepspace auth whoami`).
 * That user is billed.
 *
 * Each subcommand is defined with the command runtime (lib/command.ts): the
 * `--json` flag, the `{ ok, … }` envelope, the refusal slug, the `Next:` line,
 * and the exit code come from there. Before that, the subcommands caught their
 * own errors and `console.error`'d the message — which meant a `--json` caller
 * got PLAIN PROSE on stderr and an empty stdout.
 *
 * No `run()` is defined on the parent — that matches the convention used
 * by `test-accounts` and prevents citty from firing both the parent and
 * a matched subcommand. Bare `deepspace integrations` (no subcommand)
 * prints citty's auto-generated help.
 */

import { defineCommand } from 'citty'
import { defineDeepspaceCommand } from '../lib/command'
import { runInvoke, runInfo, runList, parseTimeout } from './_invoke-impl'

const list = defineDeepspaceCommand({
  meta: {
    name: 'list',
    description: 'List all available integrations',
  },
  async run({ args }) {
    return runList({ json: args.json })
  },
})

const info = defineDeepspaceCommand({
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
  },
  async run({ args }) {
    return runInfo({ target: args.target as string, json: args.json })
  },
})

const invoke = defineDeepspaceCommand({
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
    return runInvoke({
      target: args.target as string,
      body: args.body as string | undefined,
      bodyFile: args['body-file'] as string | undefined,
      json: args.json,
      timeout: parseTimeout(args.timeout),
      yes: Boolean(args.yes),
    })
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
