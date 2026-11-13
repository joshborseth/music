import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'

import { type AlbumSummary, type ArtistDetails, type Song } from '@music/shared'

import {
  HOME_MIXES,
  HOME_NEW_RELEASES,
  HOME_RECENT_ALBUMS,
  HOME_RECENT_SONGS,
  RADIO_SONGS,
  homeFeed,
  homeMixes,
  mixDetails,
  mixSeedOf,
  moreLike,
  newReleases,
} from './home.ts'

const song = (
  videoId: string,
  maybeAlbumId: Option.Option<string>,
  artist: Readonly<{ id: string; name: string }> = {
    id: 'UCa',
    name: 'Fleetwood Mac',
  },
): Song => ({
  videoId,
  title: `Song ${videoId}`,
  artists: [
    { maybeId: Option.some(artist.id), name: artist.name },
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

const history = (recentSongs: ReadonlyArray<Song>) =>
  homeFeed({ recentSongs, played: [], liked: [] })

describe('home feed', () => {
  test('is empty before anything has played', () => {
    expect(history([])).toEqual({
      jumpBackIn: [],
      recentlyPlayed: [],
      maybeLastPlayed: Option.none(),
      mixes: [],
    })
  })

  test('shows a song played once on its own, not its album too', () => {
    const feed = history([song('a', Option.some('A'))])

    expect(feed.jumpBackIn).toEqual([])
    expect(feed.recentlyPlayed.map(({ videoId }) => videoId)).toEqual(['a'])
    expect(Option.map(feed.maybeLastPlayed, ({ videoId }) => videoId)).toEqual(
      Option.some('a'),
    )
  })

  test('folds an album two songs played from into Jump back in, and only there', () => {
    const feed = history([
      song('a', Option.some('A')),
      song('b', Option.none()),
      song('c', Option.some('B')),
      song('d', Option.some('A')),
    ])

    expect(feed.jumpBackIn.map(({ id }) => id)).toEqual(['A'])
    expect(feed.jumpBackIn[0]).toEqual({
      id: 'A',
      title: 'Album A',
      artists: [{ maybeId: Option.some('UCa'), name: 'Fleetwood Mac' }],
      maybeKind: Option.none(),
      maybeYear: Option.none(),
      artwork: song('a', Option.none()).artwork,
    })
    expect(feed.recentlyPlayed.map(({ videoId }) => videoId)).toEqual([
      'b',
      'c',
    ])
    expect(Option.map(feed.maybeLastPlayed, ({ videoId }) => videoId)).toEqual(
      Option.some('a'),
    )
  })

  test('keeps each shelf short', () => {
    const albumPlays = Array.from({ length: 40 }, (_, index) =>
      song(`s${index}`, Option.some(`A${Math.floor(index / 2)}`)),
    )
    const singlePlays = Array.from({ length: 40 }, (_, index) =>
      song(`t${index}`, Option.some(`B${index}`)),
    )
    const feed = history([...albumPlays, ...singlePlays])

    expect(feed.jumpBackIn).toHaveLength(HOME_RECENT_ALBUMS)
    expect(feed.recentlyPlayed).toHaveLength(HOME_RECENT_SONGS)
  })
})

describe('home mixes', () => {
  const daftPunk = { id: 'UCdp', name: 'Daft Punk' }
  const justice = { id: 'UCj', name: 'Justice' }
  const once = { id: 'UCo', name: 'Played Once' }

  test('mixes the artists played and liked most, each from their favorite song', () => {
    const getLucky = song('lucky', Option.none(), daftPunk)
    const oneMoreTime = song('omt', Option.none(), daftPunk)
    const dance = song('dance', Option.none(), justice)
    const mixes = homeMixes(
      [
        { song: getLucky, playCount: 3 },
        { song: dance, playCount: 2 },
        { song: oneMoreTime, playCount: 1 },
        { song: song('x', Option.none(), once), playCount: 1 },
      ],
      [oneMoreTime, dance],
    )

    expect(mixes).toEqual([
      {
        id: 'RDAMVMlucky',
        title: 'Mix: Daft Punk',
        maybeSubtitle: Option.some('Based on Song lucky'),
        artwork: getLucky.artwork,
      },
      {
        id: 'RDAMVMdance',
        title: 'Mix: Justice',
        maybeSubtitle: Option.some('Based on Song dance'),
        artwork: dance.artwork,
      },
    ])
  })

  test('bases a mix on a song Home shows nowhere else, when there is one', () => {
    const getLucky = song('lucky', Option.none(), daftPunk)
    const oneMoreTime = song('omt', Option.none(), daftPunk)
    const feed = homeFeed({
      recentSongs: [getLucky],
      played: [
        { song: getLucky, playCount: 5 },
        { song: oneMoreTime, playCount: 2 },
      ],
      liked: [],
    })

    expect(feed.mixes.map(({ id }) => id)).toEqual(['RDAMVMomt'])
  })

  test('keeps the favorite song when Home shows all of them', () => {
    const getLucky = song('lucky', Option.none(), daftPunk)
    const feed = homeFeed({
      recentSongs: [getLucky],
      played: [{ song: getLucky, playCount: 5 }],
      liked: [],
    })

    expect(feed.mixes.map(({ id }) => id)).toEqual(['RDAMVMlucky'])
  })

  test('makes a few at most', () => {
    const played = Array.from({ length: 10 }, (_, index) => ({
      song: song(`s${index}`, Option.none(), {
        id: `UC${index}`,
        name: `Artist ${index}`,
      }),
      playCount: 5,
    }))

    expect(homeMixes(played, [])).toHaveLength(HOME_MIXES)
  })

  test('opens as a playlist that starts with its song', () => {
    const seed = song('lucky', Option.none(), daftPunk)
    const next = song('next', Option.none(), justice)
    const details = Option.getOrThrow(mixDetails('lucky', [seed, next, seed]))

    expect(mixSeedOf(details.playlist.id)).toEqual(Option.some('lucky'))
    expect(details.playlist.title).toBe('Mix: Daft Punk')
    expect(details.tracks.map(({ videoId }) => videoId)).toEqual([
      'lucky',
      'next',
    ])
    expect(mixDetails('lucky', [])).toEqual(Option.none())
  })

  test('only takes YouTube radio ids as mixes', () => {
    expect(mixSeedOf('RDAMVMabc')).toEqual(Option.some('abc'))
    expect(mixSeedOf('PLabc')).toEqual(Option.none())
    expect(mixSeedOf('RDAMVM')).toEqual(Option.none())
  })
})

describe('new releases', () => {
  const release = (id: string, year: string): AlbumSummary => ({
    id,
    title: `Release ${id}`,
    artists: [],
    maybeKind: Option.some('Single'),
    maybeYear: Option.some(year),
    artwork: [],
  })

  const artist = (
    albums: ReadonlyArray<AlbumSummary>,
    singles: ReadonlyArray<AlbumSummary>,
  ): ArtistDetails => ({
    artist: {
      id: 'UC',
      name: 'Artist',
      maybeAudience: Option.none(),
      artwork: [],
    },
    maybeDescription: Option.none(),
    topSongs: [],
    topSongPlays: {},
    maybeAllSongsPlaylistId: Option.none(),
    albums,
    singles,
    relatedArtists: [],
    maybeRadio: Option.none(),
  })

  test('lists releases from this year and last, newest first, a couple per artist', () => {
    const releases = newReleases(
      [
        artist(
          [release('a2025', '2025'), release('a2013', '2013')],
          [release('s2026', '2026'), release('s2026b', '2026')],
        ),
        artist([release('b2026', '2026')], []),
      ],
      2026,
    )

    expect(releases.map(({ id }) => id)).toEqual(['s2026', 's2026b', 'b2026'])
  })

  test('leaves out artists with nothing new', () => {
    expect(newReleases([artist([release('old', '2013')], [])], 2026)).toEqual(
      [],
    )
  })

  test('keeps the shelf short', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      artist([release(`r${index}`, '2026')], []),
    )

    expect(newReleases(many, 2026)).toHaveLength(HOME_NEW_RELEASES)
  })
})

describe('more like', () => {
  const macDeMarco = { id: 'UCmac', name: 'Mac DeMarco' }
  const swimming = { id: 'UCmiller', name: 'Mac Miller' }
  const other = { id: 'UCo', name: 'Other' }
  const named = (
    videoId: string,
    title: string,
    album: Option.Option<string>,
    artist: Readonly<{ id: string; name: string }>,
  ): Song => ({ ...song(videoId, album, artist), title })
  const ids = (songs: ReadonlyArray<Song>) =>
    songs.map(({ videoId }) => videoId)

  // Played lately: "Come Back to Earth", from Swimming, and "Pink + White".
  const comeBackToEarth = named(
    'cbte',
    'Come Back to Earth',
    Option.some('SWIM'),
    swimming,
  )
  const pinkWhite = named('pw', 'Pink + White', Option.some('BLONDE'), other)
  const liked = named(
    'liked',
    'Chamber of Reflection',
    Option.none(),
    macDeMarco,
  )

  test('leaves out what played lately, the seed’s album, and liked songs', () => {
    const radio = [
      named('swim2', 'Self Care', Option.some('SWIM'), swimming),
      pinkWhite,
      named('pwcopy', 'Pink + White', Option.some('OTHER'), other),
      liked,
      named('new1', 'Ladders', Option.some('GOOD'), other),
      named('swim3', 'Wings', Option.some('SWIM'), swimming),
      named('new2', 'Nights', Option.some('BLONDE2'), other),
    ]
    const songs = moreLike('cbte', radio, {
      recentSongs: [comeBackToEarth, pinkWhite],
      played: [],
      liked: [liked],
    })

    expect(ids(songs)).toEqual(['new1', 'new2'])
  })

  test('leaves out songs from an album in Jump back in', () => {
    const fromAlbum = named('blonde3', 'Ivy', Option.some('BLONDE'), other)
    const seed = named('seed', 'Seed', Option.none(), other)
    const songs = moreLike('seed', [fromAlbum], {
      recentSongs: [
        seed,
        named('b1', 'Nikes', Option.some('BLONDE'), other),
        named('b2', 'Solo', Option.some('BLONDE'), other),
      ],
      played: [],
      liked: [],
    })

    expect(songs).toEqual([])
  })

  test('keeps the shelf short', () => {
    const radio = Array.from({ length: RADIO_SONGS + 5 }, (_, index) =>
      named(`r${index}`, `Radio ${index}`, Option.none(), other),
    )

    expect(
      moreLike('cbte', radio, { recentSongs: [], played: [], liked: [] }),
    ).toHaveLength(RADIO_SONGS)
  })
})
