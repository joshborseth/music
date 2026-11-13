import { Array, Match, Option, String } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder, createKeyedLazy, createLazy } from 'foldkit/html'
import {
  CircleX,
  Disc3,
  History,
  ListMusic,
  LoaderCircle,
  Pause,
  Play,
  Search,
  User,
} from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  type AlbumSummary,
  type ArtistSummary,
  type Artwork,
  type MoodCategory,
  type MoodGroup,
  type PlaylistSummary,
  type Session,
  type Song,
  type TopResult,
} from '@music/shared'

import { textToneOn, tileColors } from '../color'
import {
  SEARCH_BAR_ATTRIBUTE,
  SEARCH_INPUT_ID,
  SEARCH_RESULTS_ATTRIBUTE,
} from '../constant'
import { Message } from '../message'
import { WaitBeforeTopShelves } from '../mount'
import {
  type RequestError,
  albumSearchQuery,
  artistSearchQuery,
  moodGroupsQuery,
  playlistSearchQuery,
  songSearchQuery,
  topResultSearchQuery,
} from '../query'
import { SEARCH_KINDS, type SearchKind, moodRouter } from '../route'
import { shownSuggestions, suggestionQuery } from '../suggestions'
import { isSearchSettled, routeQuery, routeSearchKind } from '../update'
import { largeTitle, statusBarCover } from './chrome'
import { type PageModel } from './page'
import {
  ArtworkShape,
  type NowPlaying,
  type SectionAction,
  albumCard,
  albumHref,
  albumRow,
  artistCard,
  artistHref,
  artistNames,
  artistRow,
  artworkImage,
  emptyState,
  equalizer,
  joinDetails,
  list,
  loadingRows,
  playlistCard,
  playlistHref,
  playlistRow,
  remote,
  requestErrorAlert,
  section,
  sectionWithAction,
  shelf,
  songList,
} from './shared'

// SEARCH BAR

/** The search box. Its magnifier turns into a spinner while a search loads. */
const searchField = (
  model: PageModel,
  isSearching: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [
      h.OnSubmit(Message.SubmittedSearch()),
      h.Role('search'),
      h.Class('relative flex-1'),
    ],
    [
      h.label([h.For(SEARCH_INPUT_ID), h.Class('sr-only')], ['Search music']),
      h.span(
        [
          h.Class(
            'text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2',
          ),
        ],
        [
          isSearching
            ? h.span(
                [h.Role('status'), h.AriaLabel('Searching')],
                [icon(h, LoaderCircle, 'size-[18px] animate-spin')],
              )
            : icon(h, Search, 'size-[18px]'),
        ],
      ),
      h.input([
        h.Id(SEARCH_INPUT_ID),
        h.Type('search'),
        h.Value(model.searchInput),
        h.Placeholder('Songs, artists, albums, playlists'),
        h.Autocomplete('off'),
        h.Attribute('autocorrect', 'off'),
        h.Attribute('autocapitalize', 'off'),
        h.Spellcheck(false),
        h.Attribute('enterkeyhint', 'search'),
        h.OnInput(value => Message.UpdatedSearchInput({ value })),
        h.Class(
          'bg-muted placeholder:text-muted-foreground h-10 w-full rounded-xl pr-9 pl-9 text-[17px] outline-none [&::-webkit-search-cancel-button]:hidden',
        ),
      ]),
      model.searchInput.length > 0
        ? h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedClearSearch()),
              h.AriaLabel('Clear search'),
              h.Class(
                'text-muted-foreground absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center active:opacity-50',
              ),
            ],
            [icon(h, CircleX, 'size-[18px] fill-current stroke-background')],
          )
        : h.empty,
    ],
  )

const kindPicker = (selectedKind: SearchKind, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('tablist'),
      h.AriaLabel('Search in'),
      h.Class('bg-muted grid h-8 grid-cols-5 rounded-[9px] p-0.5'),
    ],
    Array.map(SEARCH_KINDS, kind =>
      h.button(
        [
          h.Type('button'),
          h.Role('tab'),
          h.AriaSelected(kind === selectedKind),
          h.OnClick(Message.SelectedSearchKind({ kind })),
          h.Class(
            cn(
              'rounded-[7px] text-[13px] font-semibold transition-all duration-200',
              kind === selectedKind
                ? 'bg-background text-foreground shadow-sm dark:bg-accent'
                : 'text-muted-foreground',
            ),
          ),
        ],
        [kind],
      ),
    ),
  )

const stickySearchBar = (
  model: PageModel,
  kind: SearchKind,
  isSearching: boolean,
  hasTyped: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.DataAttribute(SEARCH_BAR_ATTRIBUTE, ''),
      h.Class(
        'search-bar-edge sticky top-[var(--safe-top)] z-[31] -mb-1.5 flex flex-col gap-2.5 px-4 pt-1 pb-4',
      ),
    ],
    [
      searchField(model, isSearching, h),
      hasTyped || Option.isSome(routeQuery(model.route))
        ? kindPicker(kind, h)
        : h.empty,
    ],
  )

// TOP RESULT

const TOP_RESULT_ARTWORK_WIDTH = 96

type TopResultParts = Readonly<{
  title: string
  kindLabel: string
  details: string
  artwork: Artwork
  shape: (typeof ArtworkShape)[keyof typeof ArtworkShape]
  placeholderIcon: typeof User
}>

const topResultParts = (topResult: TopResult): TopResultParts =>
  Match.valueTags(topResult, {
    Artist: ({ artist }) => ({
      title: artist.name,
      kindLabel: 'Artist',
      details: Option.getOrElse(artist.maybeAudience, () => ''),
      artwork: artist.artwork,
      shape: ArtworkShape.Round,
      placeholderIcon: User,
    }),
    Album: ({ album }) => ({
      title: album.title,
      kindLabel: Option.getOrElse(album.maybeKind, () => 'Album'),
      details: joinDetails([
        artistNames(album.artists),
        Option.getOrElse(album.maybeYear, () => ''),
      ]),
      artwork: album.artwork,
      shape: ArtworkShape.Card,
      placeholderIcon: Disc3,
    }),
    Song: ({ song }) => ({
      title: song.title,
      kindLabel: 'Song',
      details: artistNames(song.artists),
      artwork: song.artwork,
      shape: ArtworkShape.Card,
      placeholderIcon: ListMusic,
    }),
    Playlist: ({ playlist }) => ({
      title: playlist.title,
      kindLabel: 'Playlist',
      details: Option.getOrElse(playlist.maybeSubtitle, () => ''),
      artwork: playlist.artwork,
      shape: ArtworkShape.Card,
      placeholderIcon: ListMusic,
    }),
  })

const topResultCardClass =
  'pressable bg-secondary mx-4 flex items-center gap-4 rounded-2xl p-3 text-left'

/**
 * Whether the top result is a song, and if so whether it is the one playing:
 * the card then marks it as song rows do and pauses or resumes it.
 */
type TopResultPlayback = 'NotASong' | 'Ready' | 'Playing' | 'Paused'

const topResultPlayback = (
  topResult: TopResult,
  playing: NowPlaying,
): TopResultPlayback => {
  if (topResult._tag !== 'Song') {
    return 'NotASong'
  } else if (!Option.contains(playing.maybeVideoId, topResult.song.videoId)) {
    return 'Ready'
  } else {
    return playing.isPlaying ? 'Playing' : 'Paused'
  }
}

const topResultContent = (
  parts: TopResultParts,
  playback: TopResultPlayback,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  h.span(
    [h.Class('relative shrink-0')],
    [
      artworkImage(
        {
          artwork: parts.artwork,
          displayWidth: TOP_RESULT_ARTWORK_WIDTH,
          shape: parts.shape,
          className: 'size-24',
          placeholderIcon: parts.placeholderIcon,
          isEager: true,
        },
        h,
      ),
      playback === 'Playing' || playback === 'Paused'
        ? h.span(
            [
              h.Class(
                cn(
                  'absolute inset-0 flex items-center justify-center bg-black/45 text-white',
                  parts.shape,
                ),
              ),
            ],
            [equalizer(playback === 'Playing', 'h-5 [&>*]:w-1', h)],
          )
        : h.empty,
    ],
  ),
  h.span(
    [h.Class('flex min-w-0 flex-1 flex-col gap-1')],
    [
      h.span(
        [
          h.Class(
            'line-clamp-2 text-[22px] leading-tight font-bold tracking-tight',
          ),
        ],
        [parts.title],
      ),
      h.span(
        [
          h.Class(
            'text-muted-foreground line-clamp-2 text-[13px] leading-snug',
          ),
        ],
        [joinDetails([parts.kindLabel, parts.details])],
      ),
    ],
  ),
  playback === 'NotASong'
    ? h.empty
    : h.span(
        [
          h.AriaHidden(true),
          h.Class(
            'bg-brand text-brand-foreground flex size-11 shrink-0 items-center justify-center rounded-full',
          ),
        ],
        [
          playback === 'Playing'
            ? icon(h, Pause, 'size-5 fill-current')
            : icon(h, Play, 'size-5 fill-current ml-0.5'),
        ],
      ),
]

/** A song played from search results says what was searched for. */
const playingFromSearch = (query: string): Session.PlayingFrom => ({
  kind: 'Search',
  title: query,
  id: query,
})

/**
 * The best match, big, above the songs: an artist, album, or playlist opens;
 * a song plays, and once it is the song playing, pauses and resumes it.
 */
const topResultCard = (
  topResult: TopResult,
  query: string,
  playing: NowPlaying,
  h: HtmlBuilder<Message>,
): Html => {
  const parts = topResultParts(topResult)
  const playback = topResultPlayback(topResult, playing)
  const link = (href: string) =>
    h.a(
      [h.Href(href), h.Class(topResultCardClass)],
      topResultContent(parts, playback, h),
    )
  return Match.valueTags(topResult, {
    Artist: ({ artist }) => link(artistHref(artist.id)),
    Album: ({ album }) => link(albumHref(album.id)),
    Playlist: ({ playlist }) => link(playlistHref(playlist.id)),
    Song: ({ song }) =>
      h.button(
        [
          h.Type('button'),
          h.OnClick(
            playback === 'Ready'
              ? Message.ClickedPlaySongs({
                  songs: [song],
                  startIndex: 0,
                  maybePlayingFrom: Option.some(playingFromSearch(query)),
                })
              : Message.ClickedTogglePlayback(),
          ),
          h.AriaLabel(
            `${playback === 'Playing' ? 'Pause' : 'Play'} ${song.title}`,
          ),
          h.Class(cn(topResultCardClass, 'w-[calc(100%-2rem)]')),
        ],
        topResultContent(parts, playback, h),
      ),
  })
}

const resultsHeading = (title: string, h: HtmlBuilder<Message>): Html =>
  h.h2(
    [
      h.Class(
        'px-4 pt-1 pb-2 text-[22px] leading-tight font-bold tracking-tight',
      ),
    ],
    [title],
  )

// TOP

/** Songs Top shows before See All. */
const TOP_SONG_COUNT = 4
/** Artists, albums, or playlists in each of Top's shelves. */
const TOP_SHELF_COUNT = 10

const seeAll = (kind: SearchKind): SectionAction => ({
  label: 'See All',
  accessibleLabel: `See all ${kind.toLowerCase()}`,
  onClick: Message.SelectedSearchKind({ kind }),
})

const loadedOrEmpty = <A>(
  data: AsyncData.AsyncData<ReadonlyArray<A>, RequestError>,
): ReadonlyArray<A> => Option.getOrElse(AsyncData.getData(data), () => [])

const isTopResult = (
  maybeTopResult: Option.Option<TopResult>,
  tag: 'Artist' | 'Album' | 'Playlist',
  id: string,
): boolean =>
  Option.exists(maybeTopResult, topResult =>
    Match.valueTags(topResult, {
      Artist: ({ artist }) => tag === 'Artist' && artist.id === id,
      Album: ({ album }) => tag === 'Album' && album.id === id,
      Song: () => false,
      Playlist: ({ playlist }) => tag === 'Playlist' && playlist.id === id,
    }),
  )

/**
 * The top result's song, or another copy of it: YouTube Music often has
 * the same song on an album and on its deluxe edition.
 */
const isTopResultSong = (
  maybeTopResult: Option.Option<TopResult>,
  song: Song,
): boolean =>
  Option.exists(
    maybeTopResult,
    topResult =>
      topResult._tag === 'Song' &&
      (topResult.song.videoId === song.videoId ||
        (topResult.song.title.toLowerCase() === song.title.toLowerCase() &&
          artistNames(topResult.song.artists) === artistNames(song.artists))),
  )

/**
 * The songs the Top tab lists: the top artist's most played songs when the
 * best match is an artist, as Apple Music and Spotify do, else the song
 * search.
 */
const topSongs = (
  maybeTopResult: Option.Option<TopResult>,
  searchedSongs: ReadonlyArray<Song>,
): ReadonlyArray<Song> =>
  Option.match(maybeTopResult, {
    onNone: () => searchedSongs,
    onSome: topResult =>
      Match.valueTags(topResult, {
        Artist: ({ topSongs: artistSongs }) =>
          Array.isReadonlyArrayNonEmpty(artistSongs)
            ? artistSongs
            : searchedSongs,
        Album: () => searchedSongs,
        Song: () => searchedSongs,
        Playlist: () => searchedSongs,
      }),
  })

type TopShelfItems = Readonly<{
  artists: ReadonlyArray<ArtistSummary>
  albums: ReadonlyArray<AlbumSummary>
  playlists: ReadonlyArray<PlaylistSummary>
}>

/** The artists, albums, and playlists the Top tab shelves, past its card. */
const topShelfItems = (
  artistData: AsyncData.AsyncData<ReadonlyArray<ArtistSummary>, RequestError>,
  albumData: AsyncData.AsyncData<ReadonlyArray<AlbumSummary>, RequestError>,
  playlistData: AsyncData.AsyncData<
    ReadonlyArray<PlaylistSummary>,
    RequestError
  >,
  maybeTopResult: Option.Option<TopResult>,
): TopShelfItems => ({
  artists: Array.filter(
    loadedOrEmpty(artistData),
    artist => !isTopResult(maybeTopResult, 'Artist', artist.id),
  ),
  albums: Array.filter(
    loadedOrEmpty(albumData),
    album => !isTopResult(maybeTopResult, 'Album', album.id),
  ),
  playlists: Array.filter(
    loadedOrEmpty(playlistData),
    playlist => !isTopResult(maybeTopResult, 'Playlist', playlist.id),
  ),
})

/**
 * A shelf the browser lays out only once it nears the screen. Below the
 * first rows, most of the Top tab's shelves start off screen.
 */
const offscreenShelf = <A>(
  items: ReadonlyArray<A>,
  render: (items: Array.NonEmptyReadonlyArray<A>) => Html,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(Array.take(items, TOP_SHELF_COUNT), {
    onEmpty: () => h.empty,
    onNonEmpty: shownItems =>
      h.div(
        [
          h.Class(
            '[contain-intrinsic-size:auto_15rem] [content-visibility:auto]',
          ),
        ],
        [render(shownItems)],
      ),
  })

const artistsShelf = (
  artists: ReadonlyArray<ArtistSummary>,
  h: HtmlBuilder<Message>,
): Html =>
  offscreenShelf(
    artists,
    items =>
      shelf(
        {
          title: 'Artists',
          items,
          toKey: artist => artist.id,
          toCard: artistCard,
          maybeAction: Option.some(seeAll('Artists')),
        },
        h,
      ),
    h,
  )

const albumsShelf = (
  albums: ReadonlyArray<AlbumSummary>,
  h: HtmlBuilder<Message>,
): Html =>
  offscreenShelf(
    albums,
    items =>
      shelf(
        {
          title: 'Albums',
          items,
          toKey: album => album.id,
          toCard: albumCard,
          maybeAction: Option.some(seeAll('Albums')),
        },
        h,
      ),
    h,
  )

const playlistsShelf = (
  playlists: ReadonlyArray<PlaylistSummary>,
  h: HtmlBuilder<Message>,
): Html =>
  offscreenShelf(
    playlists,
    items =>
      shelf(
        {
          title: 'Playlists',
          items,
          toKey: playlist => playlist.id,
          toCard: playlistCard,
          maybeAction: Option.some(seeAll('Playlists')),
        },
        h,
      ),
    h,
  )

type TopShelfKind = 'Artists' | 'Albums' | 'Playlists'

/** The Top tab's shelves, in the order they show. */
const TOP_SHELVES: ReadonlyArray<TopShelfKind> = [
  'Artists',
  'Albums',
  'Playlists',
]

const renderTopShelf = (
  kind: TopShelfKind,
  artistData: AsyncData.AsyncData<ReadonlyArray<ArtistSummary>, RequestError>,
  albumData: AsyncData.AsyncData<ReadonlyArray<AlbumSummary>, RequestError>,
  playlistData: AsyncData.AsyncData<
    ReadonlyArray<PlaylistSummary>,
    RequestError
  >,
  topResultData: AsyncData.AsyncData<Option.Option<TopResult>, RequestError>,
  h: HtmlBuilder<Message>,
): Html => {
  const items = topShelfItems(
    artistData,
    albumData,
    playlistData,
    Option.flatten(AsyncData.getData(topResultData)),
  )
  return Match.value(kind).pipe(
    Match.withReturnType<Html>(),
    Match.when('Artists', () => artistsShelf(items.artists, h)),
    Match.when('Albums', () => albumsShelf(items.albums, h)),
    Match.when('Playlists', () => playlistsShelf(items.playlists, h)),
    Match.exhaustive,
  )
}

/** One slot per shelf: only the shelves on screen are worth keeping. */
const lazyTopShelf = createKeyedLazy()

/**
 * The shelves showing so far, each drawn again only when a search it shows
 * answers, not on every change to the page, such as the song playing.
 */
const shownTopShelves = (
  model: ResultsModel,
  query: string,
  count: number,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.map(Array.take(TOP_SHELVES, count), kind =>
    lazyTopShelf(kind, renderTopShelf, [
      kind,
      artistSearchQuery.read(model.artistSearch, { query }),
      albumSearchQuery.read(model.albumSearch, { query }),
      playlistSearchQuery.read(model.playlistSearch, { query }),
      topResultSearchQuery.read(model.topResultSearch, { query }),
      h,
    ]),
  )

/**
 * Where the next shelf goes until the page has painted: then it says so
 * (`WaitBeforeTopShelves`), and the shelf takes its place. The shelves
 * come one a frame, after the first rows, so no frame holds the phone up
 * long.
 */
const nextTopShelf = (
  query: string,
  count: number,
  h: HtmlBuilder<Message>,
): Html =>
  count < TOP_SHELVES.length
    ? h.keyed('div')(`${count}:${query}`, [
        h.OnMount(WaitBeforeTopShelves({ query, count: count + 1 })),
      ])
    : h.empty

const topShelves = (
  model: ResultsModel,
  query: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const count =
    model.shownTopShelves.query === query ? model.shownTopShelves.count : 0
  return [
    ...shownTopShelves(model, query, count, h),
    nextTopShelf(query, count, h),
  ]
}

/**
 * A little of everything, as Apple Music and Spotify start: the best match,
 * the first songs, then artists, albums, and playlists to swipe through.
 * Each shelf leaves out the top result and has See All for its kind. The
 * shelves come one a frame after the rest (`nextTopShelf`).
 */
const topView = (
  model: ResultsModel,
  query: string,
  h: HtmlBuilder<Message>,
): Html => {
  const songSearch = songSearchQuery.read(model.songSearch, { query })
  const maybeTopResult = Option.flatten(
    AsyncData.getData(
      topResultSearchQuery.read(model.topResultSearch, { query }),
    ),
  )
  const songs = Array.filter(
    topSongs(maybeTopResult, loadedOrEmpty(songSearch)),
    song => !isTopResultSong(maybeTopResult, song),
  )
  const shelfItems = topShelfItems(
    artistSearchQuery.read(model.artistSearch, { query }),
    albumSearchQuery.read(model.albumSearch, { query }),
    playlistSearchQuery.read(model.playlistSearch, { query }),
    maybeTopResult,
  )
  const isEmpty =
    Option.isNone(maybeTopResult) &&
    Array.isReadonlyArrayEmpty(songs) &&
    Array.isReadonlyArrayEmpty(shelfItems.artists) &&
    Array.isReadonlyArrayEmpty(shelfItems.albums) &&
    Array.isReadonlyArrayEmpty(shelfItems.playlists)

  return Option.match(AsyncData.getError(songSearch), {
    onSome: error => requestErrorAlert(error, h),
    onNone: () =>
      isEmpty
        ? noResults(query, 'Song', h)
        : h.div(
            [h.Class('flex flex-col gap-7')],
            [
              Option.match(maybeTopResult, {
                onNone: () => h.empty,
                onSome: topResult =>
                  h.section(
                    [h.Class('flex flex-col')],
                    [
                      resultsHeading('Top Result', h),
                      topResultCard(topResult, query, model.playing, h),
                    ],
                  ),
              }),
              Array.match(songs, {
                onEmpty: () => h.empty,
                onNonEmpty: songs =>
                  sectionWithAction(
                    'Songs',
                    seeAll('Songs'),
                    [
                      songList(
                        {
                          songs: Array.take(songs, TOP_SONG_COUNT),
                          playing: model.playing,
                          swipe: model.swipe,
                          isNumbered: false,
                          isAlbumHidden: false,
                          isTitleWrapped: true,
                          playsAlone: true,
                          maybePlayingFrom: Option.some(
                            playingFromSearch(query),
                          ),
                        },
                        h,
                      ),
                    ],
                    h,
                  ),
              }),
              ...topShelves(model, query, h),
            ],
          ),
  })
}

// RESULTS

const searchKindToItemKind = {
  Top: 'Song',
  Songs: 'Song',
  Artists: 'Artist',
  Albums: 'Album',
  Playlists: 'Playlist',
} as const

const noResults = (
  query: string,
  itemKind: (typeof searchKindToItemKind)[SearchKind],
  h: HtmlBuilder<Message>,
): Html =>
  emptyState(
    {
      title: 'No results',
      description: `Nothing on YouTube Music matches “${query}”.`,
      kind: itemKind,
    },
    h,
  )

/**
 * What a search's results show. Leaving out what is typed, the results are
 * not drawn again on every letter, only when a search they show answers.
 */
type ResultsModel = Readonly<
  Pick<
    PageModel,
    | 'songSearch'
    | 'artistSearch'
    | 'albumSearch'
    | 'playlistSearch'
    | 'topResultSearch'
    | 'shownTopShelves'
    | 'swipe'
    | 'playing'
  >
>

const resultsView = (
  model: ResultsModel,
  query: string,
  kind: SearchKind,
  h: HtmlBuilder<Message>,
): Html => {
  const empty = () => noResults(query, searchKindToItemKind[kind], h)

  return Match.value(kind).pipe(
    Match.withReturnType<Html>(),
    Match.when('Top', () => topView(model, query, h)),
    Match.when('Songs', () =>
      remote(
        songSearchQuery.read(model.songSearch, { query }),
        {
          onLoading: () => loadingRows(h),
          onData: songs =>
            Array.match(songs, {
              onEmpty: empty,
              onNonEmpty: songs =>
                songList(
                  {
                    songs,
                    playing: model.playing,
                    swipe: model.swipe,
                    isNumbered: false,
                    isAlbumHidden: false,
                    isTitleWrapped: true,
                    playsAlone: true,
                    maybePlayingFrom: Option.some(playingFromSearch(query)),
                  },
                  h,
                ),
            }),
        },
        h,
      ),
    ),
    Match.when('Artists', () =>
      remote(
        artistSearchQuery.read(model.artistSearch, { query }),
        {
          onLoading: () => loadingRows(h),
          onData: artists =>
            Array.match(artists, {
              onEmpty: empty,
              onNonEmpty: artists =>
                list(
                  artists,
                  { toKey: artist => artist.id, toRow: artistRow },
                  h,
                ),
            }),
        },
        h,
      ),
    ),
    Match.when('Albums', () =>
      remote(
        albumSearchQuery.read(model.albumSearch, { query }),
        {
          onLoading: () => loadingRows(h),
          onData: albums =>
            Array.match(albums, {
              onEmpty: empty,
              onNonEmpty: albums =>
                list(albums, { toKey: album => album.id, toRow: albumRow }, h),
            }),
        },
        h,
      ),
    ),
    Match.when('Playlists', () =>
      remote(
        playlistSearchQuery.read(model.playlistSearch, { query }),
        {
          onLoading: () => loadingRows(h),
          onData: playlists =>
            Array.match(playlists, {
              onEmpty: empty,
              onNonEmpty: playlists =>
                list(
                  playlists,
                  { toKey: playlist => playlist.id, toRow: playlistRow },
                  h,
                ),
            }),
        },
        h,
      ),
    ),
    Match.exhaustive,
  )
}

/**
 * The search whose results the page shows: this one once it has answered,
 * and until then the one before it, so each pause in typing does not refill
 * the page with placeholders. With neither, from the first letter typed, the
 * page shows placeholder rows instead of the moods and genres it showed
 * before, so they never flash up while the first results load. The search
 * field shows a spinner from the first letter until results arrive.
 */
const shownSearch = (
  model: PageModel,
  query: string,
  kind: SearchKind,
): Option.Option<string> =>
  isSearchSettled(model, query, kind)
    ? Option.some(query)
    : Option.filter(model.maybeEarlierSearch, earlierQuery =>
        isSearchSettled(model, earlierQuery, kind),
      )

/** One slot: one search's results show at a time. */
const lazyResults = createLazy()

/**
 * Builds the results' model from its parts, which the slot compares. The
 * song playing comes as its id, because the page builds its `playing`
 * afresh each time it is drawn.
 */
const renderResults = (
  query: string,
  kind: SearchKind,
  songSearch: PageModel['songSearch'],
  artistSearch: PageModel['artistSearch'],
  albumSearch: PageModel['albumSearch'],
  playlistSearch: PageModel['playlistSearch'],
  topResultSearch: PageModel['topResultSearch'],
  shownTopShelves: PageModel['shownTopShelves'],
  swipe: PageModel['swipe'],
  currentVideoId: string,
  isPlaying: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  resultsView(
    {
      songSearch,
      artistSearch,
      albumSearch,
      playlistSearch,
      topResultSearch,
      shownTopShelves,
      swipe,
      playing: {
        maybeVideoId: Option.liftPredicate(currentVideoId, id => id !== ''),
        isPlaying,
      },
    },
    query,
    kind,
    h,
  )

const memoizedResults = (
  model: PageModel,
  query: string,
  kind: SearchKind,
  h: HtmlBuilder<Message>,
): Html =>
  lazyResults(renderResults, [
    query,
    kind,
    model.songSearch,
    model.artistSearch,
    model.albumSearch,
    model.playlistSearch,
    model.topResultSearch,
    model.shownTopShelves,
    model.swipe,
    Option.getOrElse(model.playing.maybeVideoId, () => ''),
    model.playing.isPlaying,
    h,
  ])

// SUGGESTIONS

/** The most suggestions under the search box, leaving room for results. */
const SHOWN_SUGGESTIONS = 6

/**
 * A suggestion with what was typed in regular weight and the rest of it in
 * bold, so the eye goes to what it adds.
 */
const suggestionText = (
  suggestion: string,
  typed: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  String.isNonEmpty(typed) && suggestion.toLowerCase().startsWith(typed)
    ? [
        h.span([], [suggestion.slice(0, typed.length)]),
        h.span([h.Class('font-semibold')], [suggestion.slice(typed.length)]),
      ]
    : [h.span([], [suggestion])]

const suggestionRow = (
  suggestion: string,
  typed: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    suggestion,
    [],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedSearchSuggestion({ query: suggestion })),
          h.Class(
            'flex w-full items-center gap-3 pl-4 text-left text-[17px] transition-colors active:bg-muted/70',
          ),
        ],
        [
          icon(h, Search, 'text-muted-foreground size-[18px] shrink-0'),
          h.span(
            [h.Class('line-clamp-1 flex-1 border-b py-2.5 pr-4')],
            suggestionText(suggestion, typed, h),
          ),
        ],
      ),
    ],
  )

/**
 * What YouTube Music suggests for what is typed, from the first letter:
 * tapping one searches for it.
 */
const suggestionsView = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  Array.match(Array.take(shownSuggestions(model), SHOWN_SUGGESTIONS), {
    onEmpty: () => h.empty,
    onNonEmpty: suggestions =>
      h.ul(
        [h.AriaLabel('Suggestions'), h.Class('flex flex-col pb-4')],
        Array.map(suggestions, suggestion =>
          suggestionRow(suggestion, suggestionQuery(model.searchInput), h),
        ),
      ),
  })

// RECENT SEARCHES

const recentSearchRow = (recentSearch: string, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    recentSearch,
    [],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedRecentSearch({ query: recentSearch })),
          h.Class(
            'flex w-full items-center gap-3 pl-4 text-left text-[17px] transition-colors active:bg-muted/70',
          ),
        ],
        [
          h.span(
            [
              h.Class(
                'bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full',
              ),
            ],
            [icon(h, History, 'size-[18px]')],
          ),
          h.span(
            [h.Class('line-clamp-1 flex-1 border-b py-3 pr-4')],
            [recentSearch],
          ),
        ],
      ),
    ],
  )

/** The last few searches on this device, newest first. */
const recentSearchesView = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  Array.match(model.recentSearches, {
    onEmpty: () => h.empty,
    onNonEmpty: recentSearches =>
      h.section(
        [h.Class('flex flex-col gap-1')],
        [
          h.div(
            [h.Class('flex items-center justify-between px-4')],
            [
              h.h2(
                [h.Class('text-[22px] font-bold tracking-tight')],
                ['Recently Searched'],
              ),
              h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.ClickedClearRecentSearches()),
                  h.Class('text-primary text-[17px] active:opacity-50'),
                ],
                ['Clear'],
              ),
            ],
          ),
          h.ul(
            [h.Class('flex flex-col')],
            Array.map(recentSearches, recentSearch =>
              recentSearchRow(recentSearch, h),
            ),
          ),
        ],
      ),
  })

// BROWSE

/** How many tiles a row of moods and genres holds. */
const MOOD_COLUMNS = 2

/**
 * The color of each tile in a group of moods and genres: YouTube Music's own,
 * unless it is grey or another tile's, as `tileColors` decides.
 */
export const moodGroupColors = (group: MoodGroup): ReadonlyArray<string> =>
  tileColors(
    Array.map(group.categories, ({ maybeColor }) => maybeColor),
    MOOD_COLUMNS,
  )

/**
 * A mood or genre as a tile filled with its color, its name in whichever of
 * white or near-black reads better on that color.
 */
const moodTile = (
  category: MoodCategory,
  color: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [
      h.Href(moodRouter({ params: category.params })),
      h.Class(
        cn(
          'pressable flex h-16 items-start rounded-xl px-3 pt-2.5 text-[15px] leading-tight font-bold',
          Option.contains(textToneOn(color), 'Dark')
            ? 'text-[#0b0d12]'
            : 'text-white',
        ),
      ),
      h.Style({ backgroundColor: color }),
    ],
    [h.span([h.Class('line-clamp-2')], [category.title])],
  )

const moodGroupView = (group: MoodGroup, h: HtmlBuilder<Message>): Html =>
  section(
    group.title,
    [
      h.div(
        [h.Class('grid grid-cols-2 gap-2.5 px-4')],
        Array.zipWith(
          group.categories,
          moodGroupColors(group),
          (category, color) =>
            h.keyed('div')(category.params, [], [moodTile(category, color, h)]),
        ),
      ),
    ],
    h,
  )

const loadingTiles = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('grid grid-cols-2 gap-2.5 px-4'), h.AriaLabel('Loading')],
    Array.makeBy(8, () => h.div([h.Class('bg-muted shimmer h-16 rounded-xl')])),
  )

/** YouTube Music's moods and genres, each opening its playlists. */
const browseView = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  AsyncData.matchData(moodGroupsQuery.read(model.moodGroups), {
    onEmpty: () => loadingTiles(h),
    onFailure: error => requestErrorAlert(error, h),
    onData: groups =>
      Array.match(groups, {
        onEmpty: () =>
          emptyState(
            {
              title: 'Search YouTube Music',
              description:
                'Find any song, artist, album, or playlist and play it.',
              kind: 'Song',
            },
            h,
          ),
        onNonEmpty: groups =>
          h.div(
            [h.Class('flex flex-col gap-8')],
            Array.map(groups, group =>
              h.keyed('div')(group.title, [], [moodGroupView(group, h)]),
            ),
          ),
      }),
  })

/** Before anything is typed: recent searches first, then what to browse. */
const emptySearchView = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-8 pt-3')],
    [recentSearchesView(model, h), browseView(model, h)],
  )

// VIEW

/** The search page: search bar, catalog picker, and results or history. */
export const searchView = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const kind = routeSearchKind(model.route)
  const maybeQuery = routeQuery(model.route)
  const typedQuery = model.searchInput.trim()
  const hasTyped = typedQuery !== ''
  const isSearching =
    Option.exists(maybeQuery, query => !isSearchSettled(model, query, kind)) ||
    (hasTyped &&
      !Option.exists(
        maybeQuery,
        query => query === typedQuery && isSearchSettled(model, query, kind),
      ))
  return [
    statusBarCover(h),
    largeTitle('Search', h.empty, h),
    stickySearchBar(model, kind, isSearching, hasTyped, h),
    suggestionsView(model, h),
    h.div(
      [h.DataAttribute(SEARCH_RESULTS_ATTRIBUTE, ''), h.Class('pb-6')],
      [
        Option.match(
          Option.flatMap(maybeQuery, query => shownSearch(model, query, kind)),
          {
            onNone: () =>
              hasTyped || Option.isSome(maybeQuery)
                ? h.div([h.Class('pt-1')], [loadingRows(h)])
                : emptySearchView(model, h),
            onSome: query => memoizedResults(model, query, kind, h),
          },
        ),
      ],
    ),
  ]
}
