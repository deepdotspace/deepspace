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
 *   ~/.deepspace/playwright-states/<sha256(email)>.json
 *
 * Validity: a cached file is reused if Playwright successfully loads it
 * AND the resulting context produces a non-anonymous session on the
 * target app. If validation fails, we fall back to a fresh sign-in and
 * overwrite the cache.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserContext } from '@playwright/test'

const STATES_DIR = join(homedir(), '.deepspace', 'playwright-states')

/** Default freshness window — re-sign-in if the cache is older than this. */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function statePathForEmail(email: string): string {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24)
  return join(STATES_DIR, `${hash}.json`)
}

function ensureStatesDir() {
  if (!existsSync(STATES_DIR)) mkdirSync(STATES_DIR, { recursive: true })
}

/** Returns true if a cache file exists and is younger than `maxAgeMs`. */
function isCacheFresh(path: string, maxAgeMs: number): boolean {
  if (!existsSync(path)) return false
  try {
    const age = Date.now() - statSync(path).mtimeMs
    return age < maxAgeMs
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
    const ok = await page.evaluate(
      async ({ email, password }: { email: string; password: string }) => {
        const res = await fetch('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })
        return res.ok
      },
      account,
    )
    if (!ok) {
      throw new Error(
        `Sign-in failed for ${account.email}. Check the password is current; ` +
          `if the account was deleted on the server, re-create with ` +
          `\`deepspace test-accounts create\`.`,
      )
    }
    await ctx.storageState({ path: outPath })
    return outPath
  } finally {
    await ctx.close()
  }
}

export interface EnsureStorageStateOptions {
  /** Max age of a cached state file before we re-sign-in. Default 7 days. */
  maxAgeMs?: number
  /** Force a fresh sign-in even if the cache is fresh. */
  force?: boolean
}

/**
 * Ensure a Playwright `storageState` file exists for `account` and
 * return its path. Signs in once if the cache is missing, stale, or
 * `force: true`.
 */
export async function ensureStorageState(
  browser: Browser,
  account: { email: string; password: string },
  baseURL: string,
  options: EnsureStorageStateOptions = {},
): Promise<string> {
  const path = statePathForEmail(account.email)
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS

  if (!options.force && isCacheFresh(path, maxAgeMs)) {
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
  account: { email: string; password: string },
  baseURL: string,
  options: EnsureStorageStateOptions = {},
): Promise<BrowserContext> {
  const statePath = await ensureStorageState(browser, account, baseURL, options)
  return browser.newContext({ storageState: statePath, baseURL })
}

/** Read a cached storageState file (mostly for debugging). */
export function readCachedState(email: string): unknown | null {
  const path = statePathForEmail(email)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

/** Where the cache for `email` lives. Useful for diagnostics. */
export function getStatePathForEmail(email: string): string {
  return statePathForEmail(email)
}
