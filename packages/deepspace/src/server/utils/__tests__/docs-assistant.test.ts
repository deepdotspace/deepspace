import { describe, expect, it } from 'vitest'
import {
  buildDocsAssistantPrompt,
  parseDocsCorpus,
  readDocsRoute,
  searchDocsCorpus,
} from '../docs-assistant'

const corpus = parseDocsCorpus([
  {
    id: 'home:0',
    route: '/',
    title: 'DeepSpace SDK',
    text: 'Compile the documentation with npx deepspace docs build.',
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

describe('docs assistant corpus', () => {
  it('ranks title and exact phrase matches deterministically', () => {
    expect(searchDocsCorpus(corpus, 'quickstart install')[0]).toMatchObject({
      route: '/quickstart',
      title: 'Quickstart',
    })
  })

  it('ignores conversational filler and normalizes build and documentation terms', () => {
    expect(searchDocsCorpus(corpus, 'What command builds the documentation?')[0]).toMatchObject({
      route: '/',
      excerpt: expect.stringContaining('npx deepspace docs build'),
    })
  })

  it('reads only one exact normalized route', () => {
    expect(readDocsRoute(corpus, 'guides/auth/')).toEqual([
      {
        route: '/guides/auth',
        title: 'Authentication',
        text: 'Use the DeepSpace auth hooks to sign readers into an application.',
      },
    ])
  })

  it('rejects malformed and oversized corpus chunks', () => {
    expect(() =>
      parseDocsCorpus([{ id: 'bad', route: 'relative', title: 'Bad', text: 'x' }]),
    ).toThrow(/invalid required fields/)
    expect(() =>
      parseDocsCorpus([{ id: 'large', route: '/large', title: 'Large', text: 'x'.repeat(2_501) }]),
    ).toThrow(/exceeds/)
  })

  it('pins the agent to read-only docs tools and citations', () => {
    const prompt = buildDocsAssistantPrompt('Example', '/quickstart')
    expect(prompt).toContain('docs_search')
    expect(prompt).toContain('Markdown links')
    expect(prompt).toContain('Never claim access to application records')
  })
})
