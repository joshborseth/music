import { describe, expect, test } from 'vitest'

import { FAVORITE_PLAYS, songsToTrim } from './songCache'

const MB = 1024 * 1024
const use = (plays: number, lastUsedAt: number) => ({
  bytes: 4 * MB,
  plays,
  lastUsedAt,
})

describe('songsToTrim', () => {
  const ids = ['old', 'fav', 'new', 'next']
  const index = {
    old: use(1, 1),
    fav: use(FAVORITE_PLAYS, 2),
    new: use(0, 3),
    next: use(0, 0),
  }

  test('keeps everything while the cache fits', () => {
    expect(songsToTrim(ids, index, new Set(), 16 * MB)).toEqual([])
  })

  test('drops non-favorites, least recently used first, never protected songs', () => {
    expect(songsToTrim(ids, index, new Set(['next']), 12 * MB)).toEqual([
      'old',
      'new',
    ])
  })

  test('assumes a size for songs the index does not know', () => {
    expect(songsToTrim(['a', 'b'], {}, new Set(), 9 * MB)).toEqual(['a'])
  })
})
