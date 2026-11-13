import { Array, Effect } from 'effect'

import { MusicRpcs, type Song } from '@music/shared'

import { HOME_HISTORY_DEPTH, homeFeed } from './home.ts'
import { TimedLyrics } from './lyrics/service.ts'
import { ArtworkPalette } from './palette/service.ts'
import { PlaylistStore } from './playlists/store.ts'
import { Prefetcher, pageJobs } from './prefetch.ts'
import { YouTubeMusic } from './youtubeMusic/service.ts'

/** The most songs Home's "More like" shelf shows. */
const RADIO_SONGS = 20

/**
 * Answers each MusicRpcs call from the YouTube Music catalog or the playlist
 * store. Opening a
 * page also gets the songs someone is likely to play from it ready, so
 * Play starts instantly: the first ones downloaded whole, the next few
 * with their links found. The latest page replaces the previous one's plan.
 */
export const MusicRpcsLive = MusicRpcs.toLayer(
  Effect.gen(function* () {
    const youTubeMusic = yield* YouTubeMusic
    const prefetcher = yield* Prefetcher
    const playlistStore = yield* PlaylistStore
    const artworkPalette = yield* ArtworkPalette
    const timedLyrics = yield* TimedLyrics

    const prepare = (
      songs: ReadonlyArray<Song>,
      downloads: number,
      resolves: number,
    ) =>
      prefetcher.plan(
        'Page',
        pageJobs(
          Array.map(songs, song => song.videoId),
          downloads,
          resolves,
        ),
      )

    return {
      searchSongs: ({ query }) =>
        youTubeMusic
          .searchSongs(query)
          .pipe(Effect.tap(songs => prepare(songs, 1, 2))),
      searchArtists: ({ query }) => youTubeMusic.searchArtists(query),
      searchAlbums: ({ query }) => youTubeMusic.searchAlbums(query),
      searchPlaylists: ({ query }) => youTubeMusic.searchPlaylists(query),
      searchTopResult: ({ query }) => youTubeMusic.searchTopResult(query),
      getMoodsAndGenres: () => youTubeMusic.getMoodsAndGenres(),
      getMood: ({ params }) => youTubeMusic.getMood(params),
      getSong: ({ videoId }) =>
        youTubeMusic.getSong(videoId).pipe(
          Effect.tap(details => prepare([details.song], 1, 0)),
          Effect.flatMap(timedLyrics.withTimedLines),
        ),
      getArtist: ({ artistId }) =>
        youTubeMusic
          .getArtist(artistId)
          .pipe(Effect.tap(details => prepare(details.topSongs, 2, 3))),
      getAlbum: ({ albumId }) =>
        youTubeMusic
          .getAlbum(albumId)
          .pipe(Effect.tap(details => prepare(details.tracks, 2, 3))),
      getPlaylist: ({ playlistId }) =>
        youTubeMusic
          .getPlaylist(playlistId)
          .pipe(Effect.tap(details => prepare(details.tracks, 2, 3))),
      getMyLibrary: () => playlistStore.library(),
      getMyPlaylist: ({ playlistId }) =>
        playlistStore
          .playlist(playlistId)
          .pipe(Effect.tap(details => prepare(details.songs, 2, 3))),
      editPlaylists: ({ edit }) => playlistStore.edit(edit),
      getHome: () =>
        playlistStore
          .recentlyPlayed(HOME_HISTORY_DEPTH)
          .pipe(Effect.map(homeFeed)),
      getSongRadio: ({ videoId }) =>
        youTubeMusic
          .getUpNext(videoId)
          .pipe(Effect.map(songs => Array.take(songs, RADIO_SONGS))),
      getArtworkBackdrop: ({ artworkUrl }) =>
        artworkPalette.backdropFor(artworkUrl),
    }
  }),
)
