/**
 * Better Auth configuration factory for DeepSpace
 *
 * Provides pre-configured Better Auth instances for Cloudflare Workers + D1.
 */

import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { loggableError } from '../../shared/log-events'
import { organization, twoFactor } from 'better-auth/plugins'
import { SignJWT, importPKCS8 } from 'jose'

export interface DeepSpaceAuthConfig {
  /** D1 database binding */
  database: D1Database
  /** Base URL for the auth worker (e.g. "https://auth.deep.space") */
  baseURL: string
  /** Secret for session signing */
  secret: string
  /** Google OAuth credentials (optional) */
  google?: { clientId: string; clientSecret: string }
  /** GitHub OAuth credentials (optional) */
  github?: { clientId: string; clientSecret: string }
  /** Microsoft (Entra ID) OAuth credentials (optional) */
  microsoft?: { clientId: string; clientSecret: string }
  /**
   * Apple (Sign in with Apple) credentials (optional). Pass the raw
   * Sign-in-with-Apple key material; the ES256 client-secret JWT is minted
   * on demand, so there is no six-month token to rotate by hand.
   */
  apple?: { clientId: string; teamId: string; keyId: string; privateKey: string }
  /** Enable email/password authentication */
  emailAndPassword?: boolean
  /** Trusted origins for CORS */
  trustedOrigins?: string[]
  /**
   * Called after a new user row is created (any flow: social OAuth callback,
   * email/password, server-side `auth.api.signUpEmail`). When the signup came
   * in over HTTP, `ctx.request` exposes the inbound request; some better-auth
   * entry points carry standalone `ctx.headers` instead of (or as well as) a
   * request, so both are forwarded. For server-side creations (`auth.api.*`
   * calls) an endpoint context usually still exists but may carry NEITHER —
   * guard every field.
   *
   * Better Auth awaits `user.create.after` hooks inline before the response
   * is sent, so keep this cheap (e.g. a single D1 write) and hand slow work
   * to `ctx.waitUntil` at the call site. Exceptions are caught and logged so
   * a failing observer can never break signup itself.
   */
  onUserCreated?: (
    user: { id: string; email: string; name: string },
    ctx: { request?: Request; headers?: Headers } | null,
  ) => Promise<void>
}

/**
 * Create a Better Auth instance configured for DeepSpace.
 *
 * This is called per-request in the auth worker since D1 bindings
 * are request-scoped in Cloudflare Workers.
 */
/**
 * A static `{ clientId, clientSecret }` provider config, or an async resolver
 * that returns one (Apple mints its client secret on demand). The union keeps
 * the static google/github/microsoft assignments type-checked while allowing
 * Apple's function form, which better-auth's own types don't model.
 */
type SocialProviderConfig =
  | { clientId: string; clientSecret: string }
  | (() => Promise<{ clientId: string; clientSecret: string }>)

export function createDeepSpaceAuth(config: DeepSpaceAuthConfig) {
  const socialProviders: Record<string, SocialProviderConfig> = {}

  if (config.google) {
    socialProviders.google = config.google
  }
  if (config.github) {
    socialProviders.github = config.github
  }
  if (config.microsoft) {
    socialProviders.microsoft = config.microsoft
  }
  if (config.apple) {
    const apple = config.apple
    // better-auth resolves every social provider's config in one Promise.all
    // when it builds its request context, so an exception here rejects the
    // whole context and 500s *all* auth flows — not just Apple. Mint the fresh
    // client-secret JWT (we sign on demand rather than store a rotating token)
    // inside try/catch so a bad Apple key degrades to "Apple unavailable"
    // instead of taking Google/GitHub/Microsoft/password down with it.
    socialProviders.apple = async () => {
      try {
        return { clientId: apple.clientId, clientSecret: await generateAppleClientSecret(apple) }
      } catch (err) {
        console.error(
          `[deepspace] failed to mint Apple client secret; Apple sign-in disabled: ${loggableError(err)}`,
        )
        return { clientId: apple.clientId, clientSecret: '' }
      }
    }
  }

  return betterAuth({
    database: config.database,
    baseURL: config.baseURL,
    secret: config.secret,
    // Login is a one-time human act; everything after it is agents minting
    // short-lived JWTs from this session. 30 days idle (vs the 7-day
    // default) with daily sliding renewal means any agent active within a
    // month keeps the session alive indefinitely — the human re-logs-in
    // only after a full month of zero activity. Short-lived access stays
    // short: CLI JWTs expire in minutes (auth-worker /api/auth/token).
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    emailAndPassword: {
      enabled: config.emailAndPassword ?? true,
    },
    socialProviders: socialProviders as Parameters<typeof betterAuth>[0]['socialProviders'],
    trustedOrigins: config.trustedOrigins ?? [
      'https://deep.space',
      'https://*.deep.space',
      'https://*.app.space',
      'http://localhost:*',
      // Apple posts its OAuth callback from this origin (form_post).
      'https://appleid.apple.com',
    ],
    // Apple returns its callback as a cross-site form_post, which a
    // SameSite=Lax cookie won't ride along with — so the OAuth handshake
    // cookie must be SameSite=None. Scoped to just that cookie; the session
    // cookie stays Lax. Gated on Apple being configured: deployments without
    // Apple keep Lax entirely. Note that when Apple IS configured, this also
    // relaxes the handshake cookie for Google/GitHub/Microsoft on the same
    // instance — which is safe, since the state is encrypted and verified
    // independently of SameSite (plus a separate per-flow CSRF cookie).
    ...(config.apple
      ? {
          advanced: {
            cookies: {
              state: { attributes: { sameSite: 'none' as const, secure: true } },
              oauth_state: { attributes: { sameSite: 'none' as const, secure: true } },
            },
          },
        }
      : {}),
    // Observer hook for new-user creation (see DeepSpaceAuthConfig.onUserCreated).
    // Two-layer wiring guard — be honest about what each layer catches:
    //  1. buildDatabaseHooks's return type is pinned to
    //     BetterAuthOptions['databaseHooks'], so a better-auth upgrade that
    //     renames/reshapes the option fails tsc.
    //  2. A LOCAL typo of this key would still compile (betterAuth's generic
    //     options parameter defeats excess-property checking even for plain
    //     keys) — that case is caught by the runtime assertions in
    //     __tests__/betterAuth-hooks.test.ts, which read the wired hook back
    //     off auth.options. Don't rename the key without running them.
    databaseHooks: buildDatabaseHooks(config.onUserCreated),
    plugins: [organization(), twoFactor()],
  })
}

/**
 * Wire onUserCreated into better-auth's user.create.after hook. The wrapper
 * try/catches so a throwing observer can't fail the signup — better-auth
 * awaits `after` hooks inline before responding. Returns undefined when no
 * observer is configured (better-auth treats that as "no hooks").
 */
function buildDatabaseHooks(
  onUserCreated: DeepSpaceAuthConfig['onUserCreated'],
): BetterAuthOptions['databaseHooks'] {
  if (!onUserCreated) return undefined
  return {
    user: {
      create: {
        after: async (user, ctx) => {
          try {
            await onUserCreated(
              { id: user.id, email: user.email, name: user.name },
              // Forward BOTH request and standalone headers — some better-auth
              // entry points populate ctx.headers without a request.
              ctx ? { request: ctx.request, headers: ctx.headers ?? undefined } : null,
            )
          } catch (err) {
            console.error(
              `[deepspace] onUserCreated hook failed (signup unaffected): ${loggableError(err)}`,
            )
          }
        },
      },
    },
  }
}

/**
 * Mint the "Sign in with Apple" client-secret JWT (ES256) from the
 * downloaded .p8 key. Apple caps the lifetime at six months; we use ~180
 * days and re-mint on demand, so nothing has to be rotated manually.
 */
// Isolate-level cache of the minted Apple client secret. Apple permits
// reusing a client secret for up to six months, but better-auth resolves the
// provider config on every /api/auth/* context build — so without this we'd
// importPKCS8 + ES256-sign on every auth request, including non-Apple ones.
let cachedAppleSecret: { keyId: string; token: string; expiresAt: number } | null = null

async function generateAppleClientSecret(apple: {
  clientId: string
  teamId: string
  keyId: string
  privateKey: string
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  // Reuse until an hour before expiry; re-mint if the signing key rotates.
  if (
    cachedAppleSecret &&
    cachedAppleSecret.keyId === apple.keyId &&
    cachedAppleSecret.expiresAt - now > 3600
  ) {
    return cachedAppleSecret.token
  }
  // PEM secrets in this stack are stored with escaped newlines (mirrors the
  // JWT_PRIVATE_KEY handling in the auth worker); normalize before importPKCS8
  // so an escaped-newline key doesn't throw. No-op for real-newline keys.
  const pem = apple.privateKey.replace(/\\n/g, '\n')
  const key = await importPKCS8(pem, 'ES256')
  const expiresAt = now + 180 * 24 * 60 * 60
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: apple.keyId })
    .setIssuer(apple.teamId)
    .setSubject(apple.clientId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(key)
  cachedAppleSecret = { keyId: apple.keyId, token, expiresAt }
  return token
}

export type DeepSpaceAuth = ReturnType<typeof createDeepSpaceAuth>
