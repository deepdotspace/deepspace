/**
 * Looks a request-supplied name up in a map of handlers or configs, own keys
 * only. Plain `map[name]` also finds inherited properties: `actions.constructor`
 * is `Object`, which, called with the handler argument, returns that argument
 * (env secrets included) as the response. Route handlers keyed by a URL
 * segment should always look up through this.
 */
export function lookupOwn<T>(map: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(map, name) ? map[name] : undefined
}

/** A plain identifier safe to forward as one path segment (no `/`, `\`, `.`, `%`). */
export const SAFE_PATH_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/i
