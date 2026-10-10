import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ID_ADOPTION_EDITS, APP_ID_ADOPTION_TOGETHER } from '../../../build/app-id'
import {
  ACTION_ROUTES_BEARER_GUARD_MIGRATION_ID,
  ACTION_TOOLS_DELETE_WHERE_MIGRATION_ID,
  AGENT_TOOL_CONTEXT_MIGRATION_ID,
  AI_SDK_7_MIGRATION_ID,
  BUILD_INJECTED_APP_ID_MIGRATION_ID,
  FILES_SESSION_COOKIE_READS_MIGRATION_ID,
  INTEGRATIONS_SIGN_IN_MIGRATION_ID,
  SECURE_ROOM_BOUNDARIES_MIGRATION_ID,
  WORKER_OWNED_NOT_FOUND_MIGRATION_ID,
  validateAppMigrationIds,
} from '../../../shared/protocol/app-migrations'
import { Refusal } from '../../lib/command'

export const APP_MIGRATIONS_MANIFEST = 'deepspace.migrations.json'

/**
 * Source migrations are app-owned changes, so the CLI describes them instead
 * of guessing at arbitrary repository files. After applying and validating a
 * change, the developer records its id in the app's migration manifest.
 */
export interface AppMigrationGuidance {
  id: string
  description: string
  files: readonly string[]
  guidance: string
}

export const APP_MIGRATION_GUIDANCE: readonly AppMigrationGuidance[] = [
  {
    id: WORKER_OWNED_NOT_FOUND_MIGRATION_ID,
    description: 'Let the worker answer misses, so deleted files 404 instead of serving HTML',
    files: ['wrangler.toml', 'worker.ts or the app-owned HTTP route file'],
    guidance:
      'Set assets.not_found_handling to "none". In the worker asset fallback, return 404 when the last path segment names a file (contains a dot), and fetch "/" for client routes instead of "/index.html".',
  },
  {
    id: SECURE_ROOM_BOUNDARIES_MIGRATION_ID,
    description: 'Secure room identity, job mutations, and production debug routes',
    files: ['app-owned room proxy', 'AppJobRoom', 'debug-route handler'],
    guidance:
      'Forward verified room identity with authenticatedRoomRequest() rather than URL query parameters. Give AppJobRoom an authorizeWrite role check, and require verified admin access inside enabled debug routes.',
  },
  {
    id: ACTION_TOOLS_DELETE_WHERE_MIGRATION_ID,
    description: 'Add the deleteWhere method required by ActionTools',
    files: ['src/server/action-routes.ts, when the app has an ActionTools factory'],
    guidance:
      "Add `deleteWhere: (collection, where, limit) => execTool('records.deleteWhere', { collection, where, limit })` to the object returned as ActionTools. If the app has no ActionTools factory, record this migration as not applicable.",
  },
  {
    id: BUILD_INJECTED_APP_ID_MIGRATION_ID,
    description: "Read the browser's app id from the wrangler config selected for the build",
    files: ['src/constants.ts', 'vite.config.ts', 'vitest.config.ts when present'],
    guidance: `${APP_ID_ADOPTION_EDITS['src/constants.ts']} ${APP_ID_ADOPTION_EDITS['vite.config.ts']} ${APP_ID_ADOPTION_EDITS['vitest.config.ts']} ${APP_ID_ADOPTION_TOGETHER}`,
  },
  {
    id: ACTION_ROUTES_BEARER_GUARD_MIGRATION_ID,
    description: 'Refuse action calls without a bearer token and document their trust boundary',
    files: ['src/server/action-routes.ts, when the app has server actions'],
    guidance:
      "After resolveAuth, read `const authHeader = c.req.header('Authorization') ?? ''`, accept only its `Bearer ` token, and return 401 when absent. Document that X-App-Action bypasses per-record RBAC, so each action must authorize record ownership itself. If the app has no server action route, record this migration as not applicable.",
  },
  {
    id: FILES_SESSION_COOKIE_READS_MIGRATION_ID,
    description: 'Let private file URLs render in <img>/<audio>/<video> for the signed-in user',
    files: ['the app-owned HTTP route file that proxies /api/files/*'],
    guidance:
      "In the /api/files/* proxy only, replace `const auth = await resolveAuth(c.req.raw, c.env)` with `const auth = (await resolveAuth(c.req.raw, c.env)) ?? (await resolveSessionReadAuth(c.req.raw, c.env))`, importing resolveSessionReadAuth from 'deepspace/worker'. It identifies same-origin GET/HEAD by the app-origin session cookie and returns null for everything else. Do not add it to resolveAuth, which also gates writes. In the same route, skip the JSON URL rewrite for HEAD: change `if (contentType.includes('application/json'))` to `if (contentType.includes('application/json') && c.req.method !== 'HEAD')`, because a HEAD answer carries the content-type but no body and parsing it would turn every failed media probe into a 500.",
  },
  {
    id: AI_SDK_7_MIGRATION_ID,
    description: "Move the app's own AI code to AI SDK 7",
    files: ['src/ai/chat-routes.ts', 'every other file importing from "ai"'],
    guidance:
      "Run `npx @ai-sdk/codemod v7 src` and review its diff: it renames `system` to `instructions` in ANY object, including non-AI-SDK request bodies, so revert those. Then by hand: in the chat route's `onEnd` (formerly `onFinish`), persist `responseMessages` — `response.messages` now holds only the final step, which drops earlier tool calls — and since `onEnd` no longer runs after an abort, also persist in `onAbort({ steps })` from the completed steps' `response.messages`. Replace `result.toUIMessageStreamResponse(options)` with `createUIMessageStreamResponse({ headers, stream: toUIMessageStream({ stream: result.stream, ...options }) })` imported from 'ai'. A tool's `execute` options now include `context`. `role: 'system'` messages inside `messages` are rejected unless the call sets `allowSystemInMessages: true`.",
  },
  {
    id: INTEGRATIONS_SIGN_IN_MIGRATION_ID,
    description: "Stop signed-out visitors from calling integrations billed to the app owner",
    files: ['src/server/http-routes.ts', 'src/integrations.ts'],
    guidance:
      "In the /api/integrations/:name/:endpoint proxy, read `const config = integrations[integrationName]` and change the sign-in check from `if (!auth && billingMode === 'user')` to `if (!auth && (billingMode === 'user' || !config?.anonymous))`. In src/integrations.ts, add `anonymous?: boolean` to the config type. Every integration then needs sign-in; set `anonymous: true` only on a 'developer' integration that signed-out visitors must reach, knowing the owner pays for their calls.",
  },
  {
    id: AGENT_TOOL_CONTEXT_MIGRATION_ID,
    description: "Give the app's tools the request's env and caller, and let the app choose each caller's room",
    files: ['src/ai/agent.ts', 'src/ai/chat-routes.ts'],
    guidance:
      "Optional; nothing breaks without it. The executor passed to `buildTools` now returns whole record results, and `streamDeepSpaceAgent` and the local agent route cap each tool's result for the model instead, so existing tools stay bounded. To give tools the request: in both files, replace `type ToolFactory = typeof buildTools` with `type ToolFactory = AgentToolRouteOptions<Env>['buildTools']`, importing `AgentToolRouteOptions` from 'deepspace/worker'. In chat-routes.ts, pass `{ env: c.env, userId: auth.userId, request: c.req.raw }` as the second argument where it calls `buildTools(createUserToolExecutor(...))`; the local agent route already passes it. A tool then declares `buildTools(executor, context)` and uses `context.env` (for example `appFiles(context.env, { scope: 'self', userId: context.userId })`). Only for an app that keeps a record room per user or team: add `room?: (userId: string, env: Env) => string` to RegisterAgentOptions in agent.ts; in createAccessResolver compute `const room = options.room?.(auth.userId, env)`, pass `{ room }` as the fourth argument of `resolveAppMembership`, and return `{ ok: true, auth, room }`. The local agent route then runs tools in that room. In chat-routes.ts, have `requireAccess` return the whole grant (`if (access.ok) return access`), read `const { auth } = access` in each route, and pass `{ room: access.room }` as the fourth argument of `createUserToolExecutor`.",
  },
]

export const APP_MIGRATION_DEFINITIONS = APP_MIGRATION_GUIDANCE.map(({ id, description }) => ({
  id,
  description,
}))

/** Read the provider-neutral migration ledger shipped with an app bundle. */
export function readAppliedAppMigrations(appDir: string): string[] {
  const path = join(appDir, APP_MIGRATIONS_MANIFEST)
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Refusal(
      `${APP_MIGRATIONS_MANIFEST} must contain valid JSON`,
      'invalid_migration_manifest',
    )
  }
  const validation = validateAppMigrationIds(parsed)
  if (!validation.valid) {
    throw new Refusal(
      `${APP_MIGRATIONS_MANIFEST}: ${validation.reason}`,
      'invalid_migration_manifest',
    )
  }
  return validation.ids
}

/** The guidance still outstanding according to the app-owned ledger. */
export function pendingAppMigrationGuidance(appDir: string): AppMigrationGuidance[] {
  const applied = new Set(readAppliedAppMigrations(appDir))
  return APP_MIGRATION_GUIDANCE.filter(({ id }) => !applied.has(id))
}
