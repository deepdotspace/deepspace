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
    })
  })

  it('searches below the accepted command path for nested typos', () => {
    expect(findUnknownCommand(['app', 'migarte'], commands)).toEqual({
      attemptedPath: ['deepspace', 'app', 'migarte'],
      helpPath: ['deepspace', 'app'],
      suggestion: ['deepspace', 'app', 'migrate'],
    })
  })

  it('uses stable path ordering to break equal lexical-distance ties', () => {
    const tied: Record<string, CommandTreeNode> = {
      workspace: { subCommands: { list: {} } },
      app: { subCommands: { list: {} } },
    }
    expect(closestCommandPath('list', tied)).toEqual(['app', 'list'])
  })

  it('does not interpret flags or a leaf command positionals as commands', () => {
    expect(findUnknownCommand(['--json', 'migrate'], commands)).toBeNull()
    expect(findUnknownCommand(['deploy', 'dist'], commands)).toBeNull()
  })
})
