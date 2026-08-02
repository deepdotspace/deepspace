/**
 * The credential helper's pure core. The contract that matters: the token
 * goes ONLY to the deploy-worker host (scheme + host + port), `get` is the
 * only op that ever answers, and every other case prints nothing — git then
 * falls through to its other helpers instead of hanging on a prompt.
 */

import { describe, expect, it } from 'vitest'
import { credentialHostMatches, declineHint, respondCredential } from '../git-credential'

const DEPLOY = 'https://deploy-worker.deep.space'
const REQ = 'protocol=https\nhost=deploy-worker.deep.space\npath=api/repo/app_01X\n'

describe('respondCredential', () => {
  it('answers get for the deploy host with username + password lines', () => {
    expect(respondCredential('get', REQ, 'jwt-token', DEPLOY)).toBe(
      'username=deepspace\npassword=jwt-token\n',
    )
  })

  it('stays silent for a foreign host — git must fall through, not leak the token', () => {
    const github = 'protocol=https\nhost=github.com\npath=owner/repo.git\n'
    expect(respondCredential('get', github, 'jwt-token', DEPLOY)).toBe('')
  })

  it('matches scheme too — an http imposter on the same hostname gets nothing', () => {
    const http = 'protocol=http\nhost=deploy-worker.deep.space\n'
    expect(respondCredential('get', http, 'jwt-token', DEPLOY)).toBe('')
  })

  it('honors a localhost override with a port', () => {
    const local = 'protocol=http\nhost=localhost:8787\n'
    expect(respondCredential('get', local, 'jwt-token', 'http://localhost:8787')).toBe(
      'username=deepspace\npassword=jwt-token\n',
    )
    // Different port ⇒ different host ⇒ silent.
    const other = 'protocol=http\nhost=localhost:9999\n'
    expect(respondCredential('get', other, 'jwt-token', 'http://localhost:8787')).toBe('')
  })

  it('store and erase are silent no-ops even for the deploy host', () => {
    expect(respondCredential('store', REQ, 'jwt-token', DEPLOY)).toBe('')
    expect(respondCredential('erase', REQ, 'jwt-token', DEPLOY)).toBe('')
  })

  it('stays silent without a token (logged out) or with garbage input', () => {
    expect(respondCredential('get', REQ, null, DEPLOY)).toBe('')
    expect(respondCredential('get', 'not key value pairs', 'jwt-token', DEPLOY)).toBe('')
  })

  it('ignores fields after the blank-line terminator (protocol framing)', () => {
    const framed = 'protocol=https\nhost=github.com\n\nhost=deploy-worker.deep.space\n'
    expect(respondCredential('get', framed, 'jwt-token', DEPLOY)).toBe('')
  })
})

describe('declineHint', () => {
  it('explains a host mismatch on stderr terms — names both hosts and the env fix', () => {
    const staging = 'protocol=https\nhost=deploy-staging.example.dev\n'
    const hint = declineHint('get', staging, 'jwt-token', DEPLOY)
    expect(hint).toContain('deploy-staging.example.dev')
    expect(hint).toContain(DEPLOY)
    expect(hint).toContain('DEEPSPACE_DEPLOY_URL')
    expect(hint).not.toContain('jwt-token') // never the token
  })

  it('explains a missing token for the RIGHT host as a login problem', () => {
    expect(declineHint('get', REQ, null, DEPLOY)).toContain('deepspace auth login')
  })

  it('says nothing when credentials were served, for store/erase, or for garbage input', () => {
    expect(declineHint('get', REQ, 'jwt-token', DEPLOY)).toBe('')
    expect(declineHint('store', REQ, null, DEPLOY)).toBe('')
    expect(declineHint('erase', REQ, null, DEPLOY)).toBe('')
    expect(declineHint('get', 'not key value pairs', null, DEPLOY)).toBe('')
  })
})

describe('credentialHostMatches', () => {
  it('lets the command skip token refresh for foreign hosts', () => {
    expect(credentialHostMatches(REQ, DEPLOY)).toBe(true)
    expect(credentialHostMatches('protocol=https\nhost=github.com\n', DEPLOY)).toBe(false)
    expect(credentialHostMatches(REQ, 'not a url')).toBe(false)
  })

  it('fails closed when the request omits protocol (never token an unspecified scheme)', () => {
    // Right host, no protocol field → must NOT match.
    expect(credentialHostMatches('host=deploy-worker.deep.space\n', 'https://deploy-worker.deep.space')).toBe(
      false,
    )
  })
})
