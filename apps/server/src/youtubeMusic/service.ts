import { Array, Context, Effect, Layer, Option, pipe } from 'effect'
import { Innertube, Log, YTNodes } from 'youtubei.js'

import {
  type AlbumDetails,
  type AlbumSummary,
  type ArtistDetails,
  type ArtistSummary,
  MusicNotFoundError,
  type Song,
  type SongDetails,
  YouTubeMusicError,
} from '@music/shared'

import {
  albumFromListItem,
  artistFromListItem,
  filterSome,
  songFromListItem,
  songFromPlaylistPanelVideo,
  toAlbumDetails,
  toArtistDetails,
  toLyrics,
} from './mapping.ts'

/**
 * Messages youtubei.js throws when an id points at nothing. YouTube does not
 * return a status code for these, so the message is the only signal.
 */
const NOT_FOUND_MESSAGES: ReadonlyArray<string> = [
  'No contents found in the response',
  'Music queue was empty',
  'This video is unavailable',
]

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : globalThis.String(cause)

const isNotFound = (cause: unknown): boolean =>
  Array.some(NOT_FOUND_MESSAGES, message =>
    errorMessage(cause).includes(message),
  )

const callYouTube = <A>(request: () => Promise<A>) =>
  Effect.tryPromise({
    try: request,
    catch: cause => new YouTubeMusicError({ message: errorMessage(cause) }),
  })

const lookUp = <A>(id: string, request: () => Promise<A>) =>
  Effect.tryPromise({
    try: request,
    catch: cause =>
      isNotFound(cause)
        ? new MusicNotFoundError({ id })
        : new YouTubeMusicError({ message: errorMessage(cause) }),
  })

const orNotFound =
  (id: string) =>
  <A>(maybeValue: Option.Option<A>) =>
    Option.match(maybeValue, {
      onNone: () => Effect.fail(new MusicNotFoundError({ id })),
      onSome: Effect.succeed,
    })

type SearchType = 'song' | 'artist' | 'album'

export interface YouTubeMusicShape {
  readonly searchSongs: (
    query: string,
  ) => Effect.Effect<ReadonlyArray<Song>, YouTubeMusicError>
  readonly searchArtists: (
    query: string,
  ) => Effect.Effect<ReadonlyArray<ArtistSummary>, YouTubeMusicError>
  readonly searchAlbums: (
    query: string,
  ) => Effect.Effect<ReadonlyArray<AlbumSummary>, YouTubeMusicError>
  readonly getSong: (
    videoId: string,
  ) => Effect.Effect<SongDetails, MusicNotFoundError | YouTubeMusicError>
  readonly getArtist: (
    artistId: string,
  ) => Effect.Effect<ArtistDetails, MusicNotFoundError | YouTubeMusicError>
  readonly getAlbum: (
    albumId: string,
  ) => Effect.Effect<AlbumDetails, MusicNotFoundError | YouTubeMusicError>
}

/** Read-only access to the YouTube Music catalog, mapped to shared Schemas. */
export class YouTubeMusic extends Context.Service<
  YouTubeMusic,
  YouTubeMusicShape
>()('YouTubeMusic') {}

const make = Effect.gen(function* () {
  yield* Effect.sync(() => Log.setLevel(Log.Level.ERROR))
  const innertube = yield* callYouTube(() =>
    Innertube.create({ retrieve_player: false, lang: 'en' }),
  )
  const music = innertube.music

  const searchShelf = (query: string, type: SearchType) =>
    callYouTube(() => music.search(query, { type })).pipe(
      Effect.map(search =>
        pipe(
          Option.fromNullishOr(
            search.contents?.firstOfType(YTNodes.MusicShelf),
          ),
          Option.match({
            onNone: () => [],
            onSome: shelf => shelf.contents,
          }),
        ),
      ),
    )

  const searchSongs = Effect.fn('YouTubeMusic.searchSongs')(function* (
    query: string,
  ) {
    const items = yield* searchShelf(query, 'song')
    return filterSome(items, songFromListItem)
  })

  const searchArtists = Effect.fn('YouTubeMusic.searchArtists')(function* (
    query: string,
  ) {
    const items = yield* searchShelf(query, 'artist')
    return filterSome(items, artistFromListItem)
  })

  const searchAlbums = Effect.fn('YouTubeMusic.searchAlbums')(function* (
    query: string,
  ) {
    const items = yield* searchShelf(query, 'album')
    return filterSome(items, albumFromListItem)
  })

  const getSong = Effect.fn('YouTubeMusic.getSong')(function* (
    videoId: string,
  ) {
    const [queue, info, maybeLyrics] = yield* Effect.all(
      [
        lookUp(videoId, () => music.getUpNext(videoId)),
        lookUp(videoId, () => music.getInfo(videoId)),
        callYouTube(() => music.getLyrics(videoId)).pipe(
          Effect.map(maybeShelf =>
            Option.flatMap(Option.fromNullishOr(maybeShelf), toLyrics),
          ),
          Effect.orElseSucceed(() => Option.none()),
        ),
      ],
      { concurrency: 'unbounded' },
    )

    const queueSongs = filterSome(queue.contents, item =>
      item.is(YTNodes.PlaylistPanelVideo)
        ? songFromPlaylistPanelVideo(item.as(YTNodes.PlaylistPanelVideo))
        : Option.none(),
    )

    const song = yield* pipe(
      Array.findFirst(queueSongs, ({ videoId: id }) => id === videoId),
      orNotFound(videoId),
    )

    return {
      song,
      maybeViewCount: Option.fromNullishOr(info.basic_info.view_count),
      maybeLyrics,
      relatedSongs: Array.filter(
        queueSongs,
        ({ videoId: id }) => id !== videoId,
      ),
    }
  })

  const getArtist = Effect.fn('YouTubeMusic.getArtist')(function* (
    artistId: string,
  ) {
    const page = yield* lookUp(artistId, () => music.getArtist(artistId))
    return yield* orNotFound(artistId)(toArtistDetails(artistId, page))
  })

  const getAlbum = Effect.fn('YouTubeMusic.getAlbum')(function* (
    albumId: string,
  ) {
    const page = yield* lookUp(albumId, () => music.getAlbum(albumId))
    return yield* orNotFound(albumId)(toAlbumDetails(albumId, page))
  })

  return YouTubeMusic.of({
    searchSongs,
    searchArtists,
    searchAlbums,
    getSong,
    getArtist,
    getAlbum,
  })
})

/** Opens one YouTube Music session for the life of the server. */
export const YouTubeMusicLive = Layer.effect(YouTubeMusic, make)
