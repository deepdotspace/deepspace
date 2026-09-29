/**
 * Wire contract between the SDK's sandbox helpers (server/utils/sandbox.ts)
 * and the api-worker proxy that records who owns each Anthropic
 * code-execution file and container.
 */

/**
 * Who may use a file or container the request creates:
 * - `user` (default): only the JWT subject, inside the calling app.
 * - `app`: any caller of the same app (shared workspaces, owner-billed
 *   background turns continuing a user's conversation).
 * Another app can never use either.
 */
export const SANDBOX_SCOPES = ['user', 'app'] as const
export type SandboxScope = (typeof SANDBOX_SCOPES)[number]

/** Request header carrying the {@link SandboxScope} for resources a request creates. */
export const SANDBOX_SCOPE_HEADER = 'x-deepspace-sandbox-scope'
