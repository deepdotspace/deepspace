/**
 * Credentials are stored PER AUTH PLANE.
 *
 * A single global {session,token} pair meant one `DEEPSPACE_ENV=staging`
 * login clobbered the production session; the next prod command then
 * exchanged a staging cookie against the prod auth worker and reported
 * "Session expired. Run `deepspace auth login`" — which reads like broken
 * token auto-refresh but is a different account plane entirely. Pin the
 * isolation, and pin that production keeps its historical filenames so an
 * upgrade never logs anyone out.
 */

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { credentialPaths } from '../auth'

const DIR = join(homedir(), '.deepspace')

describe('credentialPaths', () => {
  it('production keeps the historical un-suffixed filenames', () => {
    expect(credentialPaths('https://auth.deep.space')).toEqual({
      sessionPath: join(DIR, 'session'),
      tokenPath: join(DIR, 'token'),
    })
  })

  it('staging gets its own pair — a staging login cannot clobber prod', () => {
    const stg = credentialPaths('https://auth.deepspacesites.com')
    const prod = credentialPaths('https://auth.deep.space')
    expect(stg.sessionPath).not.toBe(prod.sessionPath)
    expect(stg.tokenPath).not.toBe(prod.tokenPath)
    expect(stg.sessionPath).toBe(join(DIR, 'session.auth-deepspacesites-com'))
  })

  it('a bare DEEPSPACE_AUTH_URL override gets its own slot too', () => {
    // The key is the auth URL, not DEEPSPACE_ENV: pointing at any other auth
    // worker is just as much a different account plane.
    const a = credentialPaths('http://localhost:8794')
    const b = credentialPaths('https://auth.deep.space')
    expect(a.sessionPath).not.toBe(b.sessionPath)
    expect(a.sessionPath).toBe(join(DIR, 'session.localhost-8794'))
  })

  it('distinct planes never collide, and filenames stay path-safe', () => {
    const urls = [
      'https://auth.deep.space',
      'https://auth.deepspacesites.com',
      'https://auth.spacestest.com',
      'http://localhost:8794',
      'http://127.0.0.1:8794',
    ]
    const sessions = urls.map((u) => credentialPaths(u).sessionPath)
    expect(new Set(sessions).size).toBe(urls.length)
    for (const s of sessions) {
      expect(s.startsWith(DIR)).toBe(true)
      // No separators or traversal could reach outside ~/.deepspace.
      expect(s.slice(DIR.length + 1)).toMatch(/^(session|token)[a-zA-Z0-9.-]*$/)
    }
  })

  it('a malformed auth URL still yields a safe, non-prod filename', () => {
    const p = credentialPaths('not a url')
    expect(p.sessionPath.startsWith(join(DIR, 'session.'))).toBe(true)
    // The FILENAME carries no separator — the sanitizer can't be walked out
    // of ~/.deepspace by a hostile DEEPSPACE_AUTH_URL.
    expect(p.sessionPath.slice(DIR.length + 1)).not.toContain('/')
    expect(credentialPaths('https://evil/../../etc/passwd').sessionPath.slice(DIR.length + 1)).not.toContain('/')
  })
})
