import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { type HomeFeed, type Song } from '@music/shared'

import { withPlayedFirst } from './home'
import { toQueueTrack } from './playback/queueTrack'

const fleetwoodMac = [
  { maybeId: Option.some('UCCzULu3prrEaPvM2ZtkJlYQ'), name: 'Fleetwood Mac' },
]

const song = (
  videoId: string,
  title: string,
  maybeAlbum: Option.Option<{ id: string; name: string }>,
): Song => ({
  videoId,
  title,
  artists: fleetwoodMac,
  maybeAlbum,
  maybeDurationSeconds: Option.some(240),
  artwork: [],
})

const rumours = Option.some({ id: 'MPREb_rumours', name: 'Rumours' })
const theChain = song('ch41n', 'The Chain', rumours)
const dreams = song('dr34ms', 'Dreams', rumours)
const landslide = song(
  'l4nd',
  'Landslide',
  Option.some({ id: 'MPREb_fm', name: 'Fleetwood Mac' }),
)

const feed = (overrides: Partial<HomeFeed> = {}): HomeFeed => ({
  jumpBackIn: [],
  recentlyPlayed: [],
  maybeLastPlayed: Option.none(),
  mixes: [],
  ...overrides,
})

const ids = (songs: ReadonlyArray<Song>) => songs.map(({ videoId }) => videoId)

describe('Home when a song starts', () => {
  test('puts a song first in Recently played, and More like follows it', () => {
    const next = withPlayedFirst(toQueueTrack(landslide))(
      feed({
        recentlyPlayed: [theChain],
        maybeLastPlayed: Option.some(theChain),
      }),
    )

    expect(ids(next.recentlyPlayed)).toEqual(['l4nd', 'ch41n'])
    expect(next.jumpBackIn).toEqual([])
    expect(Option.map(next.maybeLastPlayed, ({ videoId }) => videoId)).toEqual(
      Option.some('l4nd'),
    )
  })

  test('folds a second song from an album into Jump back in', () => {
    const next = withPlayedFirst(toQueueTrack(dreams))(
      feed({ recentlyPlayed: [theChain, landslide] }),
    )

    expect(next.jumpBackIn.map(({ id }) => id)).toEqual(['MPREb_rumours'])
    expect(ids(next.recentlyPlayed)).toEqual(['l4nd'])
  })

  test('moves an album already in Jump back in to the front', () => {
    const next = withPlayedFirst(toQueueTrack(theChain))(
      feed({
        jumpBackIn: [
          {
            id: 'MPREb_other',
            title: 'Tango in the Night',
            artists: fleetwoodMac,
            maybeKind: Option.none(),
            maybeYear: Option.none(),
            artwork: [],
          },
          {
            id: 'MPREb_rumours',
            title: 'Rumours',
            artists: fleetwoodMac,
            maybeKind: Option.none(),
            maybeYear: Option.none(),
            artwork: [],
          },
        ],
        recentlyPlayed: [landslide],
      }),
    )

    expect(next.jumpBackIn.map(({ id }) => id)).toEqual([
      'MPREb_rumours',
      'MPREb_other',
    ])
    expect(ids(next.recentlyPlayed)).toEqual(['l4nd'])
  })
})
