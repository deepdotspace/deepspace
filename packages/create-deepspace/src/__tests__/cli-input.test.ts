import { describe, expect, it } from 'vitest'
import { nodeRuntimeRefusal, parseArgs, validateAppName } from '../cli-input'

const argv = (...args: string[]) => ['node', 'create-deepspace', ...args]

describe('parseArgs', () => {
  it('parses positional, separate, and equals-form values', () => {
    expect(parseArgs(argv('my-app', '--template', 'copilot', '--local=/sdk'))).toMatchObject({
      appName: 'my-app',
      template: 'copilot',
      local: '/sdk',
      invalid: undefined,
    })
  })

  it('does not consume a following flag as a missing value', () => {
    expect(parseArgs(argv('my-app', '--local', '--template', 'copilot'))).toMatchObject({
      appName: 'my-app',
      template: 'copilot',
      invalid: '--local requires a value',
    })
  })

  it('reports the first unknown option', () => {
    expect(parseArgs(argv('my-app', '--unknown', '--also-unknown'))).toMatchObject({
      appName: 'my-app',
      invalid: "Unknown option '--unknown'",
    })
  })

  // `--yes` / `-y` is the npm-create reflex. It asks for behavior this
  // scaffolder already has, so it is a no-op — never exit 1 on the literal
  // first command of the journey.
  it.each(['--yes', '-y'])('accepts %s as a no-op', (flag) => {
    expect(parseArgs(argv('my-app', flag))).toMatchObject({
      appName: 'my-app',
      interactive: false,
      invalid: undefined,
    })
  })

  it('accepts --no-register as a deprecated no-op: scaffolds never register anyway', () => {
    // Refusing it would exit-1 every script that passed it — the flag asks
    // for what already always happens (same lesson as --yes).
    expect(parseArgs(argv('my-app', '--no-register'))).toMatchObject({
      appName: 'my-app',
      invalid: undefined,
    })
  })

  it('rejects a second positional app name', () => {
    expect(parseArgs(argv('first-app', 'second-app'))).toMatchObject({
      appName: 'first-app',
      invalid: "Unexpected positional argument 'second-app' (app name is already 'first-app')",
    })
  })
})

describe('validateAppName', () => {
  it.each(['my-app', 'a1', '12', 'a'.repeat(63)])('accepts canonical app name %s', (name) => {
    expect(validateAppName(name)).toBeNull()
  })

  it.each(['a', 'A-name', '-name', 'name-', 'two--dashes', 'a'.repeat(64)])(
    'rejects non-canonical app name %s',
    (name) => {
      expect(validateAppName(name)).not.toBeNull()
    },
  )
})

describe('nodeRuntimeRefusal', () => {
  it.each(['22.15.0', '22.99.0', '24.0.0', '24.19.0', '26.0.0'])(
    'accepts supported runtime %s',
    (version) => expect(nodeRuntimeRefusal(version)).toBeNull(),
  )

  it.each(['20.20.0', '22.14.0', '23.11.1', '25.9.0', '27.0.0'])(
    'refuses unsupported runtime %s before scaffolding',
    (version) => expect(nodeRuntimeRefusal(version)).toContain(`current: ${version}`),
  )
})
