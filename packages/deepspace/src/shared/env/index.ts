/**
 * Environment detection and URL configuration
 *
 * Determines environment and provides URLs for DeepSpace services.
 *
 * Environment detection priority:
 * 1. Build-time __DEEPSPACE_ENV__ define (set via esbuild/Vite)
 * 2. Runtime window.__DEEPSPACE_ENV__
 * 3. Server-side process.env.DEEPSPACE_ENV
 * 4. Hostname detection (fallback)
 */

export type Environment = 'dev' | 'prod'

declare const __DEEPSPACE_ENV__: string | undefined

// ============================================================================
// Environment Configuration
// ============================================================================

interface EnvironmentConfig {
  name: Environment
  /** Platform API worker URL */
  apiUrl: string
  /** Platform worker URL (RecordRoom, schema registry) */
  platformWorkerUrl: string
  /** Auth worker URL (Better Auth) */
  authUrl: string
  /** Auth sign-in page URL */
  authSignInUrl: string
  /** Auth sign-up page URL */
  authSignUpUrl: string
  /** Main DeepSpace app URL */
  mainAppUrl: string
  /** Builder dashboard URL */
  dashboardUrl: string
}

const DEV_CONFIG: EnvironmentConfig = {
  name: 'dev',
  apiUrl: 'http://localhost:8795',
  platformWorkerUrl: 'http://localhost:8792',
  authUrl: 'http://localhost:8794',
  authSignInUrl: 'http://localhost:5173/sign-in',
  authSignUpUrl: 'http://localhost:5173/sign-up',
  mainAppUrl: 'http://localhost:5173',
  dashboardUrl: 'http://localhost:5174',
}

const PROD_CONFIG: EnvironmentConfig = {
  name: 'prod',
  apiUrl: 'https://api-worker.deep.space',
  platformWorkerUrl: 'https://platform-worker.deep.space',
  authUrl: 'https://auth.deep.space',
  authSignInUrl: 'https://auth.deep.space/login/social',
  authSignUpUrl: 'https://auth.deep.space/login/social',
  mainAppUrl: 'https://deep.space',
  dashboardUrl: 'https://dashboard.deep.space',
}

// ============================================================================
// Environment Detection
// ============================================================================

let cachedEnvironment: Environment | null = null

function parseEnv(value: string | undefined): Environment | null {
  if (!value) return null
  const v = value.toLowerCase()
  if (v === 'dev' || v === 'development') return 'dev'
  if (v === 'prod' || v === 'production') return 'prod'
  return null
}

export function detectEnvironment(): Environment {
  if (cachedEnvironment) return cachedEnvironment

  // 1. Build-time define
  if (typeof __DEEPSPACE_ENV__ !== 'undefined') {
    const env = parseEnv(__DEEPSPACE_ENV__)
    if (env) {
      cachedEnvironment = env
      return env
    }
  }

  // 2. Runtime window variable
  if (typeof window !== 'undefined') {
    const windowEnv = (window as { __DEEPSPACE_ENV__?: string }).__DEEPSPACE_ENV__
    const env = parseEnv(windowEnv)
    if (env) {
      cachedEnvironment = env
      return env
    }
  }

  // 3. Server-side env var
  if (typeof window === 'undefined') {
    try {
      const env = parseEnv(process.env.DEEPSPACE_ENV)
      if (env) {
        cachedEnvironment = env
        return env
      }
      if (process.env.NODE_ENV !== 'production') {
        cachedEnvironment = 'dev'
        return 'dev'
      }
    } catch {
      // process may not exist in Workers
    }
  }

  // 4. Hostname detection
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.')
    ) {
      cachedEnvironment = 'dev'
      return 'dev'
    }

    // Production: app.space, *.app.space, deep.space, *.deep.space
    if (
      hostname === 'app.space' ||
      hostname.endsWith('.app.space') ||
      hostname === 'deep.space' ||
      hostname.endsWith('.deep.space')
    ) {
      cachedEnvironment = 'prod'
      return 'prod'
    }
  }

  // Default to prod for unknown domains
  cachedEnvironment = 'prod'
  return 'prod'
}

export function getEnvironmentConfig(): EnvironmentConfig {
  const env = detectEnvironment()
  return env === 'dev' ? DEV_CONFIG : PROD_CONFIG
}

// ============================================================================
// Convenience Getters
// ============================================================================

export function getApiUrl(): string {
  return getEnvironmentConfig().apiUrl
}

export function getPlatformWorkerUrl(): string {
  return getEnvironmentConfig().platformWorkerUrl
}

export function getAuthUrl(): string {
  return getEnvironmentConfig().authUrl
}

export function isLocalDev(): boolean {
  return detectEnvironment() === 'dev'
}

export function isProduction(): boolean {
  return detectEnvironment() === 'prod'
}

/** Reset cached environment (useful for testing) */
export function resetEnvironmentCache(): void {
  cachedEnvironment = null
}

// ============================================================================
// Convenience Object
// ============================================================================

export const ENV = {
  get current() {
    return detectEnvironment()
  },
  get config() {
    return getEnvironmentConfig()
  },
  get apiUrl() {
    return getApiUrl()
  },
  get platformWorkerUrl() {
    return getPlatformWorkerUrl()
  },
  get authUrl() {
    return getAuthUrl()
  },
  get isLocal() {
    return isLocalDev()
  },
  get isProd() {
    return isProduction()
  },
} as const
