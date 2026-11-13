import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  type AlbumSummary,
  type MyLibrary,
  type MyPlaylistSummary,
  type Song,
} from '@music/shared'

import {
  matchesLibrarySearch,
  sortAlbums,
  sortArtists,
  sortPlaylists,
} from './library'
import { moveSong } from './playlistEditor'

const playlist = (
  id: string,
  title: string,
  createdAt: number,
  maybePlayedAt: Option.Option<number> = Option.none(),
): MyPlaylistSummary => ({
  id,
  title,
  isLiked: id === 'liked',
  songCount: 1,
  totalSeconds: 200,
  covers: [],
  updatedAt: 1,
  createdAt,
  maybePlayedAt,
  maybeDescription: Option.none(),
  maybeCoverVideoId: Option.none(),
})

const album = (id: string, title: string, artist: string): AlbumSummary => ({
  id,
  title,
  artists: [{ maybeId: Option.some(`UC${artist}`), name: artist }],
  maybeKind: Option.some('Album'),
  maybeYear: Option.none(),
  artwork: [],
})

const library = (overrides: Partial<MyLibrary> = {}): MyLibrary => ({
  playlists: [],
  likedVideoIds: [],
  albums: [],
  artists: [],
  albumPlayedAt: {},
  artistPlayedAt: {},
  ...overrides,
})

const ids = (items: ReadonlyArray<Readonly<{ id: string }>>) =>
  items.map(({ id }) => id)

describe('sortPlaylists', () => {
  // The server lists them the most recently changed first.
  const playlists = [
    playlist('liked', 'Liked Songs', 0, Option.some(900)),
    playlist('b', 'beach', 20, Option.some(100)),
    playlist('a', 'Álbum night', 30),
    playlist('c', 'Commute', 10, Option.some(500)),
  ]

  test('keeps Liked Songs first in every order', () => {
    expect(ids(sortPlaylists(playlists, 'RecentlyUpdated'))).toEqual([
      'liked',
      'b',
      'a',
      'c',
    ])
    expect(ids(sortPlaylists(playlists, 'RecentlyAdded'))).toEqual([
      'liked',
      'a',
      'b',
      'c',
    ])
    expect(ids(sortPlaylists(playlists, 'RecentlyPlayed'))).toEqual([
      'liked',
      'c',
      'b',
      'a',
    ])
    expect(ids(sortPlaylists(playlists, 'Title'))).toEqual([
      'liked',
      'a',
      'b',
      'c',
    ])
  })
})

describe('sortAlbums and sortArtists', () => {
  const saved = library({
    albums: [
      album('rumours', 'Rumours', 'Fleetwood Mac'),
      album('abbey', 'Abbey Road', 'The Beatles'),
      album('tusk', 'Tusk', 'Fleetwood Mac'),
    ],
    artists: [
      { id: 'b', name: 'beatles', maybeAudience: Option.none(), artwork: [] },
      { id: 'a', name: 'ABBA', maybeAudience: Option.none(), artwork: [] },
    ],
    albumPlayedAt: { tusk: 50, abbey: 70 },
    artistPlayedAt: { a: 10 },
  })

  test('albums by when saved, played, title, or artist', () => {
    expect(ids(sortAlbums(saved, 'RecentlyAdded'))).toEqual([
      'rumours',
      'abbey',
      'tusk',
    ])
    expect(ids(sortAlbums(saved, 'RecentlyPlayed'))).toEqual([
      'abbey',
      'tusk',
      'rumours',
    ])
    expect(ids(sortAlbums(saved, 'Title'))).toEqual([
      'abbey',
      'rumours',
      'tusk',
    ])
    expect(ids(sortAlbums(saved, 'Artist'))).toEqual([
      'rumours',
      'tusk',
      'abbey',
    ])
  })

  test('artists by when followed, played, or name', () => {
    expect(ids(sortArtists(saved, 'RecentlyAdded'))).toEqual(['b', 'a'])
    expect(ids(sortArtists(saved, 'RecentlyPlayed'))).toEqual(['a', 'b'])
    expect(ids(sortArtists(saved, 'Title'))).toEqual(['a', 'b'])
  })
})

describe('matchesLibrarySearch', () => {
  test('finds every word typed, ignoring case and accents', () => {
    expect(matchesLibrarySearch('', ['Anything'])).toBe(true)
    expect(matchesLibrarySearch('beyonce', ['Beyoncé'])).toBe(true)
    expect(matchesLibrarySearch('mac rum', ['Rumours', 'Fleetwood Mac'])).toBe(
      true,
    )
    expect(matchesLibrarySearch('mac tusk', ['Rumours', 'Fleetwood Mac'])).toBe(
      false,
    )
  })
})

describe('moveSong', () => {
  const song = (videoId: string): Song => ({
    videoId,
    title: videoId,
    artists: [],
    maybeAlbum: Option.none(),
    maybeDurationSeconds: Option.none(),
    artwork: [],
  })
  const songs = [song('a'), song('b'), song('c')]
  const videoIds = (list: ReadonlyArray<Song>) =>
    list.map(({ videoId }) => videoId)

  test('moves a song before another, or to the end', () => {
    expect(videoIds(moveSong(songs, 'c', Option.some('a')))).toEqual([
      'c',
      'a',
      'b',
    ])
    expect(videoIds(moveSong(songs, 'a', Option.none()))).toEqual([
      'b',
      'c',
      'a',
    ])
    expect(videoIds(moveSong(songs, 'gone', Option.some('a')))).toEqual([
      'a',
      'b',
      'c',
    ])
  })
})
