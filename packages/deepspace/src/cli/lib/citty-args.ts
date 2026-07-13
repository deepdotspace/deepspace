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
