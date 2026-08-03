import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  detectClaudeWorktree,
  detectLinkedWorktree,
  deriveWorktreePort,
  resolveWorktreePort,
  resolveAppLaunchPort,
  upsertWorktreeLaunchConfig,
  writeLaunchConfigIfMissing,
} from '../lib/launch-config'

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

function initGitRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  git(repo, ['init', '--quiet', '--initial-branch=main'])
  git(repo, ['config', 'user.name', 'DeepSpace Test'])
  git(repo, ['config', 'user.email', 'test@deep.space'])
  writeFileSync(join(repo, 'tracked.txt'), 'initial\n')
  git(repo, ['add', 'tracked.txt'])
  git(repo, ['commit', '--quiet', '-m', 'initial'])
  return repo
}

function addClaudeWorktree(owner: string, name: string): string {
  const worktree = join(owner, '.claude', 'worktrees', name)
  git(owner, ['worktree', 'add', '--quiet', '-b', `test/${name}`, worktree, 'HEAD'])
  return worktree
}

describe('detectClaudeWorktree', () => {
  let root: string

  beforeEach(() => {
    root = initGitRepo('ds detect wt-')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns null outside a worktree', () => {
    expect(detectClaudeWorktree(root)).toBeNull()
  })

  it('detects an app at the worktree root', () => {
    const appDir = addClaudeWorktree(root, 'feature-x')
    expect(detectClaudeWorktree(appDir)).toEqual({
      mainRepoRoot: realpathSync(root),
      worktreeName: 'feature-x',
    })
  })

  it('detects an app nested below the worktree root', () => {
    const worktree = addClaudeWorktree(root, 'feature-x')
    const appDir = join(worktree, 'apps', 'web')
    mkdirSync(appDir, { recursive: true })
    expect(detectClaudeWorktree(appDir)).toEqual({
      mainRepoRoot: realpathSync(root),
      worktreeName: 'feature-x',
    })
  })

  it('uses Git identity when the app is reached through a symlink', () => {
    const worktree = addClaudeWorktree(root, 'feature-x')
    const alias = join(tmpdir(), `${basename(root)}-alias`)
    symlinkSync(worktree, alias, 'dir')
    try {
      expect(detectClaudeWorktree(alias)).toEqual({
        mainRepoRoot: realpathSync(root),
        worktreeName: 'feature-x',
      })
    } finally {
      rmSync(alias, { force: true })
    }
  })

  it('ignores fake Claude-shaped segments below a real worktree root', () => {
    const worktree = addClaudeWorktree(root, 'feature-x')
    const appDir = join(worktree, 'fixtures', '.claude', 'worktrees', 'not-a-checkout')
    mkdirSync(appDir, { recursive: true })
    expect(detectClaudeWorktree(appDir)).toEqual({
      mainRepoRoot: realpathSync(root),
      worktreeName: 'feature-x',
    })
  })

  it('ignores a bare .claude dir without worktrees', () => {
    expect(detectClaudeWorktree(join(root, '.claude', 'skills'))).toBeNull()
  })

  it('rejects a matching path that is not a registered Git worktree', () => {
    const ordinaryDir = join(root, '.claude', 'worktrees', 'ordinary', 'apps', 'web')
    mkdirSync(ordinaryDir, { recursive: true })
    expect(detectClaudeWorktree(ordinaryDir)).toBeNull()
  })

  it('uses the innermost worktree for nested worktrees', () => {
    // Nested worktrees are created by a session rooted at the outer worktree,
    // so the outer worktree's launch.json is the one its preview tool reads.
    const outer = addClaudeWorktree(root, 'outer')
    const appDir = addClaudeWorktree(outer, 'inner')
    expect(detectClaudeWorktree(appDir)).toEqual({
      mainRepoRoot: realpathSync(outer),
      worktreeName: 'inner',
    })
  })

  it('detects Codex and arbitrary native worktrees without calling them Claude worktrees', () => {
    const codexDir = join(root, '.codex', 'worktrees', 'id', 'app')
    git(root, ['worktree', 'add', '--quiet', '--detach', codexDir, 'HEAD'])
    expect(detectLinkedWorktree(codexDir)).toEqual({
      worktreeRoot: realpathSync(codexDir),
      mainRepoRoot: realpathSync(root),
    })
    expect(detectClaudeWorktree(codexDir)).toBeNull()
  })

  it('still detects an active checkout when another registration is stale', () => {
    const stale = addClaudeWorktree(root, 'stale')
    rmSync(stale, { recursive: true, force: true })
    const active = addClaudeWorktree(root, 'active')
    expect(detectClaudeWorktree(active)).toEqual({
      mainRepoRoot: realpathSync(root),
      worktreeName: 'active',
    })
  })
})

describe('deriveWorktreePort', () => {
  it('is stable for the same canonical worktree key', () => {
    expect(deriveWorktreePort('feature-x')).toBe(deriveWorktreePort('feature-x'))
  })

  it('stays in 5180-6179 and avoids the default 5173', () => {
    for (const name of ['a', 'feature-x', 'nurture-ui', 'x'.repeat(80)]) {
      const port = deriveWorktreePort(name)
      expect(port).toBeGreaterThanOrEqual(5180)
      expect(port).toBeLessThanOrEqual(6179)
    }
  })
})

describe('upsertWorktreeLaunchConfig', () => {
  let mainRepo: string
  let appDir: string

  beforeEach(() => {
    mainRepo = mkdtempSync(join(tmpdir(), 'ds-launch-'))
    appDir = join(mainRepo, '.claude', 'worktrees', 'feature-x')
    mkdirSync(appDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(mainRepo, { recursive: true, force: true })
  })

  const launchPath = () => join(mainRepo, '.claude', 'launch.json')
  const readConfig = () => JSON.parse(readFileSync(launchPath(), 'utf-8'))

  it('creates launch.json with the worktree entry when absent', () => {
    const result = upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })
    expect(result).toEqual({ entryName: 'wt-feature-x', port: 5186 })
    const config = readConfig()
    expect(config.configurations).toEqual([
      {
        name: 'wt-feature-x',
        runtimeExecutable: 'npx',
        runtimeArgs: ['deepspace', 'dev', 'start', '--port', '5186'],
        port: 5186,
        cwd: appDir,
      },
    ])
  })

  it('preserves extra args (--prod / --env) in the entry', () => {
    upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, {
      port: 5186,
      extraArgs: ['--prod', '--env', 'staging'],
    })
    const entry = readConfig().configurations[0]
    expect(entry.runtimeArgs).toEqual([
      'deepspace',
      'dev',
      'start',
      '--port',
      '5186',
      '--prod',
      '--env',
      'staging',
    ])
  })

  it('probes past a port claimed by another entry', () => {
    writeFileSync(
      launchPath(),
      JSON.stringify({
        version: '0.0.1',
        configurations: [
          { name: 'my-app', port: 5186 },
          { name: 'wt-other', port: 5187, cwd: appDir },
        ],
      }),
    )
    const result = upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, {
      port: 5186,
      probePort: true,
    })
    expect(result!.port).toBe(5188)
    const entry = readConfig().configurations.find(
      (c: { name: string }) => c.name === 'wt-feature-x',
    )
    expect(entry.port).toBe(5188)
    expect(entry.runtimeArgs).toContain('5188')
  })

  it('does not probe when probePort is off (explicit --port)', () => {
    writeFileSync(
      launchPath(),
      JSON.stringify({ version: '0.0.1', configurations: [{ name: 'my-app', port: 5186 }] }),
    )
    const result = upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })
    expect(result!.port).toBe(5186)
  })

  it('keeps its own previous port out of the probe (re-run is stable)', () => {
    upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186, probePort: true })
    const rerun = upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, {
      port: 5186,
      probePort: true,
    })
    expect(rerun!.port).toBe(5186)
  })

  it('preserves existing entries and updates its own in place', () => {
    writeFileSync(
      launchPath(),
      JSON.stringify({
        version: '0.0.1',
        configurations: [
          {
            name: 'my-app',
            runtimeExecutable: 'npx',
            runtimeArgs: ['deepspace', 'dev', 'start'],
            port: 5173,
          },
          {
            name: 'wt-feature-x',
            runtimeExecutable: 'npx',
            runtimeArgs: [],
            port: 5999,
            cwd: appDir,
          },
        ],
      }),
    )
    upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })
    const config = readConfig()
    expect(config.configurations).toHaveLength(2)
    expect(config.configurations[0].name).toBe('my-app')
    const entry = config.configurations.find((c: { name: string }) => c.name === 'wt-feature-x')
    expect(entry.port).toBe(5186)
    expect(entry.cwd).toBe(appDir)
  })

  it('prunes stale wt-* entries whose cwd is gone, keeps live ones', () => {
    const liveDir = join(mainRepo, '.claude', 'worktrees', 'other')
    mkdirSync(liveDir, { recursive: true })
    writeFileSync(
      launchPath(),
      JSON.stringify({
        version: '0.0.1',
        configurations: [
          { name: 'wt-deleted', port: 5190, cwd: join(mainRepo, '.claude', 'worktrees', 'gone') },
          { name: 'wt-other', port: 5191, cwd: liveDir },
          { name: 'my-app', port: 5173 },
        ],
      }),
    )
    upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })
    const names = readConfig().configurations.map((c: { name: string }) => c.name)
    expect(names).toEqual(['wt-other', 'my-app', 'wt-feature-x'])
  })

  it('never prunes non-wt entries even if their cwd is gone', () => {
    writeFileSync(
      launchPath(),
      JSON.stringify({
        version: '0.0.1',
        configurations: [{ name: 'custom', port: 5000, cwd: join(mainRepo, 'nope') }],
      }),
    )
    upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })
    const names = readConfig().configurations.map((c: { name: string }) => c.name)
    expect(names).toEqual(['custom', 'wt-feature-x'])
  })

  it('never prunes wt-* entries whose cwd is outside .claude/worktrees', () => {
    writeFileSync(
      launchPath(),
      JSON.stringify({
        version: '0.0.1',
        configurations: [
          { name: 'wt-storybook', port: 5195, cwd: join(mainRepo, 'somewhere', 'gone') },
        ],
      }),
    )
    upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })
    const names = readConfig().configurations.map((c: { name: string }) => c.name)
    expect(names).toEqual(['wt-storybook', 'wt-feature-x'])
  })

  it('never prunes wt-* entries with a relative cwd', () => {
    writeFileSync(
      launchPath(),
      JSON.stringify({
        version: '0.0.1',
        configurations: [{ name: 'wt-docs', port: 5195, cwd: 'relative/does-not-exist' }],
      }),
    )
    upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })
    const names = readConfig().configurations.map((c: { name: string }) => c.name)
    expect(names).toEqual(['wt-docs', 'wt-feature-x'])
  })

  it('treats a string-valued port as claimed when probing', () => {
    writeFileSync(
      launchPath(),
      JSON.stringify({ version: '0.0.1', configurations: [{ name: 'my-app', port: '5186' }] }),
    )
    const result = upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, {
      port: 5186,
      probePort: true,
    })
    expect(result!.port).toBe(5187)
  })

  it('self-heals an empty launch.json instead of failing', () => {
    writeFileSync(launchPath(), '')
    const result = upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })
    expect(result).toEqual({ entryName: 'wt-feature-x', port: 5186 })
    expect(readConfig().configurations).toHaveLength(1)
  })

  it('returns null and leaves a malformed file untouched', () => {
    writeFileSync(launchPath(), 'not json {')
    expect(upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })).toBeNull()
    expect(readFileSync(launchPath(), 'utf-8')).toBe('not json {')
  })

  it('returns null on a valid-JSON file with the wrong shape', () => {
    writeFileSync(launchPath(), JSON.stringify({ configurations: 'nope' }))
    expect(upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })).toBeNull()
  })

  it('treats an empty file as absent and self-heals', () => {
    writeFileSync(launchPath(), '')
    const result = upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })
    expect(result).toEqual({ entryName: 'wt-feature-x', port: 5186 })
  })

  it('parses a file with a UTF-8 BOM', () => {
    writeFileSync(
      launchPath(),
      '\uFEFF' +
        JSON.stringify({ version: '0.0.1', configurations: [{ name: 'my-app', port: 5173 }] }),
    )
    const result = upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })
    expect(result).toEqual({ entryName: 'wt-feature-x', port: 5186 })
    expect(readConfig().configurations.map((c: { name: string }) => c.name)).toEqual([
      'my-app',
      'wt-feature-x',
    ])
  })
})

describe('writeLaunchConfigIfMissing', () => {
  let mainRepo: string

  beforeEach(() => {
    mainRepo = mkdtempSync(join(tmpdir(), 'ds-seed-'))
  })

  afterEach(() => {
    rmSync(mainRepo, { recursive: true, force: true })
  })

  const launchPath = () => join(mainRepo, '.claude', 'launch.json')
  const readConfig = () => JSON.parse(readFileSync(launchPath(), 'utf-8'))

  it('creates the file with the app entry when absent', () => {
    writeLaunchConfigIfMissing(mainRepo, 'my-app', 5173)
    expect(readConfig().configurations).toEqual([
      {
        name: 'my-app',
        runtimeExecutable: 'npx',
        runtimeArgs: ['deepspace', 'dev', 'start', '--port', '5173'],
        port: 5173,
      },
    ])
  })

  it('appends the app entry to a file created by a worktree upsert', () => {
    const appDir = join(mainRepo, '.claude', 'worktrees', 'feature-x')
    mkdirSync(appDir, { recursive: true })
    upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5186 })
    writeLaunchConfigIfMissing(mainRepo, 'my-app', 5173)
    const names = readConfig().configurations.map((c: { name: string }) => c.name)
    expect(names).toEqual(['wt-feature-x', 'my-app'])
  })

  it('never touches an existing entry with the same name', () => {
    mkdirSync(join(mainRepo, '.claude'), { recursive: true })
    writeFileSync(
      launchPath(),
      JSON.stringify({
        version: '0.0.1',
        configurations: [{ name: 'my-app', runtimeExecutable: 'bun', runtimeArgs: [], port: 4000 }],
      }),
    )
    writeLaunchConfigIfMissing(mainRepo, 'my-app', 5173)
    const entry = readConfig().configurations[0]
    expect(entry.runtimeExecutable).toBe('bun')
    expect(entry.port).toBe(4000)
    expect(readConfig().configurations).toHaveLength(1)
  })

  it('leaves a malformed file untouched', () => {
    mkdirSync(join(mainRepo, '.claude'), { recursive: true })
    writeFileSync(launchPath(), 'not json {')
    writeLaunchConfigIfMissing(mainRepo, 'my-app', 5173)
    expect(readFileSync(launchPath(), 'utf-8')).toBe('not json {')
  })

  // DEV-3: `dev --port` must resync the existing entry.
  it('updates an existing entry port + --port arg when updatePort is set (DEV-3)', () => {
    mkdirSync(join(mainRepo, '.claude'), { recursive: true })
    writeFileSync(
      launchPath(),
      JSON.stringify({
        version: '0.0.1',
        configurations: [
          {
            name: 'my-app',
            runtimeExecutable: 'npx',
            runtimeArgs: ['deepspace', 'dev', 'start', '--port', '5173', '--env', 'staging'],
            port: 5173,
          },
        ],
      }),
    )
    writeLaunchConfigIfMissing(mainRepo, 'my-app', 5180, { updatePort: true })
    const entry = readConfig().configurations[0]
    expect(entry.port).toBe(5180)
    // --port value updated; the user's other args (--env staging) preserved.
    expect(entry.runtimeArgs).toEqual([
      'deepspace',
      'dev',
      'start',
      '--port',
      '5180',
      '--env',
      'staging',
    ])
    expect(readConfig().configurations).toHaveLength(1)
  })

  it('resyncs a stale runtimeArgs --port even when the port field already matches', () => {
    mkdirSync(join(mainRepo, '.claude'), { recursive: true })
    writeFileSync(
      launchPath(),
      JSON.stringify({
        version: '0.0.1',
        configurations: [
          {
            name: 'my-app',
            runtimeExecutable: 'npx',
            // port field is 5180 but runtimeArgs still says 5173 (divergent).
            runtimeArgs: ['deepspace', 'dev', 'start', '--port', '5173'],
            port: 5180,
          },
        ],
      }),
    )
    writeLaunchConfigIfMissing(mainRepo, 'my-app', 5180, { updatePort: true })
    const entry = readConfig().configurations[0]
    expect(entry.port).toBe(5180)
    expect(entry.runtimeArgs).toEqual(['deepspace', 'dev', 'start', '--port', '5180'])
  })

  it('does NOT update an existing entry without updatePort (default)', () => {
    mkdirSync(join(mainRepo, '.claude'), { recursive: true })
    writeFileSync(
      launchPath(),
      JSON.stringify({
        version: '0.0.1',
        configurations: [{ name: 'my-app', runtimeExecutable: 'npx', runtimeArgs: [], port: 5173 }],
      }),
    )
    writeLaunchConfigIfMissing(mainRepo, 'my-app', 5180)
    expect(readConfig().configurations[0].port).toBe(5173)
  })
})

describe('resolveAppLaunchPort (DEV-2)', () => {
  let appDir: string
  beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), 'ds-applaunch-'))
  })
  afterEach(() => rmSync(appDir, { recursive: true, force: true }))

  const writeLaunch = (configs: unknown[]) => {
    mkdirSync(join(appDir, '.claude'), { recursive: true })
    writeFileSync(
      join(appDir, '.claude', 'launch.json'),
      JSON.stringify({ version: '0.0.1', configurations: configs }),
    )
  }

  it('returns the port of the entry matching the app name (from wrangler.toml)', () => {
    writeFileSync(join(appDir, 'wrangler.toml'), 'name = "my-app"\n')
    writeLaunch([
      { name: 'other', port: 1234 },
      { name: 'my-app', port: 8790 },
    ])
    expect(resolveAppLaunchPort(appDir)).toBe(8790)
  })

  it('falls back to the sole entry when the name does not match', () => {
    writeLaunch([{ name: 'whatever', port: 4321 }])
    expect(resolveAppLaunchPort(appDir)).toBe(4321)
  })

  it('returns null when multiple entries exist and none match the app name', () => {
    // Must NOT pick an arbitrary entry — that would make `kill` target another
    // app's port.
    writeFileSync(join(appDir, 'wrangler.toml'), 'name = "my-app"\n')
    writeLaunch([
      { name: 'other-a', port: 1111 },
      { name: 'other-b', port: 2222 },
    ])
    expect(resolveAppLaunchPort(appDir)).toBeNull()
  })

  it('returns null when there is no launch.json', () => {
    expect(resolveAppLaunchPort(appDir)).toBeNull()
  })

  it('returns null on a malformed launch.json', () => {
    mkdirSync(join(appDir, '.claude'), { recursive: true })
    writeFileSync(join(appDir, '.claude', 'launch.json'), 'not json {')
    expect(resolveAppLaunchPort(appDir)).toBeNull()
  })
})

describe('resolveWorktreePort', () => {
  let mainRepo: string
  let appDir: string

  beforeEach(() => {
    mainRepo = initGitRepo('ds-wtport-')
    appDir = addClaudeWorktree(mainRepo, 'feature-x')
  })

  afterEach(() => {
    rmSync(mainRepo, { recursive: true, force: true })
  })

  it('returns null outside a worktree', () => {
    expect(resolveWorktreePort(mainRepo)).toBeNull()
  })

  it('returns the wt entry port written by dev (including probing)', () => {
    upsertWorktreeLaunchConfig(mainRepo, 'feature-x', appDir, { port: 5191 })
    expect(resolveWorktreePort(appDir)).toBe(5191)
  })

  it('falls back to the derived port when no entry exists yet', () => {
    expect(resolveWorktreePort(appDir)).toBe(deriveWorktreePort(realpathSync(appDir)))
  })

  it('falls back to the derived port on a malformed launch.json', () => {
    mkdirSync(join(mainRepo, '.claude'), { recursive: true })
    writeFileSync(join(mainRepo, '.claude', 'launch.json'), 'not json {')
    expect(resolveWorktreePort(appDir)).toBe(deriveWorktreePort(realpathSync(appDir)))
  })

  it('isolates a non-Claude native worktree by canonical checkout path', () => {
    const native = join(mainRepo, '..', `${basename(mainRepo)}-native`)
    git(mainRepo, ['worktree', 'add', '--quiet', '--detach', native, 'HEAD'])
    try {
      expect(resolveWorktreePort(native)).toBe(deriveWorktreePort(realpathSync(native)))
    } finally {
      git(mainRepo, ['worktree', 'remove', '--force', native])
    }
  })
})
