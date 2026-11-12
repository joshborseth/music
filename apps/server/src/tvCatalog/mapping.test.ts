import { describe, expect, test } from 'bun:test'
import { Option, Schema } from 'effect'

import {
  type AlbumSummary,
  type ArtistDetails,
  type MyLibrary,
  type MyPlaylistSummary,
  type Song,
  Tv,
} from '@music/shared'

import {
  SEARCH_SHELF_SIZE,
  albumCard,
  artistCollection,
  homeShelves,
  labelled,
  largestArtworkUrl,
  lyricsOf,
  myPlaylistCard,
  myPlaylistCollection,
  playlistCard,
  searchShelves,
  songCard,
  songFromQueueTrack,
  toQueueTrack,
} from './mapping.ts'

const FIXTURES = new URL('../../../../fixtures/tv/', import.meta.url)

const image = (id: string, size: number) => ({
  url: `https://lh3.googleusercontent.com/${id}=w${size}-h${size}`,
  width: size,
  height: size,
})

const song = (videoId: string, overrides: Partial<Song> = {}): Song => ({
  videoId,
  title: `Song ${videoId}`,
  artists: [
    { maybeId: Option.some('UCa'), name: 'Rick Astley' },
    { maybeId: Option.none(), name: 'Guest' },
  ],
  maybeAlbum: Option.some({ id: 'MPREb_abc', name: 'Whenever' }),
  maybeDurationSeconds: Option.some(213),
  artwork: [image(videoId, 60), image(videoId, 120), image(videoId, 544)],
  ...overrides,
})

const album = (overrides: Partial<AlbumSummary> = {}): AlbumSummary => ({
  id: 'MPREb_abc',
  title: 'Whenever You Need Somebody',
  artists: [{ maybeId: Option.some('UCa'), name: 'Rick Astley' }],
  maybeKind: Option.some('Album'),
  maybeYear: Option.some('1987'),
  artwork: [image('album', 226), image('album', 544)],
  ...overrides,
})

const myPlaylist = (
  overrides: Partial<MyPlaylistSummary> = {},
): MyPlaylistSummary => ({
  id: 'liked',
  title: 'Liked songs',
  isLiked: true,
  songCount: 12,
  totalSeconds: 3900,
  covers: [],
  updatedAt: 1,
  ...overrides,
})

const library: MyLibrary = {
  playlists: [
    myPlaylist(),
    myPlaylist({
      id: 'p1',
      title: 'Road trip',
      isLiked: false,
      songCount: 1,
      covers: [[image('cover', 120), image('cover', 544)]],
    }),
  ],
  likedVideoIds: ['a'],
}

describe('toQueueTrack', () => {
  test('builds the same track as the web app', () => {
    expect(toQueueTrack(song('a'))).toEqual({
      videoId: 'a',
      title: 'Song a',
      artists: 'Rick Astley, Guest',
      album: 'Whenever',
      durationSeconds: 213,
      // The smallest image at least 720 px wide, else the largest.
      artworkUrl: 'https://lh3.googleusercontent.com/a=w544-h544',
    })
  })

  test('uses nulls for what a song lacks', () => {
    expect(
      toQueueTrack(
        song('b', {
          maybeAlbum: Option.none(),
          maybeDurationSeconds: Option.none(),
          artwork: [],
        }),
      ),
    ).toMatchObject({ album: null, durationSeconds: null, artworkUrl: null })
  })

  test('survives the round trip through Liked songs', () => {
    const track = toQueueTrack(song('a'))
    expect(toQueueTrack(songFromQueueTrack(track))).toEqual({
      ...track,
      // The queue keeps the album only by name, without its id.
      album: null,
    })
  })
})

describe('cards', () => {
  test('a song card carries its track', () => {
    const card = songCard(song('a'))
    expect(card).toMatchObject({
      kind: 'Song',
      id: 'a',
      subtitle: 'Rick Astley, Guest',
    })
    expect(card.track?.videoId).toBe('a')
  })

  test('an album card names its kind, artists, and year', () => {
    expect(albumCard(album()).subtitle).toBe('Album · Rick Astley · 1987')
    expect(
      albumCard(album({ maybeKind: Option.some('Single') }), false),
    ).toMatchObject({ subtitle: 'Single · 1987', track: null })
    expect(albumCard(album({ maybeKind: Option.none() })).subtitle).toBe(
      'Album · Rick Astley · 1987',
    )
  })

  test('a playlist card names who made it', () => {
    expect(
      playlistCard({
        id: 'RD1',
        title: '80s Hits',
        maybeSubtitle: Option.some('YouTube Music'),
        artwork: [],
      }),
    ).toMatchObject({ subtitle: 'Playlist · YouTube Music', artworkUrl: null })
  })

  test('the kind label leads once, with middle dots', () => {
    expect(labelled('Playlist', 'Playlist • Aaron · 14 views')).toBe(
      'Playlist · Aaron · 14 views',
    )
    expect(labelled('Playlist', 'Chart • YouTube Charts')).toBe(
      'Playlist · Chart · YouTube Charts',
    )
    expect(labelled('Playlist', '')).toBe('Playlist')
  })

  test('my playlist cards count songs and use the first cover', () => {
    expect(myPlaylistCard(library.playlists[0]!)).toMatchObject({
      kind: 'MyPlaylist',
      id: 'liked',
      subtitle: 'Playlist · 12 songs',
      artworkUrl: null,
    })
    expect(myPlaylistCard(library.playlists[1]!)).toMatchObject({
      subtitle: 'Playlist · 1 song',
      artworkUrl: 'https://lh3.googleusercontent.com/cover=w544-h544',
    })
  })
})

describe('shelves', () => {
  test('home puts your playlists first and drops empty shelves', () => {
    const { shelves } = homeShelves(library, {
      shelves: [
        { _tag: 'SongShelf', title: 'Quick picks', songs: [song('a')] },
        { _tag: 'AlbumShelf', title: 'Empty', albums: [] },
      ],
    })
    expect(shelves.map(({ title }) => title)).toEqual([
      'Your playlists',
      'Quick picks',
    ])
    expect(shelves[0]?.cards.map(({ id }) => id)).toEqual(['liked', 'p1'])
  })

  test('search caps each shelf and drops empty ones', () => {
    const songs = Array.from({ length: 20 }, (_, index) => song(`s${index}`))
    const { shelves } = searchShelves({
      songs,
      artists: [],
      albums: [album()],
      playlists: [],
    })
    expect(shelves.map(({ title }) => title)).toEqual(['Songs', 'Albums'])
    expect(shelves[0]?.cards).toHaveLength(SEARCH_SHELF_SIZE)
  })
})

describe('collections', () => {
  test('an artist plays its top songs and shelves its releases', () => {
    const details: ArtistDetails = {
      artist: {
        id: 'UCa',
        name: 'Rick Astley',
        maybeAudience: Option.none(),
        artwork: [image('artist', 120), image('artist', 900)],
      },
      maybeDescription: Option.some('Singer.'),
      topSongs: [song('a')],
      albums: [album()],
      singles: [],
      similarArtists: [],
    }
    const collection = artistCollection(details)
    expect(collection).toMatchObject({
      kind: 'Artist',
      title: 'Rick Astley',
      subtitle: 'Artist',
      description: 'Singer.',
      artworkUrl: 'https://lh3.googleusercontent.com/artist=w900-h900',
    })
    expect(collection.tracks.map(({ videoId }) => videoId)).toEqual(['a'])
    expect(collection.shelves).toEqual([
      {
        title: 'Albums',
        cards: [albumCard(album(), false)],
      },
    ])
  })

  test('my playlist spells out its length', () => {
    expect(
      myPlaylistCollection({
        playlist: library.playlists[0]!,
        songs: [song('a')],
      }),
    ).toMatchObject({
      subtitle: 'Playlist · 12 songs · 1 hr 5 min',
      description: null,
      artworkUrl: null,
    })
  })

  test('largest artwork is the last size', () => {
    expect(largestArtworkUrl([image('x', 60), image('x', 544)])).toBe(
      'https://lh3.googleusercontent.com/x=w544-h544',
    )
    expect(largestArtworkUrl([])).toBeNull()
  })
})

describe('lyrics', () => {
  test('nulls when a song has none', () => {
    expect(
      lyricsOf({
        song: song('a'),
        maybeViewCount: Option.none(),
        maybeLyrics: Option.none(),
        relatedSongs: [],
      }),
    ).toEqual({ text: null, source: null, lines: null })
  })
})

describe('fixtures shared with the TV app', () => {
  const read = (name: string) => Bun.file(new URL(name, FIXTURES)).json()
  const cases: ReadonlyArray<readonly [string, Schema.Decoder<unknown>]> = [
    ['shelves.json', Tv.TvShelves],
    ['collection.json', Tv.TvCollection],
    ['lyrics.json', Tv.TvLyrics],
    ['lyrics-untimed.json', Tv.TvLyrics],
    ['lyrics-none.json', Tv.TvLyrics],
    ['liked.json', Tv.TvLiked],
    ['like-request.json', Tv.TvLikeRequest],
    ['version.json', Tv.TvVersion],
    ['version-none.json', Tv.TvVersion],
  ]

  test.each(cases)('%s decodes', async (name, schema) => {
    const decoded = Schema.decodeUnknownExit(schema)(await read(name))
    expect(decoded._tag).toBe('Success')
  })

  test('every fixture is covered', async () => {
    const names = await Array.fromAsync(
      new Bun.Glob('*.json').scan({ cwd: FIXTURES.pathname }),
    )
    expect([...names].sort()).toEqual(cases.map(([name]) => name).sort())
  })

  test('the encoded mapping round-trips through the fixture Schema', () => {
    const encoded = Schema.encodeSync(Tv.TvShelves)(
      homeShelves(library, {
        shelves: [
          { _tag: 'SongShelf', title: 'Quick picks', songs: [song('a')] },
        ],
      }),
    )
    expect(Schema.decodeExit(Tv.TvShelves)(encoded)._tag).toBe('Success')
  })
})
