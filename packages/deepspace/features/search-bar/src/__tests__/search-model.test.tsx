import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getHighlightedParts, useSearchIndex } from '../search-model'

const items = [
  { id: 'middle', title: 'Notes about sheep' },
  { id: 'exact', title: 'Sheep' },
  { id: 'prefix', title: 'Sheep counter' },
]

function ranked(query: string, limit?: number) {
  let result = items
  function Probe() {
    result = useSearchIndex({ items, query, getText: (item) => [item.title], limit })
    return null
  }
  renderToStaticMarkup(<Probe />)
  return result
}

describe('inline search model', () => {
  it('ranks exact and prefix matches before contained matches', () => {
    expect(ranked('sheep').map((item) => item.id)).toEqual(['exact', 'prefix', 'middle'])
  })

  it('applies the result limit to searches and empty queries', () => {
    expect(ranked('sheep', 2)).toHaveLength(2)
    expect(ranked('', 2)).toEqual(items.slice(0, 2))
  })

  it('highlights every case-insensitive match without dropping text', () => {
    expect(getHighlightedParts('Sheep sheep', 'sheep')).toEqual([
      { text: 'Sheep', match: true },
      { text: ' ', match: false },
      { text: 'sheep', match: true },
    ])
  })
})
