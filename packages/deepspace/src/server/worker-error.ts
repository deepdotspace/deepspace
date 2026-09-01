import type { Context, ErrorHandler } from 'hono'
import { loggableError } from '../shared/log-events'

/**
 * The one `app.onError` for every Hono worker (the scaffolded app template
 * and the platform workers alike). It exists because Hono's default handler
 * is `console.error(err)` — and Workers Logs keeps only a logged Error
 * OBJECT's stack frames, dropping the message (see `loggableError`) — so an
 * uncaught route error surfaced in `deepspace logs` as bare frames.
 *
 * A response-bearing error (`HTTPException` — auth 401s, upload 413s) keeps
 * its own answer, exactly as Hono's default would; everything else is logged
 * as ONE string — `[prefix] METHOD /path: message, frames, bounded cause
 * chain` — and answered by `respond` (a plain-text 500 unless the worker's
 * API contract needs another shape).
 */
export function workerErrorHandler(
  prefix: string,
  respond: (c: Context) => Response = (c) => c.text('Internal Server Error', 500),
): ErrorHandler {
  return (err, c) => {
    if ('getResponse' in err) {
      const res = (err as { getResponse: () => Response }).getResponse()
      return c.newResponse(res.body, res)
    }
    console.error(
      `[${prefix}] ${c.req.method} ${new URL(c.req.url).pathname}: ${loggableError(err)}`,
    )
    return respond(c)
  }
}
