import { defineCommand } from 'citty'
import { AGENT_CREDENTIAL_INSTRUCTIONS } from '../../shared/agent-credential'
import {
  agentHash,
  agentRequest,
  createAgentCredential,
  readAgentCredential,
  rememberAgentSession,
  saveAgentCredential,
  type AgentCredential,
} from '../agent-credentials'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import { cliAction, resolveActionArgv } from '../lib/output'

function credential(): AgentCredential {
  const value = readAgentCredential()
  if (!value)
    throw new Refusal(
      'No credential exists at DEEPSPACE_AGENT_CREDENTIAL_FILE. Register an agent first.',
      'agent_not_registered',
    )
  return value
}

function publicResult(result: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...result }
  delete safe.token
  return safe
}

function keepChallenge(
  value: AgentCredential,
  result: Record<string, unknown>,
  purpose: 'register' | 'renew',
) {
  const challenge = result.challenge as
    | { id?: unknown; prompt?: unknown; expiresAt?: unknown }
    | undefined
  if (
    !challenge ||
    typeof challenge.id !== 'string' ||
    typeof challenge.prompt !== 'string' ||
    typeof challenge.expiresAt !== 'string'
  )
    throw new Refusal('The auth service returned an invalid challenge.', 'invalid_response')
  value.pending = {
    id: challenge.id,
    prompt: challenge.prompt,
    expiresAt: challenge.expiresAt,
    purpose,
  }
  saveAgentCredential(value)
}

function show(
  value: AgentCredential,
  result: Record<string, unknown>,
  json: boolean,
  purpose?: 'register' | 'renew',
) {
  const privateReceipt = value.privateReceipt === true
  const safe = publicResult(result)
  const challenge = result.challenge as { purpose?: string; state?: string } | undefined
  purpose ??=
    challenge?.purpose === 'register' || challenge?.purpose === 'renew'
      ? challenge.purpose
      : undefined
  let action
  if (purpose && challenge && ['expired', 'exhausted'].includes(challenge.state ?? '')) {
    safe.nextStep = {
      kind: 'request-challenge',
      instruction: 'Request a fresh challenge using the same credential.',
    }
    action =
      purpose === 'renew'
        ? cliAction('deepspace', 'auth', 'agent', 'renew', '--json')
        : cliAction(
            'deepspace',
            'auth',
            'agent',
            'register',
            '--name',
            String(result.name ?? value.name),
            ...(privateReceipt ? ['--private'] : []),
            '--json',
          )
  } else if (purpose && challenge) {
    // An answer needs reasoning, so it is not an executable `action` yet.
    safe.nextStep = {
      kind: 'solve-challenge',
      instruction:
        'Solve challenge.prompt, then append your integer answer to argvPrefix and run it in cwd.',
      cwd: process.cwd(),
      argvPrefix: resolveActionArgv([
        'deepspace',
        'auth',
        'agent',
        purpose,
        ...(purpose === 'register' && privateReceipt ? ['--private'] : []),
        '--json',
        '--answer',
      ]),
      input: { type: 'integer', source: 'challenge.prompt' },
    }
  } else if (purpose === 'register' && result.userId) {
    if (!privateReceipt) {
      safe.accountReceipt = {
        credential: value.credential,
        userId: result.userId,
        authUrl: value.authUrl,
        instruction: AGENT_CREDENTIAL_INSTRUCTIONS,
      }
    }
    safe.nextStep = {
      kind: 'build-app',
      instruction:
        'Your account is ready. Scaffold an app with create-deepspace, commit its source, and run deepspace deploy --json inside it.',
      template: 'public-board',
      credential: {
        path: process.env.DEEPSPACE_AGENT_CREDENTIAL_FILE,
        writable: true,
        persistence:
          'Keep the phrase in the private chat or private storage; this file may be temporary.',
      },
    }
  }
  if (!action && !challenge && result.verificationRequired === true)
    action = cliAction('deepspace', 'auth', 'agent', 'renew', '--json')
  if (!action && purpose && result.userId && !challenge)
    action = cliAction('deepspace', 'auth', 'whoami', '--json')
  if (!json) console.log(JSON.stringify(safe, null, 2))
  return {
    data: safe,
    ...(action ? { action } : {}),
  }
}

const register = defineDeepspaceCommand({
  meta: {
    name: 'register',
    description:
      'Create an independent agent account on staging; request a challenge, then submit --answer',
  },
  args: {
    name: { type: 'string', description: 'Agent display name' },
    private: {
      type: 'boolean',
      description: 'Remember private storage for this account and omit phrase receipts',
      negativeDescription: 'Return phrase receipts in the private chat again',
    },
    answer: { type: 'string', description: 'Integer answer to the saved challenge' },
  },
  async run({ args }) {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    const existing = readAgentCredential()
    if (
      args.answer === undefined &&
      (args.name !== undefined || !existing) &&
      (!name || name.length > 80)
    )
      throw new Refusal('Supply --name with 1-80 characters.', 'invalid_name')
    const value =
      existing ?? (args.answer !== undefined ? credential() : createAgentCredential(name))
    if (typeof args.private === 'boolean' && args.private !== value.privateReceipt) {
      value.privateReceipt = args.private
      saveAgentCredential(value)
    }
    if (value.userId) {
      const result = await agentRequest('token', value)
      rememberAgentSession(value, result, 'register')
      return show(value, result, !!args.json, 'register')
    }
    if (args.answer !== undefined) {
      if (value.pending?.purpose !== 'register')
        throw new Refusal(
          'Recover the pending registration challenge with status before submitting an answer.',
          'challenge_required',
          {
            action: cliAction('deepspace', 'auth', 'agent', 'status', '--json'),
          },
        )
      const result = await agentRequest('register', value, {
        challengeId: value.pending.id,
        answer: args.answer,
      })
      rememberAgentSession(value, result, 'register')
      return show(value, result, !!args.json, 'register')
    }
    try {
      const result = await agentRequest('challenges', value, {
        credentialHash: agentHash(value),
        name: value.name,
      })
      keepChallenge(value, result, 'register')
      return show(value, result, !!args.json, 'register')
    } catch (error) {
      // The durable credential is intentionally written before the first
      // network request. If staging temporarily has no validated challenge,
      // the account still does not exist, but the agent can safely retry the
      // same registration later with this exact credential. Say both facts in
      // the machine contract so an agent does not mistake local initialization
      // for a completed signup or generate a second identity.
      if (error instanceof Refusal && error.code === 'agent_challenges_unavailable') {
        throw new Refusal(
          'The private agent credential was initialized, but no account was created because staging has no validated signup challenge. Retry this same registration later; keep using the existing credential file.',
          error.code,
          {
            action: cliAction(
              'deepspace',
              'auth',
              'agent',
              'register',
              '--name',
              value.name,
              ...(value.privateReceipt ? ['--private'] : []),
              '--json',
            ),
            extra: {
              ...error.extra,
              credentialState: 'initialized',
              accountState: 'not_registered',
              retrySameCredential: true,
            },
          },
        )
      }
      // A lost successful signup response must recover the same identity.
      if (!(error instanceof Refusal) || error.code !== 'agent_already_registered') throw error
      const result = await agentRequest('token', value)
      rememberAgentSession(value, result, 'register')
      return show(value, result, !!args.json, 'register')
    }
  },
})

const renew = defineDeepspaceCommand({
  meta: { name: 'renew', description: 'Request or answer a challenge for the same agent account' },
  args: {
    answer: { type: 'string', description: 'Integer answer to the saved renewal challenge' },
  },
  async run({ args }) {
    const value = credential()
    if (args.answer !== undefined && value.pending?.purpose !== 'renew')
      throw new Refusal(
        'Recover the pending renewal challenge with status before submitting an answer.',
        'challenge_required',
        {
          action: cliAction('deepspace', 'auth', 'agent', 'status', '--json'),
        },
      )
    const result = await agentRequest(
      'renew',
      value,
      args.answer === undefined ? {} : { challengeId: value.pending!.id, answer: args.answer },
    )
    if (args.answer === undefined) keepChallenge(value, result, 'renew')
    else rememberAgentSession(value, result, 'renew')
    return show(value, result, !!args.json, 'renew')
  },
})

const status = defineDeepspaceCommand({
  meta: {
    name: 'status',
    description: 'Inspect account state and recover a pending challenge without allocating another',
  },
  async run({ args }) {
    const value = credential()
    const result = await agentRequest('status', value, undefined, 'GET')
    if (typeof result.userId === 'string') {
      if (value.userId && result.userId !== value.userId)
        throw new Refusal(
          'The returned agent identity did not match this credential.',
          'invalid_response',
        )
      value.userId = result.userId
      if (typeof result.verifiedUntil === 'string') value.verifiedUntil = result.verifiedUntil
    }
    const challenge = result.challenge as { purpose?: string } | undefined
    if (challenge?.purpose === 'register' || challenge?.purpose === 'renew')
      keepChallenge(value, result, challenge.purpose)
    else {
      delete value.pending
      saveAgentCredential(value)
    }
    return show(value, result, !!args.json)
  },
})

const revoke = defineDeepspaceCommand({
  meta: {
    name: 'revoke',
    description:
      'Revoke this durable credential; existing short-lived tokens expire within 15 minutes',
  },
  async run({ args }) {
    const value = credential()
    const result = await agentRequest('revoke', value)
    delete value.token
    saveAgentCredential(value)
    return show(value, result, !!args.json)
  },
})

export default defineCommand({
  meta: { name: 'agent', description: 'Staging prototype for independent agent accounts' },
  subCommands: { register, renew, status, revoke },
})
