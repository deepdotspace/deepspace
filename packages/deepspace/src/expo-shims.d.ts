declare module 'expo-linking' {
  export function createURL(path?: string, options?: Record<string, unknown>): string
  export function parse(url: string): { queryParams?: Record<string, string | string[] | undefined> }
}

declare module 'expo-crypto' {
  export function randomUUID(): string
  export function digestStringAsync(algorithm: string, data: string, options?: { encoding?: string }): Promise<string>
  export const CryptoDigestAlgorithm: { SHA256: string }
  export const CryptoEncoding: { BASE64: string }
}

declare module 'expo-secure-store' {
  export function getItemAsync(key: string, options?: Record<string, unknown>): Promise<string | null>
  export function setItemAsync(key: string, value: string, options?: Record<string, unknown>): Promise<void>
  export function deleteItemAsync(key: string, options?: Record<string, unknown>): Promise<void>
}

declare module 'expo-web-browser' {
  export type WebBrowserAuthSessionResult = { type: 'success'; url: string } | { type: string; url?: string }
  export function openAuthSessionAsync(url: string, redirectUrl?: string, options?: Record<string, unknown>): Promise<WebBrowserAuthSessionResult>
  export function openBrowserAsync(url: string, options?: Record<string, unknown>): Promise<{ type: string }>
}

declare module 'expo' {
  import type { ComponentType } from 'react'
  export function requireOptionalNativeModule<T = unknown>(moduleName: string): T | null
  export function requireNativeView<P = Record<string, unknown>>(moduleName: string, viewName?: string): ComponentType<P>
}
