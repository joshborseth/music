import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'

import { type Song } from '@music/shared'

import { HOME_RECENT_ALBUMS, HOME_RECENT_SONGS, homeFeed } from './home.ts'

const song = (videoId: string, maybeAlbumId: Option.Option<string>): Song => ({
  videoId,
  title: `Song ${videoId}`,
  artists: [
    { maybeId: Option.some('UCa'), name: 'Fleetwood Mac' },
    { maybeId: Option.none(), name: 'Guest' },
  ],
  maybeAlbum: Option.map(maybeAlbumId, id => ({ id, name: `Album ${id}` })),
  maybeDurationSeconds: Option.some(200),
  artwork: [
    {
      url: `https://lh3.googleusercontent.com/${videoId}`,
      width: 544,
      height: 544,
    },
  ],
})

describe('home feed', () => {
  test('is empty before anything has played', () => {
    expect(homeFeed([])).toEqual({ jumpBackIn: [], recentlyPlayed: [] })
  })

  test('jumps back into each album once, latest first, under its first artist', () => {
    const feed = homeFeed([
      song('a', Option.some('A')),
      song('b', Option.none()),
      song('c', Option.some('B')),
      song('d', Option.some('A')),
    ])

    expect(feed.jumpBackIn.map(({ id }) => id)).toEqual(['A', 'B'])
    expect(feed.jumpBackIn[0]).toEqual({
      id: 'A',
      title: 'Album A',
      artists: [{ maybeId: Option.some('UCa'), name: 'Fleetwood Mac' }],
      maybeKind: Option.none(),
      maybeYear: Option.none(),
      artwork: song('a', Option.none()).artwork,
    })
    expect(feed.recentlyPlayed.map(({ videoId }) => videoId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })

  test('keeps each shelf short', () => {
    const played = Array.from({ length: 40 }, (_, index) =>
      song(`s${index}`, Option.some(`A${index}`)),
    )
    const feed = homeFeed(played)

    expect(feed.recentlyPlayed).toHaveLength(HOME_RECENT_SONGS)
    expect(feed.jumpBackIn).toHaveLength(HOME_RECENT_ALBUMS)
  })
})
