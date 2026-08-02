import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readRecentSearches, rememberRecentItem, rememberRecentQuery } from '../search-model'

const storageKey = 'search-history-test'
let values: Map<string, string>

beforeEach(() => {
  values = new Map()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('recent search history', () => {
  it('stores only the stable ID for a selected result', () => {
    expect(rememberRecentItem(storageKey, 'post-1', 5)).toEqual([
      { kind: 'item', itemId: 'post-1' },
    ])
    expect(JSON.parse(values.get(storageKey) ?? 'null')).toEqual([
      { kind: 'item', itemId: 'post-1' },
    ])
  })

  it('ignores legacy result snapshots instead of replaying incomplete objects', () => {
    values.set(storageKey, JSON.stringify([{ id: 'post-1', title: 'Old title' }]))
    expect(readRecentSearches(storageKey, 5)).toEqual([])
  })

  it('deduplicates submitted queries without changing their display casing', () => {
    rememberRecentQuery(storageKey, 'Project Alpha', 5)
    expect(rememberRecentQuery(storageKey, 'project alpha', 5)).toEqual([
      { kind: 'query', query: 'project alpha' },
    ])
  })
})
