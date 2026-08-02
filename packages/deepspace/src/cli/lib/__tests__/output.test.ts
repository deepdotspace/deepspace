import type { CommandDef } from 'citty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineDeepspaceCommand } from '../command'
import { assertExecutableAction, cliAction } from '../output'

afterEach(() => vi.restoreAllMocks())

describe('structured CLI actions', () => {
  it('preserves executable argv as data and binds it to an absolute cwd', () => {
    expect(cliAction('deepspace', 'pull')).toEqual({
      cwd: process.cwd(),
      argv: ['deepspace', 'pull'],
    })
  })

  it('rejects placeholders because an agent cannot execute them verbatim', () => {
    expect(() => cliAction('deepspace', 'app', 'create', '<name>')).toThrow(/placeholder/)
  })

  it('rejects relative working directories and empty executables', () => {
    expect(() => assertExecutableAction({ cwd: '.', argv: ['git', 'status'] })).toThrow(/absolute/)
    expect(() => assertExecutableAction({ cwd: process.cwd(), argv: [] })).toThrow(/executable/)
  })
})

describe('shared command output', () => {
  it('flushes queued large JSON before exiting', async () => {
    const payload = 'x'.repeat(128 * 1024)
    const writes: string[] = []
    const fakeStdout = {
      writableLength: payload.length,
      write: vi.fn((chunk: string, callback: () => void) => {
        writes.push(chunk)
        callback()
        return true
      }),
    }
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(fakeStdout as never)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
    const exits: number[] = []
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code ?? 0)
      throw new Error(`exit:${code ?? 0}`)
    }) as never)
    const command = defineDeepspaceCommand({
      meta: { name: 'large-output-test', description: 'test only' },
      async run() {
        return { data: { payload } }
      },
    }) as CommandDef & {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }

    await expect(command.run({ args: { json: true } })).rejects.toThrow('exit:0')
    expect(JSON.parse(logs[0])).toEqual({ ok: true, payload })
    expect(writes).toEqual([''])
    expect(exits).toEqual([0])
  })
})
