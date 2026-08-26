import { afterEach, describe, expect, it, vi } from 'vitest'

// Force the real (clack) spinner branch and capture its calls: createSpinner
// only uses p.spinner() when stdout is a TTY, and the Windows abort this guard
// prevents is specific to that real spinner.
const stub = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }))
vi.mock('@clack/prompts', () => ({ spinner: () => stub }))

import { createSpinner, stopActiveSpinner, setPlainProgress } from '../spinner'

const origIsTTY = process.stdout.isTTY
function forceTTY(): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
}

afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true })
  setPlainProgress(false)
  stub.start.mockClear()
  stub.stop.mockClear()
  stub.message.mockClear()
})

describe('stopActiveSpinner (Windows clean-exit guard)', () => {
  it('stops the spinner that is currently painting so exit() cannot abort', () => {
    forceTTY()
    const s = createSpinner()
    s.start('working…')
    expect(stub.start).toHaveBeenCalledWith('working…')
    stopActiveSpinner()
    expect(stub.stop).toHaveBeenCalledTimes(1)
  })

  it('is a no-op once the spinner has already been stopped (idempotent)', () => {
    forceTTY()
    const s = createSpinner()
    s.start()
    s.stop('done')
    stub.stop.mockClear()
    stopActiveSpinner()
    expect(stub.stop).not.toHaveBeenCalled()
  })

  it('does nothing and never throws when no spinner is active', () => {
    expect(() => stopActiveSpinner()).not.toThrow()
  })
})

describe('non-TTY progress', () => {
  it('prints one bounded line per phase so agent/CI logs receive live feedback', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      lines.push(String(value))
    })
    try {
      const progress = createSpinner()
      progress.start('Preparing…')
      progress.message('Transferring…')
      progress.stop('Done.')
    } finally {
      log.mockRestore()
    }
    expect(lines).toEqual(['Preparing…', 'Transferring…', 'Done.'])
  })

  it('setPlainProgress(true) forces bounded lines even in a TTY (--json runs)', () => {
    forceTTY()
    setPlainProgress(true)
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      lines.push(String(value))
    })
    try {
      const progress = createSpinner()
      progress.start('Preparing…')
      progress.message('Transferring…')
      progress.stop('Done.')
    } finally {
      log.mockRestore()
    }
    expect(stub.start).not.toHaveBeenCalled()
    expect(lines).toEqual(['Preparing…', 'Transferring…', 'Done.'])
  })
})
