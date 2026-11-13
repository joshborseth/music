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

import { HOME_RECENT_ALBUMS, HOME_RECENT_SONGS, homeFeed } from '../home.ts'
import { type PlayedSong } from '../playlists/store.ts'
import {
  HOME_FOLLOWED_ARTISTS,
  HOME_LIKED_SONGS,
  HOME_PLAYLIST_SHELVES,
  HOME_PLAYLIST_SONGS,
  type HomeShelvesInput,
  SEARCH_SHELF_SIZE,
  albumCard,
  artistCollection,
  homePlaylists,
  homeShelves,
  labelled,
  largestArtworkUrl,
  libraryShelves,
  lyricsOf,
  myPlaylistCard,
  myPlaylistCollection,
  playlistCard,
  playlistCollection,
  savedOf,
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
  title: 'Liked Songs',
  isLiked: true,
  songCount: 12,
  totalSeconds: 3900,
  covers: [],
  updatedAt: 1,
  createdAt: 1,
  maybePlayedAt: Option.none(),
  maybeDescription: Option.none(),
  maybeCoverVideoId: Option.none(),
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
  albums: [],
  artists: [],
  albumPlayedAt: {},
  artistPlayedAt: {},
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

/** Home as `/tv/home` builds it: from the play history and Liked songs. */
const home = (
  lib: MyLibrary,
  liked: ReadonlyArray<Song>,
  recent: ReadonlyArray<Song>,
  more: Omit<HomeShelvesInput, 'library' | 'likedSongs' | 'feed'> & {
    played?: ReadonlyArray<PlayedSong>
  } = {},
) => {
  const { played = [], ...rest } = more
  return homeShelves({
    library: lib,
    likedSongs: liked,
    feed: homeFeed({ recentSongs: recent, played, liked }),
    ...rest,
  })
}

const titles = (shelves: ReadonlyArray<Tv.TvShelf>) =>
  shelves.map(({ title }) => title)

describe('shelves', () => {
  test('home is your liked songs, a mix of the artist you like, and your playlists until something plays, the fuller first', () => {
    const liked = Array.from({ length: HOME_LIKED_SONGS + 5 }, (_, index) =>
      song(`l${index}`),
    )
    const { shelves } = home(library, liked, [])
    // One mix and two playlists leave most of their rows empty: they go last.
    expect(titles(shelves)).toEqual([
      'Liked Songs',
      'Your mixes',
      'Your playlists',
    ])
    expect(shelves[0]?.cards).toHaveLength(HOME_LIKED_SONGS)
    expect(shelves[0]?.cards[0]).toMatchObject({ kind: 'Song', id: 'l0' })
    expect(shelves[2]?.cards.map(({ id }) => id)).toEqual(['liked', 'p1'])
  })

  test('home splits what played lately as the phone does: albums more than one song played from, then the other songs', () => {
    const recent = [
      song('r0', { maybeAlbum: Option.some({ id: 'A', name: 'Album A' }) }),
      song('r1', { maybeAlbum: Option.none() }),
      song('r2', { maybeAlbum: Option.some({ id: 'B', name: 'Album B' }) }),
      song('r3', { maybeAlbum: Option.some({ id: 'A', name: 'Album A' }) }),
      song('r4', { maybeAlbum: Option.some({ id: 'C', name: 'Album C' }) }),
      song('r5', { maybeAlbum: Option.some({ id: 'D', name: 'Album D' }) }),
    ]
    const { shelves } = home(library, [], recent)
    expect(titles(shelves)).toEqual([
      'Recently played',
      'Jump back in',
      'Your playlists',
    ])
    // Album A's songs show once, as the album, under its own artist.
    expect(shelves[0]?.cards.map(({ id }) => id)).toEqual([
      'r1',
      'r2',
      'r4',
      'r5',
    ])
    expect(shelves[0]?.cards[0]?.track).toEqual(toQueueTrack(recent[1]!))
    expect(shelves[1]?.cards).toEqual([
      {
        kind: 'Album',
        id: 'A',
        title: 'Album A',
        subtitle: 'Album · Rick Astley',
        artworkUrl: 'https://lh3.googleusercontent.com/r0=w544-h544',
        track: null,
      },
    ])
  })

  test('home caps what played lately', () => {
    const recent = [
      ...Array.from({ length: 40 }, (_, index) =>
        song(`a${index}`, {
          maybeAlbum: Option.some({
            id: `A${Math.floor(index / 2)}`,
            name: 'Album',
          }),
        }),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        song(`s${index}`, {
          maybeAlbum: Option.some({ id: `S${index}`, name: 'Single' }),
        }),
      ),
    ]
    const { shelves } = home(library, [], recent)
    expect(titles(shelves).slice(0, 2)).toEqual([
      'Jump back in',
      'Recently played',
    ])
    expect(shelves[0]?.cards).toHaveLength(HOME_RECENT_ALBUMS)
    expect(shelves[1]?.cards).toHaveLength(HOME_RECENT_SONGS)
  })

  test('home leaves out Liked songs while it is empty', () => {
    expect(titles(home(library, [], []).shelves)).toEqual(['Your playlists'])
  })

  test('home adds your mixes, more like the song played last, and new releases, in the phone order', () => {
    const geese = (videoId: string) =>
      song(videoId, {
        title: `Geese ${videoId}`,
        artists: [{ maybeId: Option.some('UCgeese'), name: 'Geese' }],
      })
    const played = [
      { song: geese('g1'), playCount: 9 },
      { song: song('x1'), playCount: 3 },
      { song: geese('g2'), playCount: 2 },
    ]
    const recent = [geese('g2'), song('x1'), geese('g3')].map(each => ({
      ...each,
      maybeAlbum: Option.none(),
    }))
    const releases = ['N1', 'N2', 'N3'].map(id =>
      album({
        id,
        maybeKind: Option.some('Single'),
        maybeYear: Option.some('2026'),
      }),
    )
    const { shelves } = home(library, [], recent, {
      played,
      radio: Option.some({
        seed: recent[0]!,
        songs: [song('m1'), song('m2'), song('m3')],
      }),
      newReleases: releases,
    })
    expect(titles(shelves)).toEqual([
      'Recently played',
      'More like Geese g2',
      'New from artists you follow',
      'Your mixes',
      'Your playlists',
    ])
    // A mix per artist, the most played first, each opening as a playlist.
    expect(shelves[3]?.cards).toEqual([
      {
        kind: 'Playlist',
        id: 'RDAMVMg1',
        title: 'Mix: Geese',
        subtitle: 'Based on Geese g1',
        artworkUrl: 'https://lh3.googleusercontent.com/g1=w544-h544',
        track: null,
      },
      expect.objectContaining({ id: 'RDAMVMx1', title: 'Mix: Rick Astley' }),
    ])
    expect(shelves[1]?.cards.map(({ kind, id }) => [kind, id])).toEqual([
      ['Song', 'm1'],
      ['Song', 'm2'],
      ['Song', 'm3'],
    ])
    expect(shelves[2]?.cards[0]).toMatchObject({
      kind: 'Album',
      id: 'N1',
      subtitle: 'Single · Rick Astley · 2026',
    })
  })

  test('home adds the songs of your latest playlists, and leads with full shelves while little has played', () => {
    const roadTrip = library.playlists[1]!
    const songs = Array.from({ length: HOME_PLAYLIST_SONGS + 5 }, (_, index) =>
      song(`p${index}`),
    )
    const { shelves } = home(library, [song('l0')], [song('r0')], {
      playlists: [{ playlist: roadTrip, songs }],
    })
    // One song played: its shelf holds a card, so the playlist leads.
    expect(titles(shelves)).toEqual([
      'Road trip',
      'Recently played',
      'Your mixes',
      'Your playlists',
      'Liked Songs',
    ])
    expect(shelves[0]?.cards).toHaveLength(HOME_PLAYLIST_SONGS)
    expect(shelves[0]?.cards[0]).toMatchObject({ kind: 'Song', id: 'p0' })
  })

  test('home shows the artists you follow after your liked songs, the fuller shelves first', () => {
    const artist = (id: string) => ({
      id,
      name: `Artist ${id}`,
      maybeAudience: Option.none(),
      artwork: [image(id, 544)],
    })
    const followed = Array.from(
      { length: HOME_FOLLOWED_ARTISTS + 3 },
      (_, index) => artist(`UC${index}`),
    )
    const { shelves } = home({ ...library, artists: followed }, [], [])
    expect(titles(shelves)).toEqual(['Artists you follow', 'Your playlists'])
    expect(shelves[0]?.cards).toHaveLength(HOME_FOLLOWED_ARTISTS)
    expect(shelves[0]?.cards[0]).toMatchObject({
      kind: 'Artist',
      id: 'UC0',
      title: 'Artist UC0',
    })

    const few = home(
      { ...library, artists: [artist('UCa')] },
      Array.from({ length: 5 }, (_, index) => song(`l${index}`)),
      [],
    )
    expect(titles(few.shelves)).toEqual([
      'Liked Songs',
      'Your mixes',
      'Your playlists',
      'Artists you follow',
    ])
  })

  test('home picks playlists with songs, latest first, never Liked songs', () => {
    const playlists = [
      myPlaylist(),
      myPlaylist({ id: 'empty', isLiked: false, songCount: 0 }),
      ...Array.from({ length: HOME_PLAYLIST_SHELVES + 2 }, (_, index) =>
        myPlaylist({ id: `p${index}`, isLiked: false, songCount: 3 }),
      ),
    ]
    expect(
      homePlaylists({
        playlists,
        likedVideoIds: [],
        albums: [],
        artists: [],
        albumPlayedAt: {},
        artistPlayedAt: {},
      }).map(({ id }) => id),
    ).toEqual(
      Array.from({ length: HOME_PLAYLIST_SHELVES }, (_, index) => `p${index}`),
    )
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
      topSongPlays: {},
      maybeAllSongsPlaylistId: Option.none(),
      albums: [album()],
      singles: [],
      relatedArtists: [],
      maybeRadio: Option.none(),
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

  test('a mix made on Home says so, and a playlist says it is one', () => {
    const details = (id: string) => ({
      playlist: {
        id,
        title: 'Mix: Geese',
        maybeSubtitle: Option.some('Based on Cobra'),
        artwork: [],
      },
      maybeOwner: Option.none(),
      maybeDescription: Option.none(),
      maybeLengthSummary: Option.some('50 songs'),
      tracks: [song('a')],
    })
    expect(playlistCollection(details('RDAMVMcobra')).subtitle).toBe(
      'Mix · Based on Cobra · 50 songs',
    )
    expect(playlistCollection(details('PL1')).subtitle).toBe(
      'Playlist · Based on Cobra · 50 songs',
    )
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
    expect(
      myPlaylistCollection({
        playlist: {
          ...library.playlists[1]!,
          maybeDescription: Option.some('For the long drive.'),
        },
        songs: [song('a')],
      }),
    ).toMatchObject({ description: 'For the long drive.' })
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
      }),
    ).toEqual({ text: null, source: null, lines: null })
  })
})

describe('saved albums and followed artists', () => {
  test('says whether an album is saved or an artist followed', () => {
    const withBoth: MyLibrary = {
      ...library,
      albums: [album({ id: 'A1' })],
      artists: [
        {
          id: 'UCa',
          name: 'Rick Astley',
          maybeAudience: Option.none(),
          artwork: [],
        },
      ],
    }
    expect(savedOf(withBoth, 'Album', 'A1')).toEqual({
      kind: 'Album',
      id: 'A1',
      saved: true,
    })
    expect(savedOf(withBoth, 'Album', 'UCa').saved).toBe(false)
    expect(savedOf(withBoth, 'Artist', 'UCa').saved).toBe(true)
    expect(savedOf(withBoth, 'Artist', 'A1').saved).toBe(false)
  })
})

describe('library shelves', () => {
  test('are your playlists alone until anything is saved or followed', () => {
    expect(libraryShelves(library).shelves.map(({ title }) => title)).toEqual([
      'Your playlists',
    ])
  })

  test('add the albums saved and the artists followed, latest first', () => {
    const { shelves } = libraryShelves({
      ...library,
      albums: [album({ id: 'A2' }), album({ id: 'A1' })],
      artists: [
        {
          id: 'UCa',
          name: 'Rick Astley',
          maybeAudience: Option.none(),
          artwork: [image('artist', 544)],
        },
      ],
    })
    expect(shelves.map(({ title }) => title)).toEqual([
      'Your playlists',
      'Albums',
      'Artists',
    ])
    expect(shelves[1]?.cards.map(({ kind, id }) => [kind, id])).toEqual([
      ['Album', 'A2'],
      ['Album', 'A1'],
    ])
    expect(shelves[2]?.cards[0]).toMatchObject({
      kind: 'Artist',
      id: 'UCa',
      title: 'Rick Astley',
    })
  })
})

describe('fixtures shared with the TV app', () => {
  const read = (name: string) => Bun.file(new URL(name, FIXTURES)).json()
  const cases: ReadonlyArray<readonly [string, Schema.Decoder<unknown>]> = [
    ['shelves.json', Tv.TvShelves],
    ['home.json', Tv.TvShelves],
    ['collection.json', Tv.TvCollection],
    ['lyrics.json', Tv.TvLyrics],
    ['lyrics-untimed.json', Tv.TvLyrics],
    ['lyrics-none.json', Tv.TvLyrics],
    ['liked.json', Tv.TvLiked],
    ['like-request.json', Tv.TvLikeRequest],
    ['saved.json', Tv.TvSaved],
    ['save-request.json', Tv.TvSaveRequest],
    ['version.json', Tv.TvVersion],
    ['version-none.json', Tv.TvVersion],
    ['analysis.json', Tv.TvAnalysis],
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
      home(library, [song('a')], [song('b')]),
    )
    expect(Schema.decodeExit(Tv.TvShelves)(encoded)._tag).toBe('Success')
  })
})
