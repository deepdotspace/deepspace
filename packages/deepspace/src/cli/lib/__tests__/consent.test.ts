/**
 * The one behavior of the shared gate no call-site suite pins: a CANCELLED
 * prompt (Ctrl-C / Esc — clack's isCancel sentinel) is a refusal to consent,
 * never consent. Every command suite stubs `isCancel: () => false`, so this
 * lived untested when the logic was copied per command.
 */
import { describe, it, expect, vi } from 'vitest'

const prompts = vi.hoisted(() => ({
  confirm: vi.fn(),
  isCancel: vi.fn(),
}))
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>()
  return { ...actual, confirm: prompts.confirm, isCancel: prompts.isCancel }
})

import { requireConsent } from '../consent'
import { Refusal } from '../cli-errors'

function onTty<T>(fn: () => Promise<T>): Promise<T> {
  const prior = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  return fn().finally(() => {
    if (prior) Object.defineProperty(process.stdin, 'isTTY', prior)
    else Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })
  })
}

describe('requireConsent', () => {
  it('treats a cancelled prompt (isCancel) as a decline', async () => {
    const cancelSentinel = Symbol('clack-cancel')
    prompts.confirm.mockResolvedValueOnce(cancelSentinel)
    prompts.isCancel.mockImplementation((value: unknown) => value === cancelSentinel)

    await onTty(async () => {
      await expect(
        requireConsent({ yes: false, json: false, message: 'Destroy the thing.' }),
      ).rejects.toMatchObject({ code: 'consent_declined' })
    })
  })

  it('a lazy prompt is never evaluated for a machine caller', async () => {
    const lazy = vi.fn(async () => 'never asked')
    const err = await requireConsent({
      yes: false,
      json: true,
      message: 'Destroy the thing.',
      prompt: lazy,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Refusal)
    expect((err as Refusal).code).toBe('confirmation_required')
    expect(lazy).not.toHaveBeenCalled()
  })

  it('a lazy prompt is never evaluated under --yes', async () => {
    const lazy = vi.fn(async () => 'never asked')
    await requireConsent({ yes: true, json: false, message: 'x', prompt: lazy })
    expect(lazy).not.toHaveBeenCalled()
  })
})
