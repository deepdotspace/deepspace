/**
 * verifyJwt's scope rule: sign-in sessions carry no `scope`; machine
 * credentials (an app's APP_OWNER_JWT, agent tokens) do, and are accepted
 * only where the caller opts in. Real ES256 signing, so this is the same
 * code path production runs.
 */

import { describe, expect, it } from 'vitest'
import { importPKCS8, SignJWT } from 'jose'
import { isAppTokenScope, verifyJwt } from '../jwtVerifier'
import { agentTokenIssuer, verifyAgentToken } from '../agentToken'

const ISSUER = 'https://auth.test.deep.space'
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHdCNTlzfguOe6KiVagYksU5ZTrQ2
9qMZbXQJesZQOsFR7tdd4qSBuVzv+ZhxOdYmDwGbcCyA+9gdTpdqqFxEOw==
-----END PUBLIC KEY-----`
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgViVa+AqStZtvZ49N
7VVjclAPZuJ3TmQQDeRAiamBxPKhRANCAAQd0I1OXN+C457oqJVqBiSxTllOtDb2
oxltdAl6xlA6wVHu113ipIG5XO/5mHE51iYPAZtwLID72B1Ol2qoXEQ7
-----END PRIVATE KEY-----`
const config = { publicKey: PUBLIC_KEY, issuer: ISSUER }

async function sign(
  claims: Record<string, unknown>,
  options: { issuer?: string; audience?: string } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject('user_owner')
    .setIssuer(options.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
  if (options.audience) jwt.setAudience(options.audience)
  return jwt.sign(await importPKCS8(PRIVATE_KEY, 'ES256'))
}

describe('verifyJwt scope', () => {
  it('accepts a session token, which carries no scope', async () => {
    const { result } = await verifyJwt(config, await sign({ name: 'Owner' }))
    expect(result?.userId).toBe('user_owner')
  })

  it("refuses an app's owner token by default", async () => {
    const token = await sign({ scope: 'app:app_demo', app_name: 'app_demo' })
    const { result, error } = await verifyJwt(config, token)
    expect(result).toBeNull()
    expect(String(error)).toMatch(/scope "app:app_demo" is not accepted/)
  })

  it('accepts an owner token where the caller opts in with isAppTokenScope', async () => {
    const token = await sign({ scope: 'app:app_demo', app_name: 'app_demo' })
    const { result } = await verifyJwt({ ...config, acceptScope: isAppTokenScope }, token)
    expect(result?.claims.scope).toBe('app:app_demo')
  })

  it('refuses a scope the opt-in does not cover, and a non-string scope', async () => {
    const appOnly = { ...config, acceptScope: isAppTokenScope }
    expect((await verifyJwt(appOnly, await sign({ scope: 'agent' }))).result).toBeNull()
    expect((await verifyJwt(appOnly, await sign({ scope: ['app:x'] }))).result).toBeNull()
  })

  it('still accepts agent tokens through verifyAgentToken', async () => {
    const origin = 'https://demo.app.space'
    const token = await sign(
      { scope: 'agent' },
      { issuer: agentTokenIssuer(ISSUER), audience: origin },
    )
    expect((await verifyAgentToken(config, token, origin)).result?.userId).toBe('user_owner')
    const unscoped = await sign({}, { issuer: agentTokenIssuer(ISSUER), audience: origin })
    expect((await verifyAgentToken(config, unscoped, origin)).result).toBeNull()
  })
})
