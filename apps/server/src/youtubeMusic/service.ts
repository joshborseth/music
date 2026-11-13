import {
  Array,
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Record,
  Semaphore,
  pipe,
} from 'effect'
import { type Helpers, Innertube, Log, YTMusic, YTNodes } from 'youtubei.js'

import {
  type AlbumDetails,
  type AlbumSummary,
  type ArtistDetails,
  type ArtistSummary,
  type MoodDetails,
  type MoodGroup,
  MusicNotFoundError,
  type PlaylistDetails,
  type PlaylistSummary,
  type RadioStation,
  type ReleaseKind,
  type Song,
  type SongDetails,
  type TopResult,
  YouTubeMusicError,
} from '@music/shared'

import { MIX_SONGS, mixDetails, mixSeedOf } from '../home.ts'
import {
  ArtistShelfTitle,
  type DiscographyLink,
  type MoodShelf,
  type MusicVideo,
  type TopCard,
  type TopSong,
  albumFromListItem,
  artistFromListItem,
  audioTrackFor,
  audioTrackQuery,
  chooseTopResult,
  discographyLink,
  filterAlbumsForQuery,
  filterPlaylistsForQuery,
  filterSome,
  musicVideoIds,
  perceptualLoudnessOf,
  playlistFromListItem,
  playlistOwnerFromResponse,
  rankArtistsForQuery,
  rankSongsForQuery,
  releasesFromItems,
  songFromListItem,
  songFromPlaylistPanelVideo,
  suggestionsFrom,
  toAlbumDetails,
  toArtistDetails,
  toLyrics,
  toMoodDetails,
  toMoodGroups,
  toPlaylistDetails,
  topCardFrom,
  topCardSong,
  twoRowItemsOf,
} from './mapping.ts'

/**
 * Messages youtubei.js throws when an id points at nothing. YouTube does not
 * return a status code for these, so the message is the only signal. An id
 * of the wrong shape ("Invalid album id") points at nothing too: its page
 * says it is not there, not that YouTube Music is busy.
 */
const NOT_FOUND_MESSAGES: ReadonlyArray<string> = [
  'No contents found in the response',
  'Music queue was empty',
  'This video is unavailable',
  'Invalid album id',
  'Invalid artist id',
]

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : globalThis.String(cause)

export const isNotFound = (cause: unknown): boolean =>
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

type PlaylistPage = YTMusic.Playlist

/**
 * YouTube sends a playlist about 100 songs at a time. Long ones are read up
 * to this many, so the page, Play, and Save a copy see the whole list.
 */
const MAX_PLAYLIST_SONGS = 500

/**
 * A song search is kept this long. The top result looks through the same
 * search the web app asks for at the same moment, and this asks YouTube once.
 */
const SONG_SEARCH_TTL = Duration.minutes(1)
const SONG_SEARCH_CAPACITY = 64

/**
 * Suggestions for what is typed are kept this long. They come on every
 * letter typed, and change slowly.
 */
const SUGGESTIONS_TTL = Duration.minutes(30)
const SUGGESTIONS_CAPACITY = 1024

/**
 * An artist page is kept this long. Search reads an artist's top songs from
 * it, and Home the newest releases of every artist I follow.
 */
const ARTIST_PAGE_TTL = Duration.hours(1)
const ARTIST_PAGE_CAPACITY = 128

/**
 * How long search waits for the top artist's page before listing the song
 * search under it instead.
 */
const TOP_SONGS_WAIT = Duration.seconds(4)

/**
 * How long a song search waits for the top song's artist page, whose hits
 * it lists after the artist's matching songs. The page is kept for an hour.
 */
const ARTIST_HITS_WAIT = Duration.millis(1500)

/**
 * The song found for a music video is kept this long. The answer rarely
 * changes, and a playlist of videos asks for one per video.
 */
const AUDIO_TRACK_TTL = Duration.days(1)
const AUDIO_TRACK_CAPACITY = 4096

/** How many music videos are looked up at once. */
const AUDIO_TRACK_CONCURRENCY = 8

/**
 * How long a list waits for its music videos' songs. A playlist of 400
 * videos takes about 25 seconds to look up, so it opens with the songs found
 * by then, and the rest are ready the next time it opens.
 */
const AUDIO_TRACK_WAIT = Duration.seconds(4)

/**
 * What to do with a music video that has no song: a playlist someone chose
 * keeps it, and a radio, where it is only filler, leaves it out.
 */
type WithoutSong = 'Keep' | 'Drop'

/** A song's loudness figure doesn't change; a day keeps the cache small. */
const LOUDNESS_TTL = Duration.days(1)
const LOUDNESS_CAPACITY = 1024

const MOODS_AND_GENRES_BROWSE_ID = 'FEmusic_moods_and_genres'
const MOOD_BROWSE_ID = 'FEmusic_moods_and_genres_category'

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
  /** The card YouTube Music shows above its results, if it shows one. */
  readonly searchTopResult: (
    query: string,
  ) => Effect.Effect<Option.Option<TopResult>, YouTubeMusicError>
  /** What YouTube Music suggests searching for as this is typed. */
  readonly searchSuggestions: (
    query: string,
  ) => Effect.Effect<ReadonlyArray<string>, YouTubeMusicError>
  /** YouTube Music's moods and genres, in their groups. */
  readonly getMoodsAndGenres: () => Effect.Effect<
    ReadonlyArray<MoodGroup>,
    YouTubeMusicError
  >
  readonly getMood: (
    params: string,
  ) => Effect.Effect<MoodDetails, MusicNotFoundError | YouTubeMusicError>
  readonly getSong: (
    videoId: string,
  ) => Effect.Effect<SongDetails, MusicNotFoundError | YouTubeMusicError>
  /**
   * The songs YouTube Music's radio would play after this one, for
   * autoplay and the phone Home's "More like" shelf.
   */
  readonly getUpNext: (
    videoId: string,
  ) => Effect.Effect<
    ReadonlyArray<Song>,
    MusicNotFoundError | YouTubeMusicError
  >
  /**
   * How long a song is, for songs that came without one. YouTube's "up next"
   * list for a song starts with the song itself, with its length.
   */
  readonly getDurationSeconds: (
    videoId: string,
  ) => Effect.Effect<Option.Option<number>, YouTubeMusicError>
  readonly getArtist: (
    artistId: string,
  ) => Effect.Effect<ArtistDetails, MusicNotFoundError | YouTubeMusicError>
  /**
   * The artist page alone, kept for an hour: the few releases it lists
   * stand in for the full discography `getArtist` reads.
   */
  readonly getArtistOverview: (
    artistId: string,
  ) => Effect.Effect<ArtistDetails, MusicNotFoundError | YouTubeMusicError>
  readonly getAlbum: (
    albumId: string,
  ) => Effect.Effect<AlbumDetails, MusicNotFoundError | YouTubeMusicError>
  readonly getPlaylist: (
    playlistId: string,
  ) => Effect.Effect<PlaylistDetails, MusicNotFoundError | YouTubeMusicError>
  /**
   * The song a music video is of (`audioTrackFor`), from a song search kept
   * for a day. None when there is none, or YouTube did not answer.
   */
  readonly getSongForVideo: (
    video: MusicVideo,
  ) => Effect.Effect<Option.Option<Song>>
  /** The songs an artist's or album's radio plays, in its order. */
  readonly getRadio: (
    station: RadioStation,
  ) => Effect.Effect<
    ReadonlyArray<Song>,
    MusicNotFoundError | YouTubeMusicError
  >
  /**
   * YouTube's loudness figure for a song, in LUFS (`perceptualLoudnessOf`),
   * kept for a day: Sound Check's guess until the server has measured the
   * song itself. None when YouTube gives none.
   */
  readonly getLoudnessLufs: (
    videoId: string,
  ) => Effect.Effect<Option.Option<number>, YouTubeMusicError>
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

  const searchCacheOptions = {
    capacity: SONG_SEARCH_CAPACITY,
    timeToLive: Exit.match({
      onFailure: () => Duration.zero,
      onSuccess: () => SONG_SEARCH_TTL,
    }),
  }

  /** A song search in YouTube's order. */
  const songShelves = yield* Cache.makeWith(
    (query: string) =>
      Effect.map(searchShelf(query, 'song'), items =>
        filterSome(items, songFromListItem),
      ),
    searchCacheOptions,
  )

  /** The card YouTube Music shows above its results, as it shows it. */
  const topCards = yield* Cache.makeWith(
    (query: string) =>
      Effect.map(
        callYouTube(() => music.search(query)),
        search =>
          Option.flatMap(
            Option.fromNullishOr(
              search.contents?.firstOfType(YTNodes.MusicCardShelf),
            ),
            topCardFrom,
          ),
      ),
    searchCacheOptions,
  )

  /** An artist search, ranked and without unknown namesakes. */
  const artistSearches = yield* Cache.makeWith(
    (query: string) =>
      Effect.map(searchShelf(query, 'artist'), items =>
        rankArtistsForQuery(query, filterSome(items, artistFromListItem)),
      ),
    searchCacheOptions,
  )

  const suggestions = yield* Cache.makeWith(
    (query: string) =>
      Effect.map(
        callYouTube(() => music.getSearchSuggestions(query)),
        sections =>
          suggestionsFrom(
            Array.flatMap(sections, section =>
              Array.fromIterable(section.contents),
            ),
          ),
      ),
    {
      capacity: SUGGESTIONS_CAPACITY,
      timeToLive: Exit.match({
        onFailure: () => Duration.zero,
        onSuccess: () => SUGGESTIONS_TTL,
      }),
    },
  )

  /** The card, or none when the search for it fails. */
  const topCardOf = (query: string) =>
    Cache.get(topCards, query).pipe(
      Effect.orElseSucceed(() => Option.none<TopCard>()),
    )

  const audioTrackSearches = yield* Semaphore.make(AUDIO_TRACK_CONCURRENCY)

  /** The song a music video is of, from a song search for its words. */
  const audioTracks = yield* Cache.makeWith(
    (video: MusicVideo) =>
      Effect.map(searchShelf(audioTrackQuery(video), 'song'), items =>
        audioTrackFor(video, filterSome(items, songFromListItem)),
      ).pipe(audioTrackSearches.withPermits(1)),
    {
      capacity: AUDIO_TRACK_CAPACITY,
      timeToLive: Exit.match({
        onFailure: () => Duration.zero,
        onSuccess: () => AUDIO_TRACK_TTL,
      }),
    },
  )

  const audioTrackOf = (song: MusicVideo): Effect.Effect<Option.Option<Song>> =>
    Cache.get(audioTracks, {
      videoId: song.videoId,
      title: song.title,
      artists: song.artists,
    }).pipe(Effect.orElseSucceed(() => Option.none<Song>()))

  /**
   * Each song, with the song it is of when it is a music video and it was
   * found within `AUDIO_TRACK_WAIT`. Lookups still running carry on, so the
   * cache has them next time.
   */
  const withAudioTracks = (
    songs: ReadonlyArray<Song>,
    videoIds: ReadonlySet<string>,
  ): Effect.Effect<
    ReadonlyArray<Readonly<{ song: Song; maybeTrack: Option.Option<Song> }>>
  > =>
    Effect.forEach(songs, song =>
      videoIds.has(song.videoId)
        ? Effect.map(Effect.forkDetach(audioTrackOf(song)), lookup =>
            Fiber.join(lookup).pipe(
              Effect.timeoutOption(AUDIO_TRACK_WAIT),
              Effect.map(maybeFound => ({
                song,
                maybeTrack: Option.flatten(maybeFound),
              })),
            ),
          )
        : Effect.succeed(
            Effect.succeed({ song, maybeTrack: Option.none<Song>() }),
          ),
    ).pipe(
      Effect.flatMap(waits => Effect.all(waits, { concurrency: 'unbounded' })),
    )

  /**
   * Songs, with each music video among them (`videoIds`) swapped for the
   * song it is of: the album audio, which plays without the video's intro
   * and skits and shows the album cover. This app plays songs, not videos.
   */
  const songsNotVideos = (
    songs: ReadonlyArray<Song>,
    videoIds: ReadonlySet<string>,
    withoutSong: WithoutSong,
  ): Effect.Effect<ReadonlyArray<Song>> =>
    videoIds.size === 0
      ? Effect.succeed(songs)
      : Effect.map(withAudioTracks(songs, videoIds), found =>
          Array.dedupeWith(
            Array.flatMap(found, ({ song, maybeTrack }) =>
              Option.match(maybeTrack, {
                onNone: () =>
                  withoutSong === 'Keep' || !videoIds.has(song.videoId)
                    ? [song]
                    : [],
                onSome: track => [track],
              }),
            ),
            (left, right) => left.videoId === right.videoId,
          ),
        )

  const searchArtists = Effect.fn('YouTubeMusic.searchArtists')(function* (
    query: string,
  ) {
    return yield* Cache.get(artistSearches, query)
  })

  /**
   * Releases, without karaoke, tributes, and other artists' singles of the
   * top result's song, which the card tells.
   */
  const searchAlbums = Effect.fn('YouTubeMusic.searchAlbums')(function* (
    query: string,
  ) {
    const [items, maybeCard] = yield* Effect.all(
      [searchShelf(query, 'album'), topCardOf(query)],
      { concurrency: 'unbounded' },
    )
    return filterAlbumsForQuery(
      query,
      filterSome(items, albumFromListItem),
      Option.flatMap(maybeCard, card => topCardSong(query, card)),
    )
  })

  const searchPlaylists = Effect.fn('YouTubeMusic.searchPlaylists')(function* (
    query: string,
  ) {
    const items = yield* searchShelf(query, 'playlist')
    return filterPlaylistsForQuery(
      query,
      filterSome(items, playlistFromListItem),
    )
  })

  const searchSuggestions = Effect.fn('YouTubeMusic.searchSuggestions')(
    function* (query: string) {
      const typed = query.trim().toLowerCase()
      return typed === '' ? [] : yield* Cache.get(suggestions, typed)
    },
  )

  /** An artist's top songs as songs, each keeping its play count. */
  const topSongsNotVideos = (page: YTMusic.Artist, details: ArtistDetails) =>
    Effect.map(
      withAudioTracks(
        details.topSongs,
        musicVideoIds(
          Array.flatMap(page.sections, section =>
            section.is(YTNodes.MusicShelf)
              ? Array.fromIterable(section.as(YTNodes.MusicShelf).contents)
              : [],
          ),
        ),
      ),
      (found): ArtistDetails => {
        const songs = Array.map(found, ({ song, maybeTrack }) => ({
          song: Option.getOrElse(maybeTrack, () => song),
          maybePlays: Record.get(details.topSongPlays, song.videoId),
        }))
        return {
          ...details,
          topSongs: Array.dedupeWith(
            Array.map(songs, ({ song }) => song),
            (left, right) => left.videoId === right.videoId,
          ),
          topSongPlays: Record.fromEntries(
            Array.flatMap(songs, ({ song, maybePlays }) =>
              Option.match(maybePlays, {
                onNone: () => [],
                onSome: plays => [[song.videoId, plays] as const],
              }),
            ),
          ),
        }
      },
    )

  const artistPages = yield* Cache.makeWith(
    (artistId: string) =>
      Effect.gen(function* () {
        const page = yield* lookUp(artistId, () => music.getArtist(artistId))
        const details = yield* orNotFound(artistId)(
          toArtistDetails(artistId, page),
        )
        return { page, details: yield* topSongsNotVideos(page, details) }
      }),
    {
      capacity: ARTIST_PAGE_CAPACITY,
      timeToLive: Exit.match({
        onFailure: () => Duration.zero,
        onSuccess: () => ARTIST_PAGE_TTL,
      }),
    },
  )

  const getArtistOverview = Effect.fn('YouTubeMusic.getArtistOverview')(
    function* (artistId: string) {
      const { details } = yield* Cache.get(artistPages, artistId)
      return details
    },
  )

  /**
   * An artist's most played songs, or none if their page takes longer than
   * `wait`. A slow page carries on loading, so the cache has it next time.
   */
  const topSongsOf = (artistId: string, wait: Duration.Duration) =>
    Effect.forkDetach(getArtistOverview(artistId)).pipe(
      Effect.flatMap(Fiber.join),
      Effect.map(({ topSongs }) => topSongs),
      Effect.timeoutOption(wait),
      Effect.map(Option.getOrElse((): ReadonlyArray<Song> => [])),
      Effect.orElseSucceed((): ReadonlyArray<Song> => []),
    )

  /**
   * The song YouTube Music's top result is, with its artist's hits, which a
   * song search ranks by.
   */
  const topSongFor = (query: string) =>
    Effect.gen(function* () {
      const maybeSong = Option.flatMap(yield* topCardOf(query), card =>
        topCardSong(query, card),
      )
      if (Option.isNone(maybeSong)) return Option.none<TopSong>()
      const song = maybeSong.value
      const maybeArtistId = pipe(
        Array.findFirst(song.artists, ({ maybeId }) => Option.isSome(maybeId)),
        Option.flatMap(({ maybeId }) => maybeId),
      )
      const artistSongs = Option.isSome(maybeArtistId)
        ? yield* topSongsOf(maybeArtistId.value, ARTIST_HITS_WAIT)
        : []
      return Option.some<TopSong>({ song, artistSongs })
    })

  const songSearches = yield* Cache.makeWith(
    (query: string) =>
      Effect.map(
        Effect.all([Cache.get(songShelves, query), topSongFor(query)], {
          concurrency: 'unbounded',
        }),
        ([songs, maybeTop]) => rankSongsForQuery(query, songs, maybeTop),
      ),
    searchCacheOptions,
  )

  const searchSongs = Effect.fn('YouTubeMusic.searchSongs')(function* (
    query: string,
  ) {
    return yield* Cache.get(songSearches, query)
  })

  /**
   * YouTube Music's card, made a song when it is a music video, left out
   * when it is no song, and given way to the artist the search names
   * (`chooseTopResult`). An artist comes with their most played songs.
   */
  const searchTopResult = Effect.fn('YouTubeMusic.searchTopResult')(function* (
    query: string,
  ) {
    const [maybeCard, songs, artists] = yield* Effect.all(
      [
        Cache.get(topCards, query),
        Cache.get(songShelves, query).pipe(
          Effect.orElseSucceed((): ReadonlyArray<Song> => []),
        ),
        Cache.get(artistSearches, query).pipe(
          Effect.orElseSucceed((): ReadonlyArray<ArtistSummary> => []),
        ),
      ],
      { concurrency: 'unbounded' },
    )
    const maybeTopResult = chooseTopResult(query, maybeCard, songs, artists)
    if (Option.isNone(maybeTopResult)) return maybeTopResult
    const topResult = maybeTopResult.value
    if (topResult._tag !== 'Artist') return maybeTopResult
    const topSongs = yield* topSongsOf(topResult.artist.id, TOP_SONGS_WAIT)
    return Option.some({ ...topResult, topSongs })
  })

  const getMoodsAndGenres = Effect.fn('YouTubeMusic.getMoodsAndGenres')(
    function* () {
      const response = yield* callYouTube(() =>
        innertube.actions.execute('/browse', {
          browseId: MOODS_AND_GENRES_BROWSE_ID,
          client: 'YTMUSIC',
        }),
      )
      return yield* Option.match(toMoodGroups(response.data), {
        onNone: () =>
          Effect.fail(
            new YouTubeMusicError({
              message: 'The moods and genres page changed shape',
            }),
          ),
        onSome: Effect.succeed,
      })
    },
  )

  const getMood = Effect.fn('YouTubeMusic.getMood')(function* (params: string) {
    const response = yield* lookUp(params, () =>
      innertube.actions.execute('/browse', {
        browseId: MOOD_BROWSE_ID,
        params,
        client: 'YTMUSIC',
        parse: true,
      }),
    )
    const carousels: ReadonlyArray<MoodShelf> = Array.map(
      response.contents_memo?.getType(YTNodes.MusicCarouselShelf) ?? [],
      carousel => ({
        title: carousel.header?.title.toString().trim() ?? '',
        items: carousel.contents,
      }),
    )
    const grids: ReadonlyArray<MoodShelf> = Array.map(
      response.contents_memo?.getType(YTNodes.Grid) ?? [],
      grid => ({
        title: pipe(
          Option.fromNullishOr(grid.header),
          Option.filter(header => header.is(YTNodes.GridHeader)),
          Option.map(header =>
            header.as(YTNodes.GridHeader).title.toString().trim(),
          ),
          Option.getOrElse(() => ''),
        ),
        items: grid.items,
      }),
    )
    const maybeTitle = pipe(
      Option.fromNullishOr(response.header_memo?.getType(YTNodes.MusicHeader)),
      Option.flatMap(Array.head),
      Option.flatMap(header => Option.fromNullishOr(header.title)),
      Option.map(title => title.toString().trim()),
    )
    const shelves = [...carousels, ...grids]
    const moodPage = toMoodDetails({
      title: Option.getOrElse(maybeTitle, () => ''),
      shelves,
    })
    const details = {
      ...moodPage,
      songs: yield* songsNotVideos(
        moodPage.songs,
        musicVideoIds(Array.flatMap(shelves, ({ items }) => items)),
        'Keep',
      ),
    }
    return Array.isReadonlyArrayEmpty(details.playlistShelves) &&
      Array.isReadonlyArrayEmpty(details.songs)
      ? yield* Effect.fail(new MusicNotFoundError({ id: params }))
      : details
  })

  const queueSongs = (contents: ReadonlyArray<Helpers.YTNode>) =>
    filterSome(contents, item =>
      item.is(YTNodes.PlaylistPanelVideo)
        ? songFromPlaylistPanelVideo(item.as(YTNodes.PlaylistPanelVideo))
        : Option.none(),
    )

  /** YouTube's "up next" for a song, as it sends it: the song comes first. */
  const upNextSongs = (videoId: string) =>
    Effect.map(
      lookUp(videoId, () => music.getUpNext(videoId)),
      queue => queueSongs(queue.contents),
    )

  /**
   * YouTube Music's radio after a song, as songs. The radio follows its
   * seed: one started from a music video plays music videos, so a video is
   * swapped for its song first. `seedId` is the song the radio started
   * from, which leads the list.
   */
  const songRadio = (videoId: string) =>
    Effect.gen(function* () {
      const queue = yield* lookUp(videoId, () => music.getUpNext(videoId))
      const songs = queueSongs(queue.contents)
      const videoIds = musicVideoIds(queue.contents)
      const maybeSeedTrack = videoIds.has(videoId)
        ? yield* pipe(
            Array.findFirst(songs, ({ videoId: id }) => id === videoId),
            Option.match({
              onNone: () => Effect.succeed(Option.none<Song>()),
              onSome: audioTrackOf,
            }),
          )
        : Option.none<Song>()
      if (Option.isNone(maybeSeedTrack)) {
        return {
          seedId: videoId,
          songs: yield* songsNotVideos(songs, videoIds, 'Drop'),
        }
      }
      const seedId = maybeSeedTrack.value.videoId
      const trackQueue = yield* lookUp(seedId, () => music.getUpNext(seedId))
      return {
        seedId,
        songs: yield* songsNotVideos(
          queueSongs(trackQueue.contents),
          musicVideoIds(trackQueue.contents),
          'Drop',
        ),
      }
    })

  const getUpNext = Effect.fn('YouTubeMusic.getUpNext')(function* (
    videoId: string,
  ) {
    const { seedId, songs } = yield* songRadio(videoId)
    // The seed, or the song it became, is playing already.
    return Array.filter(
      songs,
      ({ videoId: id }) => id !== videoId && id !== seedId,
    )
  })

  const getDurationSeconds = Effect.fn('YouTubeMusic.getDurationSeconds')(
    function* (videoId: string) {
      const songs = yield* upNextSongs(videoId).pipe(
        Effect.catchTag('MusicNotFoundError', () => Effect.succeed([])),
      )
      return pipe(
        Array.findFirst(songs, ({ videoId: id }) => id === videoId),
        Option.flatMap(({ maybeDurationSeconds }) => maybeDurationSeconds),
      )
    },
  )

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
    }
  })

  /**
   * Every release of one kind, from the discography page behind a release
   * carousel's "More". None when it can't be read; the carousel's own
   * releases stand in.
   */
  const discography = (
    link: DiscographyLink,
    artist: Readonly<{ id: string; name: string }>,
    defaultKind: Option.Option<ReleaseKind>,
  ): Effect.Effect<Option.Option<ReadonlyArray<AlbumSummary>>> =>
    callYouTube(() =>
      innertube.actions.execute('/browse', {
        browseId: link.browseId,
        params: link.params,
        client: 'YTMUSIC',
        parse: true,
      }),
    ).pipe(
      Effect.map(response =>
        pipe(
          releasesFromItems(
            artist,
            twoRowItemsOf(
              Array.flatMap(
                response.contents_memo?.getType(YTNodes.Grid) ?? [],
                grid => grid.items,
              ),
            ),
            defaultKind,
          ),
          Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
        ),
      ),
      Effect.orElseSucceed(() => Option.none()),
    )

  const getArtist = Effect.fn('YouTubeMusic.getArtist')(function* (
    artistId: string,
  ) {
    const { page, details } = yield* Cache.get(artistPages, artistId)
    const artist = { id: artistId, name: details.artist.name }
    const fullList = (
      title: string,
      shown: ReadonlyArray<AlbumSummary>,
      defaultKind: Option.Option<ReleaseKind>,
    ) =>
      Option.match(discographyLink(page, title), {
        onNone: () => Effect.succeed(shown),
        onSome: link =>
          Effect.map(discography(link, artist, defaultKind), maybeAll =>
            Option.getOrElse(maybeAll, () => shown),
          ),
      })
    const [albums, singles] = yield* Effect.all(
      [
        fullList(ArtistShelfTitle.Albums, details.albums, Option.some('Album')),
        fullList(ArtistShelfTitle.Singles, details.singles, Option.none()),
      ],
      { concurrency: 'unbounded' },
    )
    return { ...details, albums, singles }
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

  /** A mix made on Home: the seed song, then its radio. */
  const getMix = (playlistId: string, seedVideoId: string) =>
    songRadio(seedVideoId).pipe(
      Effect.flatMap(({ songs }) =>
        orNotFound(playlistId)(
          mixDetails(seedVideoId, Array.take(songs, MIX_SONGS)),
        ),
      ),
    )

  const getPlaylist = Effect.fn('YouTubeMusic.getPlaylist')(function* (
    playlistId: string,
  ) {
    const maybeMixSeed = mixSeedOf(playlistId)
    if (Option.isSome(maybeMixSeed)) {
      return yield* getMix(playlistId, maybeMixSeed.value)
    }
    // NOTE: the page is fetched raw, as `music.getPlaylist` does, because
    // the parsed header leaves out who made the playlist.
    const response = yield* lookUp(playlistId, () =>
      innertube.actions.execute('/browse', {
        browseId: playlistId.startsWith('VL') ? playlistId : `VL${playlistId}`,
        client: 'YTMUSIC',
      }),
    )
    const first = yield* lookUp(
      playlistId,
      async () => new YTMusic.Playlist(response, innertube.actions),
    )
    const items = Array.take(
      yield* withLaterPages(first, Array.fromIterable(first.items)),
      MAX_PLAYLIST_SONGS,
    )
    const details = yield* orNotFound(playlistId)(
      toPlaylistDetails(playlistId, {
        header: first.header,
        items,
        maybeOwner: playlistOwnerFromResponse(response.data),
      }),
    )
    return {
      ...details,
      tracks: yield* songsNotVideos(
        details.tracks,
        musicVideoIds(items),
        'Keep',
      ),
    }
  })

  const getRadio = Effect.fn('YouTubeMusic.getRadio')(function* (
    station: RadioStation,
  ) {
    const response = yield* lookUp(station.playlistId, () =>
      innertube.actions.execute('/next', {
        playlistId: station.playlistId,
        ...Option.match(station.maybeParams, {
          onNone: () => ({}),
          onSome: params => ({ params }),
        }),
        ...Option.match(station.maybeVideoId, {
          onNone: () => ({}),
          onSome: videoId => ({ videoId }),
        }),
        client: 'YTMUSIC',
        parse: true,
      }),
    )
    const contents = Array.flatMap(
      response.contents_memo?.getType(YTNodes.PlaylistPanel) ?? [],
      panel => Array.fromIterable(panel.contents),
    )
    const songs = yield* songsNotVideos(
      queueSongs(contents),
      musicVideoIds(contents),
      'Drop',
    )
    return Array.isReadonlyArrayEmpty(songs)
      ? yield* Effect.fail(new MusicNotFoundError({ id: station.playlistId }))
      : Array.dedupeWith(songs, (left, right) => left.videoId === right.videoId)
  })

  // NOTE: the iOS client's player response carries the loudness; YouTube
  // Music's own (YTMUSIC) refuses to play signed out and has none.
  const loudnesses = yield* Cache.makeWith(
    (videoId: string) =>
      callYouTube(() =>
        innertube.actions.execute('/player', {
          videoId,
          client: 'IOS',
          parse: false,
        }),
      ).pipe(Effect.map(response => perceptualLoudnessOf(response.data))),
    {
      capacity: LOUDNESS_CAPACITY,
      timeToLive: Exit.match({
        onFailure: () => Duration.zero,
        onSuccess: () => LOUDNESS_TTL,
      }),
    },
  )

  return YouTubeMusic.of({
    searchSongs,
    searchArtists,
    searchAlbums,
    searchPlaylists,
    searchTopResult,
    searchSuggestions,
    getMoodsAndGenres,
    getMood,
    getSong,
    getUpNext,
    getDurationSeconds,
    getArtist,
    getArtistOverview,
    getAlbum,
    getPlaylist,
    getSongForVideo: audioTrackOf,
    getRadio,
    getLoudnessLufs: videoId => Cache.get(loudnesses, videoId),
  })
})

/** Opens one YouTube Music session for the life of the server. */
export const YouTubeMusicLive = Layer.effect(YouTubeMusic, make)
