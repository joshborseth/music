import { Array, Context, Duration, Effect, Layer, Option, pipe } from 'effect'
import {
  type Helpers,
  Innertube,
  Log,
  type YTMusic,
  YTNodes,
} from 'youtubei.js'

import {
  type AlbumDetails,
  type AlbumSummary,
  type ArtistDetails,
  type ArtistSummary,
  type HomeFeed,
  MusicNotFoundError,
  type PlaylistDetails,
  type PlaylistSummary,
  type Song,
  type SongDetails,
  YouTubeMusicError,
} from '@music/shared'

import {
  albumFromListItem,
  artistFromListItem,
  filterSome,
  homeShelfFromCarousel,
  playlistFromListItem,
  songFromListItem,
  songFromPlaylistPanelVideo,
  toAlbumDetails,
  toArtistDetails,
  toLyrics,
  toPlaylistDetails,
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

type SearchType = 'song' | 'artist' | 'album' | 'playlist'

type HomeFeedPage = YTMusic.HomeFeed

type PlaylistPage = YTMusic.Playlist

/**
 * YouTube sends a playlist about 100 songs at a time. Long ones are read up
 * to this many, so the page, Play, and Save a copy see the whole list.
 */
const MAX_PLAYLIST_SONGS = 500

/** The home feed changes slowly, and fetching it takes three round trips. */
const HOME_CACHE_TTL = Duration.minutes(15)

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
  readonly searchPlaylists: (
    query: string,
  ) => Effect.Effect<ReadonlyArray<PlaylistSummary>, YouTubeMusicError>
  readonly getSong: (
    videoId: string,
  ) => Effect.Effect<SongDetails, MusicNotFoundError | YouTubeMusicError>
  /** The songs YouTube Music would play after this one. */
  readonly getUpNext: (
    videoId: string,
  ) => Effect.Effect<
    ReadonlyArray<Song>,
    MusicNotFoundError | YouTubeMusicError
  >
  readonly getArtist: (
    artistId: string,
  ) => Effect.Effect<ArtistDetails, MusicNotFoundError | YouTubeMusicError>
  readonly getAlbum: (
    albumId: string,
  ) => Effect.Effect<AlbumDetails, MusicNotFoundError | YouTubeMusicError>
  readonly getPlaylist: (
    playlistId: string,
  ) => Effect.Effect<PlaylistDetails, MusicNotFoundError | YouTubeMusicError>
  readonly getHome: () => Effect.Effect<HomeFeed, YouTubeMusicError>
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

  const searchPlaylists = Effect.fn('YouTubeMusic.searchPlaylists')(function* (
    query: string,
  ) {
    const items = yield* searchShelf(query, 'playlist')
    return filterSome(items, playlistFromListItem)
  })

  const upNextSongs = (videoId: string) =>
    Effect.map(
      lookUp(videoId, () => music.getUpNext(videoId)),
      queue =>
        filterSome(queue.contents, item =>
          item.is(YTNodes.PlaylistPanelVideo)
            ? songFromPlaylistPanelVideo(item.as(YTNodes.PlaylistPanelVideo))
            : Option.none(),
        ),
    )

  const getUpNext = Effect.fn('YouTubeMusic.getUpNext')(function* (
    videoId: string,
  ) {
    const songs = yield* upNextSongs(videoId)
    return Array.filter(songs, ({ videoId: id }) => id !== videoId)
  })

  const getSong = Effect.fn('YouTubeMusic.getSong')(function* (
    videoId: string,
  ) {
    const [queueSongs, info, maybeLyrics] = yield* Effect.all(
      [
        upNextSongs(videoId),
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

  /** Reads on until the playlist ends; a page that fails ends it early. */
  const withLaterPages = (
    page: PlaylistPage,
    items: ReadonlyArray<Helpers.YTNode>,
  ): Effect.Effect<ReadonlyArray<Helpers.YTNode>> =>
    page.has_continuation && items.length < MAX_PLAYLIST_SONGS
      ? callYouTube(() => page.getContinuation()).pipe(
          Effect.matchEffect({
            onFailure: () => Effect.succeed(items),
            onSuccess: next => withLaterPages(next, [...items, ...next.items]),
          }),
        )
      : Effect.succeed(items)

  const getPlaylist = Effect.fn('YouTubeMusic.getPlaylist')(function* (
    playlistId: string,
  ) {
    const first = yield* lookUp(playlistId, () => music.getPlaylist(playlistId))
    const items = yield* withLaterPages(first, Array.fromIterable(first.items))
    return yield* orNotFound(playlistId)(
      toPlaylistDetails(playlistId, {
        header: first.header,
        items: Array.take(items, MAX_PLAYLIST_SONGS),
      }),
    )
  })

  /** The next page of the home feed, or nothing when it fails or ends. */
  const nextHomePage = (feed: HomeFeedPage) =>
    feed.has_continuation
      ? callYouTube(() => feed.getContinuation()).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none<HomeFeedPage>()),
        )
      : Effect.succeed(Option.none<HomeFeedPage>())

  const fetchHome = Effect.fn('YouTubeMusic.getHome')(function* () {
    const first = yield* callYouTube(() => music.getHomeFeed())
    const second = yield* nextHomePage(first)
    const third = yield* Option.match(second, {
      onNone: () => Effect.succeed(Option.none<HomeFeedPage>()),
      onSome: nextHomePage,
    })
    const pages = [first, ...Option.toArray(second), ...Option.toArray(third)]
    const carousels = filterSome(
      Array.flatMap(pages, page => page.sections ?? []),
      section =>
        section.is(YTNodes.MusicCarouselShelf)
          ? Option.some(section.as(YTNodes.MusicCarouselShelf))
          : Option.none(),
    )
    return { shelves: filterSome(carousels, homeShelfFromCarousel) }
  })

  const [cachedHome, forgetHome] = yield* Effect.cachedInvalidateWithTTL(
    fetchHome(),
    HOME_CACHE_TTL,
  )
  const getHome = () => cachedHome.pipe(Effect.tapError(() => forgetHome))

  return YouTubeMusic.of({
    searchSongs,
    searchArtists,
    searchAlbums,
    searchPlaylists,
    getSong,
    getUpNext,
    getArtist,
    getAlbum,
    getPlaylist,
    getHome,
  })
})

/** Opens one YouTube Music session for the life of the server. */
export const YouTubeMusicLive = Layer.effect(YouTubeMusic, make)
