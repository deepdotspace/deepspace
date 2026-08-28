/**
 * Better Auth session cookie name. The CLI presents it when exchanging a
 * stored session for JWTs, and the auth worker requires it when minting —
 * the two sides must agree on the exact name.
 */
export const SESSION_COOKIE = '__Secure-better-auth.session_token'
