import { describe, expect, it } from 'vitest'
import {
  closestCommandPath,
  editDistance,
  findUnknownCommand,
  type CommandTreeNode,
} from '../command-suggestions'

const commands: Record<string, CommandTreeNode> = {
  deploy: {},
  app: {
    subCommands: {
      list: {},
      migrate: {},
      source: {},
    },
  },
  test: {
    subCommands: {
      accounts: {},
    },
  },
}

describe('command suggestions', () => {
  it('calculates lexical edit distance case-insensitively', () => {
    // Case-insensitive, and an adjacent SWAP costs one edit, not two:
    // `MIGARTE` is `migrate` with one transposition.
    expect(editDistance('MIGARTE', 'migrate')).toBe(1)
    expect(editDistance('migrate', 'MIGRATE')).toBe(0)
    // Substitutions still cost one each.
    expect(editDistance('migrxte', 'migrate')).toBe(1)
    expect(editDistance('mixrxte', 'migrate')).toBe(2)
  })

  it('prefers the transposed neighbour over an equidistant unrelated verb', () => {
    // `puhs` is one swap from `push` but two substitutions from `pull`.
    // Under plain Levenshtein they tied and the alphabetical tiebreak sent a
    // mistyped push to `pull` — a different act, and the tie is the single
    // most common kind of typo there is.
    expect(editDistance('puhs', 'push')).toBe(1)
    expect(editDistance('puhs', 'pull')).toBe(2)
    expect(closestCommandPath('puhs', { push: {}, pull: {} })).toEqual(['push'])
  })

  it('searches nested subcommands for an unknown top-level command', () => {
    expect(closestCommandPath('migrate', commands)).toEqual(['app', 'migrate'])
    expect(findUnknownCommand(['migrate'], commands)).toEqual({
      attemptedPath: ['deepspace', 'migrate'],
      helpPath: ['deepspace'],
      suggestion: ['deepspace', 'app', 'migrate'],
      remainder: [],
      // `migrate` matches `app migrate` exactly, but only a quoted whole path
      // is deterministic enough to hand back as runnable — a ranked or exact
      // leaf guess stays a hint (`credits` ranks `create`, which scaffolds).
      executable: false,
    })
  })

  it('prefers an exact command elsewhere in the tree over a fuzzy sibling', () => {
    // `deepspace auth status` — `status` exists at the top level, and the
    // fuzzy-nearest sibling under auth was `logout`: a destructive guess for
    // a read verb (2026-08-25 collab AX audit).
    const tree: Record<string, CommandTreeNode> = {
      status: {},
      auth: { subCommands: { login: {}, logout: {}, whoami: {} } },
    }
    expect(findUnknownCommand(['auth', 'status'], tree)).toMatchObject({
      attemptedPath: ['deepspace', 'auth', 'status'],
      suggestion: ['deepspace', 'status'],
      executable: false,
    })
  })

  it('searches below the accepted command path for nested typos', () => {
    expect(findUnknownCommand(['app', 'migarte'], commands)).toEqual({
      attemptedPath: ['deepspace', 'app', 'migarte'],
      helpPath: ['deepspace', 'app'],
      suggestion: ['deepspace', 'app', 'migrate'],
      remainder: [],
      // A fuzzy correction (`migarte` → `migrate`) is a hint, never runnable:
      // no distance threshold reliably separates a typo fix from a different
      // verb, so only the quoted whole-path case reaches the action channel.
      executable: false,
    })
  })

  it("carries the caller's positionals so the suggested action can run", () => {
    // The action is documented as runnable verbatim. Dropping the positionals
    // turned every corrected verb that takes one into a second refusal
    // (`missing_argument`) with a different code and no further recovery.
    expect(findUnknownCommand(['app', 'migarte', 'up'], commands)?.remainder).toEqual(['up'])
  })

  it('stops at the first flag, so a secret in the argv never lands in the envelope', () => {
    // `auth logn --email a@b.c --password hunter2` used to echo the password
    // into `action.argv`, and agents persist envelopes. Positionals are what
    // the corrected verb needs; flags are not worth that risk.
    expect(
      findUnknownCommand(['app', 'migarte', 'up', '--token', 'hunter2'], commands)?.remainder,
    ).toEqual(['up'])
    expect(
      findUnknownCommand(['app', 'migarte', '--password', 'hunter2'], commands)?.remainder,
    ).toEqual([])
  })

  it('uses stable path ordering to break equal lexical-distance ties', () => {
    const tied: Record<string, CommandTreeNode> = {
      workspace: { subCommands: { list: {} } },
      app: { subCommands: { list: {} } },
    }
    expect(closestCommandPath('list', tied)).toEqual(['app', 'list'])
  })

  it('withholds the executable action for every ranked guess — only an exact quoted path runs', () => {
    // `credits` ranks `create` closest; running that guess would start an
    // interactive scaffold, and no distance threshold separates a harmless
    // typo from that reliably. Say "did you mean", but never hand a ranked
    // guess over to run; the quoted-token case is exact and stays executable.
    const tree: Record<string, CommandTreeNode> = {
      app: { subCommands: { create: {}, usage: {} } },
    }
    const unknown = findUnknownCommand(['credits'], tree)
    expect(unknown?.suggestion).toEqual(['deepspace', 'app', 'create'])
    expect(unknown?.executable).toBe(false)
    expect(findUnknownCommand(['app', 'usgae'], tree)?.executable).toBe(false)
    expect(findUnknownCommand(['app usage'], tree)).toMatchObject({
      executable: true,
      quotedToken: true,
    })
  })

  /** A one-word guess that lands on a destructive verb must not come back as
   *  something an agent can paste and run. */
  it('withholds the executable action when the suggestion destroys something (quoted paths too)', () => {
    const tree: Record<string, CommandTreeNode> = {
      app: { subCommands: { files: { subCommands: { rm: {}, list: {} } } } },
      secrets: { subCommands: { delete: {} } },
      status: {},
    }
    // Ranked guesses are never executable; the destructive floor is what keeps
    // even the exact quoted-token path from handing back a deleting command.
    expect(findUnknownCommand(['rm'], tree)).toMatchObject({
      suggestion: ['deepspace', 'app', 'files', 'rm'],
      executable: false,
    })
    expect(findUnknownCommand(['secrets delete'], tree)).toMatchObject({
      suggestion: ['deepspace', 'secrets', 'delete'],
      executable: false,
      quotedToken: true,
    })
    // A non-destructive exact path keeps its action.
    expect(findUnknownCommand(['app files list'], tree)).toMatchObject({
      suggestion: ['deepspace', 'app', 'files', 'list'],
      executable: true,
    })
  })

  /**
   * `deepspace "auth whoami"` — over-quoting in a script, or a shell that does
   * not word-split. The nearest-name search answered it with the token itself,
   * so the error read "did you mean `deepspace auth whoami`?" for input that
   * printed identically. Resolve the split path exactly and flag it.
   */
  it('recognises a whole command passed as one quoted token', () => {
    expect(findUnknownCommand(['app list'], commands)).toMatchObject({
      attemptedPath: ['deepspace', 'app list'],
      suggestion: ['deepspace', 'app', 'list'],
      quotedToken: true,
      executable: true,
    })
    expect(findUnknownCommand(['test accounts'], commands)).toMatchObject({
      suggestion: ['deepspace', 'test', 'accounts'],
      quotedToken: true,
    })
  })

  it('does not claim a quoted token when the split path is not real', () => {
    // Still gets a nearest-name suggestion; it just is not an exact split.
    expect(findUnknownCommand(['app nonsense'], commands)?.quotedToken).toBeUndefined()
    expect(findUnknownCommand(['migarte'], commands)?.quotedToken).toBeUndefined()
  })

  it('does not interpret flags or a leaf command positionals as commands', () => {
    expect(findUnknownCommand(['--json', 'migrate'], commands)).toBeNull()
    expect(findUnknownCommand(['deploy', 'dist'], commands)).toBeNull()
  })
})


describe('a guess must not become a runnable action', () => {
  const tree: Record<string, CommandTreeNode> = {
    deploy: {},
    status: {},
    app: {
      subCommands: {
        create: {},
        list: {},
        usage: {},
        collaborators: { subCommands: { add: {}, cancel: {}, list: {} } },
        transfer: { subCommands: { cancel: {}, status: {} } },
      },
    },
  }

  it('withholds a NEGATION inversion — the nearest verb is the OPPOSITE act', () => {
    // `undeploy` is two edits from `deploy`. Handed back as an action — which
    // the action contract says to run verbatim — it would DEPLOY the app the
    // caller meant to take down.
    const guess = findUnknownCommand(['undeploy'], tree)
    expect(guess?.suggestion).toEqual(['deepspace', 'deploy'])
    expect(guess?.executable).toBe(false)
  })

  it('still SUGGESTS a genuine, CLOSE correction — as a hint, never runnable', () => {
    // Even a one-edit typo fix stays off the action channel: no distance
    // threshold reliably separates a typo from a different verb.
    const guess = findUnknownCommand(['app', 'usgae'], tree)
    expect(guess?.suggestion).toEqual(['deepspace', 'app', 'usage'])
    expect(guess?.executable).toBe(false)
  })

  it('prefers an exact leaf deeper in the tree over a ranked guess', () => {
    // `add` names a real leaf — `app collaborators add` — so an exact match
    // deeper in the tree beats anything the ranker would return for it.
    const exact = findUnknownCommand(['app', 'add', 'alice@example.com'], tree)
    expect(exact?.suggestion).toEqual(['deepspace', 'app', 'collaborators', 'add'])
    expect(exact?.remainder).toEqual(['alice@example.com'])
    expect(exact?.executable).toBe(false)
  })

  it('does NOT treat an AMBIGUOUS exact match as evidence', () => {
    // `cancel` is a leaf under two groups with opposite meanings: revoking a
    // collaborator invite vs calling off an ownership transfer. The tie is
    // settled alphabetically, so it can only ever be a hint.
    const guess = findUnknownCommand(['app', 'cancel', 'alice@example.com'], tree)
    expect(guess?.executable).toBe(false)
  })
})
