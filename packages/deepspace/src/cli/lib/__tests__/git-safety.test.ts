/** Secret-path redaction, committed-secret refusal, and oversized-object diagnostics. */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  committedSecretRefusal,
  findOversizedObjects,
  statusFiles,
  trackedSecretFiles,
  SECRET_IN_HISTORY_CODE,
} from '../git/safety'
import { runGit } from '../git/process'

// Real-git suite: every test shells out to git in scratch repos (~2s solo)
// and blows the default 5s wall under parallel vitest workers — the drifting
// 18-24 failures in docs/audits/2026-08-06-e2e-0.13.0. Headroom, not a
// license to hang.
vi.setConfig({ testTimeout: 30_000 })
import { initRepo, resolveCommit } from '../git/repository'

function git(cwd: string, args: string[], input?: string): string {
  return runGit(cwd, args, input === undefined ? {} : { input })
    .stdout.toString('utf-8')
    .trim()
}

describe('statusFiles (dirty-path listing)', () => {
  let wdir: string

  beforeAll(() => {
    wdir = mkdtempSync(join(tmpdir(), 'ds-status-'))
    initRepo(wdir, 'main')
    git(wdir, ['config', 'user.email', 't@example.com'])
    git(wdir, ['config', 'user.name', 'T'])
    writeFileSync(join(wdir, 'old.txt'), 'stable body for rename detection\n')
    git(wdir, ['add', '-A'])
    git(wdir, ['commit', '-q', '-m', 'base'])
  })
  afterAll(() => rmSync(wdir, { recursive: true, force: true }))

  it('reports BOTH sides of a staged rename (new + removed path), never the raw `old -> new` blob', () => {
    git(wdir, ['mv', 'old.txt', 'renamed.txt'])
    try {
      const files = statusFiles(wdir)
      expect(files).toContain('renamed.txt') // the new path (worktree holds it)
      expect(files).toContain('old.txt') // the removed path — must not be undercounted
      expect(files).not.toContain('old.txt -> renamed.txt') // never the raw porcelain blob
    } finally {
      git(wdir, ['mv', 'renamed.txt', 'old.txt'])
    }
  })

  it('returns non-ASCII paths literally, never C-quoted', () => {
    // Without core.quotePath=false this would come back `"h\303\251llo…"`.
    // (Paths containing SPACES are still porcelain-quoted regardless of
    // quotePath — a pre-existing, listing-only cosmetic gap.)
    const name = 'héllo-wörld.txt'
    writeFileSync(join(wdir, name), 'hi\n')
    try {
      const files = statusFiles(wdir)
      expect(files).toContain(name)
      // The C-quoted form git emits without core.quotePath=false.
      expect(files.some((f) => f.startsWith('"'))).toBe(false)
    } finally {
      rmSync(join(wdir, name))
    }
  })

  it('dedupes a path that is both staged-deleted and untracked (git rm --cached)', () => {
    const r = mkdtempSync(join(tmpdir(), 'ds-status-dup-'))
    try {
      initRepo(r, 'main')
      git(r, ['config', 'user.email', 't@example.com'])
      git(r, ['config', 'user.name', 'T'])
      writeFileSync(join(r, 'dup.txt'), 'body\n')
      git(r, ['add', '-A'])
      git(r, ['commit', '-q', '-m', 'add dup'])
      // Stages a deletion; dup.txt stays in the worktree as UNTRACKED, so
      // porcelain emits two records ('D  dup.txt' + '?? dup.txt') for one path.
      git(r, ['rm', '--cached', '-q', 'dup.txt'])
      expect(statusFiles(r)).toEqual(['dup.txt'])
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  it('strips a secret file that appears in two states — filter runs BEFORE dedupe, so it is never leaked', () => {
    const r = mkdtempSync(join(tmpdir(), 'ds-status-secret-'))
    try {
      initRepo(r, 'main')
      git(r, ['config', 'user.email', 't@example.com'])
      git(r, ['config', 'user.name', 'T'])
      writeFileSync(join(r, '.env'), 'SECRET=x\n')
      git(r, ['add', '-f', '.env']) // force past any ignore
      git(r, ['commit', '-q', '-m', 'add .env'])
      git(r, ['rm', '--cached', '-q', '.env']) // staged delete + untracked = two records
      // Both records are secret-filtered away — the Set must not resurrect a
      // single ".env" from the deduped pair.
      expect(statusFiles(r)).toEqual([])
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  it('does not surface an untracked directory whose only visible children are secrets (--untracked-files=all)', () => {
    const r = mkdtempSync(join(tmpdir(), 'ds-status-secretdir-'))
    try {
      initRepo(r, 'main')
      git(r, ['config', 'user.email', 't@example.com'])
      git(r, ['config', 'user.name', 'T'])
      writeFileSync(join(r, 'keep.txt'), 'x\n')
      git(r, ['add', '-A'])
      git(r, ['commit', '-q', '-m', 'base'])
      mkdirSync(join(r, 'nested'))
      writeFileSync(join(r, 'nested', '.env'), 'SECRET=x\n')
      writeFileSync(join(r, 'nested', '.mcp.json'), '{}\n')
      // Every untracked non-ignored file under nested/ is a secret. Under the old
      // default `-unormal` git collapses them to `nested/`, which the per-basename
      // secret filter can't match → phantom dirty path. With `-uall` each file is
      // listed and stripped → empty.
      expect(statusFiles(r)).toEqual([])
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  it('KEEPS a nested untracked template file (.env.example) — a template is not a secret', () => {
    const r = mkdtempSync(join(tmpdir(), 'ds-status-tmpl-'))
    try {
      initRepo(r, 'main')
      git(r, ['config', 'user.email', 't@example.com'])
      git(r, ['config', 'user.name', 'T'])
      writeFileSync(join(r, 'keep.txt'), 'x\n')
      git(r, ['add', '-A'])
      git(r, ['commit', '-q', '-m', 'base'])
      mkdirSync(join(r, 'nested'))
      writeFileSync(join(r, 'nested', '.env.example'), 'SECRET=<put yours here>\n')
      // A template is NOT a secret — statusFiles uses the template-exempt
      // predicate, so a dirty template still shows up as work to commit.
      expect(statusFiles(r)).toEqual(['nested/.env.example'])
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
})

describe('statusFiles secret-safety on a rename endpoint', () => {
  it('redacts a secret whether it is the rename source OR the destination, keeping the other side', () => {
    // git mv config.txt .env  → destination is a secret: redact .env, keep config.txt.
    const r1 = mkdtempSync(join(tmpdir(), 'ds-rensec-dst-'))
    try {
      initRepo(r1, 'main')
      git(r1, ['config', 'user.email', 't@example.com'])
      git(r1, ['config', 'user.name', 'T'])
      writeFileSync(join(r1, 'config.txt'), 'x\n')
      git(r1, ['add', '-A'])
      git(r1, ['commit', '-q', '-m', 'base'])
      git(r1, ['mv', 'config.txt', '.env'])
      const files = statusFiles(r1)
      expect(files).not.toContain('.env') // secret destination redacted
      expect(files).toContain('config.txt') // removed source still reported
    } finally {
      rmSync(r1, { recursive: true, force: true })
    }
    // git mv .env config.txt → source is a secret: redact .env, keep config.txt.
    const r2 = mkdtempSync(join(tmpdir(), 'ds-rensec-src-'))
    try {
      initRepo(r2, 'main')
      git(r2, ['config', 'user.email', 't@example.com'])
      git(r2, ['config', 'user.name', 'T'])
      writeFileSync(join(r2, '.env'), 'SECRET=x\n')
      git(r2, ['add', '-f', '.env'])
      git(r2, ['commit', '-q', '-m', 'base'])
      git(r2, ['mv', '.env', 'config.txt'])
      const files = statusFiles(r2)
      expect(files).not.toContain('.env') // secret source redacted
      expect(files).toContain('config.txt') // new path still reported
    } finally {
      rmSync(r2, { recursive: true, force: true })
    }
  })
})

describe('committedSecretRefusal (workspace publish/land guard)', () => {
  // A workspace ref publishes the branch tip's REAL committed history, so a
  // secret committed anywhere reachable from it goes up verbatim. The guard is
  // asserted against the whole reachable closure, not just the tip's tree.
  const opts = { action: 'publish this workspace', then: 're-run the command' }

  const mkRepo = (): string => {
    const r = mkdtempSync(join(tmpdir(), 'ds-secret-refusal-'))
    initRepo(r, 'main')
    git(r, ['config', 'user.email', 't@example.com'])
    git(r, ['config', 'user.name', 'T'])
    writeFileSync(join(r, 'tracked.txt'), 'v1\n')
    git(r, ['add', '-A'])
    git(r, ['commit', '-q', '-m', 'base'])
    return r
  }

  it('refuses when a secret is committed in the history being published', () => {
    const r = mkRepo()
    try {
      // Force-commit a secret (it would normally be gitignored), then build a
      // normal commit on top — the leak is reachable through the ancestry even
      // though the tip's own tree no longer has to mention it.
      writeFileSync(join(r, '.env'), 'APP_OWNER_JWT=secret\n')
      git(r, ['add', '-f', '.env'])
      git(r, ['commit', '-q', '-m', 'oops committed .env'])
      const head = resolveCommit(r, 'HEAD')!

      const refusal = committedSecretRefusal(r, head, opts)
      expect(refusal).not.toBeNull()
      expect(refusal?.files).toContain('.env')
      expect(refusal?.code).toBe(SECRET_IN_HISTORY_CODE)
      // Names the offender and the untrack recipe — an agent must not have to
      // hunt for which file blocked the publish.
      expect(refusal?.message).toContain('.env')
      expect(refusal?.message).toContain('git rm --cached')
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  it('does NOT refuse for a dirty-but-uncommitted secret (nothing published carries it)', () => {
    const r = mkRepo()
    try {
      writeFileSync(join(r, '.env'), 'APP_OWNER_JWT=secret\n')
      writeFileSync(join(r, 'tracked.txt'), 'wip\n')
      expect(committedSecretRefusal(r, resolveCommit(r, 'HEAD'), opts)).toBeNull()
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  it('does NOT refuse for a committed secret-LESS template (.env.example)', () => {
    const r = mkRepo()
    try {
      writeFileSync(join(r, '.env.example'), 'SECRET=<yours>\n')
      git(r, ['add', '.env.example'])
      git(r, ['commit', '-q', '-m', 'add template'])
      expect(committedSecretRefusal(r, resolveCommit(r, 'HEAD'), opts)).toBeNull()
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  it('a null commit (unborn HEAD — nothing committed) is always clean', () => {
    const r = mkRepo()
    try {
      expect(committedSecretRefusal(r, null, opts)).toBeNull()
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
})

describe('trackedSecretFiles (push-side .dev.vars guard)', () => {
  let sdir: string
  const mk = (rel: string, body: string) => {
    const full = join(sdir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }

  beforeAll(() => {
    sdir = mkdtempSync(join(tmpdir(), 'ds-secrets-'))
    initRepo(sdir, 'main')
    git(sdir, ['config', 'user.email', 't@example.com'])
    git(sdir, ['config', 'user.name', 'T'])
    mk('src/index.ts', 'export {}\n')
    // Force-commit secret files at the root AND nested (monorepo) — .gitignore
    // would normally keep them out, so `-f` simulates the leak the guard catches.
    mk('.dev.vars', 'ROOT=secret\n')
    mk('.dev.vars.production', 'PROD=secret\n')
    mk('apps/web/.dev.vars', 'NESTED=secret\n')
    // Must NOT be flagged: secret-less templates, and look-alikes that are not
    // a `.dev.vars`/`.dev.vars.<suffix>` BASENAME.
    mk('.dev.vars.example', 'KEY=<put yours here>\n')
    mk('config/.dev.vars.sample', 'KEY=\n')
    mk('.dev.varsbackup', 'not a secret file\n')
    mk('foo.dev.vars', 'not a secret file\n')
    mk('.dev.vars.foo/inner.txt', 'file inside a dir merely named like a secret\n')
    git(sdir, ['add', '-A', '-f'])
    git(sdir, ['commit', '-q', '-m', 'oops committed secrets'])
  })
  afterAll(() => rmSync(sdir, { recursive: true, force: true }))

  it('detects tracked real .dev.vars* secrets at the root AND at any depth', () => {
    const found = trackedSecretFiles(sdir, 'HEAD').sort()
    expect(found).toEqual(['.dev.vars', '.dev.vars.production', 'apps/web/.dev.vars'])
  })

  it('does NOT flag templates or basename look-alikes', () => {
    const found = trackedSecretFiles(sdir, 'HEAD')
    // secret-less template variants (allowed to commit)
    expect(found).not.toContain('.dev.vars.example')
    expect(found).not.toContain('config/.dev.vars.sample')
    // not a `.dev.vars`/`.dev.vars.<suffix>` basename
    expect(found).not.toContain('.dev.varsbackup')
    expect(found).not.toContain('foo.dev.vars')
    // a file inside a directory merely named `.dev.vars.foo` is not a secret
    expect(found).not.toContain('.dev.vars.foo/inner.txt')
  })

  it('finds them from a subdirectory too (scans the whole repo, not the cwd prefix)', () => {
    const found = trackedSecretFiles(join(sdir, 'apps/web'), 'HEAD')
    expect(found).toContain('.dev.vars')
    expect(found).toContain('apps/web/.dev.vars')
  })

  it('returns nothing for a ref/tree with no secret files', () => {
    const clean = mkdtempSync(join(tmpdir(), 'ds-clean-'))
    try {
      initRepo(clean, 'main')
      git(clean, ['config', 'user.email', 't@example.com'])
      git(clean, ['config', 'user.name', 'T'])
      writeFileSync(join(clean, 'ok.txt'), 'fine\n')
      git(clean, ['add', '-A'])
      git(clean, ['commit', '-q', '-m', 'clean'])
      expect(trackedSecretFiles(clean, 'HEAD')).toEqual([])
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
  })
})

describe('trackedSecretFiles (extended families: .env/.npmrc/.mcp.json)', () => {
  // The starter is a Vite template, so the denylist covers more than wrangler's
  // `.dev.vars*`: `.env`/`.env.*`, `.npmrc` (auth tokens), `.mcp.json`.
  let edir: string
  const mk = (rel: string, body: string) => {
    const full = join(edir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }

  beforeAll(() => {
    edir = mkdtempSync(join(tmpdir(), 'ds-env-secrets-'))
    initRepo(edir, 'main')
    git(edir, ['config', 'user.email', 't@example.com'])
    git(edir, ['config', 'user.name', 'T'])
    mk('src/index.ts', 'export {}\n')
    // Real secrets at root AND nested (monorepo) — `-f` simulates the leak.
    mk('.env', 'SECRET=1\n')
    mk('.env.local', 'SECRET=2\n')
    mk('.npmrc', '//registry.npmjs.org/:_authToken=tok\n')
    mk('.envrc', 'export SECRET=1\n')
    mk('.mcp.json', '{"mcpServers":{}}\n')
    mk('upper/.ENV', 'SECRET=uppercase\n')
    mk('caps/.NPMRC', '//r/:_authToken=uppercase\n')
    mk('apps/web/.env', 'NESTED=1\n')
    mk('apps/web/.npmrc', '//r/:_authToken=nested\n')
    mk('apps/web/.envrc', 'export NESTED=1\n')
    // Must NOT be flagged: secret-less templates, and mid-name look-alikes whose
    // basename is not one of the secret segments.
    mk('.env.example', 'SECRET=<put yours here>\n')
    mk('config/.env.sample', 'K=\n')
    mk('upper/.ENV.EXAMPLE', 'SECRET=<put yours here>\n')
    mk('foo.env', 'not a secret\n')
    mk('preview.env.ts', 'export {}\n')
    git(edir, ['add', '-A', '-f'])
    git(edir, ['commit', '-q', '-m', 'oops committed secrets'])
  })
  afterAll(() => rmSync(edir, { recursive: true, force: true }))

  it('flags real .env/.npmrc/.mcp.json secrets at the root AND at any depth', () => {
    expect(trackedSecretFiles(edir, 'HEAD').sort()).toEqual(
      [
        '.env',
        '.env.local',
        '.envrc',
        '.mcp.json',
        '.npmrc',
        'apps/web/.env',
        'apps/web/.envrc',
        'apps/web/.npmrc',
        'caps/.NPMRC',
        'upper/.ENV',
      ].sort(),
    )
  })

  it('does NOT flag .env templates or mid-name look-alikes', () => {
    const found = trackedSecretFiles(edir, 'HEAD')
    expect(found).not.toContain('.env.example')
    expect(found).not.toContain('config/.env.sample')
    expect(found).not.toContain('upper/.ENV.EXAMPLE')
    expect(found).not.toContain('foo.env')
    expect(found).not.toContain('preview.env.ts')
  })
})

describe('control characters in paths (-z / NUL-delimited output)', () => {
  // Git allows any byte except NUL and `/` in a path component — a newline and a
  // tab included. WITHOUT `-z`, git C-QUOTES such a path (even under
  // core.quotePath=false), so a `\n`-split fragments the listing AND the trailing
  // quote pushes the basename off the `$` anchor — a crafted `<newline>.env` then
  // evades the secret regex. The `-z` conversions read literal NUL-delimited
  // bytes, so each path stays one intact field and the secret is still caught.
  const CTRL = 'pa\t\nrent' // one dir name carrying BOTH a tab and a newline

  const setup = (): string => {
    const r = mkdtempSync(join(tmpdir(), 'ds-ctrl-'))
    initRepo(r, 'main')
    git(r, ['config', 'user.email', 't@example.com'])
    git(r, ['config', 'user.name', 'T'])
    writeFileSync(join(r, 'base.txt'), 'base\n')
    git(r, ['add', '-A'])
    git(r, ['commit', '-q', '-m', 'base'])
    return r
  }
  const mk = (root: string, rel: string, body: string) => {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }

  it('statusFiles returns a control-char path as ONE field, never fragmented', () => {
    const r = setup()
    try {
      const path = `${CTRL}/tracked.txt`
      mk(r, path, 'v1\n')
      git(r, ['add', '-A'])
      git(r, ['commit', '-q', '-m', 'add control-char tracked file'])
      writeFileSync(join(r, path), 'v2 dirty\n')
      // A `\n`-split would surface `pa\t` and `rent/tracked.txt` — here it's one.
      expect(statusFiles(r)).toEqual([path])
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  it('trackedSecretFiles flags a committed <newline>.env as ONE intact path (no quote-evasion)', () => {
    const r = setup()
    try {
      const secret = `${CTRL}/.env`
      mk(r, secret, 'APP_OWNER_JWT=leak\n')
      mk(r, `${CTRL}/keep.ts`, 'export {}\n')
      git(r, ['add', '-A', '-f'])
      git(r, ['commit', '-q', '-m', 'oops committed a control-char secret'])
      // Exactly the one secret, with its literal newline+tab — matched because
      // it is one field, not a C-quoted `"pa\t\nrent/.env"` that ends in `"`.
      expect(trackedSecretFiles(r, 'HEAD')).toEqual([secret])
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  it('statusFiles reports a rename to a control-char path as both clean sides (new + old), newline-safe', () => {
    const r = setup()
    try {
      mk(r, 'rename-me.txt', 'stable body for rename detection\n')
      git(r, ['add', '-A'])
      git(r, ['commit', '-q', '-m', 'to be renamed'])
      const newPath = 'pa\t\nrenamed.txt'
      git(r, ['mv', 'rename-me.txt', newPath])
      // `-z` porcelain emits `R <new>\0<old>\0`: the NEW path (with its embedded
      // tab/newline) is one literal field and the trailing OLD field is a second.
      // Both are reported as clean separate entries — never the raw `old -> new`
      // blob — and the newline never splits a record.
      const files = statusFiles(r)
      expect(files).toContain(newPath)
      expect(files).toContain('rename-me.txt')
      expect(files).toHaveLength(2)
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
})

describe('findOversizedObjects', () => {
  it('names committed blobs over the cap, biggest first, and skips small ones', () => {
    const r = mkdtempSync(join(tmpdir(), 'ds-oversized-'))
    try {
      initRepo(r, 'main')
      git(r, ['config', 'user.email', 'test@example.com'])
      git(r, ['config', 'user.name', 'Test'])
      writeFileSync(join(r, 'big.bin'), 'x'.repeat(5000))
      writeFileSync(join(r, 'bigger.bin'), 'y'.repeat(9000))
      writeFileSync(join(r, 'small.txt'), 'ok\n')
      git(r, ['add', '-A'])
      git(r, ['commit', '-q', '-m', 'add files'])
      // Cap between small and big → both large blobs named, largest first; the
      // tiny file (and the tree/commit objects) are excluded.
      const hits = findOversizedObjects(r, 1000)
      expect(hits.map((h) => h.path)).toEqual(['bigger.bin', 'big.bin'])
      expect(hits[0].bytes).toBe(9000)
      expect(hits.some((h) => h.path === 'small.txt')).toBe(false)
      // limit caps the count.
      expect(findOversizedObjects(r, 1000, 1).map((h) => h.path)).toEqual(['bigger.bin'])
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })

  it('returns [] on a non-repo dir (advisory — never throws into a push error)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ds-oversized-nonrepo-'))
    try {
      expect(findOversizedObjects(empty, 1)).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
