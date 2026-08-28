/**
 * One coordinator for the generated app's two assistant surfaces:
 *
 * - the in-app assistant is the website AI chat UI;
 * - the local assistant is the user's Codex, Claude, or similar client.
 *
 * The CLI only bridges a local assistant to these Worker routes. It does not
 * authorize or host either assistant.
 */

import type { Hono } from 'hono'
import { registerAgentToolRoutes, resolveAppMembership } from 'deepspace/worker'
import type { AgentToolAccessResult, JwtClaims } from 'deepspace/worker'
import type { buildTools } from './tools.js'
import { registerAiChatRoutes } from './chat-routes.js'
import { resolveAgentAuth, resolveAuth } from '../server/http-routes.js'
import type { AppContext, Env } from '../../worker.js'

type ToolFactory = typeof buildTools

export interface AgentAuthorizationContext {
  userId: string
  claims: JwtClaims
  request: Request
  env: Env
}

export interface RegisterAgentOptions {
  /** The existing app-owned tool factory from src/ai/tools.ts. */
  tools: ToolFactory
  /** Enable the website AI chat UI. Defaults to true. */
  inApp?: boolean
  /** Enable the user's local Codex/Claude/etc. assistant. Defaults to true. */
  local?: boolean
  /**
   * Optional app-specific gate for subscriptions, teams, roles, or app data.
   * It only narrows access after verified identity and app membership succeed.
   */
  authorize?: (context: AgentAuthorizationContext) => boolean | Promise<boolean>
}

function createAccessResolver(options: RegisterAgentOptions, resolveIdentity: typeof resolveAuth) {
  return async (request: Request, env: Env): Promise<AgentToolAccessResult> => {
    const auth = await resolveIdentity(request, env)
    if (!auth) return { ok: false, status: 401 }

    // Membership has exactly one definition — the caller's row in this app's
    // canonical users collection (the owner is always a member). It is the
    // same primitive that gates the admin and realtime routes. A membership
    // read that could not complete is 503 (retryable), never 403: a transient
    // room failure must not present as a permission denial.
    const membership = await resolveAppMembership(env, auth.userId, request.signal)
    if (!membership) return { ok: false, status: 503 }
    if (!membership.member) return { ok: false, status: 403 }

    if (options.authorize) {
      try {
        if (
          !(await options.authorize({ userId: auth.userId, claims: auth.claims, request, env }))
        ) {
          return { ok: false, status: 403 }
        }
      } catch {
        // The callback failed rather than denied — fail closed but retryable.
        return { ok: false, status: 503 }
      }
    }

    return { ok: true, auth }
  }
}

/**
 * Register generated app assistant routes with one authorization policy for
 * both the website AI and the local assistant. The CLI is only their bridge.
 */
export function registerAgent(app: Hono<AppContext>, options: RegisterAgentOptions): void {
  if (options.inApp !== false) {
    registerAiChatRoutes(app, createAccessResolver(options, resolveAuth), options.tools)
  }
  if (options.local !== false) {
    registerAgentToolRoutes(app, {
      buildTools: options.tools,
      resolveAccess: createAccessResolver(options, resolveAgentAuth),
    })
  }
}
