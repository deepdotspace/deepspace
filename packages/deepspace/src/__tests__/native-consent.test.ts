import { beforeEach, describe, expect, it, vi } from 'vitest'

const opened = vi.hoisted(() => ({ urls: [] as string[] }))

vi.mock('expo-web-browser', () => ({
  openBrowserAsync: async (url: string) => {
    opened.urls.push(url)
    return { type: 'cancel' }
  },
}))

beforeEach(() => {
  opened.urls.length = 0
})

describe('native integration consent', () => {
  it('finds the consent URL only in a requiresOAuth success envelope', async () => {
    const { consentUrlOf } = await import('../native/consent')
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=s'
    expect(
      consentUrlOf({
        success: true,
        data: { requiresOAuth: true, provider: 'google', scopes: [], authUrl },
      }),
    ).toBe(authUrl)
    expect(consentUrlOf({ success: true, data: { messages: [] } })).toBeNull()
    expect(consentUrlOf({ success: false, data: { requiresOAuth: true, authUrl } })).toBeNull()
    expect(consentUrlOf({ success: true })).toBeNull()
    // A flattened envelope carries the fields on the result itself.
    expect(
      consentUrlOf({ success: true, requiresOAuth: true, authUrl } as { success: boolean }),
    ).toBe(authUrl)
    expect(consentUrlOf({ success: true, data: { requiresOAuth: true, authUrl: 42 } })).toBeNull()
  })

  it('opens https consent pages in the browser sheet and refuses anything else', async () => {
    const { openIntegrationConsent } = await import('../native/consent')
    await openIntegrationConsent('https://accounts.google.com/o/oauth2/v2/auth?state=s')
    expect(opened.urls).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?state=s'])
    await expect(openIntegrationConsent('javascript:alert(1)')).rejects.toThrow(/https/)
    await expect(openIntegrationConsent('http://accounts.google.com/')).rejects.toThrow(/https/)
    expect(opened.urls).toHaveLength(1)
  })
})
