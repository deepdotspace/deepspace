import * as p from '@clack/prompts'
import { CliExit } from '../../lib/cli-errors'
import { executableAction, printAction, withSlug, type CliAction } from '../../lib/output'

export interface DeployOutput {
  readonly json: boolean
  readonly nonInteractive: boolean
  emitJson(value: unknown): void
  showIntro(): void
  die(message: string, code: string, opts?: { action?: CliAction; actionRequired?: boolean }): never
}

/** Owns deploy's human/JSON output contract and its single pre-upload exit door. */
export function createDeployOutput(json: boolean): DeployOutput {
  const nonInteractive = json || !process.stdin.isTTY
  const realStdoutWrite = process.stdout.write.bind(process.stdout)
  let emitted = false
  let introShown = false
  let lastHuman = ''

  if (json) {
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
      const ansiSgr = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, 'g')
      const line = text
        .replace(ansiSgr, '')
        .replace(/[│◇◆■└┌]/g, '')
        .trim()
      if (line) lastHuman = line
      return (process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stdout.write

    process.on('exit', (code) => {
      if (emitted || code === 0) return
      process.stdout.write = realStdoutWrite
      realStdoutWrite(
        `${JSON.stringify({ ok: false, code: 'deploy_failed', error: lastHuman || 'deploy failed' })}\n`,
      )
    })
  }

  const emitJson = (value: unknown): void => {
    emitted = true
    process.stdout.write = realStdoutWrite
    realStdoutWrite(`${JSON.stringify(value)}\n`)
  }

  return {
    json,
    nonInteractive,
    emitJson,
    showIntro() {
      introShown = true
    },
    die(message, code, opts = {}) {
      // Deploy's own exit door, so it owns the pinning the command runtime
      // applies elsewhere — a bare `deepspace` argv must never leave here.
      const action = opts.action ? executableAction(opts.action) : undefined
      if (json) {
        emitJson({
          ok: false,
          code,
          error: message,
          ...(opts.actionRequired ? { actionRequired: true } : {}),
          ...(action ? { action } : {}),
        })
      } else {
        if (introShown && opts.actionRequired) p.log.warn(withSlug(message, code))
        else if (introShown) p.cancel(withSlug(message, code))
        else console.error(withSlug(message, code))
        if (action) printAction(action)
      }
      // Throw, never process.exit(): deploy has completed fetch() requests by
      // the time most refusals fire, and exiting after one aborts on Windows
      // (see lib/command.ts). The sentinel unwinds to wrapCommandErrors →
      // renderCliError, which records the exit code without re-rendering.
      throw new CliExit(opts.actionRequired ? 2 : 1)
    },
  }
}
