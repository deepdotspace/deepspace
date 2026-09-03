/**
 * Platform API error normalization — the one chokepoint that turns the
 * api-worker's error envelope into a render-safe + branch-safe shape.
 *
 * The platform emits errors as `{ error: <machine slug>, message?: <human>,
 * ...details }` (e.g. 402 `{ error: 'insufficient_credits', message:
 * 'Insufficient credits.', availableCredits, requiredCredits }`; some routes
 * send the bare slug with no `message` at all, e.g. 409
 * `{ error: 'owner_connect_not_ready' }`). Consumers must never show the slug
 * to a person or make an agent parse the sentence — this module separates the
 * two once, for the integration client, server actions, billing hooks, and the
 * CLI.
 */

/** One structured validation issue (Zod shape) from a `validation_failed` response. */
export interface ApiErrorIssue {
  path?: string[]
  message: string
  code?: string
}

/** A platform error response, normalized. */
export interface NormalizedApiError {
  /**
   * Human-readable text, safe to render:
   * `message ?? non-slug error ?? humanized(slug) ?? slug`.
   */
  error: string
  /** The machine slug (e.g. 'insufficient_credits') for branching — never render it. */
  code?: string
  /** HTTP status of the response; 0 when no HTTP response arrived (transport failure). */
  status: number
  /** Structured fields the server sent alongside the error (e.g. `availableCredits`). */
  details?: Record<string, unknown>
  /** Zod issues accompanying a `validation_failed` response. */
  issues?: ApiErrorIssue[]
}

// A machine slug: lowercase alphanumeric segments joined by `_`, `.`, or `-`.
// Rejects human sentences ("Unknown integration: openai/foo") so they pass
// through as the error text rather than masquerading as a code.
const SLUG_RE = /^[a-z0-9]+(?:[_.-][a-z0-9]+)*$/

// Human text for the slugs the platform emits without (or before) a `message`
// of their own. Unknown slugs fall through to the raw message/slug unchanged.
const HUMAN_MESSAGES: Record<string, string> = {
  owner_connect_not_ready:
    "This app isn't ready to accept payments yet — the app owner needs to finish payment setup.",
  invalid_json: 'The request body was not valid JSON.',
  invalid_body: 'The request body is invalid.',
  invalid_product_id: 'Invalid product id.',
  duplicate_product_id: 'Duplicate product id.',
  unknown_product: 'Unknown product.',
  too_many_products: 'Too many products declared.',
  invalid_amount: 'Invalid amount.',
  invalid_name: 'Invalid product name.',
  invalid_description: 'Invalid product description.',
  unsupported_currency: 'Unsupported currency.',
  unknown_app: 'Unknown app.',
  not_app_owner: 'Only the app owner (or a collaborator) can do this.',
  invalid_return_url: 'Invalid return URL.',
  invalid_cancel_url: 'Invalid cancel URL.',
  unknown_plan: 'Unknown subscription plan.',
  unknown_price: 'No price is configured for that billing interval.',
  no_subscription: 'No subscription found for this account.',
}

/**
 * Normalize a platform error body (parsed JSON, or anything else) plus its
 * HTTP status into a {@link NormalizedApiError}. Pass status 0 for failures
 * that never produced an HTTP response.
 */
export function normalizeApiError(status: number, body: unknown): NormalizedApiError {
  const payload = (body !== null && typeof body === 'object' ? body : {}) as Record<
    string,
    unknown
  >
  const rawError = typeof payload.error === 'string' ? payload.error : undefined
  const message = typeof payload.message === 'string' ? payload.message : undefined
  // In the `{ code: slug, error: human }` convention the server's `error` IS
  // the specific human sentence — it must beat the generic slug mapping.
  const humanError = rawError !== undefined && !SLUG_RE.test(rawError) ? rawError : undefined
  const code =
    rawError !== undefined && SLUG_RE.test(rawError)
      ? rawError
      : typeof payload.code === 'string' && SLUG_RE.test(payload.code)
        ? payload.code
        : undefined

  const details: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (
      key === 'success' ||
      key === 'error' ||
      key === 'message' ||
      key === 'issues' ||
      key === 'code'
    )
      continue
    details[key] = value
  }

  return {
    error:
      message ??
      humanError ??
      (code !== undefined ? HUMAN_MESSAGES[code] : undefined) ??
      rawError ??
      `Request failed (${status})`,
    ...(code !== undefined ? { code } : {}),
    status,
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(Array.isArray(payload.issues) ? { issues: payload.issues as ApiErrorIssue[] } : {}),
  }
}

/**
 * The error the billing hooks (`useCheckout`, `useSubscription`) throw for a
 * platform refusal. `message` is human text safe to render; branch on `code`:
 *
 *   try {
 *     await subscribe('pro')
 *   } catch (e) {
 *     if (e instanceof PlatformApiError && e.code === 'owner_connect_not_ready') {
 *       // owner hasn't finished payment onboarding
 *     }
 *   }
 */
export class PlatformApiError extends Error {
  /** The machine slug (e.g. 'owner_connect_not_ready'), when the server sent one. */
  readonly code?: string
  /** HTTP status of the response; 0 when no HTTP response arrived. */
  readonly status: number
  /** Structured fields the server sent alongside the error. */
  readonly details?: Record<string, unknown>
  /** Zod issues accompanying a `validation_failed` response. */
  readonly issues?: ApiErrorIssue[]

  constructor(normalized: NormalizedApiError) {
    super(normalized.error)
    this.name = 'PlatformApiError'
    this.code = normalized.code
    this.status = normalized.status
    this.details = normalized.details
    this.issues = normalized.issues
  }
}

/**
 * The machine slug from a thrown {@link PlatformApiError}, or null for any
 * other thrown value — the chokepoint for "which refusal was this?" checks.
 */
export const apiErrorCode = (e: unknown): string | null =>
  e instanceof PlatformApiError ? (e.code ?? null) : null
