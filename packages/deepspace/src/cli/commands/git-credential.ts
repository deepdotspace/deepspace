/**
 * `deepspace git-credential` — a standard git credential helper.
 *
 * `ensureSpaceRemote` installs it host-scoped
 * (`credential.<scheme>://<host>.helper`), so once any sync command has run,
 * plain `git push space` / `git fetch space` work in any terminal: git asks
 * this helper, and it answers with the logged-in DeepSpace bearer token as
 * the password (the server ignores the username).
 *
 * Protocol (git-credential(7)): the op arrives as argv (`get`/`store`/
 * `erase`), the request as `key=value` lines on stdin up to a blank line,
 * and the answer as `key=value` lines on stdout. This helper never prompts,
 * never logs the token, and always exits 0 — for a non-DeepSpace host or a
 * logged-out user its STDOUT stays silent so git falls through to its other
 * helpers (or fails the request with the server's 401). A declined `get`
 * leaves a one-line stderr breadcrumb, because the downstream git failure
 * ("could not read Username") never says WHY no credentials came back.
 */

import { defineCommand } from 'citty'
import { ensureToken } from '../auth'
import { deployBaseUrl } from '../lib/vc-remote'
import { MAX_STDIN_BYTES, readStreamText } from '../lib/stdio'

function parseFields(input: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of input.split('\n')) {
    if (line === '') break // blank line terminates the request
    const eq = line.indexOf('=')
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return fields
}

/** Does the credential request target the deploy worker (scheme + host,
 *  port included — a localhost override carries one)? */
export function credentialHostMatches(input: string, deployUrl: string): boolean {
  let base: URL
  try {
    base = new URL(deployUrl)
  } catch {
    return false
  }
  const fields = parseFields(input)
  if (fields.get('host') !== base.host) return false
  // Fail closed on a missing protocol: git always sends one for HTTP remotes,
  // so its absence is anomalous — never hand a token to an unspecified scheme.
  const protocol = fields.get('protocol')
  return `${protocol}:` === base.protocol
}

/**
 * The helper's pure core: the exact stdout for one request. Empty string ⇒
 * print nothing (foreign host, store/erase, or no token available).
 */
export function respondCredential(
  op: string,
  input: string,
  token: string | null,
  deployUrl: string,
): string {
  if (op !== 'get' || !token) return ''
  if (!credentialHostMatches(input, deployUrl)) return ''
  // Username is ignored by the server; "deepspace" by convention.
  return `username=deepspace\npassword=${token}\n`
}

/**
 * The stderr line for a declined `get` (empty string ⇒ nothing to say).
 * The helper is installed host-scoped, so a mismatch means the remote's host
 * WAS a deploy service when it was configured but the current environment
 * points elsewhere — name both so the fix (usually DEEPSPACE_DEPLOY_URL) is
 * self-evident. Never includes the token; stdout stays untouched.
 */
export function declineHint(
  op: string,
  input: string,
  token: string | null,
  deployUrl: string,
): string {
  if (op !== 'get') return ''
  const host = parseFields(input).get('host')
  if (!host) return ''
  if (!credentialHostMatches(input, deployUrl)) {
    return `deepspace git-credential: no credentials for ${host} — the current deploy service is ${deployUrl}. If ${host} is your deploy service, export DEEPSPACE_DEPLOY_URL to match.\n`
  }
  if (!token) {
    return 'deepspace git-credential: not logged in (or the session could not be refreshed) — run `deepspace auth login`.\n'
  }
  return ''
}

export default defineCommand({
  meta: {
    name: 'git-credential',
    description: 'Git credential helper (installed automatically; not for direct use)',
  },
  args: {
    op: {
      type: 'positional',
      description: 'Credential operation: get, store, or erase',
      required: false,
    },
  },
  async run({ args }) {
    const op = String(args.op ?? '')
    // Git always pipes the request; a bare interactive invocation gets an
    // empty request instead of a hung read.
    const input = process.stdin.isTTY ? '' : await readStreamText(process.stdin, MAX_STDIN_BYTES)
    // store/erase are silent no-ops — the token lives in ~/.deepspace, not in
    // git's credential storage.
    if (op !== 'get') return
    const url = deployBaseUrl()
    // Only touch auth for our own host: a foreign host must get an instant
    // empty answer, not a token-refresh round-trip.
    let token: string | null = null
    if (credentialHostMatches(input, url)) {
      try {
        token = await ensureToken()
      } catch {
        // Not logged in / session expired — stay silent (see header).
      }
    }
    const out = respondCredential(op, input, token, url)
    if (out) {
      process.stdout.write(out)
    } else {
      const hint = declineHint(op, input, token, url)
      if (hint) process.stderr.write(hint)
    }
  },
})
