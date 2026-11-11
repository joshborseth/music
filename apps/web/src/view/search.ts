import { Array, Match, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'
import { History, Search, X } from 'lucide'

import { button } from '@/components/ui/button'
import { input } from '@/components/ui/input'
import { tabsListClass, tabsTriggerClass } from '@/components/ui/tabs'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { SEARCH_INPUT_ID } from '../constant'
import { Message } from '../message'
import { Model } from '../model'
import { albumSearchQuery, artistSearchQuery, songSearchQuery } from '../query'
import { SEARCH_KINDS, type SearchKind } from '../route'
import { routeQuery, routeSearchKind } from '../update'
import {
  albumRow,
  artistRow,
  emptyState,
  list,
  loadingRows,
  remote,
  songRow,
} from './shared'

// SEARCH BAR

const searchForm = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [
      h.OnSubmit(Message.SubmittedSearch()),
      h.Role('search'),
      h.Class('relative'),
    ],
    [
      h.span(
        [
          h.Class(
            'text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2',
          ),
        ],
        [icon(h, Search)],
      ),
      input(
        {
          id: SEARCH_INPUT_ID,
          label: 'Search music',
          labelClass: 'sr-only',
          type: 'search',
          value: model.searchInput,
          placeholder: 'Songs, artists, albums',
          onInput: value => Message.UpdatedSearchInput({ value }),
          className:
            'h-11 rounded-full pr-11 pl-10 text-base [&::-webkit-search-cancel-button]:hidden',
        },
        h,
      ),
      model.searchInput.length > 0
        ? h.span(
            [h.Class('absolute top-1/2 right-1.5 -translate-y-1/2')],
            [
              button(
                {
                  onClick: Message.ClickedClearSearch(),
                  variant: 'ghost',
                  size: 'icon',
                  type: 'button',
                  className: 'rounded-full',
                },
                [icon(h, X), h.span([h.Class('sr-only')], ['Clear search'])],
                h,
              ),
            ],
          )
        : h.empty,
    ],
  )

const kindTabs = (selectedKind: SearchKind, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('tablist'),
      h.AriaLabel('Search in'),
      h.DataAttribute('variant', 'default'),
      h.Class(cn(tabsListClass('default'), 'h-9 w-full')),
    ],
    Array.map(SEARCH_KINDS, kind =>
      h.button(
        [
          h.Type('button'),
          h.Role('tab'),
          h.AriaSelected(kind === selectedKind),
          ...(kind === selectedKind ? [h.DataAttribute('selected', '')] : []),
          h.OnClick(Message.SelectedSearchKind({ kind })),
          h.Class(tabsTriggerClass),
        ],
        [kind],
      ),
    ),
  )

// RESULTS

const searchKindToItemKind = {
  Songs: 'Song',
  Artists: 'Artist',
  Albums: 'Album',
} as const

const resultsView = (
  model: Model,
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
                list(
                  songs,
                  {
                    toKey: song => song.videoId,
                    toRow: (song, h) =>
                      songRow(
                        {
                          song,
                          maybeTrackNumber: Option.none(),
                          isAlbumHidden: false,
                          maybeOnPlay: Option.some(
                            Message.ClickedPlaySongs({
                              songs: [song],
                              startIndex: 0,
                            }),
                          ),
                        },
                        h,
                      ),
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

const recentSearchesView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Array.match(model.recentSearches, {
    onEmpty: () =>
      emptyState(
        {
          title: 'Search YouTube Music',
          description: 'Find any song, artist, or album and see its details.',
          kind: 'Song',
        },
        h,
      ),
    onNonEmpty: recentSearches =>
      h.section(
        [h.Class('flex flex-col gap-1')],
        [
          h.div(
            [h.Class('flex items-center justify-between')],
            [
              h.h2(
                [h.Class('text-muted-foreground text-sm font-medium')],
                ['Recent searches'],
              ),
              button(
                {
                  onClick: Message.ClickedClearRecentSearches(),
                  variant: 'ghost',
                  size: 'sm',
                },
                ['Clear'],
                h,
              ),
            ],
          ),
          h.ul(
            [h.Class('-mx-2 flex flex-col')],
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
                        'hover:bg-muted/60 active:bg-muted flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm',
                      ),
                    ],
                    [
                      h.span(
                        [h.Class('text-muted-foreground')],
                        [icon(h, History)],
                      ),
                      h.span([h.Class('line-clamp-1')], [recentSearch]),
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

/** The search page: search bar, catalog tabs, and results or history. */
export const searchView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const kind = routeSearchKind(model.route)

  return h.div(
    [h.Class('flex flex-col gap-4')],
    [
      h.div(
        [
          h.Class(
            'bg-background/90 sticky top-0 z-10 -mx-4 flex flex-col gap-3 px-4 pt-[max(env(safe-area-inset-top),1rem)] pb-3 backdrop-blur',
          ),
        ],
        [
          h.h1([h.Class('text-2xl font-bold tracking-tight')], ['Music']),
          searchForm(model, h),
          kindTabs(kind, h),
        ],
      ),
      Option.match(routeQuery(model.route), {
        onNone: () => recentSearchesView(model, h),
        onSome: query => resultsView(model, query, kind, h),
      }),
    ],
  )
}
