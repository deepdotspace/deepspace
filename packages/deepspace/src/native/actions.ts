/**
 * Server actions from React Native. Actions answer HTTP 200 with an
 * `ActionResult` envelope, so callers narrow on `success`; transport failures
 * and HTTP errors throw `DeepSpaceExpoError`.
 */
import type { ActionResult } from '../server/utils/action-types'
import { requireNativeClient } from './session'

export type { ActionResult }

export function callAction<TData = unknown>(
  name: string,
  params: Record<string, unknown> = {},
): Promise<ActionResult<TData>> {
  return requireNativeClient().request<ActionResult<TData>>(
    `/api/actions/${encodeURIComponent(name)}`,
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
  )
}
