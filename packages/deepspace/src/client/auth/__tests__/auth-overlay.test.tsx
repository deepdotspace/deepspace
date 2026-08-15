// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthOverlay } from '../AuthOverlay'

vi.mock('../hooks', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false, userId: null, sessionId: null }),
}))
vi.mock('../client', () => ({
  signIn: { email: vi.fn(async () => ({ error: null })) },
}))
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(element: ReactElement): Promise<HTMLElement> {
  await act(async () => {
    root.render(element)
    await Promise.resolve()
  })
  const overlay = container.querySelector<HTMLElement>('[data-testid="auth-overlay"]')
  expect(overlay).not.toBeNull()
  return overlay!
}

describe('AuthOverlay branding', () => {
  it('renders the DeepSpace defaults when no branding props are given', async () => {
    const overlay = await render(<AuthOverlay />)
    expect(overlay.textContent).toContain('Sign in to DeepSpace')
    expect(overlay.textContent).toContain('Sync your data across devices')
  })

  it('renders a custom title, description, and logo', async () => {
    const overlay = await render(
      <AuthOverlay
        title="Sign in to Orbital"
        description="Pick up your boards on any device"
        logo={<span data-testid="custom-logo">◎</span>}
      />,
    )
    expect(overlay.textContent).toContain('Sign in to Orbital')
    expect(overlay.textContent).not.toContain('Sign in to DeepSpace')
    expect(overlay.textContent).toContain('Pick up your boards on any device')
    expect(overlay.querySelector('[data-testid="custom-logo"]')).not.toBeNull()
    // DeepSpace is the auth provider, so its ToS/Privacy attribution stays
    // even on a host-branded card.
    expect(overlay.textContent).toContain('Terms of Service')
    expect(overlay.textContent).toContain('Privacy Policy')
  })
})
