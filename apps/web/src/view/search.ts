import { Array, Match, Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { CircleX, Disc3, History, ListMusic, Play, Search, User } from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  type Artwork,
  type MoodCategory,
  type MoodGroup,
  type TopResult,
} from '@music/shared'

import {
  SEARCH_BAR_ATTRIBUTE,
  SEARCH_INPUT_ID,
  SEARCH_RESULTS_ATTRIBUTE,
} from '../constant'
import { Message } from '../message'
import {
  albumSearchQuery,
  artistSearchQuery,
  moodGroupsQuery,
  playlistSearchQuery,
  songSearchQuery,
  topResultSearchQuery,
} from '../query'
import { SEARCH_KINDS, type SearchKind, moodRouter } from '../route'
import { routeQuery, routeSearchKind } from '../update'
import { largeTitle, statusBarCover } from './chrome'
import { type PageModel } from './page'
import {
  ArtworkShape,
  albumHref,
  albumRow,
  artistHref,
  artistNames,
  artistRow,
  artworkImage,
  emptyState,
  joinDetails,
  list,
  loadingRows,
  playlistHref,
  playlistRow,
  remote,
  requestErrorAlert,
  section,
  songList,
} from './shared'

// SEARCH BAR

const searchField = (model: PageModel, h: HtmlBuilder<Message>): Html =>
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
        [icon(h, Search, 'size-[18px]')],
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
      h.Class('bg-muted grid h-8 grid-cols-4 rounded-[9px] p-0.5'),
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
      searchField(model, h),
      Option.isSome(routeQuery(model.route)) ? kindPicker(kind, h) : h.empty,
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

const topResultContent = (
  parts: TopResultParts,
  isPlayable: boolean,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
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
  isPlayable
    ? h.span(
        [
          h.AriaHidden(true),
          h.Class(
            'bg-primary text-primary-foreground flex size-11 shrink-0 items-center justify-center rounded-full',
          ),
        ],
        [icon(h, Play, 'size-5 fill-current ml-0.5')],
      )
    : h.empty,
]

/**
 * The best match, big, above the songs: an artist, album, or playlist opens;
 * a song plays.
 */
const topResultCard = (topResult: TopResult, h: HtmlBuilder<Message>): Html => {
  const parts = topResultParts(topResult)
  const link = (href: string) =>
    h.a(
      [h.Href(href), h.Class(topResultCardClass)],
      topResultContent(parts, false, h),
    )
  return Match.valueTags(topResult, {
    Artist: ({ artist }) => link(artistHref(artist.id)),
    Album: ({ album }) => link(albumHref(album.id)),
    Playlist: ({ playlist }) => link(playlistHref(playlist.id)),
    Song: ({ song }) =>
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedPlaySongs({ songs: [song], startIndex: 0 })),
          h.AriaLabel(`Play ${song.title}`),
          h.Class(cn(topResultCardClass, 'w-[calc(100%-2rem)]')),
        ],
        topResultContent(parts, true, h),
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

/**
 * Songs, under the top result when YouTube Music picks one. The songs
 * never wait for it.
 */
const songResults = (
  model: PageModel,
  query: string,
  songsView: Html,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(
    Option.flatten(
      AsyncData.getData(
        topResultSearchQuery.read(model.topResultSearch, { query }),
      ),
    ),
    {
      onNone: () => songsView,
      onSome: topResult =>
        h.div(
          [h.Class('flex flex-col')],
          [
            resultsHeading('Top Result', h),
            topResultCard(topResult, h),
            h.div([h.Class('h-6')]),
            resultsHeading('Songs', h),
            songsView,
          ],
        ),
    },
  )

// RESULTS

const searchKindToItemKind = {
  Songs: 'Song',
  Artists: 'Artist',
  Albums: 'Album',
  Playlists: 'Playlist',
} as const

const resultsView = (
  model: PageModel,
  query: string,
  kind: SearchKind,
  h: HtmlBuilder<Message>,
): Html => {
  const noResults = emptyState(
    {
      title: 'No results',
      description: `Nothing on YouTube Music matches “${query}”.`,
      kind: searchKindToItemKind[kind],
    },
    h,
  )

  return Match.value(kind).pipe(
    Match.withReturnType<Html>(),
    Match.when('Songs', () =>
      remote(
        songSearchQuery.read(model.songSearch, { query }),
        {
          onLoading: () => loadingRows(h),
          onData: songs =>
            Array.match(songs, {
              onEmpty: () => noResults,
              onNonEmpty: songs =>
                songResults(
                  model,
                  query,
                  songList(
                    {
                      songs,
                      playing: model.playing,
                      swipe: model.swipe,
                      isNumbered: false,
                      isAlbumHidden: false,
                      isTitleWrapped: true,
                    },
                    h,
                  ),
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
              onEmpty: () => noResults,
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
              onEmpty: () => noResults,
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
              onEmpty: () => noResults,
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

const moodTile = (category: MoodCategory, h: HtmlBuilder<Message>): Html =>
  h.a(
    [
      h.Href(moodRouter({ params: category.params })),
      h.Class(
        'pressable bg-secondary relative flex h-14 items-center overflow-hidden rounded-xl pr-3 pl-5 text-[15px] leading-tight font-semibold',
      ),
    ],
    [
      h.span([
        h.AriaHidden(true),
        h.Class('absolute inset-y-0 left-0 w-1.5'),
        h.Style({
          backgroundColor: Option.getOrElse(
            category.maybeColor,
            () => 'var(--primary)',
          ),
        }),
      ]),
      h.span([h.Class('line-clamp-2')], [category.title]),
    ],
  )

const moodGroupView = (group: MoodGroup, h: HtmlBuilder<Message>): Html =>
  section(
    group.title,
    [
      h.div(
        [h.Class('grid grid-cols-2 gap-2.5 px-4')],
        Array.map(group.categories, category =>
          h.keyed('div')(category.params, [], [moodTile(category, h)]),
        ),
      ),
    ],
    h,
  )

const loadingTiles = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('grid grid-cols-2 gap-2.5 px-4'), h.AriaLabel('Loading')],
    Array.makeBy(8, () => h.div([h.Class('bg-muted shimmer h-14 rounded-xl')])),
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
  return [
    statusBarCover(h),
    largeTitle('Search', h.empty, h),
    stickySearchBar(model, kind, h),
    h.div(
      [h.DataAttribute(SEARCH_RESULTS_ATTRIBUTE, ''), h.Class('pb-6')],
      [
        Option.match(routeQuery(model.route), {
          onNone: () => emptySearchView(model, h),
          onSome: query => resultsView(model, query, kind, h),
        }),
      ],
    ),
  ]
}
