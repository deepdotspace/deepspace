/** Generic bounded retry loop. The final attempt's response/error always wins. */
export async function retryTransient<T>(
  run: () => Promise<T>,
  {
    delaysMs,
    shouldRetryError = () => true,
    shouldRetryResult = () => false,
  }: {
    delaysMs: number[]
    shouldRetryError?: (error: unknown) => boolean
    shouldRetryResult?: (result: T) => boolean
  },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await run()
      if (!shouldRetryResult(result) || attempt >= delaysMs.length) return result
    } catch (error) {
      if (!shouldRetryError(error) || attempt >= delaysMs.length) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]))
  }
}

/** Retry rebuilt request bodies on network failures and eligible responses. */
export async function fetchWithTransientRetry(
  url: string,
  makeInit: () => RequestInit,
  {
    attempts = 4,
    retryServerErrors = true,
    timeoutMs = 60_000,
  }: { attempts?: number; retryServerErrors?: boolean; timeoutMs?: number } = {},
): Promise<Response> {
  return retryTransient(
    async () => {
      // Every attempt is bounded: a hung service must surface as a fast,
      // retryable failure, never inherit undici's multi-minute default.
      return await fetch(url, { ...makeInit(), signal: AbortSignal.timeout(timeoutMs) })
    },
    {
      delaysMs: Array.from({ length: Math.max(0, attempts - 1) }, (_, attempt) =>
        Math.min(8_000, 500 * 2 ** attempt),
      ),
      shouldRetryResult: (response) =>
        retryServerErrors &&
        (response.status >= 500 || response.status === 408 || response.status === 429),
    },
  )
}
