// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentationRuntimeData } from '../../types'
import { PageActions } from '../page-actions'

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
    contextual: { actions: ['view', 'copy'] },
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

describe('documentation page actions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('closes the actions menu and restores focus after copying', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('# Introduction'))),
    )
    act(() => root.render(<PageActions data={data} onAssistantOpen={() => undefined} />))

    const details = container.querySelector('details')
    const summary = details?.querySelector('summary')
    const copy = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.includes('Copy page'),
    )
    expect(details).not.toBeNull()
    expect(summary).not.toBeNull()
    expect(copy).not.toBeUndefined()
    if (details) details.open = true

    await act(async () => {
      copy?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledWith('# Introduction')
    expect(details?.open).toBe(false)
    expect(document.activeElement).toBe(summary)
  })
})
