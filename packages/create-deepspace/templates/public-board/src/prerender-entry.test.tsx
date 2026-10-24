import { expect, it } from 'vitest'
import { PRERENDER_ROUTES } from './prerender-entry'
it('keeps the live board out of static prerendering', () => {
  expect(PRERENDER_ROUTES).toEqual([])
})
