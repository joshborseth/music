import { Array, Match, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'
import { CircleX, History, Search } from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  SEARCH_BAR_ATTRIBUTE,
  SEARCH_INPUT_ID,
  SEARCH_RESULTS_ATTRIBUTE,
} from '../constant'
import { Message } from '../message'
import { albumSearchQuery, artistSearchQuery, songSearchQuery } from '../query'
import { SEARCH_KINDS, type SearchKind } from '../route'
import { routeQuery, routeSearchKind } from '../update'
import { largeTitle, statusBarCover } from './chrome'
import { type PageModel } from './page'
import {
  albumRow,
  artistRow,
  emptyState,
  list,
  loadingRows,
  remote,
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
        h.Placeholder('Songs, artists, albums'),
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
      h.Class('bg-muted grid h-8 grid-cols-3 rounded-[9px] p-0.5'),
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

// RESULTS

const searchKindToItemKind = {
  Songs: 'Song',
  Artists: 'Artist',
  Albums: 'Album',
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
                songList(
                  {
                    songs,
                    playing: model.playing,
                    swipe: model.swipe,
                    isNumbered: false,
                    isAlbumHidden: false,
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
    Match.exhaustive,
  )
}

// RECENT SEARCHES

const recentSearchesView = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  Array.match(model.recentSearches, {
    onEmpty: () =>
      emptyState(
        {
          title: 'Search YouTube Music',
          description: 'Find any song, artist, or album and play it.',
          kind: 'Song',
        },
        h,
      ),
    onNonEmpty: recentSearches =>
      h.section(
        [h.Class('flex flex-col pt-3')],
        [
          h.div(
            [h.Class('flex items-center justify-between px-4 pb-1')],
            [
              h.h2(
                [h.Class('text-[22px] font-bold tracking-tight')],
                ['Recent searches'],
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
              h.keyed('li')(
                recentSearch,
                [],
                [
                  h.button(
                    [
                      h.Type('button'),
                      h.OnClick(
                        Message.ClickedRecentSearch({ query: recentSearch }),
                      ),
                      h.Class(
                        'flex w-full items-center gap-3 px-4 text-left text-[17px] transition-colors active:bg-muted/70',
                      ),
                    ],
                    [
                      h.span(
                        [h.Class('text-muted-foreground')],
                        [icon(h, History, 'size-5')],
                      ),
                      h.span(
                        [
                          h.Class(
                            'line-clamp-1 flex-1 border-b py-3 text-primary',
                          ),
                        ],
                        [recentSearch],
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
  })

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
          onNone: () => recentSearchesView(model, h),
          onSome: query => resultsView(model, query, kind, h),
        }),
      ],
    ),
  ]
}
