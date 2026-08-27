import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The shipped multi-user spec has to pass on a correctly working app, from a
 * fresh scaffold, on any machine.
 *
 * It used to assert `toHaveText(a.name)` — but `name` there comes from the
 * LOCAL account registry (`account.name ?? account.email.split('@')[0]`),
 * while the page renders the Better Auth SESSION's `name || email`. Those are
 * different facts: an account created as `--name "Collab A"` and later
 * recovered on another machine has no local name at all, so the registry says
 * "collab-a" while the page correctly says "Collab A" — and `toHaveText` is
 * exact. The email is the credential the context signed in with, so it is the
 * one identity both sides agree on.
 */
const TEMPLATES = new URL('../../templates/', import.meta.url)
const OVERLAY_NAVIGATION = [
  'starter/src/components/Navigation.tsx',
  'copilot/src/components/sidebar/AppSidebar.tsx',
]

function template(path: string): string {
  return readFileSync(new URL(path, TEMPLATES), 'utf8')
}

describe('scaffolded collaboration spec', () => {
  const spec = template('base/tests/collab.spec.ts')

  it('asserts the account the browser signed in as', () => {
    expect(spec).toContain("getByTestId('nav-user-email')).toHaveText(user.email")
  })

  it('never compares the page against the local registry display name', () => {
    expect(spec).not.toMatch(/toHaveText\(\s*[a-z]+\.name\b/)
  })

  it('only asserts the identity chip is populated, since its text is not knowable', () => {
    expect(spec).toContain("getByTestId('nav-user-name')).toHaveText(/\\S/")
  })

  it('skips itself on a machine with no usable test-account pool', () => {
    // A cold machine has no pool, and `users()` throws there — which turned
    // "you have not created test accounts yet" into three red tests about the
    // app on the very first `deepspace test run all`.
    expect(spec).toContain("loadAllTestAccounts } from 'deepspace/testing'")
    expect(spec).toMatch(/test\.skip\(\s*\n?\s*usableTestAccounts < 2,/)
    // The skip reason has to name the command that fixes it.
    expect(spec).toContain('test accounts create')
    expect(spec).toContain('--password-stdin')
  })

  it('finds its assertion targets in every product overlay', () => {
    for (const component of OVERLAY_NAVIGATION) {
      const source = template(component)
      // The chip smoke.spec.ts counts when signed out…
      expect(source, component).toContain('data-testid="nav-user-name"')
      // …the menu that opens it, and the email inside.
      expect(source, component).toContain('aria-label="Account menu"')
      expect(source, component).toContain('data-testid="nav-user-email"')
    }
  })
})
