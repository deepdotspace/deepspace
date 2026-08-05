import { describe, expect, it } from 'vitest'
import {
  buildDocumentationAssistantTools,
  buildDocumentationAssistantPrompt,
  parseDocumentationCorpus,
  readDocumentationRoute,
  searchDocumentationCorpus,
} from '../assistant'

const corpus = parseDocumentationCorpus([
  {
    id: 'home:0',
    route: '/',
    title: 'DeepSpace SDK',
    text: 'Documentation is compiled automatically during deepspace deploy.',
  },
  {
    id: 'quickstart:0',
    route: '/quickstart',
    title: 'Quickstart',
    text: 'Install the SDK, initialize the app, and run deepspace deploy.',
  },
  {
    id: 'auth:0',
    route: '/guides/auth',
    title: 'Authentication',
    text: 'Use the DeepSpace auth hooks to sign readers into an application.',
  },
])

describe('documentation assistant corpus', () => {
  it('ranks title and exact phrase matches deterministically', () => {
    expect(searchDocumentationCorpus(corpus, 'quickstart install')[0]).toMatchObject({
      route: '/quickstart',
      title: 'Quickstart',
    })
  })

  it('ignores conversational filler and normalizes build and documentation terms', () => {
    expect(searchDocumentationCorpus(corpus, 'What command builds the documentation?')[0]).toMatchObject({
      route: '/',
      excerpt: expect.stringContaining('deepspace deploy'),
    })
  })

  it('reads only one exact normalized route', () => {
    expect(readDocumentationRoute(corpus, 'guides/auth/')).toEqual([
      {
        route: '/guides/auth',
        title: 'Authentication',
        text: 'Use the DeepSpace auth hooks to sign readers into an application.',
      },
    ])
  })

  it('rejects malformed and oversized corpus chunks', () => {
    expect(() =>
      parseDocumentationCorpus([{ id: 'bad', route: 'relative', title: 'Bad', text: 'x' }]),
    ).toThrow(/invalid required fields/)
    expect(() =>
      parseDocumentationCorpus([{ id: 'large', route: '/large', title: 'Large', text: 'x'.repeat(2_501) }]),
    ).toThrow(/exceeds/)
  })

  it('pins the agent to read-only documentation tools and citations', () => {
    const prompt = buildDocumentationAssistantPrompt('Example', '/quickstart')
    expect(prompt).toContain('documentation_search')
    expect(prompt).toContain('Markdown links')
    expect(prompt).toContain('Never claim access to application records')
  })

  it('returns citation paths for the active documentation mount', async () => {
    const tools = buildDocumentationAssistantTools([
      { id: 'guide', route: '/guide', title: 'Guide', text: 'Deploy a guide.' },
    ], '/docs')
    const search = tools.documentation_search
    if (!search?.execute) throw new Error('documentation_search is not executable')
    const result = await search.execute({ query: 'deploy' }, {
      messages: [], toolCallId: 'test', abortSignal: new AbortController().signal,
    }) as { results: Array<{ url: string }> }
    expect(result.results[0]?.url).toBe('/docs/guide')
  })
})
