/**
 * App-name validation + sanitization helpers.
 *
 * Strategy: validate strictly so we have a precise definition of "valid",
 * but DON'T reject non-conforming names — sanitize them, warn the user, and
 * proceed. Hard rejection would break apps whose `wrangler.toml name` was
 * something like `My_App` (previously deployed as `my-app` via silent
 * server-side sanitization). The new behavior preserves "still deploys,"
 * but the CLI now surfaces a warning so the user can fix the name when
 * convenient instead of being silently surprised by their hostname.
 *
 * Rules track Cloudflare's WfP script-name constraints (RFC 1035 host label,
 * no consecutive dashes) plus our 2-char minimum so subdomains read sensibly.
 */

export const APP_NAME_RULES = {
  /** ^[a-z0-9](-?[a-z0-9])+$ — RFC 1035 host label, no consecutive dashes. */
  pattern: /^[a-z0-9](?:-?[a-z0-9])+$/,
  minLength: 2,
  maxLength: 63,
} as const

export type AppNameValidation =
  | { valid: true; name: string }
  | { valid: false; reason: string }

/**
 * Strict validation: returns valid only if the name already conforms.
 * Useful as a precondition test or for CI lints.
 */
export function validateAppName(raw: unknown): AppNameValidation {
  if (typeof raw !== 'string') {
    return { valid: false, reason: 'App name must be a string' }
  }
  const name = raw.trim()
  if (!name) {
    return { valid: false, reason: 'App name is required' }
  }
  if (name.length < APP_NAME_RULES.minLength) {
    return { valid: false, reason: `App name "${name}" is too short (min ${APP_NAME_RULES.minLength} chars)` }
  }
  if (name.length > APP_NAME_RULES.maxLength) {
    return { valid: false, reason: `App name "${name}" is too long (max ${APP_NAME_RULES.maxLength} chars)` }
  }
  if (!APP_NAME_RULES.pattern.test(name)) {
    return {
      valid: false,
      reason:
        `App name "${name}" is invalid. Use lowercase letters, digits, and single hyphens only ` +
        `(must start + end with alphanumeric). Examples: my-app, search-v2, unison-search.`,
    }
  }
  return { valid: true, name }
}

export type AppNameResolution =
  | { ok: true; name: string; warning?: string }
  | { ok: false; reason: string }

/**
 * Resolve an app name for deploy: prefer the input as-is if valid, otherwise
 * sanitize and warn. Hard-fail only if even sanitization can't produce a
 * valid name (empty, all-non-alphanumeric, too short, too long).
 *
 * The intent is "what previously worked still works, with a friendly warning
 * about non-conforming names."
 */
export function resolveAppName(raw: unknown): AppNameResolution {
  const strict = validateAppName(raw)
  if (strict.valid) return { ok: true, name: strict.name }

  if (typeof raw !== 'string') return { ok: false, reason: strict.reason }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'App name is required' }

  const sanitized = sanitizeAppName(trimmed)
  const sanitizedStrict = validateAppName(sanitized)
  if (!sanitizedStrict.valid) {
    return {
      ok: false,
      reason: `App name "${trimmed}" can't be sanitized into a valid name (${sanitizedStrict.reason}). Pick something matching: lowercase letters, digits, single hyphens, ${APP_NAME_RULES.minLength}-${APP_NAME_RULES.maxLength} chars.`,
    }
  }
  return {
    ok: true,
    name: sanitized,
    warning:
      `App name "${trimmed}" doesn't conform to deploy rules — using "${sanitized}" instead. ` +
      `Update wrangler.toml's \`name\` to silence this warning.`,
  }
}

/**
 * Lossy normalization that mirrors what the deploy-worker historically did
 * server-side. Keep only [a-z0-9-], collapse consecutive dashes, trim leading
 * and trailing dashes.
 */
function sanitizeAppName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}
