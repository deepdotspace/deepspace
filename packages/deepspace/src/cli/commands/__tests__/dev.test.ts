import { describe, expect, it } from 'vitest'
import { devExitSucceeded } from '../dev'

describe('development server exit handling', () => {
  it('treats an interrupt exit as success only after this process received the signal', () => {
    expect(devExitSucceeded(null, false)).toBe(true)
    expect(devExitSucceeded(0, false)).toBe(true)
    expect(devExitSucceeded(130, true)).toBe(true)
    expect(devExitSucceeded(130, false)).toBe(false)
    expect(devExitSucceeded(143, true)).toBe(true)
    expect(devExitSucceeded(1, false)).toBe(false)
  })
})
