import { describe, expect, it, vi } from 'vitest'
import { nodeRuntimeRefusal, parseArgs, readCliInput, validateAppName } from '../cli-input'

const argv = (...args: string[]) => ['node', 'create-deepspace', ...args]

describe('prototype distribution guidance', () => {
  const url = 'https://example.com/pinned/deepspace.tgz'
  const templates = () => [{ name: 'starter', description: 'Starter' }]

  it('defaults to the matching archive while respecting explicit SDK and local selections', async () => {
    expect(
      await readCliInput(argv('my-app'), () => '0.42.3', templates, 'starter', url),
    ).toMatchObject({ sdkUrl: url })
    const override = 'https://example.com/other/deepspace.tgz'
    expect(
      await readCliInput(
        argv('my-app', '--sdk-url', override),
        () => '0.42.3',
        templates,
        'starter',
        url,
      ),
    ).toMatchObject({ sdkUrl: override })
    expect(
      await readCliInput(
        argv('my-app', '--local', '/tmp/sdk'),
        () => '0.42.3',
        templates,
        'starter',
        url,
      ),
    ).toMatchObject({ local: '/tmp/sdk', sdkUrl: undefined })
    expect(await readCliInput(argv('my-app'), () => '0.42.3', templates, 'starter')).toMatchObject({
      sdkUrl: undefined,
    })
  })

  it('keeps prototype help and missing-name guidance on the installed command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`)
    })
    try {
      await expect(
        readCliInput(argv('--help'), () => '0.42.3', templates, 'starter', url),
      ).rejects.toThrow('exit:0')
      const help = log.mock.calls.flat().join('\n')
      expect(help).toContain(url)
      expect(help).toContain('create-deepspace my-app --template public-board')
      expect(help).not.toContain('@latest')
      await expect(readCliInput(argv(), () => '0.42.3', templates, 'starter', url)).rejects.toThrow(
        'exit:1',
      )
      expect(error.mock.calls.flat().join('\n')).toContain('create-deepspace --help')
      expect(error.mock.calls.flat().join('\n')).not.toContain('@latest')
      log.mockClear()
      await expect(
        readCliInput(argv('--help'), () => '0.42.3', templates, 'starter'),
      ).rejects.toThrow('exit:0')
      expect(log.mock.calls.flat().join('\n')).toContain('npm create deepspace@latest')
    } finally {
      log.mockRestore()
      error.mockRestore()
      exit.mockRestore()
    }
  })
})

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

it('accepts an exact SDK archive URL and refuses unsafe or conflicting sources', () => {
  const url = 'https://example.com/commit/deepspace.tgz'
  expect(parseArgs(['node', 'create-deepspace', 'board', '--sdk-url', url]).sdkUrl).toBe(url)
  for (const source of [
    'http://example.com/sdk.tgz',
    'https://user:secret@example.com/sdk.tgz',
    'file:/tmp/sdk.tgz',
    'https://example.com/sdk',
  ]) {
    expect(
      parseArgs(['node', 'create-deepspace', 'board', '--sdk-url', source]).invalid,
    ).toBeTruthy()
  }
  expect(
    parseArgs(['node', 'create-deepspace', 'board', '--sdk-url', url, '--local', '/tmp/sdk'])
      .invalid,
  ).toBeTruthy()
})

it('requires explicit opt-in to modify agent skill configuration', () => {
  expect(parseArgs(argv('app')).withSkill).toBe(false)
  expect(parseArgs(argv('app', '--yes')).withSkill).toBe(false)
  expect(parseArgs(argv('app', '--with-skill')).withSkill).toBe(true)
})
