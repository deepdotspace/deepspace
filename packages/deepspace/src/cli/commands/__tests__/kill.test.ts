/**
 * DEV-1: `kill` must never report the port free when it couldn't actually
 * inspect the system (no lsof/pgrep and no /proc). noTargetsMessage encodes
 * that decision; these tests would fail if it regressed to always-ok.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { noTargetsMessage, readPowershellPids } from '../kill'

const PS_OK = '__deepspace_ps_ok__'

describe('noTargetsMessage (DEV-1)', () => {
  it('reports "nothing listening" when the port was inspected and empty', () => {
    const r = noTargetsMessage({ enumerated: true, swept: false, all: false, port: 5173 })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('Nothing listening on :5173')
  })

  it('ERRORS (not ok) when nothing could be inspected — no lsof/pgrep/proc', () => {
    const r = noTargetsMessage({ enumerated: false, swept: false, all: false, port: 8790 })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("Couldn't determine")
    expect(r.message).toContain('8790')
  })

  it('is ok under --all when the name-sweep ran, even if the port was not enumerable', () => {
    const r = noTargetsMessage({ enumerated: false, swept: true, all: true, port: 5173 })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('no stray workerd/wrangler/vite')
  })

  it('ERRORS under --all when neither the port nor the name-sweep could run', () => {
    const r = noTargetsMessage({ enumerated: false, swept: false, all: true, port: 5173 })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("Couldn't determine")
  })

  it('is ok when the port was enumerated even if --all sweep could not run', () => {
    const r = noTargetsMessage({ enumerated: true, swept: false, all: true, port: 5173 })
    expect(r.ok).toBe(true)
  })

  // The refusal has to name a tool the platform actually has. Windows ships
  // neither lsof nor procps and needs neither; pointing a Windows user at them
  // is an instruction they cannot follow.
  it('names PowerShell, not lsof/procps, when it cannot inspect on Windows', () => {
    const r = noTargetsMessage({
      enumerated: false,
      swept: false,
      all: false,
      port: 5173,
      platform: 'win32',
    })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("Couldn't determine")
    expect(r.message).toContain('PowerShell')
    // netstat, not Get-NetTCPConnection: one reason we get here is that
    // Get-NetTCPConnection itself is unavailable, so the remedy must not be
    // the very cmdlet that just failed. netstat ships with every Windows.
    expect(r.message).toContain('netstat -ano | findstr :5173')
    expect(r.message).not.toContain('lsof')
    expect(r.message).not.toContain('procps')
  })

  it('keeps the lsof/procps remedy on posix', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const r = noTargetsMessage({ enumerated: false, swept: false, all: false, port: 5173, platform })
      expect(r.ok).toBe(false)
      expect(r.message).toContain('lsof')
      expect(r.message).toContain('procps')
      expect(r.message).not.toContain('PowerShell')
    }
  })

  it('reports "nothing listening" identically on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const r = noTargetsMessage({ enumerated: true, swept: false, all: false, port: 5173, platform })
      expect(r.ok).toBe(true)
      expect(r.message).toContain('Nothing listening on :5173')
    }
  })
})

/**
 * The Windows regression this encodes: `powershell.exe -Command` exits with the
 * status of the LAST command, and `-ErrorAction SilentlyContinue` leaves `$?`
 * false after "no matching connection" — so a FREE port exited 1 and was read
 * as "PowerShell is absent", turning every `dev kill` against a free port into
 * the DEV-1 refusal. Completion is proven by a sentinel, never by exit code.
 */
describe('readPowershellPids (Windows: found-nothing is not a failure)', () => {
  it('treats a sentinel with no pids as "ran, nothing listening"', () => {
    expect(readPowershellPids(`${PS_OK}\n`)).toEqual({ pids: [], ran: true })
  })

  it('parses pids that precede the sentinel', () => {
    expect(readPowershellPids(`4321\n8765\n${PS_OK}\n`)).toEqual({ pids: [4321, 8765], ran: true })
  })

  it('never lets the sentinel itself parse as a pid', () => {
    expect(readPowershellPids(`${PS_OK}\n`).pids).toEqual([])
  })

  it('reports ran:false when the sentinel is missing (query could not run)', () => {
    expect(readPowershellPids('')).toEqual({ pids: [], ran: false })
    expect(readPowershellPids('Get-NoSuch : not recognized\n')).toEqual({ pids: [], ran: false })
  })

  it('discards pids from a run that never reached the sentinel', () => {
    // Partial output without the marker is not a trustworthy answer.
    expect(readPowershellPids('4321\n')).toEqual({ pids: [], ran: false })
  })
})

/**
 * The pure helper above can be right while the caller still reads the exit
 * code — which is exactly the bug. These drive `enumerateListeners` through a
 * mocked spawnSync on a forced win32, so a revert of runPowershellChecked to
 * `ran: r.status === 0` fails here even if the helper is left untouched.
 */
describe('enumerateListeners on Windows (wrapper + sentinel, end to end)', () => {
  const realPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    vi.doUnmock('node:child_process')
    vi.resetModules()
  })

  /** Load kill.ts as if on Windows, with every spawnSync call captured. */
  async function loadOnWindows(query: { status: number | null; stdout: string }) {
    const commands: string[] = []
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      spawnSync: (_exe: string, args: string[]) => {
        const script = args[args.length - 1]
        // First call is the `pwsh` availability probe; fail it so the code
        // falls back to powershell.exe, the shape that shipped the bug.
        if (script.includes('PSVersionTable')) return { status: 1, stdout: '' }
        commands.push(script)
        return { status: query.status, stdout: query.stdout }
      },
    }))
    const mod = await import('../kill')
    return { mod, commands }
  }

  const SENTINEL = '__deepspace_ps_ok__'

  it('THE REGRESSION: exit 1 with a sentinel is "ran, nothing listening"', async () => {
    const { mod } = await loadOnWindows({ status: 1, stdout: `${SENTINEL}\n` })
    // Exit 1 is what a FREE port produces. Reading it as failure is the bug.
    expect(mod.enumerateListeners(5173)).toEqual({ pids: [], enumerated: true })
  })

  it('THE REGRESSION: exit 1 with a sentinel still yields the pids', async () => {
    const { mod } = await loadOnWindows({ status: 1, stdout: `4321\n${SENTINEL}\n` })
    expect(mod.enumerateListeners(5173)).toEqual({ pids: [4321], enumerated: true })
  })

  it('treats a missing sentinel as "could not inspect", even on exit 0', async () => {
    const { mod } = await loadOnWindows({ status: 0, stdout: '' })
    expect(mod.enumerateListeners(5173)).toEqual({ pids: [], enumerated: false })
  })

  it('actually wraps the query so a terminating failure skips the sentinel', async () => {
    const { mod, commands } = await loadOnWindows({ status: 0, stdout: `${SENTINEL}\n` })
    mod.enumerateListeners(5173)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("$ErrorActionPreference='Stop'")
    expect(commands[0]).toContain('try {')
    expect(commands[0]).toContain(`'${SENTINEL}'`)
    expect(commands[0]).toContain('catch { }')
  })

  it('excludes the PowerShell helper from its own --all sweep', async () => {
    // The search terms are written INTO this command line, so without
    // `$_.ProcessId -ne $PID` the query matches itself and `--all` reports
    // "Killed 1 process(es)" on a machine with nothing running.
    const { mod, commands } = await loadOnWindows({ status: 0, stdout: `${SENTINEL}\n` })
    mod.sweepByName(['workerd', 'wrangler', 'vite'])
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('$_.ProcessId -ne $PID')
    // The self-exclusion must gate the WHOLE name filter, not just its first
    // clause: `-and` binds tighter than `-or`, so without the wrapping paren
    // `X -and A -or B` is `(X -and A) -or B` and every clause after the first
    // lets the helper straight back in.
    //
    // Assert on `-and ((` — the wrapper's paren followed by the first clause's
    // own paren. A regex like /-ne \$PID -and \(.*\)/ looks like it pins this
    // and does NOT: each clause is already parenthesised, so `-and (` matches
    // the first clause's paren and the test passes with the wrapper deleted.
    expect(commands[0]).toContain('-and ((')
  })

  it('still matches on CommandLine, keeping parity with posix pgrep -f', async () => {
    const { mod, commands } = await loadOnWindows({ status: 0, stdout: `${SENTINEL}\n` })
    mod.sweepByName(['workerd', 'vite'])
    expect(commands[0]).toContain("$_.CommandLine -like '*workerd*'")
    expect(commands[0]).toContain("$_.CommandLine -like '*vite*'")
    expect(commands[0]).toContain("$_.Name -like '*vite*'")
  })

  it('sweeps pids and reports swept, and drops the node pid', async () => {
    const { mod } = await loadOnWindows({
      status: 1, // a free/empty result still exits 1 — must not read as failure
      stdout: `4321\n${process.pid}\n8765\n${SENTINEL}\n`,
    })
    const r = mod.sweepByName(['workerd'])
    expect(r.swept).toBe(true)
    expect(r.pids).toEqual([4321, 8765])
    expect(r.pids).not.toContain(process.pid)
  })

  it('keeps -ErrorAction SilentlyContinue on the port query', async () => {
    // Without it the free-port case terminates under the Stop preference and
    // `kill` refuses again — the original bug by a different route.
    const { mod, commands } = await loadOnWindows({ status: 0, stdout: `${SENTINEL}\n` })
    mod.enumerateListeners(5173)
    expect(commands[0]).toContain('Get-NetTCPConnection -LocalPort 5173 -State Listen')
    expect(commands[0]).toContain('-ErrorAction SilentlyContinue')
  })
})
