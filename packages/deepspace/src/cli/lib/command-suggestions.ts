export interface CommandTreeNode {
  subCommands?: Record<string, CommandTreeNode>
}

export interface UnknownCommand {
  attemptedPath: string[]
  helpPath: string[]
  suggestion: string[]
}

/** Levenshtein distance for short command names. */
export function editDistance(a: string, b: string): number {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  const dp = Array.from({ length: left.length + 1 }, (_, i) => [
    i,
    ...new Array<number>(right.length).fill(0),
  ])
  for (let j = 1; j <= right.length; j++) dp[0][j] = j
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[left.length][right.length]
}

function commandPaths(table: Record<string, CommandTreeNode>, prefix: string[] = []): string[][] {
  const paths: string[][] = []
  for (const [name, command] of Object.entries(table)) {
    const path = [...prefix, name]
    paths.push(path)
    if (command.subCommands) paths.push(...commandPaths(command.subCommands, path))
  }
  return paths
}

/**
 * Pick a command from the whole remaining tree, comparing the unknown token to
 * every command name. This lets a misplaced leaf such as top-level `migrate`
 * resolve to `app migrate`, not merely to the nearest top-level group.
 */
export function closestCommandPath(
  input: string,
  table: Record<string, CommandTreeNode>,
): string[] | null {
  const ranked = commandPaths(table)
    .map((path) => ({ path, distance: editDistance(input, path.at(-1) ?? '') }))
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        a.path.length - b.path.length ||
        a.path.join(' ').localeCompare(b.path.join(' ')),
    )
  return ranked[0]?.path ?? null
}

/**
 * Find the first invalid command token. Once a leaf command is reached, its
 * remaining positional arguments belong to that command and are not checked.
 */
export function findUnknownCommand(
  argv: string[],
  rootCommands: Record<string, CommandTreeNode>,
): UnknownCommand | null {
  let table: Record<string, CommandTreeNode> | undefined = rootCommands
  const accepted: string[] = []

  for (const token of argv) {
    if (!table || token.startsWith('-')) return null
    const command: CommandTreeNode | undefined = table[token]
    if (!command) {
      const relativeSuggestion = closestCommandPath(token, table)
      if (!relativeSuggestion) return null
      return {
        attemptedPath: ['deepspace', ...accepted, token],
        helpPath: ['deepspace', ...accepted],
        suggestion: ['deepspace', ...accepted, ...relativeSuggestion],
      }
    }
    accepted.push(token)
    table = command.subCommands
  }

  return null
}
