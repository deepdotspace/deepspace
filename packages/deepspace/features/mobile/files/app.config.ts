/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ExpoConfig } from 'expo/config'
import { parse } from 'smol-toml'

// The Worker's wrangler.toml is the one source of truth for the app id and its
// app.space name, exactly as it is for the web build.
const wrangler = parse(readFileSync(resolve(__dirname, '..', 'wrangler.toml'), 'utf8')) as {
  name: string
  vars: { DEEPSPACE_APP_ID: string; NATIVE_AUTH_REDIRECT_URIS?: string }
}

if (!/^app_[0-9A-Z]{26}$/.test(wrangler.vars.DEEPSPACE_APP_ID)) {
  throw new Error(
    'wrangler.toml has no app id yet. Run `npx deepspace app init` in the app folder first.',
  )
}

/** URL scheme for the sign-in callback: the app name without dashes. */
const scheme = /^[a-z]/.test(wrangler.name)
  ? wrangler.name.replace(/[^a-z0-9]/g, '')
  : `app${wrangler.name.replace(/[^a-z0-9]/g, '')}`
const callback = `${scheme}://auth/callback`
const allowed = (wrangler.vars.NATIVE_AUTH_REDIRECT_URIS ?? '').split(',').map((uri) => uri.trim())
if (!allowed.includes(callback)) {
  throw new Error(
    `Add NATIVE_AUTH_REDIRECT_URIS = "${callback}" to [vars] in wrangler.toml, then deploy the Worker.`,
  )
}

const config: ExpoConfig = {
  name: wrangler.name,
  slug: wrangler.name,
  scheme,
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    // Replace with an identifier registered to your Apple team before building for a device.
    bundleIdentifier: `space.app.${scheme}`,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    // Replace with your own package name before publishing.
    package: `space.app.${scheme}`,
  },
  plugins: ['expo-secure-store', 'expo-web-browser'],
  extra: {
    deepspace: {
      appId: wrangler.vars.DEEPSPACE_APP_ID,
      baseUrl: `https://${wrangler.name}.app.space`,
    },
  },
}

export default config
