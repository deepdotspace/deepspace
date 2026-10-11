/**
 * deepspace testflight <signed.ipa>
 *
 * Uploads a signed iOS build (from `eas build --local`, or anything that
 * produces an IPA) to App Store Connect and waits until TestFlight offers
 * it: processing VALID and the internal group's build IN_BETA_TESTING.
 *
 * The App Store Connect app is found from the IPA's own bundle id, so the
 * command needs no per-app configuration beyond the API key
 * (lib/app-store-connect.ts). It never prints Apple's signed upload URLs or
 * the credentials.
 *
 * It deliberately sets no "What to Test" notes: TestFlight shows a build's
 * notes in a screen that holds the app at its first launch on a Mac.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { ascClient, resolveAscCredentials, type AscFetch } from '../lib/app-store-connect'
import { defineDeepspaceCommand, Refusal } from '../lib/command'

export interface IpaInfo {
  bundleId: string
  version: string
  build: string
}

/** The bundle id, version and build number from the IPA's Info.plist (macOS: unzip and plutil). */
export function readIpaInfo(ipaPath: string): IpaInfo {
  if (process.platform !== 'darwin') {
    throw new Refusal('`testflight` reads the IPA with macOS tools; run it on a Mac.', 'unsupported_platform')
  }
  const plist = execFileSync('unzip', ['-p', ipaPath, 'Payload/*.app/Info.plist'])
  const info = JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist, encoding: 'utf8' }),
  ) as Record<string, unknown>
  const bundleId = String(info.CFBundleIdentifier ?? '')
  const version = String(info.CFBundleShortVersionString ?? '')
  const build = String(info.CFBundleVersion ?? '')
  if (!bundleId || !version || !build) {
    throw new Refusal('The IPA has no bundle id, version or build number in its Info.plist.', 'invalid_ipa')
  }
  return { bundleId, version, build }
}

interface UploadOperation {
  method: string
  url: string
  offset: number
  length: number
  requestHeaders?: Array<{ name: string; value: string }>
}

interface Resource<A = Record<string, unknown>> {
  id: string
  attributes: A
}

const data = <T>(json: unknown) => (json as { data?: T } | null)?.data

export interface UploadOptions {
  asc: AscFetch
  bytes: Uint8Array
  fileName: string
  info: IpaInfo
  timeoutMs: number
  log: (line: string) => void
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
}

export interface UploadResult {
  appId: string
  bundleId: string
  version: string
  build: string
}

export async function uploadToTestFlight(options: UploadOptions): Promise<UploadResult> {
  const { asc, bytes, info, log } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const json = (body: unknown) => JSON.stringify(body)

  const apps = await asc(`/v1/apps?filter%5BbundleId%5D=${encodeURIComponent(info.bundleId)}&fields%5Bapps%5D=bundleId`)
  const app = data<Resource[]>(apps.json)?.find((candidate) => candidate.attributes.bundleId === info.bundleId)
  if (!app) {
    throw new Refusal(
      `No App Store Connect app has the bundle id ${info.bundleId}. Create the app in App Store Connect (on the team the API key belongs to) first.`,
      'asc_app_not_found',
    )
  }

  const upload = await asc('/v1/buildUploads', {
    method: 'POST',
    body: json({
      data: {
        type: 'buildUploads',
        attributes: { cfBundleShortVersionString: info.version, cfBundleVersion: info.build, platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: app.id } } },
      },
    }),
  })
  const uploadId = data<Resource>(upload.json)?.id
  if (upload.status !== 201 || !uploadId) {
    throw new Refusal(
      `App Store Connect would not start the upload (HTTP ${upload.status}). A build ${info.build} may already exist; raise the build number.`,
      'asc_upload_failed',
    )
  }

  const file = await asc('/v1/buildUploadFiles', {
    method: 'POST',
    body: json({
      data: {
        type: 'buildUploadFiles',
        attributes: { assetType: 'ASSET', fileName: options.fileName, fileSize: bytes.length, uti: 'com.apple.ipa' },
        relationships: { buildUpload: { data: { type: 'buildUploads', id: uploadId } } },
      },
    }),
  })
  const fileResource = data<Resource<{ uploadOperations?: UploadOperation[] }>>(file.json)
  if (file.status !== 201 || !fileResource) {
    throw new Refusal(`App Store Connect would not accept the file (HTTP ${file.status}).`, 'asc_upload_failed')
  }
  const operations = fileResource.attributes.uploadOperations ?? []
  await Promise.all(
    operations.map(async (operation, index) => {
      const response = await fetchImpl(operation.url, {
        method: operation.method,
        headers: Object.fromEntries((operation.requestHeaders ?? []).map((header) => [header.name, header.value])),
        body: bytes.slice(operation.offset, operation.offset + operation.length),
      })
      if (!response.ok) {
        throw new Refusal(`Upload part ${index + 1} failed (HTTP ${response.status}).`, 'asc_upload_failed')
      }
    }),
  )
  const complete = await asc(`/v1/buildUploadFiles/${fileResource.id}`, {
    method: 'PATCH',
    body: json({
      data: {
        type: 'buildUploadFiles',
        id: fileResource.id,
        attributes: {
          uploaded: true,
          sourceFileChecksums: { file: { algorithm: 'MD5', hash: createHash('md5').update(bytes).digest('hex') } },
        },
      },
    }),
  })
  if (complete.status >= 300) {
    throw new Refusal(`App Store Connect did not accept the finished upload (HTTP ${complete.status}).`, 'asc_upload_failed')
  }
  log(`Uploaded ${info.version} (${info.build}) in ${operations.length} parts; waiting for App Store Connect.`)

  const result = { appId: app.id, ...info }
  const deadline = Date.now() + options.timeoutMs
  let lastState = ''
  while (Date.now() < deadline) {
    const builds = await asc(
      `/v1/builds?filter%5Bapp%5D=${app.id}&filter%5Bversion%5D=${encodeURIComponent(info.build)}&sort=-uploadedDate&limit=10`,
    )
    const build = data<Resource<{ version?: string; processingState?: string }>[]>(builds.json)?.find(
      (candidate) => candidate.attributes.version === info.build,
    )
    if (build) {
      const processing = build.attributes.processingState ?? 'PROCESSING'
      const beta = await asc(`/v1/buildBetaDetails?filter%5Bbuild%5D=${build.id}`)
      const internal =
        data<Resource<{ internalBuildState?: string }>[]>(beta.json)?.[0]?.attributes.internalBuildState ?? 'PENDING'
      const state = `processing ${processing}, TestFlight ${internal}`
      if (state !== lastState) log(state)
      lastState = state
      if (processing === 'INVALID') {
        throw new Refusal('App Store Connect marked the build INVALID; its email to the account says why.', 'asc_build_invalid')
      }
      if (processing === 'VALID' && internal === 'IN_BETA_TESTING') return result
      // A build reaches IN_BETA_TESTING only through an internal group that
      // receives every build; without one it would wait here until the timeout.
      if (processing === 'VALID' && internal === 'READY_FOR_BETA_TESTING') {
        const groups = await asc(
          `/v1/apps/${app.id}/betaGroups?fields%5BbetaGroups%5D=isInternalGroup,hasAccessToAllBuilds`,
        )
        const receivesAll = data<Resource<{ isInternalGroup?: boolean; hasAccessToAllBuilds?: boolean }>[]>(
          groups.json,
        )?.some((group) => group.attributes.isInternalGroup && group.attributes.hasAccessToAllBuilds)
        if (!receivesAll) {
          throw new Refusal(
            `${info.version} (${info.build}) is processed, but no internal TestFlight group receives every build. Create one in App Store Connect (TestFlight, Internal Testing, with automatic distribution) or add the build to a group.`,
            'asc_no_internal_group',
          )
        }
      }
    }
    await sleep(options.pollMs ?? 20_000)
  }
  throw new Refusal(
    `App Store Connect had not released ${info.version} (${info.build}) to TestFlight after ${Math.round(options.timeoutMs / 60_000)} minutes (last: ${lastState || 'not yet listed'}). Run the command again with a later build number, or check App Store Connect.`,
    'asc_timeout',
  )
}

export default defineDeepspaceCommand({
  meta: {
    name: 'testflight',
    description: 'Upload a signed iOS build (.ipa) to App Store Connect and wait until TestFlight offers it',
  },
  args: {
    ipa: { type: 'positional', description: 'Path to the signed .ipa', required: true },
    'timeout-minutes': { type: 'string', description: 'Minutes to wait for App Store Connect processing', default: '40' },
  },
  async run({ args }) {
    const ipaPath = resolve(String(args.ipa))
    if (!existsSync(ipaPath)) throw new Refusal(`No IPA at ${ipaPath}.`, 'invalid_ipa')
    const minutes = Number(args['timeout-minutes'])
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Refusal('--timeout-minutes must be a positive number.', 'invalid_flags')
    }
    const info = readIpaInfo(ipaPath)
    const asc = ascClient(resolveAscCredentials(process.cwd()))
    const result = await uploadToTestFlight({
      asc,
      bytes: readFileSync(ipaPath),
      fileName: basename(ipaPath),
      info,
      timeoutMs: minutes * 60_000,
      log: (line) => {
        if (!args.json) console.log(line)
      },
    })
    if (!args.json) console.log(`${result.version} (${result.build}) is on TestFlight.`)
    return { data: { ...result } }
  },
})
