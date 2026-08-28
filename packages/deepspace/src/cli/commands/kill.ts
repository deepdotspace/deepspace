/**
 * deepspace dev kill [--port N] [--all]
 *
 * Stops a local dev server bound to the given port, plus the workerd
 * child processes that wrangler/Vite would normally clean up but
 * sometimes leak when the parent dies ungracefully (Ctrl-C in a
 * detached terminal, IDE close, sandbox deny on signal, etc).
 *
 *   deepspace dev kill                  # kill listener on 5173 + its workerd children
 *   deepspace dev kill --port 5180      # kill listener on a different port
 *   deepspace dev kill --all            # also sweep ALL stray workerd/wrangler procs on the machine
 *
 * Cross-platform: uses lsof/pgrep on macOS and Linux, and PowerShell
 * (Get-NetTCPConnection / Get-CimInstance) on Windows. PowerShell ships
 * with every supported Windows version since 7; no extra install required.
 *
 * Always sends SIGTERM first, waits briefly, then SIGKILL anything
 * still alive — same shape as `vite`'s own shutdown handler so we
 * don't trample DO state mid-write. (On Windows, SIGTERM is best-effort:
 * Win32 has no real signals, so node maps both to TerminateProcess. We
 * still issue them in the same order for consistent log output.)
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'
import { findAppDir } from '../lib/app-context'
import { resolveWorktreePort, resolveAppLaunchPort } from '../lib/launch-config'
import { DEFAULT_PORT, resolveDevServerPort } from '../lib/port'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'

const SIGTERM_GRACE_MS = 1500
const IS_WIN = process.platform === 'win32'

export default defineDeepspaceCommand({
  meta: {
    name: 'kill',
    description: 'Kill the local dev server and any orphaned workerd processes',
  },
  args: {
    port: {
      type: 'string',
      description: `Port to free. Without it, kill resolves its target through the shared precedence ($DEEPSPACE_PORT > worktree port > the app's last recorded launch port > ${DEFAULT_PORT}; dev itself never reads the launch port, so after \`dev --port N\` a bare kill targets N while a bare dev binds ${DEFAULT_PORT}) — pass --port to free any other.`,
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Also kill stray workerd/wrangler processes across all ports',
      default: false,
    },
  },
  async run({ args }) {
    const portArg = args.port as string | undefined
    const all = Boolean(args.all)
    const say = (line: string) => {
      if (!args.json) console.log(line)
    }
    // The shared precedence (lib/port.ts resolveDevServerPort) targets the
    // server `dev` bound (DEV-2). Without it, no-arg `kill` hit :5173 even
    // when `dev --port 8790` was running elsewhere.
    const cwd = process.cwd()
    const port = resolveDevServerPort({
      arg: portArg,
      worktree: () => resolveWorktreePort(cwd),
      appLaunch: () => resolveAppLaunchPort(findAppDir(cwd) ?? cwd),
    })
    const targets = new Set<number>()

    // 1. Anything LISTENing on the dev port (vite + the workerd child it
    //    publishes through, occasionally a stray inspector). `enumerated`
    //    tells us whether we could actually inspect the port at all.
    const listeners = enumerateListeners(port)
    for (const pid of listeners.pids) targets.add(pid)

    // 2. Children of those listeners — wrangler/vite tend to spawn workerd
    //    as a sibling, but in some shells it ends up as a child instead.
    for (const pid of [...targets]) {
      for (const child of childPids(pid)) targets.add(child)
    }

    // 3. With --all, sweep workerd / wrangler / vite anywhere on the box.
    //    Useful when port 5173 is "free" but a leftover workerd from a
    //    previous run is still holding D1 / DO state in .wrangler/.
    let swept = false
    if (all) {
      const sweep = sweepByName(['workerd', 'wrangler', 'vite'])
      swept = sweep.swept
      for (const pid of sweep.pids) targets.add(pid)
    }

    if (targets.size === 0) {
      // DEV-1: distinguish "inspected, found nothing" from "couldn't inspect".
      // The latter must NOT report the port free (exit 0) while a leaked
      // workerd keeps holding DO/D1 state — that was the original silent no-op.
      const outcome = noTargetsMessage({
        enumerated: listeners.enumerated,
        swept,
        all,
        port,
      })
      if (!outcome.ok) {
        throw new Refusal(outcome.message, 'inspect_unavailable')
      }
      say(outcome.message)
      return { data: { port, all, killed: [], portFree: true } }
    }

    // SIGTERM pass.
    for (const pid of targets) {
      if (sendSignal(pid, 'SIGTERM')) {
        say(`SIGTERM → pid ${pid}`)
      }
    }
    await wait(SIGTERM_GRACE_MS)

    const stillAlive: number[] = []
    for (const pid of targets) {
      if (isAlive(pid)) stillAlive.push(pid)
    }

    // SIGKILL holdouts.
    const killed: number[] = []
    for (const pid of stillAlive) {
      if (sendSignal(pid, 'SIGKILL')) {
        killed.push(pid)
        say(`SIGKILL → pid ${pid} (did not exit on SIGTERM)`)
      }
    }

    // Re-verify the port is free.
    await wait(200)
    const remaining = listenerPids(port)
    if (remaining.length > 0) {
      throw new Refusal(
        `Port ${port} is still held by pid(s) ${remaining.join(', ')} — try \`deepspace dev kill --port ${port}\` again, or kill manually.`,
        'port_still_held',
        {
          action: cliAction('deepspace', 'dev', 'kill', '--port', String(port)),
          extra: { port, holders: remaining },
        },
      )
    }

    // Report what actually happened. Under --all we may have swept processes on
    // ports other than `port` (matched by name), so a bare "Port 5173 is free"
    // would misrepresent the sweep (DEV-6).
    say(
      all
        ? `Killed ${targets.size} process(es) (workerd/wrangler/vite sweep). :${port} is free.`
        : `Port ${port} is free.`,
    )
    return {
      data: { port, all, killed: [...targets], sigkilled: killed, portFree: true },
    }
  },
})

// ── Platform-specific helpers ─────────────────────────────────────────────

/**
 * Decide what to print when no kill targets were found. Pure so the DEV-1
 * rule — never claim the port is free when we couldn't actually inspect it —
 * is unit-testable. `ok:false` means we lacked any way to observe the system
 * (no lsof/pgrep AND no /proc) and must exit non-zero rather than lie.
 */
export function noTargetsMessage(opts: {
  enumerated: boolean
  swept: boolean
  all: boolean
  port: number
  /** Injectable for tests. The remedy has to name the tool THIS platform uses —
   *  "install lsof (or procps for pgrep)" is unactionable on Windows, which has
   *  neither and needs none of them. */
  platform?: NodeJS.Platform
}): { ok: boolean; message: string } {
  const { enumerated, swept, all, port, platform = process.platform } = opts
  const couldObserve = enumerated || (all && swept)
  if (!couldObserve) {
    return {
      ok: false,
      message:
        platform === 'win32'
          ? `Couldn't determine what's running on :${port}: the PowerShell port query ` +
            `could not be run, so nothing was inspected or killed. Either powershell.exe ` +
            `(or pwsh) is not on PATH, or Get-NetTCPConnection is unavailable on this ` +
            `Windows edition. Find the process manually with ` +
            `\`netstat -ano | findstr :${port}\`.`
          : `Couldn't determine what's running on :${port}: no lsof/pgrep and /proc ` +
            `is unavailable, so nothing was inspected or killed. Install lsof (or ` +
            `procps for pgrep), or find and kill the process manually.`,
    }
  }
  return {
    ok: true,
    message: all
      ? `Nothing listening on :${port} and no stray workerd/wrangler/vite processes found.`
      : `Nothing listening on :${port}. (Pass --all to sweep stray workerd/wrangler.)`,
  }
}

/**
 * PIDs listening on `port`, plus whether we could inspect the port at all.
 * `enumerated:false` means every available method (lsof / PowerShell / /proc)
 * was missing — a genuine "don't know", not "nothing there".
 */
export function enumerateListeners(port: number): { pids: number[]; enumerated: boolean } {
  if (IS_WIN) {
    // Get-NetTCPConnection is the modern replacement for netstat -ano.
    // -ErrorAction SilentlyContinue swallows the "No matching connection" error
    // record, so a free port stays a non-terminating, sentinel-reaching run
    // under withSentinel's $ErrorActionPreference='Stop'. Do not remove it: the
    // query would then terminate on a free port and `kill` would refuse instead
    // of reporting the port free. It does NOT make the command exit 0 — see
    // PS_SENTINEL. Residual: it also silences an error record from a degraded
    // CIM provider, which would read as "nothing listening"; the genuine
    // failures (cmdlet or module missing) terminate and are caught.
    const r = runPowershellChecked(
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
    )
    return { pids: r.pids, enumerated: r.ran }
  }
  // lsof is authoritative when present. It exits 1 (not an error, for us) when
  // nothing matches, so "ran but empty" is a real "nothing listening".
  const lsof = runLsof(port)
  if (lsof.ran) return { pids: lsof.pids, enumerated: true }
  // lsof is absent on many container/CI images — the official Bookworm Node
  // images ship none of lsof/ss/fuser/netstat. /proc needs no external binary
  // and covers Linux; if it's also unavailable we truly can't tell (enumerated:false).
  const proc = listenerPidsViaProc(port)
  return { pids: proc.pids, enumerated: proc.available }
}

/** Thin wrapper for the post-kill re-verify, where capability is irrelevant. */
function listenerPids(port: number): number[] {
  return enumerateListeners(port).pids
}

/** Run lsof for a port. `ran` distinguishes "lsof absent" from "found nothing". */
function runLsof(port: number): { pids: number[]; ran: boolean } {
  try {
    // -t prints PIDs only, one per line; -nP avoids DNS / service lookups.
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf-8',
    })
    if (r.error) return { pids: [], ran: false } // ENOENT: lsof not installed
    // 0 = matches printed; 1 = no matches. Both mean lsof ran successfully.
    return { pids: r.status === 0 ? parsePidLines(r.stdout) : [], ran: true }
  } catch {
    return { pids: [], ran: false }
  }
}

/** Port → listening PIDs via /proc alone (no lsof/ss). Finds the LISTEN
 *  socket's inode in /proc/net/tcp{,6}, then the process holding that fd.
 *  `available` is false when /proc itself couldn't be read. */
function listenerPidsViaProc(port: number): { pids: number[]; available: boolean } {
  let available = false
  try {
    const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
    const inodes = new Set<string>()
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let data: string
      try {
        data = readFileSync(f, 'utf-8')
      } catch {
        continue
      }
      available = true
      for (const line of data.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/)
        // sl local_address(1) rem_address(2) st(3) … inode(9); st 0A = LISTEN.
        if (cols[3] !== '0A') continue
        if (cols[1]?.split(':')[1] === hexPort && cols[9]) inodes.add(cols[9])
      }
    }
    if (!available) return { pids: [], available: false }
    if (!inodes.size) return { pids: [], available: true }
    const pids = new Set<number>()
    for (const pidDir of readdirSync('/proc')) {
      if (!/^\d+$/.test(pidDir)) continue
      let fds: string[]
      try {
        fds = readdirSync(`/proc/${pidDir}/fd`)
      } catch {
        continue // not ours / gone
      }
      for (const fd of fds) {
        let link: string
        try {
          link = readlinkSync(`/proc/${pidDir}/fd/${fd}`)
        } catch {
          continue
        }
        const m = link.match(/^socket:\[(\d+)\]$/)
        if (m && inodes.has(m[1])) {
          pids.add(Number(pidDir))
          break
        }
      }
    }
    return { pids: [...pids], available: true }
  } catch {
    return { pids: [], available }
  }
}

function childPids(parentPid: number): number[] {
  if (IS_WIN) {
    return runPowershell(
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Select-Object -ExpandProperty ProcessId`,
    )
  }
  return run(['pgrep', '-P', String(parentPid)])
}

/**
 * Sweep processes by name/commandline. `swept` reports whether the enumerator
 * (pgrep / PowerShell) actually ran — so `--all` doesn't falsely claim "no
 * stray processes" when it never got to look.
 */
export function sweepByName(names: string[]): { pids: number[]; swept: boolean } {
  const all = new Set<number>()
  if (IS_WIN) {
    // Match against process Name (e.g. "workerd") AND CommandLine (catches
    // npx-launched scripts like "vite" that show up as node.exe with vite
    // in the args). Matching CommandLine is deliberate and matches `pgrep -f`
    // on posix — keep the two platforms equally thorough.
    //
    // `$_.ProcessId -ne $PID` is what stops the query matching ITSELF. Every
    // search term is written into this command line, so the powershell.exe
    // running it has "workerd", "wrangler" and "vite" in its own CommandLine
    // and satisfies the filter. The caller's `pid !== process.pid` guard below
    // only excludes the NODE process, not the PowerShell child it spawns — so
    // a clean machine returned one phantom pid and `--all` reported "Killed 1
    // process(es)" having killed nothing (plus a narrow window where Windows
    // had already recycled that pid onto an unrelated process). posix needs no
    // equivalent: pgrep runs once per name, and never reports itself.
    const orClauses = names
      .map((n) => `($_.Name -like '*${n}*') -or ($_.CommandLine -like '*${n}*')`)
      .join(' -or ')
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (${orClauses}) } | Select-Object -ExpandProperty ProcessId`
    const r = runPowershellChecked(script)
    for (const pid of r.pids) if (pid !== process.pid) all.add(pid)
    return { pids: [...all], swept: r.ran }
  }
  let swept = false
  for (const name of names) {
    const r = runPgrep(['-f', name])
    if (r.ran) swept = true
    for (const pid of r.pids) if (pid !== process.pid) all.add(pid)
  }
  return { pids: [...all], swept }
}

/** Run pgrep. `ran` distinguishes "pgrep absent" from "matched nothing" (exit 1). */
function runPgrep(pgrepArgs: string[]): { pids: number[]; ran: boolean } {
  try {
    const r = spawnSync('pgrep', pgrepArgs, { encoding: 'utf-8' })
    if (r.error) return { pids: [], ran: false } // ENOENT: pgrep not installed
    // 0 = matches; 1 = no matches. Both mean pgrep ran.
    return {
      pids: r.status === 0 ? parsePidLines(r.stdout) : [],
      ran: r.status === 0 || r.status === 1,
    }
  } catch {
    return { pids: [], ran: false }
  }
}

// ── Process primitives ────────────────────────────────────────────────────

/** Run a command and return whitespace-separated PIDs (empty array on failure). */
function run(cmd: string[]): number[] {
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf-8' })
    if (r.status !== 0) return []
    return parsePidLines(r.stdout)
  } catch {
    return []
  }
}

/**
 * Run a PowerShell snippet. Prefers `pwsh` (PowerShell 7+) when available
 * and falls back to `powershell.exe` (Windows PowerShell 5.1, ships with
 * every Windows version we care about).
 */
function runPowershell(script: string): number[] {
  return runPowershellChecked(script).pids
}

/**
 * Proof-of-completion marker for a PowerShell query.
 *
 * PowerShell's exit code CANNOT answer "did the query run?". `powershell.exe
 * -Command` exits with the status of the last command, and `-ErrorAction
 * SilentlyContinue` suppresses the "no matching connection" MESSAGE while
 * still leaving `$?` false — so a port with nothing on it exits 1, which the
 * old code read as "PowerShell is absent". Every Windows `dev kill` against a
 * free port therefore died with the lsof/procps refusal (DEV-1) instead of
 * reporting the port free.
 *
 * A sentinel printed after the query answers the question the exit code can't.
 */
const PS_SENTINEL = '__deepspace_ps_ok__'

/**
 * Wrap a query so the sentinel is reached on success and skipped on a genuine
 * failure. `$ErrorActionPreference='Stop'` promotes an unrunnable query (a
 * cmdlet this Windows edition lacks, a broken WMI) into a terminating error the
 * catch swallows, leaving no sentinel — which is what preserves DEV-1: we must
 * never report a port free when we never managed to look. A per-cmdlet
 * `-ErrorAction SilentlyContinue` still wins over the preference, so the
 * ordinary "nothing matched" case stays non-terminating and reaches the
 * sentinel.
 */
function withSentinel(script: string): string {
  return `$ErrorActionPreference='Stop'; try { ${script}; '${PS_SENTINEL}' } catch { }`
}

/** Pure half of runPowershellChecked, exported for tests: the sentinel — never
 *  the exit code — decides whether the query actually ran. */
export function readPowershellPids(stdout: string): { pids: number[]; ran: boolean } {
  if (!stdout.includes(PS_SENTINEL)) return { pids: [], ran: false }
  return { pids: parsePidLines(stdout.replace(PS_SENTINEL, '')), ran: true }
}

/** Like runPowershell but reports whether PowerShell actually ran (`ran`),
 *  so callers can tell "no matches" from "PowerShell absent". */
function runPowershellChecked(script: string): { pids: number[]; ran: boolean } {
  const exe = pwshOrPowershell()
  try {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', withSentinel(script)], {
      encoding: 'utf-8',
    })
    // ENOENT: no PowerShell on PATH at all. A query that started but terminated
    // (a cmdlet this Windows edition lacks) is caught below by the missing
    // sentinel — both are "we could not look", which is what the refusal says.
    if (r.error) return { pids: [], ran: false }
    return readPowershellPids(r.stdout ?? '')
  } catch {
    return { pids: [], ran: false }
  }
}

function pwshOrPowershell(): string {
  // `pwsh` is the modern cross-platform binary; `powershell.exe` is the
  // legacy Windows-only one. Try modern first, fall back if missing.
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf-8',
  })
  if (probe.status === 0) return 'pwsh'
  return 'powershell.exe'
}

function parsePidLines(stdout: string): number[] {
  return stdout
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
}

function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

function isAlive(pid: number): boolean {
  try {
    // signal 0 = "do nothing, just check"
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
