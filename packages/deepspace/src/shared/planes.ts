/**
 * DeepSpace's deployment planes, in one place: production, staging and
 * DeepSpace Medical, the BAA-covered plane for healthcare apps
 * (docs/proposals/deepspace-medical.md).
 *
 * Side-effect free. The CLI, the browser client, the test-account helpers and
 * the platform workers all read it, so a plane's hosts and its restricted-plane
 * rule cannot drift between them.
 */

export type PlaneName = 'production' | 'staging' | 'medical'

export interface PlaneUrls {
  auth: string
  api: string
  platform: string
  deploy: string
  /** Deployed apps live on `<name>.<appDomain>`. */
  appDomain: string
  /** The zone the platform services live on. */
  platformDomain: string
  /** The plane's public home page. */
  home: string
  /** The builder dashboard; null where the plane has none. */
  dashboard: string | null
  /** The privacy policy sign-in screens link to. */
  privacyPolicy: string
}

export const PLANES: Readonly<Record<PlaneName, PlaneUrls>> = {
  production: {
    auth: 'https://auth.deep.space',
    api: 'https://api-worker.deep.space',
    platform: 'https://platform-worker.deep.space',
    deploy: 'https://deploy-worker.deep.space',
    appDomain: 'app.space',
    platformDomain: 'deep.space',
    home: 'https://deep.space',
    dashboard: 'https://dashboard.deep.space',
    privacyPolicy: 'https://deep.space/privacy',
  },
  // Services on deepspacesites.com, apps on spacestest.com: production's
  // two-zone split, because a Worker cannot fetch one in its own zone.
  staging: {
    auth: 'https://auth.deepspacesites.com',
    api: 'https://api.deepspacesites.com',
    platform: 'https://platform.deepspacesites.com',
    deploy: 'https://deploy.deepspacesites.com',
    appDomain: 'spacestest.com',
    platformDomain: 'deepspacesites.com',
    home: 'https://spacestest.com',
    dashboard: 'https://dashboard.deepspacesites.com',
    privacyPolicy: 'https://deep.space/privacy',
  },
  // Services on deepspacemedical.com, apps on deepspacemedical.app: two zones
  // in the medical Cloudflare account. The plane has no dashboard.
  medical: {
    auth: 'https://auth.deepspacemedical.com',
    api: 'https://api.deepspacemedical.com',
    platform: 'https://platform.deepspacemedical.com',
    deploy: 'https://deploy.deepspacemedical.com',
    appDomain: 'deepspacemedical.app',
    platformDomain: 'deepspacemedical.com',
    home: 'https://deepspacemedical.com',
    dashboard: null,
    privacyPolicy: 'https://deepspacemedical.com/privacy',
  },
}

/** Planes whose workers run without the medical restrictions. */
const OPEN_PLANES: ReadonlySet<string> = new Set(['production', 'staging'])

/**
 * Whether a platform worker runs on a restricted plane (DeepSpace Medical
 * sets `DEEPSPACE_PLANE = "medical"`). Unset means production. Any value other
 * than `production` or `staging` restricts, so a typo fails closed.
 */
export function isRestrictedPlane(env: { DEEPSPACE_PLANE?: string }): boolean {
  const plane = env.DEEPSPACE_PLANE
  return plane !== undefined && plane !== '' && !OPEN_PLANES.has(plane)
}
