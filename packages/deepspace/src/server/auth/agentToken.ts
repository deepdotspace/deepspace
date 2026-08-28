import type { JwtVerifierConfig, VerifyOutcome } from './types'
import { verifyJwt } from './jwtVerifier'

export const AGENT_TOKEN_SCOPE = 'agent'

/** A separate issuer keeps agent credentials invalid at ordinary platform APIs. */
export function agentTokenIssuer(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/agent`
}

/** Verify an agent credential for the exact origin currently receiving it. */
export async function verifyAgentToken(
  config: Omit<JwtVerifierConfig, 'audience'>,
  token: string | null | undefined,
  targetOrigin: string,
): Promise<VerifyOutcome> {
  const outcome = await verifyJwt(
    {
      ...config,
      issuer: agentTokenIssuer(config.issuer),
      audience: targetOrigin,
    },
    token,
  )
  if (!outcome.result || outcome.result.claims.scope === AGENT_TOKEN_SCOPE) return outcome
  return { ...outcome, result: null, error: new Error('Invalid agent token scope') }
}
