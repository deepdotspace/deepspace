import { describe, expect, it } from 'vitest'
import { documentationPageSection } from '../published-corpus'

const page = [
  '# Payments',
  '',
  'Intro paragraph.',
  '',
  '## Subscribe a user',
  '',
  'Call subscribe().',
  '',
  '```ts',
  '# a comment, not a heading',
  '```',
  '',
  '### Errors',
  '',
  'Handle failures.',
  '',
  '## Subscribe a user',
  '',
  'Second copy.',
  '',
  '## Cancel',
  '',
  'Done.',
  '',
].join('\n')

describe('documentationPageSection', () => {
  it('returns the heading through everything below the next equal-or-higher heading', () => {
    expect(documentationPageSection(page, 'subscribe-a-user')).toBe(
      [
        '## Subscribe a user',
        '',
        'Call subscribe().',
        '',
        '```ts',
        '# a comment, not a heading',
        '```',
        '',
        '### Errors',
        '',
        'Handle failures.',
      ].join('\n'),
    )
  })

  it('addresses duplicate headings with the same deduplicated slugs as rendered anchors', () => {
    expect(documentationPageSection(page, 'subscribe-a-user-2')).toBe(
      '## Subscribe a user\n\nSecond copy.',
    )
  })

  it('slugifies the fragment itself, so heading text also resolves', () => {
    expect(documentationPageSection(page, 'Subscribe a user')).toBe(
      documentationPageSection(page, 'subscribe-a-user'),
    )
  })

  it('runs a top-level section to the end of the page', () => {
    const section = documentationPageSection(page, 'payments')
    expect(section?.startsWith('# Payments')).toBe(true)
    expect(section?.endsWith('Done.')).toBe(true)
  })

  it('returns null for fragments no heading produces', () => {
    expect(documentationPageSection(page, 'refunds')).toBeNull()
    expect(documentationPageSection(page, 'a-comment-not-a-heading')).toBeNull()
    expect(documentationPageSection(page, '')).toBeNull()
  })
})
