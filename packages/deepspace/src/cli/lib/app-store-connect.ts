/**
 * App Store Connect API access for the iOS commands.
 *
 * Credentials are the ones EAS already uses, so one setup serves both
 * `eas build --local` and `deepspace testflight`:
 *   - EXPO_ASC_API_KEY_PATH, EXPO_ASC_KEY_ID, EXPO_ASC_ISSUER_ID, or
 *   - eas.json's submit.production.ios ascApiKeyPath / ascApiKeyId /
 *     ascApiKeyIssuerId (in the app root or its mobile/ directory).
 * The .p8 key stays wherever the developer keeps it; it is read, never copied.
 */

import { createSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { Refusal } from './command'

export interface AscCredentials {
  keyId: string
  issuerId: string
  keyPath: string
  privateKey: string
}

export interface AscResponse {
  status: number
  json: unknown
}

export type AscFetch = (path: string, init?: RequestInit) => Promise<AscResponse>

const API = 'https://api.appstoreconnect.apple.com'

interface EasSubmit {
  ascApiKeyPath?: string
  ascApiKeyId?: string
  ascApiKeyIssuerId?: string
}

function easSubmit(cwd: string): { config: EasSubmit; dir: string } | null {
  for (const dir of [cwd, join(cwd, 'mobile')]) {
    const file = join(dir, 'eas.json')
    if (!existsSync(file)) continue
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { submit?: { production?: { ios?: EasSubmit } } }
    return { config: parsed.submit?.production?.ios ?? {}, dir }
  }
  return null
}

export function resolveAscCredentials(cwd: string, env: NodeJS.ProcessEnv = process.env): AscCredentials {
  const eas = easSubmit(cwd)
  const keyId = env.EXPO_ASC_KEY_ID || eas?.config.ascApiKeyId
  const issuerId = env.EXPO_ASC_ISSUER_ID || eas?.config.ascApiKeyIssuerId
  const configuredPath = env.EXPO_ASC_API_KEY_PATH || eas?.config.ascApiKeyPath
  if (!keyId || !issuerId || !configuredPath) {
    throw new Refusal(
      'No App Store Connect API key configured. Set EXPO_ASC_API_KEY_PATH, EXPO_ASC_KEY_ID and EXPO_ASC_ISSUER_ID ' +
        '(the variables `eas build` reads), or submit.production.ios ascApiKeyPath, ascApiKeyId and ascApiKeyIssuerId in eas.json.',
      'asc_key_missing',
    )
  }
  const keyPath = isAbsolute(configuredPath) ? configuredPath : resolve(eas?.dir ?? cwd, configuredPath)
  if (!existsSync(keyPath)) {
    throw new Refusal(`No App Store Connect API key file at ${keyPath}.`, 'asc_key_missing')
  }
  return { keyId, issuerId, keyPath, privateKey: readFileSync(keyPath, 'utf8') }
}

/** An ES256 token; Apple accepts at most 20 minutes, so sign one per request. */
export function ascToken(credentials: AscCredentials, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${part({ alg: 'ES256', kid: credentials.keyId, typ: 'JWT' })}.${part({
    iss: credentials.issuerId,
    iat: nowSeconds,
    exp: nowSeconds + 1200,
    aud: 'appstoreconnect-v1',
  })}`
  // JWS wants the raw r||s signature, not DER.
  const signature = createSign('sha256')
    .update(signingInput)
    .sign({ key: credentials.privateKey, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${signature.toString('base64url')}`
}

export function ascClient(credentials: AscCredentials, fetchImpl: typeof fetch = fetch): AscFetch {
  return async (path, init = {}) => {
    const response = await fetchImpl(path.startsWith('http') ? path : `${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${ascToken(credentials)}`, 'Content-Type': 'application/json', ...init.headers },
    })
    const text = await response.text()
    // A rejected or underprivileged key will not recover; stop rather than poll.
    if (response.status === 401 || response.status === 403) {
      throw new Refusal(
        `App Store Connect refused the key ${credentials.keyId} (HTTP ${response.status}). Check the key file, the issuer id, and that the key's role can upload builds.`,
        'asc_unauthorized',
      )
    }
    let json: unknown = text
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { status: response.status, json }
  }
}
