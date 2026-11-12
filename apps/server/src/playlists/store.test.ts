import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { Effect, Option, Result } from 'effect'

import {
  LIKED_PLAYLIST_ID,
  MAX_PLAYLIST_TITLE_LENGTH,
  type PlaylistEdit,
  type Song,
} from '@music/shared'

import { makePlaylistStore, mosaicCovers, normalizeTitle } from './store.ts'

const song = (
  videoId: string,
  options: Readonly<{ albumId?: string; seconds?: number }> = {},
): Song => ({
  videoId,
  title: `Song ${videoId}`,
  artists: [{ maybeId: Option.some('UCartist'), name: 'Artist' }],
  maybeAlbum: Option.fromNullishOr(options.albumId).pipe(
    Option.map(id => ({ id, name: `Album ${id}` })),
  ),
  maybeDurationSeconds: Option.fromNullishOr(options.seconds),
  artwork: [
    {
      url: `https://lh3.googleusercontent.com/${videoId}`,
      width: 60,
      height: 60,
    },
  ],
})

const makeStore = () => {
  let clock = 1_000
  let nextId = 0
  return makePlaylistStore(new Database(':memory:', { strict: true }), {
    now: () => (clock += 1),
    newId: () => `playlist-${(nextId += 1)}`,
  })
}

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runSync(Effect.result(effect))

const edit = (store: ReturnType<typeof makeStore>, change: PlaylistEdit) =>
  Result.getOrThrow(run(store.edit(change)))

describe('playlist store', () => {
  test('starts with only an empty Liked songs', () => {
    const library = Result.getOrThrow(run(makeStore().library()))

    expect(library.likedVideoIds).toEqual([])
    expect(
      library.playlists.map(({ id, title, isLiked }) => [id, title, isLiked]),
    ).toEqual([[LIKED_PLAYLIST_ID, 'Liked songs', true]])
  })

  test('creates a playlist holding a copy of the songs, each once', () => {
    const store = makeStore()
    const result = edit(store, {
      _tag: 'Create',
      title: '  Road trip  ',
      songs: [
        song('a', { seconds: 100 }),
        song('b', { seconds: 50 }),
        song('a'),
      ],
    })

    const details = Option.getOrThrow(result.maybePlaylist)
    expect(details.playlist).toMatchObject({
      id: 'playlist-1',
      title: 'Road trip',
      isLiked: false,
      songCount: 2,
      totalSeconds: 150,
    })
    expect(details.songs.map(({ videoId }) => videoId)).toEqual(['a', 'b'])
    expect(details.songs[0]).toEqual(song('a', { seconds: 100 }))
    expect(result.library.playlists.map(({ id }) => id)).toEqual([
      LIKED_PLAYLIST_ID,
      'playlist-1',
    ])
  })

  test('adds songs to the end and skips ones already there', () => {
    const store = makeStore()
    edit(store, { _tag: 'Create', title: 'Mix', songs: [song('a')] })
    const result = edit(store, {
      _tag: 'AddSongs',
      playlistId: 'playlist-1',
      songs: [song('a'), song('c'), song('b')],
    })

    expect(
      Option.getOrThrow(result.maybePlaylist).songs.map(
        ({ videoId }) => videoId,
      ),
    ).toEqual(['a', 'c', 'b'])
  })

  test('lists the most recently changed playlist first, after Liked songs', () => {
    const store = makeStore()
    edit(store, { _tag: 'Create', title: 'First', songs: [] })
    edit(store, { _tag: 'Create', title: 'Second', songs: [] })
    const result = edit(store, {
      _tag: 'AddSongs',
      playlistId: 'playlist-1',
      songs: [song('a')],
    })

    expect(result.library.playlists.map(({ title }) => title)).toEqual([
      'Liked songs',
      'First',
      'Second',
    ])
  })

  test('likes put the newest first, and unliking removes it', () => {
    const store = makeStore()
    edit(store, { _tag: 'SetLiked', song: song('a'), isLiked: true })
    edit(store, { _tag: 'SetLiked', song: song('b'), isLiked: true })
    const liked = edit(store, {
      _tag: 'SetLiked',
      song: song('a'),
      isLiked: true,
    })

    expect(liked.library.likedVideoIds).toEqual(['b', 'a'])

    const unliked = edit(store, {
      _tag: 'SetLiked',
      song: song('b'),
      isLiked: false,
    })
    expect(unliked.library.likedVideoIds).toEqual(['a'])
  })

  test('removes one song', () => {
    const store = makeStore()
    edit(store, { _tag: 'Create', title: 'Mix', songs: [song('a'), song('b')] })
    const result = edit(store, {
      _tag: 'RemoveSong',
      playlistId: 'playlist-1',
      videoId: 'a',
    })

    expect(
      Option.getOrThrow(result.maybePlaylist).songs.map(
        ({ videoId }) => videoId,
      ),
    ).toEqual(['b'])
  })

  test('renames and deletes, but never Liked songs', () => {
    const store = makeStore()
    edit(store, { _tag: 'Create', title: 'Mix', songs: [song('a')] })

    const renamed = edit(store, {
      _tag: 'Rename',
      playlistId: 'playlist-1',
      title: 'Better mix',
    })
    expect(Option.getOrThrow(renamed.maybePlaylist).playlist.title).toBe(
      'Better mix',
    )

    edit(store, {
      _tag: 'Rename',
      playlistId: LIKED_PLAYLIST_ID,
      title: 'Nope',
    })
    const deleted = edit(store, { _tag: 'Delete', playlistId: 'playlist-1' })
    edit(store, { _tag: 'Delete', playlistId: LIKED_PLAYLIST_ID })

    expect(Option.isNone(deleted.maybePlaylist)).toBe(true)
    const library = Result.getOrThrow(run(store.library()))
    expect(library.playlists.map(({ title }) => title)).toEqual(['Liked songs'])
  })

  test('a missing playlist is not found', () => {
    const store = makeStore()

    const lookup = run(store.playlist('nope'))
    const change = run(
      store.edit({ _tag: 'AddSongs', playlistId: 'nope', songs: [song('a')] }),
    )

    expect(Result.isFailure(lookup) && lookup.failure._tag).toBe(
      'MusicNotFoundError',
    )
    expect(Result.isFailure(change) && change.failure._tag).toBe(
      'MusicNotFoundError',
    )
  })

  test('keeps its playlists when the file is opened again', () => {
    const db = new Database(':memory:', { strict: true })
    const options = { now: () => 1, newId: () => 'kept' }
    Result.getOrThrow(
      run(
        makePlaylistStore(db, options).edit({
          _tag: 'Create',
          title: 'Kept',
          songs: [song('a')],
        }),
      ),
    )

    const reopened = makePlaylistStore(db, options)
    const details = Result.getOrThrow(run(reopened.playlist('kept')))
    expect(details.songs).toHaveLength(1)
  })
})

describe('normalizeTitle', () => {
  test('trims, shortens, and names an empty title', () => {
    expect(normalizeTitle('  Mix  ')).toBe('Mix')
    expect(normalizeTitle('   ')).toBe('Untitled playlist')
    expect(normalizeTitle('x'.repeat(300))).toHaveLength(
      MAX_PLAYLIST_TITLE_LENGTH,
    )
  })
})

describe('mosaicCovers', () => {
  test('takes four covers from different albums', () => {
    const covers = mosaicCovers([
      song('a', { albumId: 'one' }),
      song('b', { albumId: 'one' }),
      song('c', { albumId: 'two' }),
      song('d'),
      song('e'),
      song('f'),
    ])

    expect(covers.map(artwork => artwork[0]?.url.split('/').at(-1))).toEqual([
      'a',
      'c',
      'd',
      'e',
    ])
  })
})
