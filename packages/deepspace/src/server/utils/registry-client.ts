/**
 * The ONE registry client. Every platform worker reaches the app-registry
 * Durable Object (hosted by the deploy worker, singleton `v1:global`) through
 * a cross-script REGISTRY binding — and before this module, each of the five
 * workers hand-rolled its own copy of the same mechanics: the instance name
 * appeared in 6 places, the `https://registry/` URL in 6, `APP_ID_RE` in 5,
 * and `RegistryClientError` + `registryErrorJson` existed byte-identical in
 * two workers. Copies that must agree and nothing enforcing it.
 *
 * This module owns the MECHANICS: instance name, stub lookup, the wire call,
 * the error type, and the standard route mapping. Each worker still declares
 * its own typed convenience wrapper listing only the actions it uses — that
 * subset is genuinely per-worker; the plumbing is not.
 */

/** The singleton registry instance — one DO holds every app/route/collaborator. */
export const REGISTRY_INSTANCE = 'v1:global'

/** Public app ids have one canonical ULID-minted shape. */
export const APP_ID_RE = /^app_[0-9A-HJKMNP-TV-Z]{26}$/
export const STRICT_APP_ID_RE = APP_ID_RE

/** Internal physical locators survive identity migration and are not public ids. */
export const RESOURCE_ID_RE = /^(app_[0-9A-HJKMNP-TV-Z]{26}|[a-z0-9][a-z0-9_-]{0,63})$/

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A 26-char ULID (48-bit ms timestamp + 80 random bits, Crockford base32) —
 *  the id shape shared by app ids (`app_…`) and workspace ids (`ws_…`). */
export function mintUlid(now = Date.now()): string {
  let ts = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts
    t = Math.floor(t / 32)
  }
  const rand = new Uint8Array(10)
  crypto.getRandomValues(rand)
  let rs = ''
  let acc = 0
  let bits = 0
  for (const byte of rand) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      rs += CROCKFORD[(acc >> bits) & 31]
    }
  }
  return `${ts}${rs}`.slice(0, 26)
}

/** Mint a fresh app id: `app_` + 26-char ULID. App ids are minted ONLY by the
 *  deploy worker's authenticated `POST /api/apps/mint`, which registers the id
 *  to its caller in the same step — an id with no owner never exists. */
export function mintAppId(now = Date.now()): string {
  return `app_${mintUlid(now)}`
}

export class RegistryClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'RegistryClientError'
  }
}

export function registryStub(ns: DurableObjectNamespace): DurableObjectStub {
  return ns.get(ns.idFromName(REGISTRY_INSTANCE))
}

/**
 * One registry action over the wire. Non-2xx answers throw
 * {@link RegistryClientError} carrying the DO's structured `code` (or
 * `'error'` for a transport-shaped body) — callers distinguish a registry-
 * REPORTED miss (`code === 'not_found'`) from an outage by that code, never
 * by treating every throw as "not found".
 */
export async function callRegistry<T>(
  stub: DurableObjectStub,
  body: { action: string } & Record<string, unknown>,
): Promise<T> {
  const res = await stub.fetch('https://registry/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
  if (!res.ok) {
    throw new RegistryClientError(
      json.error ?? `Registry error (${res.status})`,
      json.code ?? 'error',
      res.status,
    )
  }
  return json as T
}

/** Standard mapping of a registry failure onto a route response. */
export function registryErrorJson(
  c: { json: (body: unknown, status?: number) => Response },
  err: unknown,
): Response {
  if (err instanceof RegistryClientError) {
    return c.json({ error: err.message, code: err.code }, err.status as 400)
  }
  throw err
}
