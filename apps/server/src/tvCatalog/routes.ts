import { Array, Duration, Effect, Match, Option, Schema } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import {
  LIKED_PLAYLIST_ID,
  type MusicNotFoundError,
  type PlaylistStoreError,
  type Session,
  type Song,
  Tv,
  type YouTubeMusicError,
} from '@music/shared'

import { type AnalysisError, SongAnalysis } from '../analysis/service.ts'
import { VIDEO_ID } from '../audio.ts'
import { TimedLyrics } from '../lyrics/service.ts'
import { PlaylistStore } from '../playlists/store.ts'
import { Prefetcher, pageJobs } from '../prefetch.ts'
import { YouTubeMusic } from '../youtubeMusic/service.ts'
import {
  albumCollection,
  artistCollection,
  homePlaylists,
  homeShelves,
  likedOf,
  lyricsOf,
  myPlaylistCollection,
  playlistCollection,
  searchShelves,
  songFromQueueTrack,
  yourPlaylistsShelf,
} from './mapping.ts'

/*
 * The TV app's catalog: plain JSON routes under `/tv/`, described in
 * `packages/shared/src/tv.ts`. They reshape the same catalog and playlist
 * store the web app reaches through Effect RPC. Bad input answers 400, a
 * missing item 404, and YouTube Music failing 502, each with plain text.
 */

/** How far back Home looks for albums to jump back into. */
const HOME_HISTORY_DEPTH = 60

/** How long a like waits for the song's full details before using the queue's copy. */
const LIKE_LOOKUP_TIMEOUT = Duration.seconds(3)

// INPUT

const NonBlank = Schema.String.check(
  Schema.makeFilter(value => value.trim().length > 0, {
    expected: 'a non-blank string',
  }),
)

const SearchParams = Schema.Struct({ q: NonBlank })
const CollectionParams = Schema.Struct({
  kind: Tv.TvCollectionKind,
  id: NonBlank,
})
const VideoParams = Schema.Struct({ videoId: NonBlank })
const SongParams = Schema.Struct({
  videoId: Schema.String.check(Schema.isPattern(VIDEO_ID)),
})

// ERRORS

/** A request the route could not answer, with its status and a short reason. */
class TvRouteError extends Schema.TaggedError<TvRouteError>()('TvRouteError', {
  status: Schema.Number,
  message: Schema.String,
}) {}

const badRequest = (message: string) => () =>
  new TvRouteError({ status: 400, message })

type CatalogError = MusicNotFoundError | YouTubeMusicError | PlaylistStoreError

/** Turns a catalog or store failure into the status the TV should see. */
const toRouteError = (error: CatalogError): TvRouteError =>
  Match.valueTags(error, {
    MusicNotFoundError: () =>
      new TvRouteError({ status: 404, message: 'Not found' }),
    YouTubeMusicError: () =>
      new TvRouteError({
        status: 502,
        message: 'YouTube Music did not answer',
      }),
    PlaylistStoreError: () =>
      new TvRouteError({
        status: 500,
        message: 'Could not read or save your playlists',
      }),
  })

/**
 * Answers with `value` encoded by `schema`, or with the failure's status and
 * message as plain text.
 */
const respond = <A, I, R>(
  schema: Schema.Codec<A, I>,
  handler: Effect.Effect<A, TvRouteError, R>,
) => {
  const encode = HttpServerResponse.schemaJson(schema)
  return handler.pipe(
    Effect.flatMap(value => encode(value)),
    Effect.catchTag('TvRouteError', error =>
      Effect.succeed(
        HttpServerResponse.text(error.message, { status: error.status }),
      ),
    ),
    Effect.catchTag('HttpBodyError', error =>
      Effect.logError('TV catalog could not encode a response', error).pipe(
        Effect.as(
          HttpServerResponse.text('Could not encode the response', {
            status: 500,
          }),
        ),
      ),
    ),
  )
}

/** A song that could not be had is YouTube's failure; a broken analysis is ours. */
const analysisRouteError = (error: AnalysisError): TvRouteError =>
  error.reason === 'AudioUnavailable'
    ? new TvRouteError({ status: 502, message: 'The song is unavailable' })
    : new TvRouteError({ status: 500, message: 'Could not analyze the song' })

// ROUTES

export const TvCatalogRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const youTubeMusic = yield* YouTubeMusic
    const playlistStore = yield* PlaylistStore
    const timedLyrics = yield* TimedLyrics
    const songAnalysis = yield* SongAnalysis
    const prefetcher = yield* Prefetcher

    /** The same page plans the RPCs make, so Play starts at once. */
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

    const home = Effect.gen(function* () {
      const [library, liked, recent] = yield* Effect.all(
        [
          playlistStore.library(),
          playlistStore.playlist(LIKED_PLAYLIST_ID),
          playlistStore.recentlyPlayed(HOME_HISTORY_DEPTH),
        ],
        { concurrency: 'unbounded' },
      )
      // A playlist deleted meanwhile just has no shelf.
      const playlists = yield* Effect.forEach(
        homePlaylists(library),
        playlist =>
          playlistStore.playlist(playlist.id).pipe(
            Effect.map(Option.some),
            Effect.catchTag('MusicNotFoundError', () =>
              Effect.succeed(Option.none()),
            ),
          ),
        { concurrency: 'unbounded' },
      )
      return homeShelves(
        library,
        liked.songs,
        recent,
        Array.getSomes(playlists),
      )
    }).pipe(Effect.mapError(toRouteError))

    const library = playlistStore.library().pipe(
      Effect.map((library): Tv.TvShelves => ({
        shelves: [yourPlaylistsShelf(library)],
      })),
      Effect.mapError(toRouteError),
    )

    const search = Effect.gen(function* () {
      const { q } = yield* HttpServerRequest.schemaSearchParams(
        SearchParams,
      ).pipe(Effect.mapError(badRequest('Search needs q')))
      const query = q.trim()
      const results = yield* Effect.all(
        {
          songs: youTubeMusic
            .searchSongs(query)
            .pipe(Effect.tap(songs => prepare(songs, 1, 2))),
          artists: youTubeMusic.searchArtists(query),
          albums: youTubeMusic.searchAlbums(query),
          playlists: youTubeMusic.searchPlaylists(query),
        },
        { concurrency: 'unbounded' },
      ).pipe(Effect.mapError(toRouteError))
      return searchShelves(results)
    })

    const collection = Effect.gen(function* () {
      const { kind, id } = yield* HttpServerRequest.schemaSearchParams(
        CollectionParams,
      ).pipe(
        Effect.mapError(
          badRequest(
            'A collection needs kind (Album, Playlist, MyPlaylist, or Artist) and id',
          ),
        ),
      )
      return yield* openCollection(kind, id).pipe(Effect.mapError(toRouteError))
    })

    const openCollection = (
      kind: Tv.TvCollectionKind,
      id: string,
    ): Effect.Effect<Tv.TvCollection, CatalogError> => {
      switch (kind) {
        case 'Album':
          return youTubeMusic.getAlbum(id).pipe(
            Effect.tap(details => prepare(details.tracks, 2, 3)),
            Effect.map(albumCollection),
          )
        case 'Playlist':
          return youTubeMusic.getPlaylist(id).pipe(
            Effect.tap(details => prepare(details.tracks, 2, 3)),
            Effect.map(playlistCollection),
          )
        case 'MyPlaylist':
          return playlistStore.playlist(id).pipe(
            Effect.tap(details => prepare(details.songs, 2, 3)),
            Effect.map(myPlaylistCollection),
          )
        case 'Artist':
          return youTubeMusic.getArtist(id).pipe(
            Effect.tap(details => prepare(details.topSongs, 2, 3)),
            Effect.map(artistCollection),
          )
      }
    }

    const videoId = HttpServerRequest.schemaSearchParams(VideoParams).pipe(
      Effect.map(({ videoId }) => videoId.trim()),
      Effect.mapError(badRequest('Needs videoId')),
    )

    const lyrics = Effect.gen(function* () {
      const id = yield* videoId
      return yield* youTubeMusic
        .getSong(id)
        .pipe(
          Effect.flatMap(timedLyrics.withTimedLines),
          Effect.map(lyricsOf),
          Effect.mapError(toRouteError),
        )
    })

    /** Waits for the song's analysis when it is not ready yet. */
    const analysis = Effect.gen(function* () {
      const { videoId: id } = yield* HttpServerRequest.schemaSearchParams(
        SongParams,
      ).pipe(Effect.mapError(badRequest('Needs a valid videoId')))
      return yield* songAnalysis.analysis(id).pipe(
        Effect.tapError(error =>
          Effect.logWarning('Analyzing a song failed', id, error.message),
        ),
        Effect.mapError(analysisRouteError),
      )
    })

    const liked = Effect.gen(function* () {
      const id = yield* videoId
      return yield* playlistStore.library().pipe(
        Effect.map(library => likedOf(library, id)),
        Effect.mapError(toRouteError),
      )
    })

    /**
     * The song with its album and artist links, so Liked songs shows it as
     * fully as a song liked on the phone. The queue's copy keeps the album
     * only by name, so it is the fallback when YouTube Music is slow.
     */
    const fullSong = (track: Session.QueueTrack) =>
      youTubeMusic.getSong(track.videoId).pipe(
        Effect.map(details => details.song),
        Effect.timeout(LIKE_LOOKUP_TIMEOUT),
        Effect.orElseSucceed(() => songFromQueueTrack(track)),
      )

    const like = Effect.gen(function* () {
      const request = yield* HttpServerRequest.schemaBodyJson(
        Tv.TvLikeRequest,
      ).pipe(Effect.mapError(badRequest('The body must be a TvLikeRequest')))
      const song = request.liked
        ? yield* fullSong(request.track)
        : songFromQueueTrack(request.track)
      const result = yield* playlistStore
        .edit({ _tag: 'SetLiked', song, isLiked: request.liked })
        .pipe(Effect.mapError(toRouteError))
      return likedOf(result.library, request.track.videoId)
    })

    yield* router.add('GET', '/tv/home', respond(Tv.TvShelves, home))
    yield* router.add('GET', '/tv/library', respond(Tv.TvShelves, library))
    yield* router.add('GET', '/tv/search', respond(Tv.TvShelves, search))
    yield* router.add(
      'GET',
      '/tv/collection',
      respond(Tv.TvCollection, collection),
    )
    yield* router.add('GET', '/tv/lyrics', respond(Tv.TvLyrics, lyrics))
    yield* router.add('GET', '/tv/analysis', respond(Tv.TvAnalysis, analysis))
    yield* router.add('GET', '/tv/liked', respond(Tv.TvLiked, liked))
    yield* router.add('POST', '/tv/like', respond(Tv.TvLiked, like))
  }),
)
