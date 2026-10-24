/** Explicit agent identity selection, isolated from the operator's CLI session. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { AUTH_URL, DEEPSPACE_ENV, PLANE_AUTH_URLS } from './env'
import { Refusal } from './lib/command'
import { cliAction } from './lib/output'
import { decodeJwtPayload } from '../shared/jwt'
import {
  agentCredentialFromEntropy,
  normalizeAgentCredential,
  agentCredentialBearer,
} from '../shared/agent-credential'

export interface AgentCredential {
  version: 1
  authUrl: string
  credential: string
  name: string
  privateReceipt?: boolean
  token?: string
  userId?: string
  verifiedUntil?: string
  pending?: { id: string; prompt: string; expiresAt: string; purpose: 'register' | 'renew' }
}

export function agentCredentialPath(): string {
  const file = process.env.DEEPSPACE_AGENT_CREDENTIAL_FILE
  if (!file)
    throw new Refusal(
      'Set DEEPSPACE_AGENT_CREDENTIAL_FILE to a private file before creating or using an agent account. Keep the phrase in the private chat to restore it in another container.',
      'agent_credential_file_required',
    )
  if (DEEPSPACE_ENV !== 'staging' || AUTH_URL !== PLANE_AUTH_URLS.staging)
    throw new Refusal(
      'Agent signup is a staging prototype. Select DEEPSPACE_ENV=staging and remove auth URL overrides.',
      'agent_signup_disabled',
    )
  return resolve(file)
}

export function readAgentCredential(): AgentCredential | null {
  const file = agentCredentialPath()
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Refusal('Could not read the agent credential file.', 'credential_unreadable')
  }
  try {
    const value = JSON.parse(text) as AgentCredential
    if (
      value.version !== 1 ||
      value.authUrl !== AUTH_URL ||
      !normalizeAgentCredential(value.credential) ||
      typeof value.name !== 'string' ||
      (value.privateReceipt !== undefined && typeof value.privateReceipt !== 'boolean')
    )
      throw new Error('invalid')
    value.credential = normalizeAgentCredential(value.credential)!
    return value
  } catch {
    throw new Refusal(
      'The agent credential file is invalid or belongs to another auth plane.',
      'invalid_agent_credential_file',
    )
  }
}

export function saveAgentCredential(value: AgentCredential): void {
  const file = agentCredentialPath()
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } catch {
    throw new Refusal(
      'Could not persist the agent credential. Keep its private file safe and retry.',
      'credential_unwritable',
    )
  }
}

export function createAgentCredential(name: string): AgentCredential {
  const existing = readAgentCredential()
  if (existing) return existing
  const file = agentCredentialPath()
  const value: AgentCredential = {
    version: 1,
    authUrl: AUTH_URL,
    name,
    credential: agentCredentialFromEntropy(randomBytes(24)),
  }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = readAgentCredential()
      if (winner) return winner
    }
    throw new Refusal(
      'Could not create the private agent credential file. No signup request was made.',
      'credential_unwritable',
    )
  }
  return value
}

export function agentHash(value: AgentCredential): string {
  return createHash('sha256')
    .update(normalizeAgentCredential(value.credential) ?? value.credential)
    .digest('hex')
}

/** Keep app credentials in memory; never replace the platform-token cache. */
export async function mintAgentAppToken(target: string): Promise<string> {
  const credential = readAgentCredential()
  if (!credential)
    throw new Refusal(
      'Restore your private agent credential before using app tools.',
      'agent_credential_required',
    )
  const result = await agentRequest('app-token', credential, { target })
  if (typeof result.token !== 'string' || !result.token)
    throw new Refusal('The auth service returned no app tool token.', 'invalid_response')
  return result.token
}

export async function agentRequest(
  endpoint: string,
  value: AgentCredential,
  body?: Record<string, unknown>,
  method = 'POST',
): Promise<Record<string, unknown>> {
  agentCredentialPath() // Refuse an unsafe plane before transmitting credentials.
  let response: Response
  try {
    response = await fetch(`${AUTH_URL}/api/auth/agents/${endpoint}`, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentCredentialBearer(value.credential)}`,
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    })
  } catch {
    throw new Refusal(
      `The agent auth service at ${AUTH_URL} could not be reached within 10 seconds. Retain this credential and retry the same operation.`,
      'network_error',
      { extra: { recovery: 'retry-same-operation', serviceUrl: AUTH_URL, timeoutSeconds: 10 } },
    )
  }
  let result: Record<string, unknown>
  try {
    const parsed: unknown = await response.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    result = parsed as Record<string, unknown>
  } catch {
    throw new Refusal('The agent auth service returned an invalid response.', 'invalid_response')
  }
  if (!response.ok) {
    const code = typeof result.code === 'string' ? result.code : 'agent_auth_failed'
    const retryChallenge =
      ['challenge_expired', 'challenge_attempts_exhausted'].includes(code) ||
      (code === 'incorrect_answer' && result.attemptsRemaining === 0)
    const action =
      code === 'agent_verification_required'
        ? cliAction('deepspace', 'auth', 'agent', 'renew', '--json')
        : code === 'challenge_not_found'
          ? cliAction('deepspace', 'auth', 'agent', 'status', '--json')
          : retryChallenge
            ? endpoint === 'renew'
              ? cliAction('deepspace', 'auth', 'agent', 'renew', '--json')
              : cliAction(
                  'deepspace',
                  'auth',
                  'agent',
                  'register',
                  '--name',
                  value.name,
                  ...(value.privateReceipt ? ['--private'] : []),
                  '--json',
                )
            : undefined
    const extra: Record<string, unknown> = { httpStatus: response.status }
    if (
      typeof result.recovery === 'string' &&
      ['fix-input', 'reconsider-answer', 'request-challenge', 'inspect-status', 'wait'].includes(
        result.recovery,
      )
    )
      extra.recovery = result.recovery
    if (
      Number.isInteger(result.attemptsRemaining) &&
      Number(result.attemptsRemaining) >= 0 &&
      Number(result.attemptsRemaining) <= 3
    )
      extra.attemptsRemaining = result.attemptsRemaining
    const retryHeader = response.headers.get('Retry-After')
    const retrySeconds =
      retryHeader === null
        ? result.retryAfterSeconds
        : /^\d+$/.test(retryHeader)
          ? Number(retryHeader)
          : Math.max(0, Math.ceil((Date.parse(retryHeader) - Date.now()) / 1000))
    if (typeof retrySeconds === 'number' && Number.isSafeInteger(retrySeconds) && retrySeconds >= 0)
      extra.retryAfterSeconds = retrySeconds
    throw new Refusal(
      typeof result.error === 'string' ? result.error : 'Agent authentication failed.',
      code,
      { action, extra },
    )
  }
  return result
}

/** Reject app-scoped, expired or malformed tokens before caching platform access. */
function managementClaims(token: string) {
  try {
    const claims = decodeJwtPayload<{
      sub?: string
      iss?: string
      scope?: unknown
      exp?: number
      agentAccount?: boolean
      agentVerifiedUntil?: number
    }>(token)
    if (
      typeof claims.sub === 'string' &&
      claims.sub &&
      claims.iss === `${AUTH_URL}/api/auth` &&
      claims.agentAccount === true &&
      claims.scope === undefined &&
      typeof claims.exp === 'number' &&
      Number.isFinite(claims.exp) &&
      typeof claims.agentVerifiedUntil === 'number' &&
      Number.isFinite(claims.agentVerifiedUntil) &&
      claims.exp * 1000 > Date.now() &&
      claims.exp * 1000 <= claims.agentVerifiedUntil
    )
      return { sub: claims.sub, exp: claims.exp, agentVerifiedUntil: claims.agentVerifiedUntil }
  } catch {
    /* A malformed cache can be refreshed from the account phrase. */
  }
  return null
}

export function rememberAgentSession(
  value: AgentCredential,
  result: Record<string, unknown>,
  completedPurpose?: 'register' | 'renew',
): void {
  if (
    typeof result.token !== 'string' ||
    typeof result.userId !== 'string' ||
    typeof result.verifiedUntil !== 'string'
  )
    throw new Refusal('The agent auth service returned an incomplete session.', 'invalid_response')
  // Do not let a mismatched response replace a credential's stable identity.
  const claims = managementClaims(result.token)
  if (
    !claims ||
    claims.sub !== result.userId ||
    Date.parse(result.verifiedUntil) !== claims.agentVerifiedUntil ||
    (value.userId && value.userId !== result.userId)
  )
    throw new Refusal(
      'The returned agent identity did not match this credential.',
      'invalid_response',
    )
  value.token = result.token
  value.userId = result.userId
  value.verifiedUntil = result.verifiedUntil
  // Refreshing a management token must not discard an unfinished renewal.
  if (value.pending?.purpose === completedPurpose) delete value.pending
  saveAgentCredential(value)
}

export async function ensureAgentToken(
  forceRefresh = false,
  minimumValidityMs = 30_000,
): Promise<string> {
  const value = readAgentCredential()
  if (!value)
    throw new Refusal(
      'Create an agent account with deepspace auth agent register --name <name>.',
      'agent_not_registered',
    )
  if (value.verifiedUntil) {
    const remaining = Date.parse(value.verifiedUntil) - Date.now()
    if (remaining > 0 && remaining <= 30 * 60_000) {
      process.stderr.write(
        `Agent verification expires in ${Math.ceil(remaining / 60_000)} minutes. Run deepspace auth agent renew --json and solve its challenge to keep managing this account. Your deployed apps keep serving.\n`,
      )
    }
  }
  if (value.token && !forceRefresh) {
    const claims = managementClaims(value.token)
    if (
      claims &&
      claims.exp * 1000 > Date.now() + minimumValidityMs &&
      claims.sub === value.userId &&
      Date.parse(value.verifiedUntil ?? '') === claims.agentVerifiedUntil
    )
      return value.token
  }

  const result = await agentRequest('token', value)
  rememberAgentSession(value, result)
  return value.token!
}
