/**
 * Per-account `storageState` cache for Playwright.
 *
 * Better Auth applies a per-IP rate limit on `/api/auth/sign-in/email`
 * (~5 sign-ins / 60s / endpoint). A multiplayer suite that spins up
 * 5+ users per spec would hit the limit and start failing in non-obvious
 * ways. This module signs each account in *once*, persists the
 * resulting browser cookies + storage to disk, and reuses the file on
 * subsequent runs.
 *
 * Cache layout:
 *   ~/.deepspace/playwright-states/<sha256(authScope, appOrigin, email)>.json
 *
 * Validity: a cached file is reused if Playwright successfully loads it
 * AND the resulting context produces a non-anonymous session on the
 * target app. If validation fails, we fall back to a fresh sign-in and
 * overwrite the cache.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { request, type Browser, type BrowserContext } from '@playwright/test'
import { decodeJwtPayload } from '../shared/jwt'
import { currentTestAccountScope } from './accounts'

const STATES_DIR = join(homedir(), '.deepspace', 'playwright-states')

/**
 * Validation/sign-in per state path, in flight or settled. Memoizing the
 * promise — rather than flagging a Set after the await — makes concurrent
 * callers for the same account share one probe/sign-in instead of racing
 * duplicate sign-ins into the rate limit. A rejected attempt is evicted so
 * a later call can retry.
 */
const stateValidations = new Map<string, Promise<string>>()

interface StorageStateAccount {
  email: string
  password: string
  /** Remote user id, when the local registry knows it. */
  userId?: string
}

/** Where the cache for `email` against `baseURL`'s origin lives. */
export function getStatePathForEmail(email: string, baseURL: string): string {
  // Keyed by auth scope + app origin + email: one email signed into two
  // apps (or two auth environments) must never serve the wrong session.
  const key = `${currentTestAccountScope()}\n${new URL(baseURL).origin}\n${email.trim().toLowerCase()}`
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 24)
  return join(STATES_DIR, `${hash}.json`)
}

function ensureStatesDir() {
  if (!existsSync(STATES_DIR)) mkdirSync(STATES_DIR, { recursive: true })
}

/**
 * Does a token minted from a cached session belong to `account`? `sub` is
 * authoritative when the registry knows the remote user id; the `email`
 * claim covers states recorded before the id was known.
 */
export function tokenClaimsMatchAccount(
  claims: Record<string, unknown>,
  account: { email: string; userId?: string },
): boolean {
  if (account.userId && claims.sub === account.userId) return true
  return (
    typeof claims.email === 'string' &&
    claims.email.trim().toLowerCase() === account.email.trim().toLowerCase()
  )
}

/**
 * Live-validate a cached state: load it into a request context and ask the
 * app to mint a token. Only a token for this account counts — a transport
 * failure, an anonymous session, or another user's session all report
 * false, so the caller signs in fresh (where a real outage surfaces as an
 * actionable sign-in error instead of silent reuse of a dead session).
 */
async function probeStoredSession(
  path: string,
  baseURL: string,
  account: { email: string; userId?: string },
): Promise<boolean> {
  try {
    const ctx = await request.newContext({ storageState: path, baseURL })
    try {
      const res = await ctx.post('/api/auth/token')
      if (!res.ok()) return false
      const { token } = (await res.json()) as { token?: unknown }
      if (typeof token !== 'string') return false
      return tokenClaimsMatchAccount(decodeJwtPayload(token), account)
    } finally {
      await ctx.dispose()
    }
  } catch {
    return false
  }
}

/**
 * Sign `account` in by POSTing `/api/auth/sign-in/email` against
 * `baseURL` and capturing the resulting cookies. Returns the path to the
 * Playwright `storageState` JSON file.
 *
 * The browser-driven approach is intentional: we want the cookies set
 * on the same origin Playwright contexts will load from, otherwise the
 * Set-Cookie domain attribute won't match.
 */
async function signInAndSaveState(
  browser: Browser,
  account: { email: string; password: string },
  baseURL: string,
  outPath: string,
): Promise<string> {
  ensureStatesDir()
  const ctx = await browser.newContext({ baseURL })
  try {
    const page = await ctx.newPage()
    // Hit the app first so the origin is established (some auth plugins
    // require a same-origin Origin header on sign-in).
    await page.goto('/')
    const result = await page.evaluate(
      async ({ email, password }: { email: string; password: string }) => {
        const res = await fetch('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })
        const body: unknown = await res.json().catch(() => null)
        const error = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
        return {
          ok: res.ok,
          status: res.status,
          code: typeof error?.code === 'string' ? error.code : null,
          message: typeof error?.message === 'string' ? error.message : null,
        }
      },
      { email: account.email, password: account.password },
    )
    if (!result.ok) throw new Error(formatSignInFailure(account.email, result))
    await ctx.storageState({ path: outPath })
    return outPath
  } finally {
    await ctx.close()
  }
}

interface SignInFailure {
  status: number
  code: string | null
  message: string | null
}

/** Keep the server's safe status/code so auth failures remain actionable. */
export function formatSignInFailure(email: string, failure: SignInFailure): string {
  const code = failure.code ? ` ${failure.code}` : ''
  const detail = failure.message ? `: ${failure.message}` : ''
  const nextStep =
    failure.code === 'INVALID_ORIGIN'
      ? 'Add this app origin to the auth allowlist, then retry.'
      : 'Check the stored credential or recreate the account with `deepspace test accounts create`.'
  return `Sign-in failed for ${email} (HTTP ${failure.status}${code})${detail}. ${nextStep}`
}

export interface EnsureStorageStateOptions {
  /** Force a fresh sign-in even if a cached state validates. */
  force?: boolean
}

/**
 * Ensure a validated Playwright `storageState` file exists for `account`
 * and return its path. A cached file is probed against the app before
 * reuse (once per worker process); a missing, expired, or wrong-account
 * state triggers one fresh sign-in that overwrites it.
 */
export async function ensureStorageState(
  browser: Browser,
  account: StorageStateAccount,
  baseURL: string,
  options: EnsureStorageStateOptions = {},
): Promise<string> {
  const path = getStatePathForEmail(account.email, baseURL)
  if (options.force) stateValidations.delete(path)
  let pending = stateValidations.get(path)
  if (!pending) {
    pending = validateOrSignIn(browser, account, baseURL, path, options.force === true)
    stateValidations.set(path, pending)
    pending.catch(() => stateValidations.delete(path))
  }
  return pending
}

async function validateOrSignIn(
  browser: Browser,
  account: StorageStateAccount,
  baseURL: string,
  path: string,
  force: boolean,
): Promise<string> {
  if (!force && existsSync(path) && (await probeStoredSession(path, baseURL, account))) {
    return path
  }
  return signInAndSaveState(browser, account, baseURL, path)
}

/**
 * Convenience: open a fresh `BrowserContext` for `account` using the
 * cached storage state (signing in if needed). The caller is responsible
 * for closing the context.
 */
export async function newSignedInContext(
  browser: Browser,
  account: StorageStateAccount,
  baseURL: string,
  options: EnsureStorageStateOptions = {},
): Promise<BrowserContext> {
  const statePath = await ensureStorageState(browser, account, baseURL, options)
  return browser.newContext({ storageState: statePath, baseURL })
}
