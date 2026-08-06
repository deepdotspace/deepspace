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
    expect(editDistance('MIGARTE', 'migrate')).toBe(2)
  })

  it('searches nested subcommands for an unknown top-level command', () => {
    expect(closestCommandPath('migrate', commands)).toEqual(['app', 'migrate'])
    expect(findUnknownCommand(['migrate'], commands)).toEqual({
      attemptedPath: ['deepspace', 'migrate'],
      helpPath: ['deepspace'],
      suggestion: ['deepspace', 'app', 'migrate'],
      executable: true,
    })
  })

  it('searches below the accepted command path for nested typos', () => {
    expect(findUnknownCommand(['app', 'migarte'], commands)).toEqual({
      attemptedPath: ['deepspace', 'app', 'migarte'],
      helpPath: ['deepspace', 'app'],
      suggestion: ['deepspace', 'app', 'migrate'],
      executable: true,
    })
  })

  it('uses stable path ordering to break equal lexical-distance ties', () => {
    const tied: Record<string, CommandTreeNode> = {
      workspace: { subCommands: { list: {} } },
      app: { subCommands: { list: {} } },
    }
    expect(closestCommandPath('list', tied)).toEqual(['app', 'list'])
  })

  /** A one-word guess that lands on a destructive verb must not come back as
   *  something an agent can paste and run. */
  it('withholds the executable action when the suggestion destroys something', () => {
    const tree: Record<string, CommandTreeNode> = {
      app: { subCommands: { files: { subCommands: { rm: {}, list: {} } } } },
      secrets: { subCommands: { delete: {} } },
      status: {},
    }
    expect(findUnknownCommand(['rm'], tree)).toMatchObject({
      suggestion: ['deepspace', 'app', 'files', 'rm'],
      executable: false,
    })
    expect(findUnknownCommand(['delete'], tree)).toMatchObject({
      suggestion: ['deepspace', 'secrets', 'delete'],
      executable: false,
    })
    // A non-destructive target keeps its action — the floor is about damage,
    // not about suppressing suggestions.
    expect(findUnknownCommand(['stats'], tree)).toMatchObject({
      suggestion: ['deepspace', 'status'],
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
