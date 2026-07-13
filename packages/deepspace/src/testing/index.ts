/**
 * `deepspace/testing` — Playwright helpers for multi-user / multiplayer
 * tests against DeepSpace apps.
 *
 * Public surface:
 *   - `test`, `expect` — Playwright re-exports with a `users` fixture
 *   - `MultiplayerUser`, `UsersFixture` — types
 *   - `loadAllTestAccounts`, `pickTestAccounts`, `findTestAccountByName`
 *     — escape hatches for suites that need to bypass the fixture
 *   - `ensureStorageState`, `newSignedInContext` — single-user storage-state
 *     cache helpers (used internally by the fixture)
 *
 * See `docs/guides/multi-user-tests.md` for usage and pre-creation
 * instructions.
 */

export { test, expect } from './fixtures'
export type { MultiplayerUser, UsersFixture } from './fixtures'

export {
  loadAllTestAccounts,
  pickTestAccounts,
  findTestAccountByName,
} from './accounts'
export type { TestAccount } from './accounts'

export {
  ensureStorageState,
  newSignedInContext,
  getStatePathForEmail,
  readCachedState,
} from './storage-state'
export type { EnsureStorageStateOptions } from './storage-state'
