import * as p from '@clack/prompts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeApiError } from '../../../shared/api-error'
import { PLATFORM_URLS } from '../../env'
import { createSpinner } from '../../lib/spinner'

const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api

interface PlanChange {
  slug: string
  reason: 'removed' | 'repriced'
  affectedSubscribers: number
  intervals?: Array<{ interval: 'month' | 'year'; oldCents: number; newCents: number }>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadDeclaration(
  appDir: string,
  sourceFile: string,
  outputFile: string,
  exportName: string,
): Promise<unknown> {
  const sourcePath = join(appDir, 'src', sourceFile)
  if (!existsSync(sourcePath)) return undefined
  const esbuild = await import('esbuild')
  const outputPath = join(appDir, '.wrangler', 'deploy', outputFile)
  await esbuild.build({
    entryPoints: [sourcePath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    outfile: outputPath,
    logLevel: 'silent',
    write: true,
  })
  const module = (await import(`${pathToFileURL(outputPath).href}?t=${Date.now()}`)) as Record<
    string,
    unknown
  >
  return module[exportName]
}

function formatCents(cents: number): string {
  return cents === 0 ? 'free' : `$${(cents / 100).toFixed(2)}`
}

function planChangeSummary(change: PlanChange): string {
  const count = `${change.affectedSubscribers} subscriber${change.affectedSubscribers === 1 ? '' : 's'}`
  if (change.reason === 'removed') return `  • ${change.slug} — removed (${count} still on it)`
  const diffs = (change.intervals ?? [])
    .map(
      (interval) =>
        `${interval.interval}: ${formatCents(interval.oldCents)} → ${formatCents(interval.newCents)}`,
    )
    .join('; ')
  return `  • ${change.slug} — repriced (${diffs}; ${count} grandfathered on old price)`
}

async function cancelChangedPlans(appName: string, token: string, changes: PlanChange[]) {
  p.log.warn(
    `Plan change${changes.length === 1 ? '' : 's'} from this deploy left subscribers stranded:\n` +
      `${changes.map(planChangeSummary).join('\n')}\n\n` +
      'Stripe will keep charging them until you cancel. Cancel at the end of their current billing period?',
  )
  const confirmed = await p.confirm({
    message: `Cancel ${changes.length === 1 ? 'these subscribers' : 'all of them'} at period end?`,
    initialValue: false,
  })
  if (p.isCancel(confirmed) || !confirmed) {
    p.log.info('Skipped — existing subscribers stay on their current plan/price.')
    return
  }

  const maxIterations = 100
  for (const change of changes) {
    const spinner = createSpinner()
    spinner.start(
      `Canceling ${change.affectedSubscribers} subscriber${change.affectedSubscribers === 1 ? '' : 's'} on ${change.slug}...`,
    )
    let canceled = 0
    let failed = 0
    let iteration = 0
    let lastError: string | null = null
    let stopped = false
    try {
      while (iteration < maxIterations) {
        const response = await fetch(`${API_URL}/api/subscriptions/admin-cancel`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appName,
            planSlug: change.slug,
            atPeriodEnd: true,
            reason: `plan ${change.reason} via deploy`,
          }),
        })
        const body = (await response.json().catch(() => ({}))) as {
          success?: boolean
          canceled?: number
          failures?: unknown[]
          hasMore?: boolean
          error?: string
        }
        if (!response.ok || !body.success) {
          lastError = normalizeApiError(response.status, body).error
          spinner.stop(`Cancel failed for ${change.slug}: ${lastError}`)
          stopped = true
          break
        }
        const batchCanceled = body.canceled ?? 0
        canceled += batchCanceled
        failed += body.failures?.length ?? 0
        if (!body.hasMore) break
        if (batchCanceled === 0) {
          lastError = 'no progress (all rows failed this batch)'
          break
        }
        iteration++
      }
      if (!stopped) {
        const failureSuffix = failed ? `; ${failed} failed (see Stripe)` : ''
        const capSuffix = iteration >= maxIterations ? ' (batch cap reached — re-run deploy)' : ''
        spinner.stop(
          `Canceled ${canceled} on ${change.slug}${failureSuffix}${capSuffix}${lastError ? ` — ${lastError}` : ''}`,
        )
      }
    } catch (error) {
      spinner.stop(`Cancel failed for ${change.slug}: ${errorMessage(error)}`)
    }
  }
}

export async function syncSubscriptionPlans(
  appDir: string,
  appName: string,
  token: string,
  nonInteractive: boolean,
): Promise<void> {
  if (!existsSync(join(appDir, 'src', 'subscriptions.ts'))) return
  let plans: unknown
  try {
    plans = await loadDeclaration(
      appDir,
      'subscriptions.ts',
      'subscriptions.bundle.mjs',
      'subscriptionPlans',
    )
  } catch (error) {
    p.log.warn(`Could not load src/subscriptions.ts: ${errorMessage(error)}`)
    return
  }
  if (!Array.isArray(plans)) {
    p.log.warn('src/subscriptions.ts must `export const subscriptionPlans = [...] as const`')
    return
  }
  if (!plans.length) return

  const spinner = createSpinner()
  spinner.start('Syncing subscription plans...')
  try {
    const response = await fetch(`${API_URL}/api/subscriptions/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: appName, plans }),
    })
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      error?: string
      hint?: string
      planChanges?: PlanChange[]
      connectMissing?: boolean
    }
    if (!response.ok || !body.ok) {
      spinner.stop('Plan sync skipped')
      p.log.warn(
        `Plan sync failed: ${normalizeApiError(response.status, body).error}${body.hint ? ` — ${body.hint}` : ''}`,
      )
      return
    }
    spinner.stop(`Synced ${plans.length} plan${plans.length === 1 ? '' : 's'} to Stripe`)
    if (body.connectMissing) {
      p.log.warn(
        'Stripe Connect is not ready. Paid checkout will remain unavailable ' +
          'until the app owner finishes onboarding at /earnings on the dashboard.',
      )
    }
    const changes = (body.planChanges ?? []).filter((change) => change.affectedSubscribers > 0)
    if (!changes.length) return
    if (nonInteractive) {
      p.log.warn(
        `${changes.length} plan change${changes.length === 1 ? '' : 's'} left subscribers stranded; ` +
          'grandfathered (non-interactive deploy). Cancel later via the subscriptions admin helper if intended.',
      )
      return
    }
    await cancelChangedPlans(appName, token, changes)
  } catch (error) {
    spinner.stop('Plan sync skipped')
    p.log.warn(`Plan sync request failed: ${errorMessage(error)}`)
  }
}

export async function syncOneTimeProducts(
  appDir: string,
  appName: string,
  token: string,
): Promise<void> {
  if (!existsSync(join(appDir, 'src', 'products.ts'))) return
  let products: unknown
  try {
    products = await loadDeclaration(
      appDir,
      'products.ts',
      'products.bundle.mjs',
      'oneTimeProducts',
    )
  } catch (error) {
    p.log.warn(`Could not load src/products.ts: ${errorMessage(error)}`)
    return
  }
  if (!Array.isArray(products)) {
    p.log.warn('src/products.ts must `export const oneTimeProducts = [...] as const`')
    return
  }

  const spinner = products.length ? createSpinner() : null
  spinner?.start('Syncing one-time products...')
  try {
    const response = await fetch(`${API_URL}/api/charges/products/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: appName, products }),
    })
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      count?: number
      error?: string
      details?: unknown
    }
    if (response.ok && body.ok) {
      const count = body.count ?? products.length
      spinner?.stop(`Synced ${count} one-time product${count === 1 ? '' : 's'}`)
      return
    }
    spinner?.stop('Product sync skipped')
    p.log.warn(
      `Product sync failed: ${normalizeApiError(response.status, body).error}${body.details ? ` — ${JSON.stringify(body.details)}` : ''}`,
    )
  } catch (error) {
    spinner?.stop('Product sync skipped')
    p.log.warn(`Product sync request failed: ${errorMessage(error)}`)
  }
}
