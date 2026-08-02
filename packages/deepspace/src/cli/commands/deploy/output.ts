import * as p from '@clack/prompts'
import { printAction, withSlug, type CliAction } from '../../lib/output'

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
      if (json) {
        emitJson({
          ok: false,
          code,
          error: message,
          ...(opts.actionRequired ? { actionRequired: true } : {}),
          ...(opts.action ? { action: opts.action } : {}),
        })
      } else {
        if (introShown && opts.actionRequired) p.log.warn(withSlug(message, code))
        else if (introShown) p.cancel(withSlug(message, code))
        else console.error(withSlug(message, code))
        if (opts.action) printAction(opts.action)
      }
      process.exit(opts.actionRequired ? 2 : 1)
    },
  }
}
