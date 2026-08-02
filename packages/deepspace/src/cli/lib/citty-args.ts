/**
 * Helpers for citty argument quirks.
 */

/**
 * citty binds the first positional to its named arg AND *also* leaves the full
 * positional list in `args._`. A handler that naively unions `[named, ...args._]`
 * therefore processes the first positional twice — which silently broke
 * `secrets delete`: it deleted a key, re-attempted the same key, got a 404, and
 * aborted the rest (`delete A B` kept B; a single `delete A` exited 1 on success).
 *
 * Union + dedupe (dropping empties / non-strings) yields the caller's distinct
 * positionals exactly once, in first-seen order. Use this anywhere a command
 * accepts a repeatable positional.
 */
export function dedupePositionals(bound: unknown, rest: unknown): string[] {
  const restArr = Array.isArray(rest) ? rest : []
  return [...new Set([bound, ...restArr])].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  )
}

// A page size / cursor is a plain base-10 non-negative integer — either a count
// a human typed or, for a cursor, the exact token the server handed back.
// Matching on the digit STRING (after trimming surrounding whitespace) rather
// than coercing with Number() is deliberate: Number() is far too lenient here —
// it maps whitespace-only input to 0 (`Number("  ") === 0`, which silently
// replayed history for a corrupted cursor), and accepts hex/binary/scientific/
// float spellings (`0x10`, `1e3`, `5.0`) that the server never emits. `\d+`
// admits none of those, nor a sign, so negatives fall through to the error path.
// Digits alone don't bound magnitude, so callers also require Number.isSafeInteger:
// a value past 2^53 (e.g. `9007199254740993`) would round when parsed, and the
// CLI echoes the cursor back to the server verbatim — a silently-rounded cursor
// breaks the "you get back the token you sent" invariant. No legitimate page
// size or cursor approaches 2^53, so rejecting the unsafe range costs nothing.
const NON_NEGATIVE_INT_RE = /^\d+$/

/**
 * Parse a user-supplied `--limit`. An absent flag yields `undefined` (the
 * server applies its own default page size). A present-but-invalid value —
 * non-numeric, fractional, signed, whitespace-only, past 2^53, or ≤ 0 — yields
 * an `error` string instead of silently collapsing to "no limit": the old
 * `args.limit ? Number(args.limit) : undefined` (and the `Number(x) || undefined`
 * variant) turned `--limit nope` and `--limit 0` into an UNBOUNDED request, so an
 * automation asking for a small page could get the entire list back without any
 * signal. Callers surface the error through their own `fail(...)` as
 * `code:"invalid_limit"`.
 */
export function parseLimitArg(raw: unknown): { limit?: number; error?: string } {
  if (raw === undefined || raw === null || raw === '') return {}
  const s = String(raw).trim()
  const n = Number(s)
  if (!NON_NEGATIVE_INT_RE.test(s) || !Number.isSafeInteger(n) || n <= 0) {
    return { error: `Invalid --limit: ${String(raw)} (expected a positive integer).` }
  }
  return { limit: n }
}

/**
 * Parse an activity `--since` cursor. An absent flag (or an empty string, the
 * shell idiom for "no saved cursor yet") yields cursor 0 (start of history). Any
 * other present value must be a non-negative integer the server handed back — a
 * fractional one like `1.9`, a whitespace-only one, or one past 2^53 yields an
 * `error` rather than being floored/coerced/rounded: silently replaying an
 * earlier page (or echoing back a rounded cursor) is exactly what an agent with
 * a corrupted saved cursor would mistake for new activity. Callers surface the
 * error as `code:"invalid_cursor"`.
 */
export function parseCursorArg(raw: unknown): { cursor: number; error?: string } {
  if (raw === undefined || raw === null || raw === '') return { cursor: 0 }
  const s = String(raw).trim()
  const n = Number(s)
  if (!NON_NEGATIVE_INT_RE.test(s) || !Number.isSafeInteger(n)) {
    return {
      cursor: 0,
      error: `Invalid --since cursor: ${String(raw)} (expected the integer cursor returned by a previous page).`,
    }
  }
  return { cursor: n }
}
