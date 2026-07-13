/**
 * `deepspace secrets` — manage the app's secrets store.
 *
 * Every app has exactly one store, addressed by its immutable id (the
 * DEEPSPACE_APP_ID in wrangler.toml); configs follow the wrangler-env
 * convention (top-level → `prd`, `--env staging` → `staging`). There is no
 * project/link setup step: run the commands from the app directory (or pass
 * --app <appId>) and they just work — for the owner, collaborators, and
 * admin accounts alike.
 *
 *   deepspace secrets list [-c prd]
 *   deepspace secrets set KEY=value [KEY2=value2 …]
 *   deepspace secrets get KEY [--plain]
 *   deepspace secrets delete KEY [KEY2 …]
 *   deepspace secrets upload <file>        (dotenv or JSON; --replace)
 *   deepspace secrets download [--format dotenv|json|shell]
 *   deepspace secrets pull                 (refresh the .dev.vars cache)
 *   deepspace secrets configs list|create|delete
 */

import { defineCommand } from 'citty'
import { readFileSync } from 'node:fs'
import { ensureToken } from '../auth'
import { decodeJwtPayload } from '../jwt'
import { PLATFORM_URLS, writeDevVars } from '../env'
import { findAppDir } from '../lib/app-context'
import { readAppId, APP_ID_RE } from '../lib/app-identity'
import { dedupePositionals } from '../lib/citty-args'
import {
  createConfig,
  defaultConfigNameForEnv,
  deleteConfig,
  deleteSecret,
  fetchSecretsValues,
  formatSecretsDownload,
  getSecretPlain,
  listConfigs,
  listSecrets,
  parseSecretsUpload,
  pullAppSecretsCache,
  renderSecretsCache,
  setSecret,
  uploadSecrets,
  validateConfigName,
  validateSecretName,
  validateSecretValue,
  type SecretsDownloadFormat,
} from '../lib/secrets'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

const COMMON_ARGS = {
  app: {
    type: 'string' as const,
    alias: 'a',
    description: 'App id (default: DEEPSPACE_APP_ID from the nearest wrangler.toml)',
    required: false,
  },
  config: {
    type: 'string' as const,
    alias: 'c',
    description: 'Config name (default: the --env name, or "prd")',
    required: false,
  },
  env: {
    type: 'string' as const,
    alias: 'e',
    description: 'wrangler.toml [env.<name>] slot — selects that env’s app id and config',
    required: false,
  },
}

interface Target {
  appId: string
  configName: string
  token: string
}

async function resolveTarget(args: {
  app?: string
  config?: string
  env?: string
}): Promise<Target> {
  const wranglerEnv = args.env?.trim() || undefined
  let appId = args.app?.trim()
  if (appId && !APP_ID_RE.test(appId)) {
    throw new Error(`Invalid app id "${appId}" — expected app_<26 chars>.`)
  }
  if (!appId) {
    const appDir = findAppDir()
    appId = (appDir && readAppId(appDir, wranglerEnv)) || undefined
    if (!appId) {
      // `--env <name>` selects a wrangler [env.<name>] slot with its OWN app id.
      // If the slot is missing but a top-level app id exists, the user almost
      // certainly wanted to pick a *config*, not an env — point them at `-c`.
      if (wranglerEnv && appDir && readAppId(appDir, undefined)) {
        throw new Error(
          `No app id for env "${wranglerEnv}" — wrangler.toml has no [env.${wranglerEnv}] block with its own DEEPSPACE_APP_ID. ` +
            `To target the "${wranglerEnv}" config on this app, use \`-c ${wranglerEnv}\` instead of \`--env ${wranglerEnv}\`.`,
        )
      }
      throw new Error(
        'No app id. Run from an app directory whose wrangler.toml carries DEEPSPACE_APP_ID (`deepspace init` mints one), or pass --app <appId>.',
      )
    }
  }
  const configName = validateConfigName(args.config?.trim() || defaultConfigNameForEnv(wranglerEnv))
  const token = await ensureToken()
  return { appId, configName, token }
}

function fail(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

/**
 * Warn (once) when a write turns on the unauthenticated debug API. Applies to
 * every write path that can carry it — `set` and `upload` alike. Returns true
 * when it warned, so callers can skip the generic "run deploy" line (this
 * message already tells the user to redeploy).
 */
function warnIfDebugRoutesEnabled(secrets: Record<string, string>): boolean {
  if (secrets.ALLOW_DEBUG_ROUTES !== 'true') return false
  console.warn(
    '\n⚠  ALLOW_DEBUG_ROUTES=true exposes an UNAUTHENTICATED debug API on the deployed app —\n' +
      '   anyone who can reach /api/debug/* can read and mutate any record. Redeploy to apply;\n' +
      '   `deepspace secrets delete ALLOW_DEBUG_ROUTES` (then redeploy) turns it back off.',
  )
  return true
}

const APPLY_HINT = 'Run `deepspace deploy` to apply — secrets take effect at deploy time.'
// `deepspace dev` regenerates .dev.vars from the store only at startup, so a
// secret changed mid-session isn't picked up until dev restarts (DEV-4).
const LOCAL_DEV_HINT = 'Running `deepspace dev`? Restart it to load the change locally.'

const list = defineCommand({
  meta: { name: 'list', description: 'List masked secrets in a config' },
  args: {
    ...COMMON_ARGS,
    'only-names': {
      type: 'boolean',
      description: 'Only print secret names; omit values and metadata',
      default: false,
    },
    json: { type: 'boolean', description: 'Machine-readable output', default: false },
  },
  async run({ args }) {
    try {
      const t = await resolveTarget(args)
      const { secrets } = await listSecrets(DEPLOY_URL, t.token, t.appId, t.configName)
      if (args.json) {
        console.log(JSON.stringify({ appId: t.appId, config: t.configName, secrets }, null, 2))
        return
      }
      if (secrets.length === 0) {
        console.log(`No secrets in ${t.configName}.`)
        return
      }
      for (const s of secrets) {
        console.log(args['only-names'] ? s.key : `${s.key}  (v${s.version}, ${s.updatedAt})`)
      }
    } catch (err) {
      fail(err)
    }
  },
})

const set = defineCommand({
  meta: { name: 'set', description: 'Set secrets from KEY=value pairs' },
  args: {
    ...COMMON_ARGS,
    secret: { type: 'positional', description: 'KEY=value (repeatable)', required: true },
  },
  async run({ args }) {
    try {
      const t = await resolveTarget(args)
      const pairs = dedupePositionals(args.secret, args._)
      const secrets: Record<string, string> = {}
      const dupes: string[] = []
      for (const pair of pairs) {
        const eq = pair.indexOf('=')
        if (eq <= 0) throw new Error(`Expected KEY=value, got "${pair}"`)
        const key = validateSecretName(pair.slice(0, eq))
        const value = pair.slice(eq + 1)
        validateSecretValue(key, value)
        // The same KEY given twice (with different values) silently keeps the
        // last — surface it instead of dropping a value without a word.
        if (key in secrets && !dupes.includes(key)) dupes.push(key)
        secrets[key] = value
      }
      if (dupes.length) {
        console.warn(
          `Warning: ${dupes.join(', ')} given more than once — kept the last value for each.`,
        )
      }
      if (Object.keys(secrets).length === 1) {
        const [[k, v]] = Object.entries(secrets)
        await setSecret(DEPLOY_URL, t.token, t.appId, t.configName, k, v)
      } else {
        await uploadSecrets(DEPLOY_URL, t.token, t.appId, t.configName, secrets, false)
      }
      console.log(`Set ${Object.keys(secrets).length} secret${Object.keys(secrets).length === 1 ? '' : 's'} in ${t.configName}.`)
      if (!warnIfDebugRoutesEnabled(secrets)) {
        console.log(APPLY_HINT)
        console.log(LOCAL_DEV_HINT)
      }
    } catch (err) {
      fail(err)
    }
  },
})

const get = defineCommand({
  meta: { name: 'get', description: 'Get a secret; pass --plain to print the value' },
  args: {
    ...COMMON_ARGS,
    key: { type: 'positional', description: 'Secret name', required: true },
    plain: { type: 'boolean', description: 'Print the plaintext value', default: false },
  },
  async run({ args }) {
    try {
      const t = await resolveTarget(args)
      const key = validateSecretName(args.key)
      if (args.plain) {
        const { value } = await getSecretPlain(DEPLOY_URL, t.token, t.appId, t.configName, key)
        // Byte-exact when piped/redirected (`… get --plain KEY > key.pem`); add a
        // trailing newline only for a human reading it in a terminal.
        process.stdout.write(process.stdout.isTTY ? value + '\n' : value)
        return
      }
      const { secrets } = await listSecrets(DEPLOY_URL, t.token, t.appId, t.configName)
      const item = secrets.find((s) => s.key === key)
      if (!item) fail(new Error(`Secret "${key}" not found in ${t.configName}`))
      console.log(`${item.key}  (v${item.version}, ${item.updatedAt})`)
    } catch (err) {
      fail(err)
    }
  },
})

const del = defineCommand({
  meta: { name: 'delete', description: 'Delete one or more secrets' },
  args: {
    ...COMMON_ARGS,
    key: { type: 'positional', description: 'Secret name (repeatable)', required: true },
  },
  async run({ args }) {
    try {
      const t = await resolveTarget(args)
      const keys = dedupePositionals(args.key, args._)
      let deleted = 0
      let absent = 0
      for (const key of keys) {
        const name = validateSecretName(key)
        try {
          await deleteSecret(DEPLOY_URL, t.token, t.appId, t.configName, name)
          deleted++
        } catch (err) {
          // An already-absent key is a completed delete, not a failure: don't
          // let one missing key abort the rest, and keep retries idempotent.
          if ((err as { status?: number })?.status === 404) absent++
          else throw err
        }
      }
      const note = absent > 0 ? ` (${absent} already absent)` : ''
      console.log(`Deleted ${deleted} secret${deleted === 1 ? '' : 's'} from ${t.configName}.${note}`)
      if (deleted > 0) console.log(APPLY_HINT)
    } catch (err) {
      fail(err)
    }
  },
})

const upload = defineCommand({
  meta: { name: 'upload', description: 'Upload secrets from a dotenv or JSON file' },
  args: {
    ...COMMON_ARGS,
    file: { type: 'positional', description: 'Path to a dotenv or JSON file (- for stdin)', required: true },
    replace: {
      type: 'boolean',
      description: 'Replace the whole config (delete keys missing from the file)',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const t = await resolveTarget(args)
      const content =
        args.file === '-' ? readFileSync(0, 'utf-8') : readFileSync(args.file, 'utf-8')
      const secrets = parseSecretsUpload(content)
      if (Object.keys(secrets).length === 0) fail(new Error('No secrets found in the input.'))
      await uploadSecrets(DEPLOY_URL, t.token, t.appId, t.configName, secrets, args.replace)
      console.log(`Uploaded ${Object.keys(secrets).length} secrets to ${t.configName}.`)
      // A file can turn on the debug API just like `set` can — warn either way.
      if (!warnIfDebugRoutesEnabled(secrets)) console.log(APPLY_HINT)
    } catch (err) {
      fail(err)
    }
  },
})

const download = defineCommand({
  meta: { name: 'download', description: 'Download a config’s secrets (dotenv/json/shell)' },
  args: {
    ...COMMON_ARGS,
    format: {
      type: 'string',
      description: 'dotenv (default) | json | shell',
      default: 'dotenv',
    },
  },
  async run({ args }) {
    try {
      const t = await resolveTarget(args)
      const format = args.format as SecretsDownloadFormat
      if (!['dotenv', 'json', 'shell'].includes(format)) {
        fail(new Error(`Unknown format "${args.format}" — use dotenv, json, or shell.`))
      }
      const { secrets } = await fetchSecretsValues(DEPLOY_URL, t.token, t.appId, t.configName)
      process.stdout.write(formatSecretsDownload(secrets, format))
    } catch (err) {
      fail(err)
    }
  },
})

const pull = defineCommand({
  meta: { name: 'pull', description: 'Refresh the .dev.vars cache from the app store' },
  args: { ...COMMON_ARGS },
  async run({ args }) {
    try {
      const wranglerEnv = args.env?.trim() || undefined
      const appDir = findAppDir()
      if (!appDir) fail(new Error('Run from a DeepSpace app directory (one containing wrangler.toml).'))
      const t = await resolveTarget(args)
      const ownerId = decodeJwtPayload<{ sub: string }>(t.token).sub
      const pulled = await pullAppSecretsCache(DEPLOY_URL, t.token, t.appId, t.configName)
      if (!pulled) {
        console.log(`No secrets in ${t.configName} yet — nothing to pull.`)
        return
      }
      await writeDevVars(appDir, ownerId, t.token, wranglerEnv, {
        appId: t.appId,
        generatedSecretsCache: renderSecretsCache(pulled.values, pulled),
        sharedDevVarsCache: true,
      })
      console.log(
        `Pulled ${Object.keys(pulled.values).length} secrets (${t.configName}) into .dev.vars.`,
      )
    } catch (err) {
      fail(err)
    }
  },
})

const configsList = defineCommand({
  meta: { name: 'list', description: 'List the app’s configs' },
  args: { ...COMMON_ARGS },
  async run({ args }) {
    try {
      const t = await resolveTarget(args)
      const { configs } = await listConfigs(DEPLOY_URL, t.token, t.appId)
      if (configs.length === 0) {
        console.log('No configs yet — the first `secrets set` creates one.')
        return
      }
      for (const cfg of configs) {
        console.log(`${cfg.name}  (${cfg.secretCount ?? 0} secrets, updated ${cfg.updatedAt})`)
      }
    } catch (err) {
      fail(err)
    }
  },
})

const configsCreate = defineCommand({
  meta: { name: 'create', description: 'Create a config (optionally copying another)' },
  args: {
    ...COMMON_ARGS,
    name: { type: 'positional', description: 'Config name', required: true },
    'copy-from': { type: 'string', description: 'Copy secrets from this config', required: false },
  },
  async run({ args }) {
    try {
      const t = await resolveTarget(args)
      const name = validateConfigName(args.name)
      const copyFrom = args['copy-from'] || undefined
      // Create is idempotent server-side, so a plain create of an existing
      // config used to print a false "Created". Distinguish the cases up front:
      // a bare re-create is a no-op ("Already exists."); a --copy-from into an
      // existing config would clobber it, so refuse rather than silently create.
      const { configs } = await listConfigs(DEPLOY_URL, t.token, t.appId)
      if (configs.some((c) => c.name === name)) {
        if (copyFrom) {
          fail(
            new Error(
              `Config "${name}" already exists — refusing to copy "${copyFrom}" over it. Delete it first, or pick a new name.`,
            ),
          )
        }
        console.log(`Config ${name} already exists.`)
        return
      }
      await createConfig(DEPLOY_URL, t.token, t.appId, name, copyFrom)
      console.log(`Created ${name}.`)
    } catch (err) {
      fail(err)
    }
  },
})

const configsDelete = defineCommand({
  meta: { name: 'delete', description: 'Delete a config and all of its secrets' },
  args: {
    ...COMMON_ARGS,
    name: { type: 'positional', description: 'Config name', required: true },
  },
  async run({ args }) {
    try {
      const t = await resolveTarget(args)
      const name = validateConfigName(args.name)
      await deleteConfig(DEPLOY_URL, t.token, t.appId, name)
      console.log(`Deleted ${name}.`)
    } catch (err) {
      fail(err)
    }
  },
})

const configs = defineCommand({
  meta: { name: 'configs', description: 'Manage the app’s secrets configs' },
  subCommands: { list: configsList, create: configsCreate, delete: configsDelete },
})

export default defineCommand({
  meta: { name: 'secrets', description: 'Manage the app’s secrets store' },
  subCommands: {
    list,
    set,
    get,
    delete: del,
    upload,
    download,
    pull,
    configs,
  },
})
