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
import * as p from '@clack/prompts'
import { readFileSync } from 'node:fs'
import { ensureToken } from '../auth'
import { decodeJwtPayload } from '../../shared/jwt'
import { PLATFORM_URLS } from '../env'
import { findAppDir } from '../lib/app-context'
import { writeDevVars } from '../lib/dev-vars'
import { assertAppTargetResolvable, parseWranglerEnvArg, resolveAppTarget } from '../lib/app-target'
import { ApiError } from '../lib/api'
import { InputError } from '../lib/cli-errors'
import { dedupePositionals } from '../lib/citty-args'
import { MAX_STDIN_BYTES, readStreamText } from '../lib/stdio'
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
  refreshSecretsCache,
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
  json: {
    type: 'boolean' as const,
    description: 'Emit a single-line JSON result for scripts/agents',
    default: false,
  },
}

interface Target {
  appId: string
  configName: string
  token: string
}

/**
 * Which app, which config, as whom. The app comes from the shared resolver
 * every other app-scoped command uses (`--app <id or name>`, else the
 * surrounding wrangler.toml — with the same `not_in_app_repo` /
 * `app_not_initialized` / `invalid_app_id` refusals as deploy), checked
 * BEFORE the token read so a missing target never surfaces as
 * `not_authenticated`.
 */
async function resolveTarget(args: {
  app?: string
  config?: string
  env?: string
}): Promise<Target> {
  assertAppTargetResolvable(args.app, { wranglerEnv: args.env })
  const { wranglerEnv } = parseWranglerEnvArg(args.env)
  const configName = validateConfigName(args.config?.trim() || defaultConfigNameForEnv(wranglerEnv))
  const token = await ensureToken()
  const appId = await resolveAppTarget(DEPLOY_URL, token, args.app, { wranglerEnv })
  return { appId, configName, token }
}

/**
 * Failures LEAVE these bodies. cli.ts wraps every leaf in `wrapCommandErrors`,
 * whose catch is one `renderCliError` call: `--json` gets the {ok,code,error}
 * envelope on stdout, the human path gets the message with its slug appended,
 * and the exit code is recorded (never process.exit; see lib/command.ts).
 * `renderCliError` RETURNS, so a refusal is only a refusal when it THROWS —
 * rendering one mid-body leaves the body running on into the very operation it
 * refused. There is no local helper here, so `throw` is the only spelling.
 */

/**
 * A success result on the contract. Under `--json` it is the single
 * `{ ok: true, … }` line; otherwise it runs the human callback. Wires the
 * success paths that used to print prose regardless of `--json`.
 */
function ok(json: boolean, data: Record<string, unknown>, human: () => void): void {
  if (json) console.log(JSON.stringify({ ok: true, ...data }))
  else human()
}

/**
 * Warn (once) when a write turns on the privileged debug API. Applies to
 * every write path that can carry it — `set` and `upload` alike. Returns true
 * when it warned, so callers can skip the generic "run deploy" line (this
 * message already tells the user to redeploy).
 */
function warnIfDebugRoutesEnabled(secrets: Record<string, string>): boolean {
  if (secrets.ALLOW_DEBUG_ROUTES !== 'true') return false
  console.warn(
    '\n⚠  ALLOW_DEBUG_ROUTES=true enables the owner/admin debug API on the deployed app —\n' +
      '   those users can read and mutate any app record through /api/debug/*. Redeploy to apply;\n' +
      '   `deepspace secrets delete ALLOW_DEBUG_ROUTES` (then redeploy) turns it back off.',
  )
  return true
}

const APPLY_HINT = 'Run `deepspace deploy` to apply — secrets take effect at deploy time.'
/** The same fact for `--json`, which never sees APPLY_HINT: a store write is
 *  not live until the next deploy. */
const APPLIES_AT_DEPLOY = { appliesAtDeploy: true as const }
// `deepspace dev start` regenerates .dev.vars from the store only at startup, so a
// secret changed mid-session isn't picked up until dev restarts (DEV-4).
const LOCAL_DEV_HINT = 'Running `deepspace dev start`? Restart it to load the change locally.'

const list = defineCommand({
  meta: { name: 'list', description: 'List masked secrets in a config' },
  args: {
    ...COMMON_ARGS,
    'only-names': {
      type: 'boolean',
      description: 'Only print secret names; omit values and metadata',
      default: false,
    },
  },
  async run({ args }) {
    const t = await resolveTarget(args)
    const { secrets } = await listSecrets(DEPLOY_URL, t.token, t.appId, t.configName)
    if (args.json) {
      console.log(JSON.stringify({ ok: true, appId: t.appId, config: t.configName, secrets }))
      return
    }
    if (secrets.length === 0) {
      console.log(`No secrets in ${t.configName}.`)
      return
    }
    for (const s of secrets) {
      console.log(args['only-names'] ? s.key : `${s.key}  (v${s.version}, ${s.updatedAt})`)
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
    const t = await resolveTarget(args)
    const pairs = dedupePositionals(args.secret, args._)
    const secrets: Record<string, string> = {}
    const dupes: string[] = []
    for (const pair of pairs) {
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new InputError(`Expected KEY=value, got "${pair}"`, 'invalid_pair')
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
    const n = Object.keys(secrets).length
    ok(
      args.json === true,
      { appId: t.appId, config: t.configName, set: Object.keys(secrets), ...APPLIES_AT_DEPLOY },
      () => {
        console.log(`Set ${n} secret${n === 1 ? '' : 's'} in ${t.configName}.`)
        if (!warnIfDebugRoutesEnabled(secrets)) {
          console.log(APPLY_HINT)
          console.log(LOCAL_DEV_HINT)
        }
      },
    )
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
    // `--plain` is a raw byte stream by design; `--json` promises one JSON
    // document. Honoring both silently emitted the secret as non-JSON on
    // stdout under a flag agents add reflexively — refuse the contradiction
    // instead.
    //
    // Checked BEFORE resolving the app: a contradiction in the caller's own
    // flags must not surface as `not_in_app_repo` or an auth failure.
    if (args.plain && args.json === true) {
      throw new InputError(
        '--plain writes the raw secret value, which is not JSON. Use --plain to capture the value, or --json for the metadata envelope — not both.',
        'invalid_flags',
      )
    }
    const t = await resolveTarget(args)
    const key = validateSecretName(args.key)
    if (args.plain) {
      const { value } = await getSecretPlain(DEPLOY_URL, t.token, t.appId, t.configName, key)
      // Raw value, byte-exact when piped (`… get --plain KEY > key.pem`) — a
      // --json wrapper would corrupt it, so --plain is a raw stream either
      // way (documented exception, like `download`). Trailing newline only
      // for a human at a TTY.
      process.stdout.write(process.stdout.isTTY ? value + '\n' : value)
      return
    }
    const { secrets } = await listSecrets(DEPLOY_URL, t.token, t.appId, t.configName)
    const item = secrets.find((s) => s.key === key)
    if (!item)
      throw new InputError(`Secret "${key}" not found in ${t.configName}`, 'secret_not_found')
    ok(
      args.json === true,
      {
        appId: t.appId,
        config: t.configName,
        key: item!.key,
        version: item!.version,
        updatedAt: item!.updatedAt,
      },
      () => console.log(`${item!.key}  (v${item!.version}, ${item!.updatedAt})`),
    )
  },
})

const del = defineCommand({
  meta: { name: 'delete', description: 'Delete one or more secrets' },
  args: {
    ...COMMON_ARGS,
    key: { type: 'positional', description: 'Secret name (repeatable)', required: true },
  },
  async run({ args }) {
    const t = await resolveTarget(args)
    const keys = dedupePositionals(args.key, args._)
    let deleted = 0
    let absent = 0
    for (const key of keys) {
      const name = validateSecretName(key)
      try {
        const result = await deleteSecret(DEPLOY_URL, t.token, t.appId, t.configName, name)
        // New servers distinguish an idempotent replay/absent key. An older
        // successful response has no field and remains a real deletion.
        if (result.deleted === false) absent++
        else deleted++
      } catch (err) {
        // An already-absent key is a completed delete, not a failure: don't
        // let one missing key abort the rest, and keep retries idempotent.
        // `unrecognized_service` is also a 404 but means the whole service is
        // wrong — reporting "already absent" for it would be a false success.
        if (err instanceof ApiError && err.status === 404 && err.code !== 'unrecognized_service') {
          absent++
        } else throw err
      }
    }
    const note = absent > 0 ? ` (${absent} already absent)` : ''
    ok(
      args.json === true,
      { appId: t.appId, config: t.configName, deleted, absent, ...APPLIES_AT_DEPLOY },
      () => {
        console.log(
          `Deleted ${deleted} secret${deleted === 1 ? '' : 's'} from ${t.configName}.${note}`,
        )
        if (deleted > 0) console.log(APPLY_HINT)
      },
    )
  },
})

const upload = defineCommand({
  meta: { name: 'upload', description: 'Upload secrets from a dotenv or JSON file' },
  args: {
    ...COMMON_ARGS,
    file: {
      type: 'positional',
      description: 'Path to a dotenv or JSON file (- for stdin)',
      required: true,
    },
    replace: {
      type: 'boolean',
      description: 'Replace the whole config (delete keys missing from the file)',
      default: false,
    },
  },
  async run({ args }) {
    const t = await resolveTarget(args)
    const secrets = parseSecretsUpload(await readUploadSource(String(args.file)))
    if (Object.keys(secrets).length === 0)
      throw new InputError('No secrets found in the input.', 'empty_input')
    await uploadSecrets(DEPLOY_URL, t.token, t.appId, t.configName, secrets, args.replace)
    const uploaded = Object.keys(secrets)
    ok(
      args.json === true,
      {
        appId: t.appId,
        config: t.configName,
        uploaded,
        replaced: args.replace === true,
        ...APPLIES_AT_DEPLOY,
      },
      () => {
        console.log(`Uploaded ${uploaded.length} secrets to ${t.configName}.`)
        // A file can turn on the debug API just like `set` can — warn either way.
        if (!warnIfDebugRoutesEnabled(secrets)) console.log(APPLY_HINT)
      },
    )
  },
})

/** The dotenv/JSON source of an upload: a path, or `-` for stdin. A path
 *  that cannot be read is the caller's mistake, coded as such — not a raw
 *  ENOENT with the file's own basename mistaken for a secret name. */
async function readUploadSource(file: string): Promise<string> {
  if (file === '-') {
    if (process.stdin.isTTY) {
      throw new InputError(
        'Reading secrets from stdin ("-"), but stdin is a terminal — pipe dotenv or JSON input, or pass a file path.',
        'no_stdin',
      )
    }
    return readStreamText(process.stdin, MAX_STDIN_BYTES)
  }
  try {
    return readFileSync(file, 'utf-8')
  } catch (err) {
    // Two codes, because two recoveries: a missing path is a typo; anything
    // else is a path that exists but cannot be read — the errno names which.
    const errno = (err as NodeJS.ErrnoException).code
    if (typeof errno !== 'string' || errno.length === 0) throw err
    throw new InputError(
      errno === 'ENOENT'
        ? `No such file: ${file}. Pass the path of a dotenv or JSON file to upload, or \`-\` to read it from stdin.`
        : `Cannot read ${file} (${errno}).`,
      errno === 'ENOENT' ? 'file_not_found' : 'file_unreadable',
    )
  }
}

const download = defineCommand({
  meta: { name: 'download', description: 'Download a config’s secrets (dotenv/json/shell)' },
  args: {
    ...COMMON_ARGS,
    // `download` writes a FILE FORMAT to stdout, so `--json` has no meaning
    // here and is REFUSED rather than described: rewording it was not enough,
    // because the flag still silently emitted dotenv — zero JSON documents on
    // a success path, with the plaintext secrets themselves as the output a
    // parser choked on. `secrets get --plain --json` already refuses the same
    // contradiction.
    json: {
      type: 'boolean' as const,
      description: 'Not supported here — secrets are a stream; use --format json for JSON output',
      default: false,
    },
    format: {
      type: 'string',
      description: 'dotenv (default) | json | shell',
      default: 'dotenv',
    },
  },
  async run({ args }) {
    if (args.json === true) {
      throw new InputError(
        '--json is not supported by `secrets download`: it writes the secrets themselves to stdout, not an envelope. Use `--format json` for JSON-shaped secrets, or `secrets list --json` for the metadata envelope.',
        'invalid_flags',
      )
    }
    const t = await resolveTarget(args)
    const format = args.format as SecretsDownloadFormat
    if (!['dotenv', 'json', 'shell'].includes(format)) {
      throw new InputError(
        `Unknown format "${args.format}" — use dotenv, json, or shell.`,
        'invalid_format',
      )
    }
    const { secrets } = await fetchSecretsValues(DEPLOY_URL, t.token, t.appId, t.configName)
    process.stdout.write(formatSecretsDownload(secrets, format))
  },
})

const pull = defineCommand({
  meta: { name: 'pull', description: 'Refresh the .dev.vars cache from the app store' },
  args: { ...COMMON_ARGS },
  async run({ args }) {
    const wranglerEnv = args.env?.trim() || undefined
    const appDir = findAppDir()
    if (!appDir)
      throw new InputError(
        'Run from a DeepSpace app directory (one containing wrangler.toml).',
        'not_in_app_repo',
      )
    const t = await resolveTarget(args)
    const ownerId = decodeJwtPayload<{ sub: string }>(t.token).sub
    const refreshed = await refreshSecretsCache(
      DEPLOY_URL,
      t.token,
      t.appId,
      wranglerEnv,
      t.configName,
    )
    await writeDevVars(appDir, ownerId, t.token, wranglerEnv, {
      appId: t.appId,
      generatedSecretsCache: refreshed.rendered,
    })
    const count = Object.keys(refreshed.pulled?.values ?? {}).length
    ok(args.json === true, { appId: t.appId, config: t.configName, pulled: count }, () =>
      console.log(
        refreshed.pulled
          ? `Pulled ${count} secrets (${t.configName}) into .dev.vars.`
          : `Config ${t.configName} does not exist yet; regenerated .dev.vars without app secrets.`,
      ),
    )
  },
})

const configsList = defineCommand({
  meta: { name: 'list', description: 'List the app’s configs' },
  args: { ...COMMON_ARGS },
  async run({ args }) {
    const t = await resolveTarget(args)
    const { configs } = await listConfigs(DEPLOY_URL, t.token, t.appId)
    ok(args.json === true, { appId: t.appId, configs }, () => {
      if (configs.length === 0) {
        console.log('No configs yet — the first `secrets set` creates one.')
        return
      }
      for (const cfg of configs) {
        console.log(`${cfg.name}  (${cfg.secretCount ?? 0} secrets, updated ${cfg.updatedAt})`)
      }
    })
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
        throw new InputError(
          `Config "${name}" already exists — refusing to copy "${copyFrom}" over it. Delete it first, or pick a new name.`,
          'config_exists',
        )
      }
      ok(args.json === true, { appId: t.appId, config: name, created: false }, () =>
        console.log(`Config ${name} already exists.`),
      )
      return
    }
    await createConfig(DEPLOY_URL, t.token, t.appId, name, copyFrom)
    ok(
      args.json === true,
      { appId: t.appId, config: name, created: true, ...(copyFrom ? { copyFrom } : {}) },
      () => console.log(`Created ${name}.`),
    )
  },
})

const configsDelete = defineCommand({
  meta: { name: 'delete', description: 'Delete a config and all of its secrets' },
  args: {
    ...COMMON_ARGS,
    name: { type: 'positional', description: 'Config name', required: true },
    yes: {
      type: 'boolean' as const,
      alias: 'y',
      description: 'Skip the confirmation (required for --json / non-interactive)',
      default: false,
    },
  },
  async run({ args }) {
    const t = await resolveTarget(args)
    const name = validateConfigName(args.name)
    // A prompt is a permanent hang for a machine caller — `--json` promises one
    // document on stdout, and a non-TTY stdin has nobody to answer — so both
    // refuse with the flag to re-run with. Refused BEFORE the listing: the
    // count exists only to feed the interactive sentence, so listing first
    // would let a missing config answer this path with the store's own error
    // instead of the `confirmation_required` it documents.
    if (args.yes !== true && (args.json === true || !process.stdin.isTTY)) {
      throw new InputError(
        `Deleting config ${name} removes every secret in it permanently. Re-run with --yes to confirm.`,
        'confirmation_required',
      )
    }
    // This destroys every secret in the config and there is no undo, so the
    // confirmation names how many go with it. With --yes the caller has already
    // decided, so a transient failure to list must not block the delete — the
    // count is reported as unknown instead.
    let secrets: Array<{ key: string }> = []
    let counted = true
    try {
      secrets = (await listSecrets(DEPLOY_URL, t.token, t.appId, name)).secrets
    } catch (error) {
      if (args.yes !== true) throw error
      counted = false
    }
    const count = secrets.length
    if (args.yes !== true) {
      const detail =
        count === 0
          ? `Config ${name} is empty.`
          : `Config ${name} holds ${count} secret${count === 1 ? '' : 's'}: ${secrets
              .map((secret) => secret.key)
              .slice(0, 8)
              .join(', ')}${count > 8 ? `, …` : ''}.`
      const confirmed = await p.confirm({
        message: `${detail} Deleting it removes ${count === 1 ? 'that secret' : 'them all'} permanently.`,
        initialValue: false,
      })
      // isCancel covers Ctrl-C and Esc — an interrupted prompt is a refusal to
      // consent, not consent.
      if (p.isCancel(confirmed) || !confirmed) {
        throw new InputError('Cancelled.', 'confirmation_required')
      }
    }
    await deleteConfig(DEPLOY_URL, t.token, t.appId, name)
    ok(
      args.json === true,
      { appId: t.appId, config: name, deleted: true, secretsDeleted: counted ? count : null },
      () =>
        console.log(
          counted
            ? `Deleted ${name} and ${count} secret${count === 1 ? '' : 's'}.`
            : `Deleted ${name}.`,
        ),
    )
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
