import { generateKeyPairSync, createVerify } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ascToken, resolveAscCredentials, type AscFetch } from '../lib/app-store-connect'
import { uploadToTestFlight } from '../commands/testflight'

const info = { bundleId: 'com.example.tasks', version: '1.0.0', build: '7' }

/** A scripted App Store Connect: each build poll returns the next state. */
function fakeAsc(states: Array<[processing: string, internal: string]>, groups = [{ isInternalGroup: true, hasAccessToAllBuilds: true }]) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = []
  let poll = 0
  const asc: AscFetch = async (path, init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
    if (path.startsWith('/v1/apps?')) return { status: 200, json: { data: [{ id: 'app1', attributes: { bundleId: info.bundleId } }] } }
    if (path === '/v1/buildUploads') return { status: 201, json: { data: { id: 'up1', attributes: {} } } }
    if (path === '/v1/buildUploadFiles') {
      return {
        status: 201,
        json: {
          data: {
            id: 'file1',
            attributes: {
              uploadOperations: [
                { method: 'PUT', url: 'https://upload.test/1', offset: 0, length: 2 },
                { method: 'PUT', url: 'https://upload.test/2', offset: 2, length: 2 },
              ],
            },
          },
        },
      }
    }
    if (path.startsWith('/v1/buildUploadFiles/')) return { status: 200, json: {} }
    if (path.startsWith('/v1/builds?')) {
      const [processing] = states[Math.min(poll, states.length - 1)]
      return { status: 200, json: { data: [{ id: 'b1', attributes: { version: info.build, processingState: processing } }] } }
    }
    if (path.startsWith('/v1/buildBetaDetails')) {
      const [, internal] = states[Math.min(poll++, states.length - 1)]
      return { status: 200, json: { data: [{ attributes: { internalBuildState: internal } }] } }
    }
    if (path.includes('/betaGroups')) return { status: 200, json: { data: groups.map((attributes) => ({ id: 'g', attributes })) } }
    throw new Error(`unexpected ${method} ${path}`)
  }
  return { asc, calls }
}

const sentParts: string[] = []
const fetchImpl = (async (url: string) => {
  sentParts.push(url)
  return new Response(null, { status: 200 })
}) as unknown as typeof fetch

function upload(asc: AscFetch, timeoutMs = 60_000) {
  return uploadToTestFlight({
    asc,
    bytes: new Uint8Array([1, 2, 3, 4]),
    fileName: 'app.ipa',
    info,
    timeoutMs,
    log: () => {},
    fetchImpl,
    sleep: async () => {},
    pollMs: 0,
  })
}

describe('uploadToTestFlight', () => {
  it('finds the app by the IPA bundle id, uploads every part, and waits for TestFlight', async () => {
    const { asc, calls } = fakeAsc([
      ['PROCESSING', 'PROCESSING'],
      ['VALID', 'IN_BETA_TESTING'],
    ])
    await expect(upload(asc)).resolves.toEqual({ appId: 'app1', ...info })
    expect(sentParts).toEqual(expect.arrayContaining(['https://upload.test/1', 'https://upload.test/2']))
    // No release notes: they hold the Mac app behind TestFlight's first-launch screen.
    expect(calls.some((call) => call.path.includes('betaBuildLocalizations'))).toBe(false)
  })

  it('says so when no internal group receives every build', async () => {
    const { asc } = fakeAsc([['VALID', 'READY_FOR_BETA_TESTING']], [])
    await expect(upload(asc)).rejects.toMatchObject({ code: 'asc_no_internal_group' })
  })

  it('stops on an INVALID build', async () => {
    const { asc } = fakeAsc([['INVALID', 'PENDING']])
    await expect(upload(asc)).rejects.toMatchObject({ code: 'asc_build_invalid' })
  })

  it('refuses an IPA whose bundle id has no app', async () => {
    const asc: AscFetch = async () => ({ status: 200, json: { data: [] } })
    await expect(upload(asc)).rejects.toMatchObject({ code: 'asc_app_not_found' })
  })
})

describe('App Store Connect credentials', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

  it('reads the EAS variables first, then eas.json in the app or mobile/', () => {
    const root = mkdtempSync(join(tmpdir(), 'asc-'))
    mkdirSync(join(root, 'mobile', '.secrets'), { recursive: true })
    writeFileSync(join(root, 'mobile', '.secrets', 'AuthKey_K1.p8'), pem)
    writeFileSync(
      join(root, 'mobile', 'eas.json'),
      JSON.stringify({ submit: { production: { ios: { ascApiKeyPath: '.secrets/AuthKey_K1.p8', ascApiKeyId: 'K1', ascApiKeyIssuerId: 'I1' } } } }),
    )
    expect(resolveAscCredentials(root, {})).toMatchObject({ keyId: 'K1', issuerId: 'I1', keyPath: join(root, 'mobile', '.secrets', 'AuthKey_K1.p8') })

    const keyPath = join(root, 'other.p8')
    writeFileSync(keyPath, pem)
    expect(
      resolveAscCredentials(root, { EXPO_ASC_API_KEY_PATH: keyPath, EXPO_ASC_KEY_ID: 'K2', EXPO_ASC_ISSUER_ID: 'I2' }),
    ).toMatchObject({ keyId: 'K2', issuerId: 'I2', keyPath })
  })

  it('refuses with the variables to set when nothing is configured', () => {
    expect(() => resolveAscCredentials(mkdtempSync(join(tmpdir(), 'asc-')), {})).toThrow(/EXPO_ASC_API_KEY_PATH/)
  })

  it('signs a verifiable ES256 token for the App Store Connect audience', () => {
    const token = ascToken({ keyId: 'K1', issuerId: 'I1', keyPath: '', privateKey: pem }, 1000)
    const [header, payload, signature] = token.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'K1', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iss: 'I1', iat: 1000, exp: 2200, aud: 'appstoreconnect-v1' })
    const verifier = createVerify('sha256').update(`${header}.${payload}`)
    expect(verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
  })
})
