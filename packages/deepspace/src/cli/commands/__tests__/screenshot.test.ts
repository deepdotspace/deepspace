import { afterEach, describe, expect, it, vi } from 'vitest'
import { sync as spawnSync } from 'cross-spawn'
import screenshot, {
  DEFAULT_SCREENSHOT_WAIT_MS,
  normalizeWaitTimeout,
  normalizeViewportSize,
} from '../screenshot'
import * as playwrightModule from '../../lib/playwright'

vi.mock('cross-spawn', () => ({ sync: vi.fn() }))

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('normalizeViewportSize', () => {
  it.each([
    ['390x844', '390,844'],
    ['1280, 720', '1280,720'],
    ['390x10001', '390,10001'],
  ])('normalizes %s for Playwright', (input, expected) => {
    expect(normalizeViewportSize(input)).toBe(expected)
  })

  it.each(['mobile', '0x844'])('refuses %s', (input) => {
    expect(() => normalizeViewportSize(input)).toThrow(
      expect.objectContaining({ code: 'invalid_viewport' }),
    )
  })

  it('refuses dimensions that overflow or lose integer precision', () => {
    expect(() => normalizeViewportSize(`${'9'.repeat(40)}x844`)).toThrow(
      expect.objectContaining({ code: 'invalid_viewport' }),
    )
    expect(() => normalizeViewportSize(`${'9'.repeat(400)}x844`)).toThrow(
      expect.objectContaining({ code: 'invalid_viewport' }),
    )
  })

  it('refuses invalid input before checking or installing Playwright', async () => {
    const ensurePlaywright = vi.spyOn(playwrightModule, 'ensurePlaywright')
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
    const command = screenshot as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }

    await command.run({
      args: {
        url: 'http://localhost:5173/',
        output: 'screenshot.png',
        viewport: 'mobile',
        json: true,
      },
    })

    expect(ensurePlaywright).not.toHaveBeenCalled()
    expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({
      ok: false,
      code: 'invalid_viewport',
    })
  })

  it('forwards normalized dimensions and reports them in JSON', async () => {
    const ensurePlaywright = vi
      .spyOn(playwrightModule, 'ensurePlaywright')
      .mockImplementation(() => {})
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as never)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
    const command = screenshot as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }

    await command.run({
      args: {
        url: 'http://localhost:5173/',
        output: 'screenshot.png',
        viewport: '390x844',
        json: true,
      },
    })

    expect(ensurePlaywright).toHaveBeenCalledOnce()
    expect(spawnSync).toHaveBeenCalledWith(
      'npx',
      [
        'playwright',
        'screenshot',
        'http://localhost:5173/',
        'screenshot.png',
        '--viewport-size',
        '390,844',
        '--wait-for-timeout',
        String(DEFAULT_SCREENSHOT_WAIT_MS),
      ],
      { cwd: expect.any(String), stdio: ['inherit', 2, 2] },
    )
    expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({
      ok: true,
      url: 'http://localhost:5173/',
      output: 'screenshot.png',
      viewport: '390,844',
      waitForSelector: null,
      waitForTimeout: DEFAULT_SCREENSHOT_WAIT_MS,
    })
  })

  it('allows both readiness waits to be overridden or disabled', async () => {
    vi.spyOn(playwrightModule, 'ensurePlaywright').mockImplementation(() => {})
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const command = screenshot as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }

    await command.run({
      args: {
        url: 'https://example.test',
        output: 'screenshot.png',
        'wait-for-selector': '#ready',
        'wait-for-timeout': '0',
      },
    })

    expect(spawnSync).toHaveBeenCalledWith(
      'npx',
      [
        'playwright',
        'screenshot',
        'https://example.test',
        'screenshot.png',
        '--wait-for-selector',
        '#ready',
      ],
      { cwd: expect.any(String), stdio: 'inherit' },
    )
  })
})

describe('normalizeWaitTimeout', () => {
  it.each([
    [undefined, DEFAULT_SCREENSHOT_WAIT_MS],
    ['0', 0],
    [' 250 ', 250],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeWaitTimeout(input)).toBe(expected)
  })

  it.each(['-1', '1.5', 'soon', ''])('refuses %s', (input) => {
    expect(() => normalizeWaitTimeout(input)).toThrow(
      expect.objectContaining({ code: 'invalid_wait_timeout' }),
    )
  })
})
