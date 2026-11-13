import { Array, Clock, Effect } from 'effect'

import {
  type AlbumSummary,
  LIKED_PLAYLIST_ID,
  type MusicNotFoundError,
  type PlaylistStoreError,
  type Song,
  type YouTubeMusicError,
} from '@music/shared'

import {
  HOME_HISTORY_DEPTH,
  type HomeFeedInput,
  moreLike,
  newReleases,
} from './home.ts'
import { type PlaylistStoreShape } from './playlists/store.ts'
import { type YouTubeMusicShape } from './youtubeMusic/service.ts'

/*
 * Where Home's shelves come from, read the same way for the phone (the
 * `getHome`, `getNewReleases`, and `getSongRadio` RPCs) and the TV
 * (`/tv/home`). `home.ts` shapes what these read.
 */

/** How many of the most played songs Home's mixes are chosen from. */
const MIX_CANDIDATES = 100

/** The most followed artists whose pages Home reads for new releases. */
const NEW_RELEASE_ARTISTS = 24
/** How many artist pages Home reads at once. */
const ARTIST_PAGE_CONCURRENCY = 4

/** Liked songs, which the store always has. */
export const likedSongs = (
  store: PlaylistStoreShape,
): Effect.Effect<ReadonlyArray<Song>, PlaylistStoreError> =>
  store.playlist(LIKED_PLAYLIST_ID).pipe(
    Effect.map(({ songs }) => songs),
    Effect.catchTag('MusicNotFoundError', () => Effect.succeed([])),
  )

/** What `homeFeed` is made from: the play history and Liked songs. */
export const homeFeedInput = (
  store: PlaylistStoreShape,
): Effect.Effect<HomeFeedInput, PlaylistStoreError> =>
  Effect.all(
    {
      recentSongs: store.recentlyPlayed(HOME_HISTORY_DEPTH),
      played: store.mostPlayed(MIX_CANDIDATES),
      liked: likedSongs(store),
    },
    { concurrency: 'unbounded' },
  )

/**
 * "New from artists you follow": the pages of the artists followed latest,
 * read a few at once (each kept for an hour), and their newest releases. An
 * artist page that fails just adds nothing.
 */
export const loadNewReleases = (
  store: PlaylistStoreShape,
  youTubeMusic: YouTubeMusicShape,
): Effect.Effect<ReadonlyArray<AlbumSummary>, PlaylistStoreError> =>
  Effect.gen(function* () {
    const library = yield* store.library()
    const pages = yield* Effect.forEach(
      Array.take(library.artists, NEW_RELEASE_ARTISTS),
      artist => youTubeMusic.getArtistOverview(artist.id).pipe(Effect.option),
      { concurrency: ARTIST_PAGE_CONCURRENCY },
    )
    const now = yield* Clock.currentTimeMillis
    return newReleases(Array.getSomes(pages), new Date(now).getUTCFullYear())
  })

const NOTHING_PLAYED: HomeFeedInput = { recentSongs: [], played: [], liked: [] }

/**
 * "More like": YouTube Music's radio for a song, without the song, the rest
 * of its album, or anything Home already shows (`moreLike`). The play
 * history and likes it is checked against are read with it; when they
 * can't be read, the radio is only cut short.
 */
export const loadSongRadio = (
  store: PlaylistStoreShape,
  youTubeMusic: YouTubeMusicShape,
  videoId: string,
): Effect.Effect<ReadonlyArray<Song>, MusicNotFoundError | YouTubeMusicError> =>
  Effect.all(
    [
      youTubeMusic.getUpNext(videoId),
      homeFeedInput(store).pipe(Effect.orElseSucceed(() => NOTHING_PLAYED)),
    ],
    { concurrency: 'unbounded' },
  ).pipe(Effect.map(([radio, input]) => moreLike(videoId, radio, input)))
