import { Array, Option, pipe } from 'effect'

import {
  type AlbumSummary,
  type HomeFeed,
  type Session,
  type Song,
} from '@music/shared'

import { rememberFirst, songFromQueueTrack } from './library'

/*
 * Home's history shelves change at once when a song starts, the way the
 * server will fold the play into them (`foldRecent` in the server's
 * `home.ts`): an album more than one song played from moves to Jump back
 * in, and any other song shows on its own in Recently played. Home takes
 * the server's own copy the next time it opens.
 */

/** The most songs Recently played keeps, as the server does. */
const HOME_RECENT_SONGS = 20
/** The most albums Jump back in keeps, as the server does. */
const HOME_RECENT_ALBUMS = 12

const isSameSong = (left: Song, right: Song): boolean =>
  left.videoId === right.videoId

const isSameAlbum = (left: AlbumSummary, right: AlbumSummary): boolean =>
  left.id === right.id

/** The album a song came from, credited to its first artist, as the server does. */
const albumOf = (song: Song): Option.Option<AlbumSummary> =>
  Option.map(song.maybeAlbum, album => ({
    id: album.id,
    title: album.name,
    artists: song.artists.slice(0, 1),
    maybeKind: Option.none(),
    maybeYear: Option.none(),
    artwork: song.artwork,
  }))

/**
 * Whether an album is the one a playing song is from. A song the phone only
 * knows from the queue has its album's name, not its id, so the name and an
 * artist have to match.
 */
const isAlbumOf =
  (song: Song, track: Session.QueueTrack) =>
  (album: AlbumSummary): boolean =>
    Option.match(song.maybeAlbum, {
      onSome: ({ id }) => id === album.id,
      onNone: () =>
        track.album === album.title &&
        (Array.isReadonlyArrayEmpty(album.artists) ||
          Array.some(album.artists, ({ name }) =>
            track.artists.includes(name),
          )),
    })

/** The song the feed already knows for a track, which links its album. */
const knownSong = (feed: HomeFeed, track: Session.QueueTrack): Song =>
  pipe(
    Array.findFirst(
      feed.recentlyPlayed,
      ({ videoId }) => videoId === track.videoId,
    ),
    Option.orElse(() =>
      Option.filter(
        feed.maybeLastPlayed,
        ({ videoId }) => videoId === track.videoId,
      ),
    ),
    Option.getOrElse(() => songFromQueueTrack(track)),
  )

const withoutSong =
  (videoId: string) =>
  (songs: ReadonlyArray<Song>): ReadonlyArray<Song> =>
    Array.filter(songs, song => song.videoId !== videoId)

/** Home with a song that just started folded into its history shelves. */
export const withPlayedFirst =
  (track: Session.QueueTrack) =>
  (feed: HomeFeed): HomeFeed => {
    const song = knownSong(feed, track)
    const isFromAlbum = isAlbumOf(song, track)
    const maybeAlbum = Array.findFirst(feed.jumpBackIn, isFromAlbum)
    const maybeSibling = Array.findFirst(
      feed.recentlyPlayed,
      sibling =>
        sibling.videoId !== song.videoId &&
        Option.exists(albumOf(sibling), isFromAlbum),
    )
    const maybeJumpBackTo = Option.orElse(maybeAlbum, () =>
      Option.flatMap(maybeSibling, albumOf),
    )
    const withLastPlayed = { ...feed, maybeLastPlayed: Option.some(song) }
    return Option.match(maybeJumpBackTo, {
      onNone: () => ({
        ...withLastPlayed,
        recentlyPlayed: rememberFirst(
          feed.recentlyPlayed,
          song,
          isSameSong,
          HOME_RECENT_SONGS,
        ),
      }),
      onSome: album => ({
        ...withLastPlayed,
        jumpBackIn: rememberFirst(
          feed.jumpBackIn,
          album,
          isSameAlbum,
          HOME_RECENT_ALBUMS,
        ),
        recentlyPlayed: pipe(
          feed.recentlyPlayed,
          withoutSong(song.videoId),
          songs =>
            Option.match(maybeSibling, {
              onNone: () => songs,
              onSome: sibling => withoutSong(sibling.videoId)(songs),
            }),
        ),
      }),
    })
  }
