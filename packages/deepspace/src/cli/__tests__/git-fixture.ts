/**
 * Shared git-repo fixtures for CLI tests.
 *
 * The slow pattern this replaces: every test building its own repo with
 * 2–6 sequential `git` spawns. Process spawn latency — not git's work —
 * dominates those suites and stretches badly under parallel load (the
 * release gate runs every package's suite at once), which is exactly how
 * a per-test timeout flake is born.
 *
 * The fix: build each DISTINCT repo definition once per process, then hand
 * every test a filesystem copy (~10ms, zero spawns). The code under test
 * still runs real git against a real repository — only the per-test
 * construction storm is gone.
 */
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface GitFixtureSpec {
  /** Path → contents, written before staging. */
  files?: Record<string, string>
  /** Stage the files (`git add -A`). Default true when files are present. */
  add?: boolean
  /** Also commit the staged files. Default false. */
  commit?: boolean
  /** Initial branch name. Default `main`. */
  branch?: string
}

const templates = new Map<string, string>()
let templateRoot: string | undefined

function buildTemplate(spec: GitFixtureSpec): string {
  templateRoot ??= mkdtempSync(join(tmpdir(), 'ds-git-templates-'))
  const dir = mkdtempSync(join(templateRoot, 'tpl-'))
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir })
  }
  git(['init', '-q', '-b', spec.branch ?? 'main'])
  // Identity lives in the repo config so commits (template-time or
  // test-time) never depend on the host's global git setup. Written with
  // the filesystem, not `git config`, to keep the spawn count at the
  // init/add/commit minimum.
  appendFileSync(
    join(dir, '.git', 'config'),
    '[user]\n\tname = DeepSpace Test\n\temail = test@deep.space\n',
  )
  for (const [path, contents] of Object.entries(spec.files ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), contents)
  }
  const shouldAdd = spec.add ?? Object.keys(spec.files ?? {}).length > 0
  if (shouldAdd) git(['add', '-A'])
  if (spec.commit) git(['commit', '-q', '-m', 'initial'])
  return dir
}

/**
 * A fresh working copy of the repo described by `spec`.
 *
 * Copies are real temp dirs the caller owns: mutate freely, remove with
 * `rmSync(dir, { recursive: true, force: true })` (or leave it to the
 * OS temp cleaner, as the previous per-test fixtures did).
 */
export function gitFixture(spec: GitFixtureSpec = {}): string {
  const key = JSON.stringify([
    spec.branch ?? 'main',
    spec.add ?? Object.keys(spec.files ?? {}).length > 0,
    spec.commit ?? false,
    Object.entries(spec.files ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
  ])
  let template = templates.get(key)
  if (!template) {
    template = buildTemplate(spec)
    templates.set(key, template)
  }
  const dir = mkdtempSync(join(tmpdir(), 'ds-git-fixture-'))
  cpSync(template, dir, { recursive: true })
  // realpath for macOS /var → /private/var symlinks, matching what the
  // per-test fixtures returned.
  return realpathSync(dir)
}

/** Remove every memoized template (afterAll hygiene for suites that want it). */
export function cleanupGitFixtureTemplates(): void {
  if (templateRoot) rmSync(templateRoot, { recursive: true, force: true })
  templateRoot = undefined
  templates.clear()
}
