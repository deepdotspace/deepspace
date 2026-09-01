/// <reference types="@cloudflare/workers-types" />

import { storageQuotaMessage } from '../../shared/app-files'
import { loggableError } from '../../shared/log-events'

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' } as const
const QUOTA_SUMMARY_VERSION = 1
const MAX_QUOTA_SCAN_OBJECTS = 500_000
const MAX_QUOTA_SCAN_LISTS = 900
const QUOTA_REPAIR_COOLDOWN_MS = 60_000
const PENDING_MARKER_MAX_AGE_MS = 60 * 60_000
const EMPTY_MULTIPART_MARKER_MAX_AGE_MS = 60 * 60_000
const ACTIVE_MULTIPART_MARKER_MAX_AGE_MS = 8 * 24 * 60 * 60_000

/**
 * Everything the files handler needs to enforce one account allocation.
 *
 * `quotaKey` is required because an exact scan followed by an uncoordinated
 * write cannot enforce a limit under concurrency. Callers that do not want a
 * quota omit `storage`; callers that do want one must name its serialized
 * summary.
 */
export interface StorageAdmission {
  /** The app prefix receiving this request's write. */
  prefix: string
  /** Internal R2 key for the account's ETag-serialized usage summary. */
  quotaKey: string
  /** Resolve the account's limit. `null` fails writes closed. */
  limitBytes: () => Promise<number | null>
  /** Resolve the other app prefixes in the account. `null` fails closed. */
  siblingPrefixes?: () => Promise<string[] | null>
}

interface StorageReservation {
  markerKey: string | null
}

interface QuotaMarkerSpec {
  key: string
  body?: string
  metadata: Record<string, string>
}

export interface MultipartQuotaReservation {
  key: string
  etag: string
  reservationId: string
  uploadId: string
  objectKey: string
  uploadKey: string
  admitted: boolean
  declaredBytes: number
  reservedBytes: number
}

interface QuotaSummary {
  version: typeof QUOTA_SUMMARY_VERSION
  prefixes: string[]
  usedBytes: number
  measuredAt: number
  dirty: boolean
}

interface QuotaSnapshot {
  etag: string | null
  summary: QuotaSummary | null
}

interface QuotaScanBudget {
  lists: number
  objects: number
  staleKeys: string[]
}

interface MultipartMarkerState {
  version: 1
  reservationId: string
  uploadId: string
  objectKey: string
  uploadKey: string
  admitted: boolean
  declaredBytes: number
}

function fail(
  status: number,
  error: string,
  code?: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json(
    { error, ...(code ? { code } : {}), ...extra },
    { status, headers: CORS_HEADERS },
  )
}

export function quotaUnavailable(message: string): Response {
  return fail(503, message, 'storage_limit_unavailable')
}

function quotaKeySegment(value: string): string {
  return encodeURIComponent(value)
}

function markerPrefix(storage: StorageAdmission, kind: 'pending' | 'multipart'): string {
  return `__deepspace/quota/${kind}/${quotaKeySegment(storage.quotaKey)}/`
}

function pendingMarkerPrefix(storage: StorageAdmission): string {
  return markerPrefix(storage, 'pending')
}

function multipartMarkerPrefix(storage: StorageAdmission): string {
  return markerPrefix(storage, 'multipart')
}

export function multipartMarkerKey(storage: StorageAdmission, reservationId: string): string {
  return `${multipartMarkerPrefix(storage)}${quotaKeySegment(reservationId)}`
}

function accountPrefixesEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((prefix, index) => prefix === right[index])
}

async function allocationPrefixes(storage: StorageAdmission): Promise<string[] | null> {
  const siblings = storage.siblingPrefixes ? await storage.siblingPrefixes() : []
  if (siblings === null) return null
  return [...new Set([storage.prefix, ...siblings])].sort()
}

function countScan(budget: QuotaScanBudget, count: number): void {
  budget.lists++
  budget.objects += count
  if (budget.lists > MAX_QUOTA_SCAN_LISTS || budget.objects > MAX_QUOTA_SCAN_OBJECTS) {
    throw new Error('quota scan work limit exceeded')
  }
}

/**
 * Measure stored bytes under one app prefix.
 *
 * The account has one pair of marker scans rather than one pair per app, so an
 * empty historical identity costs a single bounded list call. Object count has
 * its own larger bound because tiny objects are independently amplifiable.
 */
async function prefixUsage(
  bucket: R2Bucket,
  prefix: string,
  budget: QuotaScanBudget,
): Promise<number> {
  let total = 0
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 })
    countScan(budget, page.objects.length)
    for (const object of page.objects) total += object.size
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
  return total
}

function markerBytes(object: R2Object): number {
  const raw = object.customMetadata?.reservedBytes
  const bytes = raw === undefined ? NaN : Number(raw)
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid quota marker')
  return bytes
}

function markerMaxAge(object: R2Object, fallback: number): number {
  if (object.customMetadata?.quotaKind !== 'multipart') return fallback
  return object.customMetadata.active === 'true'
    ? ACTIVE_MULTIPART_MARKER_MAX_AGE_MS
    : EMPTY_MULTIPART_MARKER_MAX_AGE_MS
}

async function markerUsage(
  bucket: R2Bucket,
  prefix: string,
  maxAgeMs: number,
  budget: QuotaScanBudget,
  excludedKey?: string,
): Promise<number> {
  let total = 0
  let cursor: string | undefined
  const now = Date.now()
  do {
    const options = {
      prefix,
      cursor,
      limit: 1000,
      include: ['customMetadata'],
    } as R2ListOptions & { include: ['customMetadata'] }
    const page = await bucket.list(options)
    countScan(budget, page.objects.length)
    for (const object of page.objects) {
      if (now - object.uploaded.getTime() > markerMaxAge(object, maxAgeMs)) {
        if (budget.staleKeys.length < 1000) budget.staleKeys.push(object.key)
      } else if (object.key !== excludedKey) {
        total += markerBytes(object)
      }
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
  return total
}

async function measuredAllocationUsage(
  bucket: R2Bucket,
  storage: StorageAdmission,
  prefixes: string[],
  excludedMarkerKey?: string,
): Promise<number> {
  const budget: QuotaScanBudget = { lists: 0, objects: 0, staleKeys: [] }
  let total = 0
  // Sequential by design: an account with many historical identities must not
  // turn one request into hundreds of concurrent R2 operations.
  for (const prefix of prefixes) total += await prefixUsage(bucket, prefix, budget)
  total += await markerUsage(
    bucket,
    pendingMarkerPrefix(storage),
    PENDING_MARKER_MAX_AGE_MS,
    budget,
    excludedMarkerKey,
  )
  total += await markerUsage(
    bucket,
    multipartMarkerPrefix(storage),
    ACTIVE_MULTIPART_MARKER_MAX_AGE_MS,
    budget,
    excludedMarkerKey,
  )
  if (budget.staleKeys.length > 0) {
    await bucket.delete(budget.staleKeys).catch((error) => {
      console.error(`[files:quota] stale marker cleanup: ${loggableError(error)}`)
    })
  }
  return total
}

function isQuotaSummary(value: unknown): value is QuotaSummary {
  if (!value || typeof value !== 'object') return false
  const summary = value as Partial<QuotaSummary>
  return (
    summary.version === QUOTA_SUMMARY_VERSION &&
    Array.isArray(summary.prefixes) &&
    summary.prefixes.every((prefix) => typeof prefix === 'string') &&
    Number.isSafeInteger(summary.usedBytes) &&
    (summary.usedBytes ?? -1) >= 0 &&
    Number.isSafeInteger(summary.measuredAt) &&
    (summary.measuredAt ?? -1) >= 0 &&
    typeof summary.dirty === 'boolean'
  )
}

async function readQuotaSummary(bucket: R2Bucket, key: string): Promise<QuotaSnapshot> {
  const object = await bucket.get(key)
  if (!object) return { etag: null, summary: null }
  try {
    const parsed = await object.json<unknown>()
    return { etag: object.etag, summary: isQuotaSummary(parsed) ? parsed : null }
  } catch {
    return { etag: object.etag, summary: null }
  }
}

async function writeQuotaSummary(
  bucket: R2Bucket,
  key: string,
  previousEtag: string | null,
  summary: QuotaSummary,
): Promise<QuotaSnapshot | null> {
  const onlyIf = previousEtag
    ? { etagMatches: previousEtag }
    : new Headers({ 'If-None-Match': '*' })
  const object = await bucket.put(key, JSON.stringify(summary), {
    onlyIf,
    httpMetadata: { contentType: 'application/json' },
  })
  return object ? { etag: object.etag, summary } : null
}

async function ensureQuotaSummary(
  bucket: R2Bucket,
  storage: StorageAdmission,
  prefixes: string[],
  /** 'reuse' trusts any well-formed summary; 'force' always re-measures;
   *  'repairDirty' re-measures a DIRTY summary past the repair cooldown —
   *  the one policy for "a stale high-water mark may not be reported", kept
   *  here so reporting and admission cannot drift, and cooldown-guarded so
   *  concurrent readers in a dirty window don't each launch a full-bucket
   *  measure. */
  measure: 'reuse' | 'force' | 'repairDirty' = 'reuse',
  excludedMarkerKey?: string,
): Promise<QuotaSnapshot | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await readQuotaSummary(bucket, storage.quotaKey)
    if (
      measure !== 'force' &&
      current.summary &&
      accountPrefixesEqual(current.summary.prefixes, prefixes) &&
      !(
        measure === 'repairDirty' &&
        current.summary.dirty &&
        Date.now() - current.summary.measuredAt >= QUOTA_REPAIR_COOLDOWN_MS
      )
    ) {
      return current
    }
    const usedBytes = await measuredAllocationUsage(bucket, storage, prefixes, excludedMarkerKey)
    const repaired = await writeQuotaSummary(bucket, storage.quotaKey, current.etag, {
      version: QUOTA_SUMMARY_VERSION,
      prefixes,
      usedBytes,
      measuredAt: Date.now(),
      dirty: false,
    })
    if (repaired) return repaired
  }
  return null
}

export async function markQuotaDirty(
  bucket: R2Bucket,
  storage: StorageAdmission | undefined,
): Promise<void> {
  if (!storage) return
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await readQuotaSummary(bucket, storage.quotaKey)
      if (!current.summary || current.summary.dirty) return
      const written = await writeQuotaSummary(bucket, storage.quotaKey, current.etag, {
        ...current.summary,
        dirty: true,
      })
      if (written) return
    }
    console.error('[files:quota] could not mark summary reclaimable after concurrent writes')
  } catch (error) {
    console.error(`[files:quota] could not mark summary reclaimable: ${loggableError(error)}`)
  }
}

async function neutralizeMarker(bucket: R2Bucket, markerKey: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const marker = await bucket.get(markerKey)
    if (!marker) return true
    if (markerBytes(marker) === 0) return true
    // Preserve multipart recovery state if the following delete keeps failing;
    // a completion retry can then neutralize/delete the same marker again.
    const body = await marker.arrayBuffer()
    const object = await bucket.put(markerKey, body, {
      onlyIf: { etagMatches: marker.etag },
      customMetadata: {
        ...marker.customMetadata,
        reservedBytes: '0',
        releasedAt: String(Date.now()),
      },
    })
    if (object) return true
  }
  return false
}

/**
 * Make a reservation stop counting before attempting its best-effort delete.
 * A failed delete therefore leaves a zero-byte cleanup record, not days of
 * phantom quota. `summaryMayBeStale` is false only when admission refused
 * before its counter reservation landed.
 */
export async function releaseQuotaMarker(
  bucket: R2Bucket,
  storage: StorageAdmission | undefined,
  markerKey: string | null,
  summaryMayBeStale: boolean,
): Promise<boolean> {
  try {
    if (markerKey && !(await neutralizeMarker(bucket, markerKey))) {
      console.error('[files:quota] could not neutralize reservation marker')
      return false
    }
    if (summaryMayBeStale) await markQuotaDirty(bucket, storage)
    if (markerKey) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await bucket.delete(markerKey)
          break
        } catch (error) {
          if (attempt === 3) throw error
        }
      }
    }
    return true
  } catch (error) {
    console.error(`[files:quota] reservation cleanup: ${loggableError(error)}`)
    return false
  }
}

function parseMultipartMarker(value: unknown): MultipartMarkerState | null {
  if (!value || typeof value !== 'object') return null
  const marker = value as Partial<MultipartMarkerState>
  if (
    marker.version !== 1 ||
    typeof marker.reservationId !== 'string' ||
    !marker.reservationId ||
    typeof marker.uploadId !== 'string' ||
    !marker.uploadId ||
    typeof marker.objectKey !== 'string' ||
    !marker.objectKey ||
    typeof marker.uploadKey !== 'string' ||
    !marker.uploadKey ||
    typeof marker.admitted !== 'boolean' ||
    !Number.isSafeInteger(marker.declaredBytes) ||
    (marker.declaredBytes ?? -1) < 0
  ) {
    return null
  }
  return marker as MultipartMarkerState
}

function multipartMarkerBody(reservation: MultipartQuotaReservation): string {
  return JSON.stringify({
    version: 1,
    reservationId: reservation.reservationId,
    uploadId: reservation.uploadId,
    objectKey: reservation.objectKey,
    uploadKey: reservation.uploadKey,
    admitted: reservation.admitted,
    declaredBytes: reservation.declaredBytes,
  } satisfies MultipartMarkerState)
}

export async function readMultipartReservation(
  bucket: R2Bucket,
  storage: StorageAdmission | undefined,
  reservationId: string,
): Promise<MultipartQuotaReservation | null | 'invalid'> {
  if (!storage) return null
  const key = multipartMarkerKey(storage, reservationId)
  let object: R2ObjectBody | null
  try {
    object = await bucket.get(key)
  } catch (error) {
    console.error(`[files:quota] reservation read: ${loggableError(error)}`)
    return 'invalid'
  }
  if (!object) return null
  let marker: MultipartMarkerState | null = null
  try {
    marker = parseMultipartMarker(await object.json<unknown>())
  } catch {
    return 'invalid'
  }
  if (!marker || marker.reservationId !== reservationId) return 'invalid'
  let reservedBytes: number
  try {
    reservedBytes = markerBytes(object)
  } catch {
    return 'invalid'
  }
  return {
    key,
    etag: object.etag,
    reservationId,
    uploadId: marker.uploadId,
    objectKey: marker.objectKey,
    uploadKey: marker.uploadKey,
    admitted: marker.admitted,
    declaredBytes: marker.declaredBytes,
    reservedBytes,
  }
}

/** Refresh an active multipart marker without carrying a per-part ledger. */
export async function refreshMultipartReservation(
  bucket: R2Bucket,
  storage: StorageAdmission | undefined,
  reservationId: string,
  uploadId: string,
  objectKey: string,
): Promise<MultipartQuotaReservation | null | 'invalid' | 'busy'> {
  if (!storage) return null
  for (let attempt = 0; attempt < 4; attempt++) {
    const reservation = await readMultipartReservation(bucket, storage, reservationId)
    if (reservation === null || reservation === 'invalid') return reservation ?? 'invalid'
    if (
      !reservation.admitted ||
      reservation.uploadId !== uploadId ||
      reservation.objectKey !== objectKey
    ) {
      return 'invalid'
    }
    const object = await bucket.put(reservation.key, multipartMarkerBody(reservation), {
      onlyIf: { etagMatches: reservation.etag },
      customMetadata: {
        quotaKind: 'multipart',
        reservedBytes: String(reservation.reservedBytes),
        active: 'true',
      },
    })
    if (object) return { ...reservation, etag: object.etag }
  }
  return 'busy'
}

export async function activateMultipartReservation(
  bucket: R2Bucket,
  storage: StorageAdmission | undefined,
  reservationId: string,
): Promise<MultipartQuotaReservation | null> {
  if (!storage) return null
  for (let attempt = 0; attempt < 4; attempt++) {
    const reservation = await readMultipartReservation(bucket, storage, reservationId)
    if (!reservation || reservation === 'invalid') return null
    if (reservation.admitted) return reservation
    const next = { ...reservation, admitted: true }
    const object = await bucket.put(reservation.key, multipartMarkerBody(next), {
      onlyIf: { etagMatches: reservation.etag },
      customMetadata: {
        quotaKind: 'multipart',
        reservedBytes: String(reservation.reservedBytes),
        active: 'false',
      },
    })
    if (object) {
      return { ...next, etag: object.etag }
    }
  }
  return null
}

function quotaExceeded(
  incomingBytes: number,
  summaryBytes: number,
  replacedBytes: number,
  limitBytes: number,
): Response {
  const usedBytes = Math.max(0, summaryBytes - replacedBytes)
  return fail(
    409,
    storageQuotaMessage(incomingBytes, usedBytes, limitBytes),
    'storage_quota_exceeded',
    { usedBytes, limitBytes },
  )
}

async function reserveQuotaSummary(
  bucket: R2Bucket,
  storage: StorageAdmission,
  prefixes: string[],
  initial: QuotaSnapshot,
  chargeBytes: number,
  incomingBytes: number,
  replacedBytes: number,
  limitBytes: number,
  markerKey: string | null,
): Promise<Response | null> {
  if (chargeBytes === 0) return null
  let current = initial
  let repaired = false
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!current.summary || !accountPrefixesEqual(current.summary.prefixes, prefixes)) {
      const ensured = await ensureQuotaSummary(
        bucket,
        storage,
        prefixes,
        'reuse',
        markerKey ?? undefined,
      )
      if (!ensured) {
        return quotaUnavailable(
          'The storage used by this account could not be verified. Retry shortly.',
        )
      }
      current = ensured
    }
    const summary = current.summary
    if (!summary) {
      return quotaUnavailable(
        'The storage used by this account could not be verified. Retry shortly.',
      )
    }
    if (summary.usedBytes + chargeBytes > limitBytes) {
      const recentlyMeasured = Date.now() - summary.measuredAt < QUOTA_REPAIR_COOLDOWN_MS
      if (repaired || (!summary.dirty && recentlyMeasured)) {
        return quotaExceeded(incomingBytes, summary.usedBytes, replacedBytes, limitBytes)
      }
      const refreshed = await ensureQuotaSummary(
        bucket,
        storage,
        prefixes,
        'force',
        markerKey ?? undefined,
      )
      if (!refreshed?.summary) {
        return quotaUnavailable(
          'The storage used by this account could not be verified. Retry shortly.',
        )
      }
      current = refreshed
      repaired = true
      continue
    }
    const written = await writeQuotaSummary(bucket, storage.quotaKey, current.etag, {
      ...summary,
      usedBytes: summary.usedBytes + chargeBytes,
    })
    if (written) return null
    current = await readQuotaSummary(bucket, storage.quotaKey)
  }
  return quotaUnavailable('Storage is busy with other uploads. Retry shortly.')
}

export async function admitStorage(
  bucket: R2Bucket,
  storage: StorageAdmission | undefined,
  incomingBytes: number,
  replacedBytes: number,
  marker?: QuotaMarkerSpec,
): Promise<StorageReservation | Response> {
  if (!storage) return { markerKey: null }
  let markerKey: string | null = null
  try {
    const limit = await storage.limitBytes()
    if (limit === null) {
      return quotaUnavailable(
        'The storage limit for this app could not be verified; nothing was uploaded. Retry shortly.',
      )
    }
    const prefixes = await allocationPrefixes(storage)
    if (prefixes === null) {
      return quotaUnavailable(
        'The apps in this storage allocation could not be enumerated; nothing was uploaded. Retry shortly.',
      )
    }
    const initial = await ensureQuotaSummary(bucket, storage, prefixes)
    if (!initial) {
      return quotaUnavailable(
        'The storage already used by this account could not be measured; nothing was uploaded. Retry shortly.',
      )
    }

    const chargeBytes = Math.max(0, incomingBytes - replacedBytes)
    const effectiveMarker =
      marker ??
      (chargeBytes > 0
        ? {
            key: `${pendingMarkerPrefix(storage)}${crypto.randomUUID()}`,
            metadata: { quotaKind: 'pending' },
          }
        : null)
    if (effectiveMarker) {
      const object = await bucket.put(effectiveMarker.key, effectiveMarker.body ?? '', {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        customMetadata: {
          ...effectiveMarker.metadata,
          reservedBytes: String(chargeBytes),
        },
      })
      if (!object) {
        return fail(
          409,
          'An upload with this request id is already in progress.',
          'reservation_conflict',
        )
      }
      markerKey = effectiveMarker.key
    }

    const refusal = await reserveQuotaSummary(
      bucket,
      storage,
      prefixes,
      initial,
      chargeBytes,
      incomingBytes,
      replacedBytes,
      limit,
      effectiveMarker?.key ?? null,
    )
    if (refusal) {
      await releaseQuotaMarker(bucket, storage, effectiveMarker?.key ?? null, false)
      return refusal
    }
    return { markerKey: effectiveMarker?.key ?? null }
  } catch (error) {
    console.error(`[files:quota] admission: ${loggableError(error)}`)
    await releaseQuotaMarker(bucket, storage, markerKey, true)
    return quotaUnavailable(
      'The storage used by this account could not be verified. Retry shortly.',
    )
  }
}

export async function storageUsage(
  bucket: R2Bucket,
  storage: StorageAdmission,
): Promise<number | null> {
  try {
    const prefixes = await allocationPrefixes(storage)
    if (prefixes === null) return null
    // The summary is a high-water mark repaired lazily; admission repairs at
    // the would-refuse boundary, but REPORTING read the stale figure forever
    // after deletes (r2 ops AX: rm-everything left usedBytes pinned at 26 MB
    // across six polls and a redeploy). 'repairDirty' re-measures a dirty
    // summary inside ensureQuotaSummary — cooldown-guarded, one read — so
    // the number a user sees converges as fast as the number that gates.
    const current = await ensureQuotaSummary(bucket, storage, prefixes, 'repairDirty')
    return current?.summary?.usedBytes ?? null
  } catch (error) {
    console.error(`[files:quota] usage: ${loggableError(error)}`)
    return null
  }
}
