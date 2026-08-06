export interface CommandTreeNode {
  subCommands?: Record<string, CommandTreeNode>
}

export interface UnknownCommand {
  attemptedPath: string[]
  helpPath: string[]
  suggestion: string[]
  /** Whether the suggestion may be handed back as a runnable `action`. */
  executable: boolean
  /** The whole command arrived as ONE quoted argv token, e.g. `"auth whoami"`. */
  quotedToken?: true
}

/**
 * A single argv token holding a whole command path — `deepspace "auth whoami"`.
 * Almost always over-quoting in a script or a shell that does not word-split,
 * and the nearest-name search answers it uselessly: the token IS the command,
 * so the suggestion comes back reading identical to what was typed.
 */
function splitTokenPath(
  token: string,
  table: Record<string, CommandTreeNode>,
): string[] | null {
  const parts = token.trim().split(/\s+/)
  if (parts.length < 2) return null
  let node: Record<string, CommandTreeNode> | undefined = table
  for (const part of parts) {
    const next: CommandTreeNode | undefined = node?.[part]
    if (!next) return null
    node = next.subCommands
  }
  return parts
}

/**
 * Verbs that destroy something. A guess is a guess: `rm` ranks `app files rm`
 * first and `delete` ranks `secrets delete` first, so an agent that pastes the
 * offered action deletes data it never named. These stay in the prose ("did you
 * mean …?") and are withheld from `action`, which is the executable channel —
 * a destructive command has to be typed on purpose.
 */
const DESTRUCTIVE_VERBS = new Set(['rm', 'delete', 'remove', 'drop', 'clear', 'undeploy', 'kill'])

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
      // An exact path that merely arrived as one token is not a guess — say so
      // precisely instead of ranking names against a string containing spaces.
      const split = splitTokenPath(token, table)
      const relativeSuggestion = split ?? closestCommandPath(token, table)
      if (!relativeSuggestion) return null
      return {
        attemptedPath: ['deepspace', ...accepted, token],
        helpPath: ['deepspace', ...accepted],
        suggestion: ['deepspace', ...accepted, ...relativeSuggestion],
        executable: !DESTRUCTIVE_VERBS.has(relativeSuggestion.at(-1) ?? ''),
        ...(split ? { quotedToken: true as const } : {}),
      }
    }
    accepted.push(token)
    table = command.subCommands
  }

  return null
}
