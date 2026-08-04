export interface DocsPublicLimiterEnv {
  DEEPSPACE_APP_ID: string
  DOCS_ASSISTANT_LIMITER: DurableObjectNamespace
}

export interface DocsPublicLease {
  leaseId: string
  stub: DurableObjectStub
}

export type DocsPublicLeaseResult =
  | { ok: true; lease: DocsPublicLease }
  | { ok: false; status: 429 | 503 }

/** Hash the edge client address before it reaches durable limiter storage. */
export async function docsPublicClientKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Acquire one bounded public docs operation from the per-app limiter. */
export async function acquireDocsPublicLease(
  env: DocsPublicLimiterEnv,
  clientKey: string,
  logPrefix: string,
): Promise<DocsPublicLeaseResult> {
  if (!env.DOCS_ASSISTANT_LIMITER) return { ok: false, status: 503 }
  const id = env.DOCS_ASSISTANT_LIMITER.idFromName(env.DEEPSPACE_APP_ID)
  const stub = env.DOCS_ASSISTANT_LIMITER.get(id)
  const response = await stub.fetch('https://docs-limiter/acquire', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey }),
  }).catch((error) => {
    console.error(`[${logPrefix}] limiter unavailable:`, error)
    return null
  })
  if (!response?.ok) {
    return { ok: false, status: response?.status === 429 ? 429 : 503 }
  }
  const body = await response.json<{ leaseId?: unknown }>().catch(() => null)
  if (!body || typeof body.leaseId !== 'string') return { ok: false, status: 503 }
  return { ok: true, lease: { leaseId: body.leaseId, stub } }
}

/** Release a concurrency lease; window usage remains consumed. */
export async function releaseDocsPublicLease(
  lease: DocsPublicLease | undefined,
  logPrefix: string,
): Promise<void> {
  if (!lease) return
  await lease.stub.fetch('https://docs-limiter/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaseId: lease.leaseId }),
  }).catch((error) => console.error(`[${logPrefix}] limiter release failed:`, error))
}
