import { describe, expect, test } from 'bun:test'

import { FAVORITE_PLAYS, songsToEvict } from './audioStore.ts'

const MB = 1024 * 1024
const song = (videoId: string, savedAt: number) => ({
  videoId,
  size: 4 * MB,
  savedAt,
})

describe('songsToEvict', () => {
  const songs = [
    song('old', 1),
    song('fav', 2),
    song('new', 3),
    song('next', 0),
  ]

  test('keeps everything while the cache fits', () => {
    expect(songsToEvict(songs, {}, new Set(), 16 * MB)).toEqual([])
  })

  test('drops songs that are not favorites, least recently used first, never protected ones', () => {
    const uses = {
      fav: { plays: FAVORITE_PLAYS, lastPlayedAt: 2 },
      old: { plays: 1, lastPlayedAt: 1 },
    }
    const evicted = songsToEvict(songs, uses, new Set(['next']), 12 * MB)
    expect(evicted.map(evictedSong => evictedSong.videoId)).toEqual([
      'old',
      'new',
    ])
  })

  test('a recent play keeps a song longer than its save time alone would', () => {
    const uses = { old: { plays: 1, lastPlayedAt: 10 } }
    const evicted = songsToEvict(songs, uses, new Set(), 12 * MB)
    expect(evicted.map(evictedSong => evictedSong.videoId)).toEqual([
      'next',
      'fav',
    ])
  })
})
