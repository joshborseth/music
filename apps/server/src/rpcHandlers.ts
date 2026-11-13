import { Array, Clock, Effect } from 'effect'

import {
  LIKED_PLAYLIST_ID,
  MusicRpcs,
  type PlaylistStoreError,
  type Song,
} from '@music/shared'

import { HOME_HISTORY_DEPTH, homeFeed, newReleases } from './home.ts'
import { TimedLyrics } from './lyrics/service.ts'
import { ArtworkPalette } from './palette/service.ts'
import { PlaylistStore } from './playlists/store.ts'
import { Prefetcher, pageJobs } from './prefetch.ts'
import { YouTubeMusic } from './youtubeMusic/service.ts'

/** The most songs Home's "More like" shelf shows. */
const RADIO_SONGS = 20

/** How many of the most played songs Home's mixes are chosen from. */
const MIX_CANDIDATES = 100

/** The most followed artists whose pages Home reads for new releases. */
const NEW_RELEASE_ARTISTS = 24
/** How many artist pages Home reads at once. */
const ARTIST_PAGE_CONCURRENCY = 4

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

    /** Liked songs, which the store always has. */
    const likedSongs: Effect.Effect<
      ReadonlyArray<Song>,
      PlaylistStoreError
    > = playlistStore.playlist(LIKED_PLAYLIST_ID).pipe(
      Effect.map(({ songs }) => songs),
      Effect.catchTag('MusicNotFoundError', () => Effect.succeed([])),
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
        Effect.all(
          {
            recentSongs: playlistStore.recentlyPlayed(HOME_HISTORY_DEPTH),
            played: playlistStore.mostPlayed(MIX_CANDIDATES),
            liked: likedSongs,
          },
          { concurrency: 'unbounded' },
        ).pipe(Effect.map(homeFeed)),
      getNewReleases: () =>
        Effect.gen(function* () {
          const library = yield* playlistStore.library()
          const pages = yield* Effect.forEach(
            Array.take(library.artists, NEW_RELEASE_ARTISTS),
            artist =>
              youTubeMusic.getArtistOverview(artist.id).pipe(Effect.option),
            { concurrency: ARTIST_PAGE_CONCURRENCY },
          )
          const now = yield* Clock.currentTimeMillis
          return newReleases(
            Array.getSomes(pages),
            new Date(now).getUTCFullYear(),
          )
        }),
      getSongRadio: ({ videoId }) =>
        youTubeMusic
          .getUpNext(videoId)
          .pipe(Effect.map(songs => Array.take(songs, RADIO_SONGS))),
      getRadio: ({ station }) => youTubeMusic.getRadio(station),
      getArtworkBackdrop: ({ artworkUrl }) =>
        artworkPalette.backdropFor(artworkUrl),
    }
  }),
)
