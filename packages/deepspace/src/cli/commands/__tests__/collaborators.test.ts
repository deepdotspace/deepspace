/**
 * What `collaborators add` DISCLOSES. The grant hands over deploy rights AND
 * plaintext read/write on every app secret, but only `--help` ever said so: the
 * human line was "✓ <email> can now deploy <app>" and the `--json` envelope had
 * no field an agent could check. An agent asked to "add Dana so she can deploy"
 * believed that was what it granted.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import collaborators from '../collaborators'
import * as authModule from '../../auth'
import * as appTarget from '../../lib/app-target'
import * as apiModule from '../../lib/api'

const APP = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
const EMAIL = 'dana@example.com'

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

function addCommand() {
  const sub = (collaborators as unknown as { subCommands: Record<string, unknown> }).subCommands
  return sub.add as { run: (ctx: { args: Record<string, unknown> }) => Promise<unknown> }
}

async function runAdd(
  response: Record<string, unknown>,
  json: boolean,
): Promise<{ stdout: string[]; envelope: Record<string, unknown> | null }> {
  vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
  vi.spyOn(appTarget, 'resolveAppTarget').mockResolvedValue(APP)
  vi.spyOn(apiModule, 'apiFetch').mockResolvedValue(response as never)
  const stdout: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => stdout.push(String(line)))
  process.exitCode = undefined
  await addCommand().run({ args: { email: EMAIL, json } })
  return {
    stdout,
    envelope: json ? (JSON.parse(stdout[0]) as Record<string, unknown>) : null,
  }
}

describe('collaborators add discloses what it grants', () => {
  const GRANTS = ['deploy', 'secrets:read', 'secrets:write']

  it('names secrets access on the human line, not just deploy', async () => {
    const { stdout } = await runAdd(
      { status: 'added', collaborator: { userId: 'usr_1', emailDisplay: EMAIL } },
      false,
    )
    const line = stdout.join('\n')
    expect(line).toContain(EMAIL)
    expect(line).toContain('secret')
    expect(line).toContain('plaintext')
    // The two things the grant does NOT confer stay stated too.
    expect(line).toContain('cannot undeploy or transfer')
  })

  it('gives the machine surface a `grants` field to check instead of prose', async () => {
    const { envelope } = await runAdd(
      { status: 'added', collaborator: { userId: 'usr_1', emailDisplay: EMAIL } },
      true,
    )
    expect(envelope).toMatchObject({ ok: true, status: 'added', grants: GRANTS })
  })

  it('carries the same grants on an invite — acceptance confers exactly them', async () => {
    const { envelope } = await runAdd(
      { status: 'invited', email: EMAIL, expiresAt: Date.now() + 86_400_000 },
      true,
    )
    expect(envelope).toMatchObject({ ok: true, status: 'invited', grants: GRANTS })
  })

  it('builds the sentence FROM the grants array, so the two cannot drift', async () => {
    // One constant feeds `--help`, the human line and the envelope: whatever the
    // array says, the prose spells out.
    const { stdout } = await runAdd(
      { status: 'added', collaborator: { userId: 'usr_1', emailDisplay: EMAIL } },
      false,
    )
    for (const grant of GRANTS) expect(stdout.join('\n')).toContain(grant)
    const help = (addCommand() as unknown as { meta: { description: string } }).meta.description
    for (const grant of GRANTS) expect(help).toContain(grant)
  })
})
