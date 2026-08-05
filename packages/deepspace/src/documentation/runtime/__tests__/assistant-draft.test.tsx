// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DocumentationRuntimeData } from '../../types'
import { DocumentationApp } from '../app'

const data: DocumentationRuntimeData = {
  basePath: '/docs',
  breadcrumbs: ['Guide'],
  config: {
    name: 'Example',
    theme: {},
    links: [],
    footer: [],
    assistant: { access: 'public' },
    mcp: { access: 'public' },
    contextual: { actions: [] },
  },
  navigation: [],
  page: {
    route: '/',
    title: 'Introduction',
    html: '<p>Welcome</p>',
    headings: [],
    kind: 'page',
    markdownUrl: '/docs/index.md',
  },
}

describe('documentation assistant draft ownership', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0)
    window.cancelAnimationFrame = (handle) => window.clearTimeout(handle)
    window.matchMedia = () => ({
      addEventListener: () => undefined,
      matches: false,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('carries the launcher draft into the panel without browser storage', () => {
    act(() => root.render(<DocumentationApp data={data} />))
    const launcher = container.querySelector<HTMLInputElement>(
      '#deepspace-documentation-assistant-launcher-input',
    )
    expect(launcher).not.toBeNull()

    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(launcher, 'How does deployment work?')
      launcher?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('.documentation-launcher-agent')?.click()
    })

    expect(container.querySelector<HTMLTextAreaElement>(
      '#deepspace-documentation-assistant textarea',
    )?.value).toBe('How does deployment work?')
    // jsdom may not expose storage on every Node line; the invariant is only
    // that the draft never persists when storage exists.
    expect(window.localStorage?.length ?? 0).toBe(0)
  })
})
