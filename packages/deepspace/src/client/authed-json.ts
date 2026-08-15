/**
 * Authenticated JSON fetch against the app's same-origin `/_deepspace` proxy.
 *
 * Shared by the billing hooks (`useCheckout`, `useSubscription`). On a non-2xx
 * response it throws a {@link PlatformApiError} built by the shared error
 * normalizer, so callers render `.message` (human text) and branch on `.code`
 * (the machine slug, e.g. 'owner_connect_not_ready') instead of string-sniffing.
 */

import { getAuthToken } from './auth/token'
import { normalizeApiError, PlatformApiError } from '../shared/api-error'

export async function authedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken()
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new PlatformApiError(normalizeApiError(res.status, data))
  }
  return data as T
}
