import { sync as spawnSync } from 'cross-spawn'
import { existsSync } from 'node:fs'
import { displayLines } from '../cli-format'

const MAX_GIT_BUFFER = 512 * 1024 * 1024

/**
 * Hard ceiling on ONE git invocation.
 *
 * `spawnSync` blocks the whole process, so a git call that never returns hangs
 * the CLI with no output and no way out — a deploy was observed sitting silently
 * for 5+ minutes on a push the server had already refused. Nothing here is
 * allowed to wait unbounded. The ceiling is generous enough for a legitimate
 * 32 MiB push over a slow link (the server's own pack cap) and short enough
 * that a wedged call surfaces as a fast, named failure instead of a stall.
 */
export const GIT_TIMEOUT_MS = 300_000

export class GitError extends Error {
  constructor(
    message: string,
    /** Optional machine slug; generic Git errors fall back to `git_error`. */
    readonly code?: string,
  ) {
    // git's own stderr carries ref names and paths the pusher chose, and this
    // class bypasses the Refusal/InputError exits — `formatCliError` prints it
    // verbatim to the terminal and into the `--json` envelope.
    super(displayLines(message))
    this.name = 'GitError'
  }
}

/** Execute git without terminal prompts, localized output, or shell interpolation. */
export function runGit(
  cwd: string,
  args: string[],
  opts: {
    input?: string | Buffer
    allowFail?: boolean
    env?: Record<string, string>
    timeoutMs?: number
  } = {},
): { stdout: Buffer; stderr: Buffer; status: number } {
  const timeout = opts.timeoutMs ?? GIT_TIMEOUT_MS
  const result = spawnSync('git', args, {
    cwd,
    input: opts.input,
    maxBuffer: MAX_GIT_BUFFER,
    timeout,
    // SIGKILL, not the default SIGTERM: a child that ignores or traps TERM
    // would otherwise keep running for its full duration and the "timeout"
    // would bound nothing.
    killSignal: 'SIGKILL',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      ...(opts.env ?? {}),
    },
  })
  // ETIMEDOUT only. Treating any signal as a timeout would relabel an
  // ENOBUFS kill (output past maxBuffer) and an external SIGKILL — an OOM
  // killer, a Ctrl-C — as "too large to transfer", which is a different
  // problem with different advice.
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new GitError(
      `git ${args[0]} did not finish within ${Math.round(timeout / 1000)}s and was stopped. ` +
        `If this was a push, the history is probably too large to transfer — see \`deepspace push\` ` +
        `for the size limits; otherwise retry, and report it with \`deepspace feedback\` if it persists.`,
      'git_timeout',
    )
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    // ENOENT is ambiguous: the BINARY is missing, or the cwd is. A worktree
    // the user deleted or moved produces the second, and reporting "git is
    // not installed" for it sends people to fix a working git install.
    // ENOTDIR is the same story with a file where the directory should be.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (code === 'ENOTDIR' || !existsSync(cwd)) {
        throw new GitError(
          `The directory this command runs in is not there: ${cwd}. ` +
            `If it was a workspace worktree, prune it (\`git worktree prune\`) and re-attach.`,
          'worktree_missing',
        )
      }
      throw new GitError(
        'git is not installed or not on PATH — install git and retry.',
        'git_not_installed',
      )
    }
    throw new GitError(`git ${args[0]} failed: ${result.error.message}`)
  }
  const status = result.status ?? 1
  if (status !== 0 && !opts.allowFail) {
    const stderr = result.stderr?.toString('utf-8').trim() ?? ''
    throw new GitError(`git ${args.join(' ')} exited ${status}${stderr ? `: ${stderr}` : ''}`)
  }
  return {
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    status,
  }
}

export function gitLine(cwd: string, args: string[]): string {
  return runGit(cwd, args).stdout.toString('utf-8').trim()
}

/** Decode a NUL-delimited git result without corrupting control characters in paths. */
export function splitNulFields(buffer: Buffer): string[] {
  const fields: string[] = []
  let start = 0
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] === 0) {
      fields.push(buffer.toString('utf-8', start, index))
      start = index + 1
    }
  }
  if (start < buffer.length) fields.push(buffer.toString('utf-8', start))
  return fields
}

/** Parse `git --version` into the major/minor pair used by the compatibility floor. */
export function parseGitVersion(output: string): [number, number] | null {
  const match = /(\d+)\.(\d+)/.exec(output)
  return match ? [Number(match[1]), Number(match[2])] : null
}

/** Git 2.29 is the minimum version that exposes the required object-format probe. */
export function gitMeetsFloor(version: [number, number] | null): boolean {
  if (!version) return true
  const [major, minor] = version
  return major > 2 || (major === 2 && minor >= 29)
}
