import { Array, Option, pipe } from 'effect'

import { type AlbumSummary, type HomeFeed, type Song } from '@music/shared'

/*
 * The phone's Home, made from the play history every device adds to. The
 * TV's Home reads the same history (`homeShelves` in `tvCatalog/mapping.ts`).
 */

/** How far back Home looks for albums to jump back into. */
export const HOME_HISTORY_DEPTH = 60
/** The most songs "Recently played" shows. */
export const HOME_RECENT_SONGS = 20
/** The most albums "Jump back in" shows. */
export const HOME_RECENT_ALBUMS = 12

/**
 * The album a song was played from, as far as the song knows it. The cover
 * is the song's own, which for an album track is the album's. The album's
 * artist is the song's first: a song's featured guests are not the album's.
 */
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
 * The albums of the songs played lately, latest first, each once. A song
 * with no album (a video, say) adds nothing.
 */
export const recentAlbums = (
  recentSongs: ReadonlyArray<Song>,
): ReadonlyArray<AlbumSummary> =>
  pipe(
    recentSongs,
    Array.map(albumOf),
    Array.getSomes,
    Array.dedupeWith((left, right) => left.id === right.id),
    Array.take(HOME_RECENT_ALBUMS),
  )

export const homeFeed = (recentSongs: ReadonlyArray<Song>): HomeFeed => ({
  jumpBackIn: recentAlbums(recentSongs),
  recentlyPlayed: Array.take(recentSongs, HOME_RECENT_SONGS),
})
