import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { Effect, Option, Result } from 'effect'

import {
  type AlbumSummary,
  type ArtistSummary,
  LIKED_PLAYLIST_ID,
  MAX_PLAYLIST_DESCRIPTION_LENGTH,
  MAX_PLAYLIST_TITLE_LENGTH,
  type PlaylistEdit,
  type Song,
  mosaicCovers,
} from '@music/shared'

import {
  PLAY_HISTORY_SIZE,
  makePlaylistStore,
  normalizeDescription,
  normalizeTitle,
} from './store.ts'

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

const songIds = (result: ReturnType<typeof edit>): ReadonlyArray<string> =>
  Option.getOrThrow(result.maybePlaylist).songs.map(({ videoId }) => videoId)

/** A store holding one playlist, `playlist-1`, of the songs `a` to `d`. */
const storeWithMix = () => {
  const store = makeStore()
  edit(store, {
    _tag: 'Create',
    title: 'Mix',
    songs: [
      song('a', { albumId: 'one' }),
      song('b', { albumId: 'two' }),
      song('c', { albumId: 'three' }),
      song('d', { albumId: 'four' }),
    ],
  })
  return store
}

describe('playlist store', () => {
  test('starts with only an empty Liked songs', () => {
    const library = Result.getOrThrow(run(makeStore().library()))

    expect(library.likedVideoIds).toEqual([])
    expect(
      library.playlists.map(({ id, title, isLiked }) => [id, title, isLiked]),
    ).toEqual([[LIKED_PLAYLIST_ID, 'Liked Songs', true]])
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
      'Liked Songs',
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
    expect(library.playlists.map(({ title }) => title)).toEqual(['Liked Songs'])
  })

  test('moves a song before another, or to the end', () => {
    const store = storeWithMix()
    const up = edit(store, {
      _tag: 'MoveSong',
      playlistId: 'playlist-1',
      videoId: 'c',
      maybeBeforeVideoId: Option.some('a'),
    })
    expect(songIds(up)).toEqual(['c', 'a', 'b', 'd'])

    const down = edit(store, {
      _tag: 'MoveSong',
      playlistId: 'playlist-1',
      videoId: 'c',
      maybeBeforeVideoId: Option.none(),
    })
    expect(songIds(down)).toEqual(['a', 'b', 'd', 'c'])

    const beforeMissing = edit(store, {
      _tag: 'MoveSong',
      playlistId: 'playlist-1',
      videoId: 'a',
      maybeBeforeVideoId: Option.some('gone'),
    })
    expect(songIds(beforeMissing)).toEqual(['b', 'd', 'c', 'a'])

    const added = edit(store, {
      _tag: 'AddSongs',
      playlistId: 'playlist-1',
      songs: [song('e')],
    })
    expect(songIds(added)).toEqual(['b', 'd', 'c', 'a', 'e'])
  })

  test('moving a song it does not hold changes nothing', () => {
    const store = storeWithMix()
    const result = edit(store, {
      _tag: 'MoveSong',
      playlistId: 'playlist-1',
      videoId: 'gone',
      maybeBeforeVideoId: Option.some('a'),
    })
    expect(songIds(result)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('keeps Liked songs newest first', () => {
    const store = makeStore()
    edit(store, { _tag: 'SetLiked', song: song('a'), isLiked: true })
    edit(store, { _tag: 'SetLiked', song: song('b'), isLiked: true })
    const result = edit(store, {
      _tag: 'MoveSong',
      playlistId: LIKED_PLAYLIST_ID,
      videoId: 'a',
      maybeBeforeVideoId: Option.some('b'),
    })
    expect(result.library.likedVideoIds).toEqual(['b', 'a'])
  })

  test('sets and clears a description', () => {
    const store = storeWithMix()
    const described = edit(store, {
      _tag: 'SetDescription',
      playlistId: 'playlist-1',
      description: '  For the long drive.  ',
    })
    expect(
      Option.getOrThrow(described.maybePlaylist).playlist.maybeDescription,
    ).toEqual(Option.some('For the long drive.'))
    expect(
      described.library.playlists.find(({ id }) => id === 'playlist-1')
        ?.maybeDescription,
    ).toEqual(Option.some('For the long drive.'))

    const cleared = edit(store, {
      _tag: 'SetDescription',
      playlistId: 'playlist-1',
      description: '   ',
    })
    expect(
      Option.getOrThrow(cleared.maybePlaylist).playlist.maybeDescription,
    ).toEqual(Option.none())
  })

  test("shows one song's cover in place of the mosaic", () => {
    const store = storeWithMix()
    const mosaic = Option.getOrThrow(
      edit(store, { _tag: 'AddSongs', playlistId: 'playlist-1', songs: [] })
        .maybePlaylist,
    ).playlist
    expect(mosaic.covers).toHaveLength(4)
    expect(mosaic.maybeCoverVideoId).toEqual(Option.none())

    const picked = Option.getOrThrow(
      edit(store, {
        _tag: 'SetCover',
        playlistId: 'playlist-1',
        maybeVideoId: Option.some('c'),
      }).maybePlaylist,
    ).playlist
    expect(picked.maybeCoverVideoId).toEqual(Option.some('c'))
    expect(picked.covers).toEqual([song('c').artwork])

    const notHeld = Option.getOrThrow(
      edit(store, {
        _tag: 'SetCover',
        playlistId: 'playlist-1',
        maybeVideoId: Option.some('gone'),
      }).maybePlaylist,
    ).playlist
    expect(notHeld.maybeCoverVideoId).toEqual(Option.some('c'))

    const back = Option.getOrThrow(
      edit(store, {
        _tag: 'SetCover',
        playlistId: 'playlist-1',
        maybeVideoId: Option.none(),
      }).maybePlaylist,
    ).playlist
    expect(back.covers).toHaveLength(4)
    expect(back.maybeCoverVideoId).toEqual(Option.none())
  })

  test('goes back to the mosaic when the cover song is removed', () => {
    const store = storeWithMix()
    edit(store, {
      _tag: 'SetCover',
      playlistId: 'playlist-1',
      maybeVideoId: Option.some('b'),
    })
    edit(store, { _tag: 'RemoveSong', playlistId: 'playlist-1', videoId: 'b' })
    const readded = Option.getOrThrow(
      edit(store, {
        _tag: 'AddSongs',
        playlistId: 'playlist-1',
        songs: [song('b', { albumId: 'two' })],
      }).maybePlaylist,
    ).playlist
    expect(readded.maybeCoverVideoId).toEqual(Option.none())
    expect(readded.covers).toHaveLength(4)
  })

  test('Liked songs keeps its own description and cover', () => {
    const store = makeStore()
    edit(store, { _tag: 'SetLiked', song: song('a'), isLiked: true })
    edit(store, {
      _tag: 'SetDescription',
      playlistId: LIKED_PLAYLIST_ID,
      description: 'Nope',
    })
    const result = edit(store, {
      _tag: 'SetCover',
      playlistId: LIKED_PLAYLIST_ID,
      maybeVideoId: Option.some('a'),
    })
    const liked = Option.getOrThrow(result.maybePlaylist).playlist
    expect(liked.maybeDescription).toEqual(Option.none())
    expect(liked.maybeCoverVideoId).toEqual(Option.none())
  })

  test('knows when each playlist, album, and artist last played', () => {
    const store = makeStore()
    edit(store, {
      _tag: 'Create',
      title: 'Mix',
      songs: [song('a', { albumId: 'one' }), song('b', { albumId: 'two' })],
    })
    edit(store, { _tag: 'Create', title: 'Quiet', songs: [song('c')] })
    Result.getOrThrow(run(store.recordPlay(song('a', { albumId: 'one' }))))
    Result.getOrThrow(run(store.recordPlay(song('b', { albumId: 'two' }))))
    const library = Result.getOrThrow(run(store.library()))

    const mix = library.playlists.find(({ title }) => title === 'Mix')
    const quiet = library.playlists.find(({ title }) => title === 'Quiet')
    const latest = Option.getOrThrow(mix?.maybePlayedAt ?? Option.none())
    expect(quiet?.maybePlayedAt).toEqual(Option.none())
    expect(quiet?.createdAt).toBeGreaterThan(mix?.createdAt ?? Infinity)
    expect(library.albumPlayedAt['two']).toBe(latest)
    expect(library.albumPlayedAt['one']).toBeLessThan(latest)
    expect(library.artistPlayedAt).toEqual({ UCartist: latest })
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

const album = (id: string, title = `Album ${id}`): AlbumSummary => ({
  id,
  title,
  artists: [{ maybeId: Option.some('UCartist'), name: 'Artist' }],
  maybeKind: Option.some('Album'),
  maybeYear: Option.some('1977'),
  artwork: [
    { url: `https://lh3.googleusercontent.com/${id}`, width: 60, height: 60 },
  ],
})

const artist = (id: string): ArtistSummary => ({
  id,
  name: `Artist ${id}`,
  maybeAudience: Option.some('1M monthly audience'),
  artwork: [],
})

/** Takes a file back to before playlists had descriptions and covers. */
const dropDescriptionsAndCovers = (db: Database): void => {
  db.run('ALTER TABLE playlists DROP COLUMN description')
  db.run('ALTER TABLE playlists DROP COLUMN cover_video_id')
}

const ids = <A extends Readonly<{ id: string }>>(
  items: ReadonlyArray<A>,
): ReadonlyArray<string> => items.map(({ id }) => id)

describe('saved albums and followed artists', () => {
  test('start empty', () => {
    const library = Result.getOrThrow(run(makeStore().library()))
    expect(library.albums).toEqual([])
    expect(library.artists).toEqual([])
  })

  test('keep each album once, the latest saved first, with its details', () => {
    const store = makeStore()
    edit(store, { _tag: 'SetAlbumSaved', album: album('a'), isSaved: true })
    edit(store, { _tag: 'SetAlbumSaved', album: album('b'), isSaved: true })
    const result = edit(store, {
      _tag: 'SetAlbumSaved',
      album: album('a', 'Rumours (Deluxe)'),
      isSaved: true,
    })

    expect(ids(result.library.albums)).toEqual(['a', 'b'])
    expect(result.library.albums[0]).toEqual(album('a', 'Rumours (Deluxe)'))
    expect(Option.isNone(result.maybePlaylist)).toBe(true)
  })

  test('remove an album, and removing one never saved changes nothing', () => {
    const store = makeStore()
    edit(store, { _tag: 'SetAlbumSaved', album: album('a'), isSaved: true })
    edit(store, { _tag: 'SetAlbumSaved', album: album('b'), isSaved: true })

    const removed = edit(store, {
      _tag: 'SetAlbumSaved',
      album: album('a'),
      isSaved: false,
    })
    expect(ids(removed.library.albums)).toEqual(['b'])

    const unchanged = edit(store, {
      _tag: 'SetAlbumSaved',
      album: album('never'),
      isSaved: false,
    })
    expect(ids(unchanged.library.albums)).toEqual(['b'])
  })

  test('follow and unfollow artists, the latest followed first', () => {
    const store = makeStore()
    edit(store, {
      _tag: 'SetArtistFollowed',
      artist: artist('x'),
      isFollowed: true,
    })
    const followed = edit(store, {
      _tag: 'SetArtistFollowed',
      artist: artist('y'),
      isFollowed: true,
    })
    expect(ids(followed.library.artists)).toEqual(['y', 'x'])
    expect(followed.library.artists[1]).toEqual(artist('x'))

    const unfollowed = edit(store, {
      _tag: 'SetArtistFollowed',
      artist: artist('y'),
      isFollowed: false,
    })
    expect(ids(unfollowed.library.artists)).toEqual(['x'])
  })

  test('leave playlists and likes alone', () => {
    const store = makeStore()
    edit(store, { _tag: 'SetLiked', song: song('a'), isLiked: true })
    const result = edit(store, {
      _tag: 'SetAlbumSaved',
      album: album('a'),
      isSaved: true,
    })
    expect(result.library.likedVideoIds).toEqual(['a'])
    expect(result.library.playlists).toHaveLength(1)
  })

  test('a file from before albums and artists keeps its playlists and history', () => {
    const db = new Database(':memory:', { strict: true })
    const options = { now: () => 1, newId: () => 'kept' }
    const older = makePlaylistStore(db, options)
    Result.getOrThrow(
      run(older.edit({ _tag: 'Create', title: 'Kept', songs: [song('a')] })),
    )
    Result.getOrThrow(run(older.recordPlay(song('b'))))
    db.run('DROP TABLE saved_albums')
    db.run('DROP TABLE followed_artists')
    dropDescriptionsAndCovers(db)
    db.run('PRAGMA user_version = 2')

    const reopened = makePlaylistStore(db, options)
    const library = Result.getOrThrow(run(reopened.library()))
    expect(ids(library.playlists)).toEqual([LIKED_PLAYLIST_ID, 'kept'])
    expect(library.albums).toEqual([])
    expect(
      Result.getOrThrow(run(reopened.recentlyPlayed(1))).map(
        ({ videoId }) => videoId,
      ),
    ).toEqual(['b'])

    const saved = edit(reopened, {
      _tag: 'SetAlbumSaved',
      album: album('a'),
      isSaved: true,
    })
    expect(ids(saved.library.albums)).toEqual(['a'])
  })

  test('a file from before descriptions and covers keeps its playlists', () => {
    const db = new Database(':memory:', { strict: true })
    const options = { now: () => 1, newId: () => 'kept' }
    Result.getOrThrow(
      run(
        makePlaylistStore(db, options).edit({
          _tag: 'Create',
          title: 'Kept',
          songs: [song('a'), song('b')],
        }),
      ),
    )
    dropDescriptionsAndCovers(db)
    db.run('PRAGMA user_version = 4')

    const reopened = makePlaylistStore(db, options)
    const details = Result.getOrThrow(run(reopened.playlist('kept')))
    expect(details.playlist).toMatchObject({
      title: 'Kept',
      maybeDescription: Option.none(),
      maybeCoverVideoId: Option.none(),
    })
    expect(details.songs.map(({ videoId }) => videoId)).toEqual(['a', 'b'])

    const described = edit(reopened, {
      _tag: 'SetDescription',
      playlistId: 'kept',
      description: 'Still here.',
    })
    expect(
      Option.getOrThrow(described.maybePlaylist).playlist.maybeDescription,
    ).toEqual(Option.some('Still here.'))
  })

  test('a file from before the title case names Liked Songs the new way', () => {
    const db = new Database(':memory:', { strict: true })
    const options = { now: () => 1, newId: () => 'kept' }
    makePlaylistStore(db, options)
    db.run("UPDATE playlists SET title = 'Liked songs' WHERE id = 'liked'")
    dropDescriptionsAndCovers(db)
    db.run('PRAGMA user_version = 3')

    const library = Result.getOrThrow(
      run(makePlaylistStore(db, options).library()),
    )
    expect(library.playlists.map(({ title }) => title)).toEqual(['Liked Songs'])
  })
})

describe('play history', () => {
  const recent = (store: ReturnType<typeof makeStore>, limit = 10) =>
    Result.getOrThrow(run(store.recentlyPlayed(limit))).map(
      ({ videoId }) => videoId,
    )

  test('starts empty', () => {
    expect(recent(makeStore())).toEqual([])
  })

  test('keeps each song once, the latest play first', () => {
    const store = makeStore()
    for (const videoId of ['a', 'b', 'c', 'a']) {
      Result.getOrThrow(run(store.recordPlay(song(videoId))))
    }

    expect(recent(store)).toEqual(['a', 'c', 'b'])
    expect(recent(store, 2)).toEqual(['a', 'c'])
  })

  test('keeps the song as it last played', () => {
    const store = makeStore()
    run(store.recordPlay(song('a')))
    run(store.recordPlay(song('a', { albumId: 'one' })))

    const [latest] = Result.getOrThrow(run(store.recentlyPlayed(1)))
    expect(latest).toEqual(song('a', { albumId: 'one' }))
  })

  test('forgets the oldest plays past its size', () => {
    const store = makeStore()
    for (let index = 0; index <= PLAY_HISTORY_SIZE; index += 1) {
      run(store.recordPlay(song(`s${index}`)))
    }

    const kept = recent(store, PLAY_HISTORY_SIZE * 2)
    expect(kept).toHaveLength(PLAY_HISTORY_SIZE)
    expect(kept).not.toContain('s0')
    expect(kept[0]).toBe(`s${PLAY_HISTORY_SIZE}`)
  })
})

describe('music videos in the play history', () => {
  const video = (videoId: string): Song => ({
    ...song(videoId),
    title: `Song ${videoId} (Official Music Video)`,
    artwork: [
      {
        url: `https://i.ytimg.com/vi/${videoId}/hq.jpg`,
        width: 400,
        height: 225,
      },
    ],
  })
  const plays = (store: ReturnType<typeof makeStore>) =>
    Result.getOrThrow(run(store.mostPlayed(10))).map(
      ({ song: played, playCount }) => [played.videoId, playCount],
    )

  test('are the plays with a video frame for a cover, newest first', () => {
    const store = makeStore()
    run(store.recordPlay(video('v1')))
    run(store.recordPlay(song('a')))
    run(store.recordPlay(video('v2')))
    const videos = Result.getOrThrow(run(store.historyVideos()))
    expect(videos.map(({ videoId }) => videoId)).toEqual(['v2', 'v1'])
    expect(videos[0]?.title).toBe('Song v2')
  })

  test('give way to their songs, keeping when they played and how often', () => {
    const store = makeStore()
    run(store.recordPlay(video('v1')))
    run(store.recordPlay(video('v1')))
    run(store.recordPlay(song('a')))
    run(store.recordPlay(song('s1')))
    run(store.recordPlay(video('v2')))
    // v1's song already played once, after it: the plays add up.
    Result.getOrThrow(run(store.replaceInHistory('v1', song('s1'))))
    // v2 is a song after all, with its square cover.
    Result.getOrThrow(run(store.replaceInHistory('v2', song('v2'))))
    expect(plays(store)).toEqual([
      ['s1', 3],
      ['v2', 1],
      ['a', 1],
    ])
    expect(Result.getOrThrow(run(store.historyVideos()))).toEqual([])
    expect(Result.getOrThrow(run(store.recentlyPlayed(10)))).toEqual([
      song('v2'),
      song('s1'),
      song('a'),
    ])
  })

  test('give way to a song not played yet', () => {
    const store = makeStore()
    run(store.recordPlay(video('v1')))
    run(store.recordPlay(video('v1')))
    Result.getOrThrow(run(store.replaceInHistory('v1', song('s1'))))
    expect(plays(store)).toEqual([['s1', 2]])
  })
})

describe('songs saved with a music video’s title', () => {
  const taxes: Song = {
    ...song('Phh3oVCtzBg'),
    title: 'Geese - Taxes (Official Music Video)',
    artists: [{ maybeId: Option.some('UCgeese'), name: 'Geese' }],
  }

  test('show a clean title in the play history', () => {
    const store = makeStore()
    run(store.recordPlay(taxes))

    const [played] = Result.getOrThrow(run(store.recentlyPlayed(1)))
    const [most] = Result.getOrThrow(run(store.mostPlayed(1)))
    expect(played?.title).toBe('Taxes')
    expect(most?.song.title).toBe('Taxes')
  })

  test('show a clean title in playlists and Liked Songs', () => {
    const store = makeStore()
    edit(store, { _tag: 'Create', title: 'Mix', songs: [taxes] })
    edit(store, { _tag: 'SetLiked', song: taxes, isLiked: true })

    const [, mine] = Result.getOrThrow(run(store.library())).playlists
    const mix = Result.getOrThrow(run(store.playlist(mine?.id ?? '')))
    const liked = Result.getOrThrow(run(store.playlist(LIKED_PLAYLIST_ID)))
    expect(mix.songs.map(({ title }) => title)).toEqual(['Taxes'])
    expect(liked.songs.map(({ title }) => title)).toEqual(['Taxes'])
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

describe('normalizeDescription', () => {
  test('trims, shortens, and drops an empty description', () => {
    expect(normalizeDescription('  Long drive  ')).toEqual(
      Option.some('Long drive'),
    )
    expect(normalizeDescription('  ')).toEqual(Option.none())
    expect(
      Option.getOrThrow(normalizeDescription('x'.repeat(1000))),
    ).toHaveLength(MAX_PLAYLIST_DESCRIPTION_LENGTH)
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
