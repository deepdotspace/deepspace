/**
 * deepspace kill [--port N] [--all]
 *
 * Stops a local dev server bound to the given port, plus the workerd
 * child processes that wrangler/Vite would normally clean up but
 * sometimes leak when the parent dies ungracefully (Ctrl-C in a
 * detached terminal, IDE close, sandbox deny on signal, etc).
 *
 *   deepspace kill                  # kill listener on 5173 + its workerd children
 *   deepspace kill --port 5180      # kill listener on a different port
 *   deepspace kill --all            # also sweep ALL stray workerd/wrangler procs on the machine
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

import { defineCommand } from 'citty'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'
import { findAppDir, resolveWorktreePort, resolveAppLaunchPort } from '../lib/app-context'
import { DEFAULT_PORT, resolvePort } from '../lib/port'

const SIGTERM_GRACE_MS = 1500
const IS_WIN = process.platform === 'win32'

/**
 * Pick the port `kill` targets, mirroring `dev`'s binding precedence so the two
 * always agree (DEV-2). Pure for testing.
 *   1. explicit --port
 *   2. worktree port (dev ignores $DEEPSPACE_PORT inside a worktree, so we do too)
 *   3. $DEEPSPACE_PORT (dev binds it outside a worktree, over a launch.json that
 *      dev only rewrites for an explicit --port)
 *   4. the app's launch.json port (kept in sync by `dev --port`)
 *   5. the default
 */
export function pickKillPort(opts: {
  explicit: number | null
  worktree: number | null
  env: number | null
  appLaunch: number | null
}): number {
  if (opts.explicit != null) return opts.explicit
  if (opts.worktree != null) return opts.worktree
  if (opts.env != null) return opts.env
  return opts.appLaunch ?? DEFAULT_PORT
}

export default defineCommand({
  meta: {
    name: 'kill',
    description: 'Kill the local dev server and any orphaned workerd processes',
  },
  args: {
    port: {
      type: 'string',
      description: `Port the dev server is bound to (default ${DEFAULT_PORT}, or $DEEPSPACE_PORT)`,
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Also kill stray workerd/wrangler processes across all ports',
      default: false,
    },
  },
  async run({ args }) {
    // Resolve which port to target, mirroring `dev`'s own precedence so `kill`
    // always targets the server `dev` bound (DEV-2). Without this, no-arg `kill`
    // hit :5173 even when `dev --port 8790` was running elsewhere.
    const cwd = process.cwd()
    const port = pickKillPort({
      explicit: args.port ? resolvePort(args.port) : null,
      worktree: resolveWorktreePort(cwd),
      // resolvePort() reads + validates $DEEPSPACE_PORT; only consult it when set.
      env: process.env.DEEPSPACE_PORT ? resolvePort() : null,
      appLaunch: resolveAppLaunchPort(findAppDir(cwd) ?? cwd),
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
    if (args.all) {
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
        all: args.all,
        port,
      })
      if (!outcome.ok) {
        console.error(outcome.message)
        process.exit(1)
      }
      console.log(outcome.message)
      return
    }

    // SIGTERM pass.
    for (const pid of targets) {
      if (sendSignal(pid, 'SIGTERM')) {
        console.log(`SIGTERM → pid ${pid}`)
      }
    }
    await wait(SIGTERM_GRACE_MS)

    const stillAlive: number[] = []
    for (const pid of targets) {
      if (isAlive(pid)) stillAlive.push(pid)
    }

    // SIGKILL holdouts.
    for (const pid of stillAlive) {
      if (sendSignal(pid, 'SIGKILL')) {
        console.log(`SIGKILL → pid ${pid} (did not exit on SIGTERM)`)
      }
    }

    // Re-verify the port is free.
    await wait(200)
    const remaining = listenerPids(port)
    if (remaining.length > 0) {
      console.error(
        `Port ${port} is still held by pid(s) ${remaining.join(', ')} — try \`deepspace kill --port ${port}\` again, or kill manually.`,
      )
      process.exit(1)
    }

    // Report what actually happened. Under --all we may have swept processes on
    // ports other than `port` (matched by name), so a bare "Port 5173 is free"
    // would misrepresent the sweep (DEV-6).
    if (args.all) {
      console.log(`Killed ${targets.size} process(es) (workerd/wrangler/vite sweep). :${port} is free.`)
    } else {
      console.log(`Port ${port} is free.`)
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
}): { ok: boolean; message: string } {
  const { enumerated, swept, all, port } = opts
  const couldObserve = enumerated || (all && swept)
  if (!couldObserve) {
    return {
      ok: false,
      message:
        `Couldn't determine what's running on :${port}: no lsof/pgrep and /proc ` +
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
function enumerateListeners(port: number): { pids: number[]; enumerated: boolean } {
  if (IS_WIN) {
    // Get-NetTCPConnection is the modern replacement for netstat -ano.
    // -ErrorAction SilentlyContinue swallows "No matching connection" so
    // the command exits 0 with empty stdout instead of a noisy red error.
    const r = runPowershellChecked(
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
    )
    return { pids: r.pids, enumerated: r.ran }
  }
  // lsof is authoritative when present. It exits 1 (not an error, for us) when
  // nothing matches, so "ran but empty" is a real "nothing listening".
  const lsof = runLsof(port)
  if (lsof.ran) return { pids: lsof.pids, enumerated: true }
  // lsof is absent on many container/CI images — `node:22-bookworm` ships none
  // of lsof/ss/fuser/netstat. /proc needs no external binary and covers Linux;
  // if it's also unavailable we truly can't tell (enumerated:false).
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
function sweepByName(names: string[]): { pids: number[]; swept: boolean } {
  const all = new Set<number>()
  if (IS_WIN) {
    // Match against process Name (e.g. "workerd") AND CommandLine (catches
    // npx-launched scripts like "vite" that show up as node.exe with vite
    // in the args).
    const orClauses = names
      .map((n) => `($_.Name -like '*${n}*') -or ($_.CommandLine -like '*${n}*')`)
      .join(' -or ')
    const script = `Get-CimInstance Win32_Process | Where-Object { ${orClauses} } | Select-Object -ExpandProperty ProcessId`
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
    return { pids: r.status === 0 ? parsePidLines(r.stdout) : [], ran: r.status === 0 || r.status === 1 }
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

/** Like runPowershell but reports whether PowerShell actually ran (`ran`),
 *  so callers can tell "no matches" (exit 0, empty) from "PowerShell absent". */
function runPowershellChecked(script: string): { pids: number[]; ran: boolean } {
  const exe = pwshOrPowershell()
  try {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
    })
    if (r.error) return { pids: [], ran: false }
    // With -ErrorAction SilentlyContinue the query exits 0 even with no matches.
    return { pids: r.status === 0 ? parsePidLines(r.stdout) : [], ran: r.status === 0 }
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
