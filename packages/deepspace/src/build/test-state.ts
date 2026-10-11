/**
 * Where a local run keeps its data: `servePreview` (deepspace/testing) sets
 * DEEPSPACE_TEST_STATE_DIR to a fresh directory per test run, so tests never
 * read or write the developer's usual local data.
 *
 * ```ts
 * plugins: [cloudflare(testState()), deepspaceBuild({ appDir })]
 * ```
 */
export const TEST_STATE_DIR_ENV = 'DEEPSPACE_TEST_STATE_DIR'

export function testState(env: NodeJS.ProcessEnv = process.env): { persistState: { path: string } } | undefined {
  const path = env[TEST_STATE_DIR_ENV]
  return path ? { persistState: { path } } : undefined
}
