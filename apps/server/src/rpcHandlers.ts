import { Array, Effect } from 'effect'

import { MusicRpcs, type Song } from '@music/shared'

import { ArtworkPalette } from './palette/service.ts'
import { PlaylistStore } from './playlists/store.ts'
import { Prefetcher, pageJobs } from './prefetch.ts'
import { YouTubeMusic } from './youtubeMusic/service.ts'

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
      getSong: ({ videoId }) =>
        youTubeMusic
          .getSong(videoId)
          .pipe(Effect.tap(details => prepare([details.song], 1, 0))),
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
      getHome: () => youTubeMusic.getHome(),
      getMyLibrary: () => playlistStore.library(),
      getMyPlaylist: ({ playlistId }) =>
        playlistStore
          .playlist(playlistId)
          .pipe(Effect.tap(details => prepare(details.songs, 2, 3))),
      editPlaylists: ({ edit }) => playlistStore.edit(edit),
      getArtworkBackdrop: ({ artworkUrl }) =>
        artworkPalette.backdropFor(artworkUrl),
    }
  }),
)
