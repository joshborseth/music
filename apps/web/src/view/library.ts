import { Array, Match, Option, String } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import {
  ArrowDownUp,
  Check,
  ChevronDown,
  CircleX,
  Disc3,
  LayoutGrid,
  List,
  ListMusic,
  Plus,
  Search,
  Trash2,
  User,
} from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  type AlbumSummary,
  type ArtistSummary,
  type MyLibrary,
  type MyPlaylistSummary,
} from '@music/shared'

import {
  type DownloadedCollection,
  type ReadyDownloads,
  downloadProgress,
  downloadSummary,
  findDownload,
  formatBytes,
  totalDownloadedBytes,
} from '../downloads/domain'
import {
  LIBRARY_ARTWORK_WIDTH,
  LIBRARY_FILTER_CHIPS,
  LIBRARY_SORTS,
  LIBRARY_SORT_LABELS,
  type LayoutKind,
  type LibraryFilter,
  type LibraryItem,
  type LibraryPrefs,
  type SortableKind,
  albumLibraryItem,
  matchesLibrarySearch,
  sortAlbums,
  sortArtists,
  sortPlaylists,
} from '../library'
import { Message } from '../message'
import { myLibraryQuery } from '../query'
import { largeTitleHeader } from './chrome'
import { type PageModel } from './page'
import {
  ArtworkShape,
  albumCard,
  albumHref,
  albumRow,
  artistCard,
  artistHref,
  artistNames,
  artistRow,
  artworkUrl,
  downloadedMark,
  emptyState,
  list,
  loadingRows,
  myPlaylistHref,
  myPlaylistRow,
  playlistCover,
  playlistHref,
  playlistLength,
  requestErrorAlert,
  section,
  shelf,
} from './shared'

const RECENTLY_VIEWED_IN_LIBRARY = 10

const LIBRARY_SEARCH_INPUT_ID = 'library-search-input'

const libraryItemHref = (item: LibraryItem): string =>
  Match.value(item.kind).pipe(
    Match.when('Album', () => albumHref(item.id)),
    Match.when('Artist', () => artistHref(item.id)),
    Match.when('Playlist', () => playlistHref(item.id)),
    Match.exhaustive,
  )

const libraryItemIcon = (item: LibraryItem) =>
  Match.value(item.kind).pipe(
    Match.when('Album', () => Disc3),
    Match.when('Artist', () => User),
    Match.when('Playlist', () => ListMusic),
    Match.exhaustive,
  )

/** Artwork `sizeClass` big: round for an artist, else with `cornerClass`. */
const libraryItemArtwork = (
  item: LibraryItem,
  sizeClass: string,
  cornerClass: string,
  h: HtmlBuilder<Message>,
): Html => {
  const shape = cn(
    sizeClass,
    item.kind === 'Artist' ? 'rounded-full' : cornerClass,
  )
  return Option.match(item.maybeArtworkUrl, {
    onNone: () =>
      h.span(
        [
          h.Class(
            cn(
              'bg-muted text-muted-foreground flex aspect-square shrink-0 items-center justify-center',
              shape,
            ),
          ),
        ],
        [icon(h, libraryItemIcon(item), 'size-2/5')],
      ),
    onSome: url =>
      h.img([
        h.Src(url),
        h.Alt(''),
        h.Loading('lazy'),
        h.Decoding('async'),
        h.Referrerpolicy('no-referrer'),
        h.Class(cn('bg-muted aspect-square shrink-0 object-cover', shape)),
      ]),
  })
}

/** An album as a tile in a grid of two: cover, title, artists. */
const albumTile = (item: LibraryItem, h: HtmlBuilder<Message>): Html =>
  h.a(
    [h.Href(libraryItemHref(item)), h.Class('pressable flex min-w-0 flex-col')],
    [
      libraryItemArtwork(item, 'w-full', 'rounded-xl', h),
      h.span(
        [h.Class('mt-2 line-clamp-1 text-[13px] leading-tight font-medium')],
        [item.title],
      ),
      h.span(
        [
          h.Class(
            'text-muted-foreground mt-0.5 line-clamp-1 text-[13px] leading-tight',
          ),
        ],
        [item.subtitle],
      ),
    ],
  )

/** Something opened lately as one compact row: artwork, title, what it is. */
const recentlyViewedRow = (item: LibraryItem, h: HtmlBuilder<Message>): Html =>
  h.a(
    [
      h.Href(libraryItemHref(item)),
      h.Class(
        'flex items-center gap-3 px-4 py-1.5 transition-colors active:bg-muted/70',
      ),
    ],
    [
      libraryItemArtwork(item, 'size-11', 'rounded-md', h),
      h.span(
        [h.Class('flex min-w-0 flex-1 flex-col')],
        [
          h.span(
            [h.Class('line-clamp-1 text-[15px] leading-snug font-medium')],
            [item.title],
          ),
          h.span(
            [
              h.Class(
                'text-muted-foreground line-clamp-1 text-[13px] leading-snug',
              ),
            ],
            [item.subtitle],
          ),
        ],
      ),
    ],
  )

/** The albums, artists, and playlists opened on this phone, newest first. */
const recentlyViewedSection = (
  items: ReadonlyArray<LibraryItem>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(items, {
    onEmpty: () => h.empty,
    onNonEmpty: items =>
      h.section(
        [h.Class('flex flex-col gap-1')],
        [
          h.div(
            [h.Class('flex items-center justify-between px-4')],
            [
              h.h2(
                [h.Class('text-[22px] leading-tight font-bold tracking-tight')],
                ['Recently Viewed'],
              ),
              h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.ClickedClearRecentlyViewed()),
                  h.AriaLabel('Clear Recently Viewed'),
                  h.Class('text-primary text-[17px] active:opacity-50'),
                ],
                ['Clear'],
              ),
            ],
          ),
          list(
            Array.take(items, RECENTLY_VIEWED_IN_LIBRARY),
            {
              toKey: item => `${item.kind}:${item.id}`,
              toRow: recentlyViewedRow,
            },
            h,
          ),
        ],
      ),
  })

// FILTERS

const filterChip = (
  filter: LibraryFilter,
  selected: LibraryFilter,
  h: HtmlBuilder<Message>,
): Html => {
  const isSelected = filter === selected
  return h.button(
    [
      h.Type('button'),
      h.AriaPressed(isSelected ? 'true' : 'false'),
      h.OnClick(
        Message.SelectedLibraryFilter({ filter: isSelected ? 'All' : filter }),
      ),
      h.Class(
        cn(
          'h-8 shrink-0 rounded-full px-4 text-[15px] font-medium transition-colors active:opacity-60',
          isSelected
            ? 'bg-primary text-primary-foreground'
            : 'bg-secondary text-foreground',
        ),
      ),
    ],
    [filter],
  )
}

/**
 * Chips that narrow the Library to one kind of thing; tapped again, back to
 * all. Downloaded shows only where the phone can download.
 */
const filterChips = (
  selected: LibraryFilter,
  canDownload: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Role('group'),
      h.AriaLabel('Show'),
      h.Class('no-scrollbar flex gap-2 overflow-x-auto px-4'),
    ],
    Array.map(
      Array.filter(
        LIBRARY_FILTER_CHIPS,
        filter => canDownload || filter !== 'Downloaded',
      ),
      filter => filterChip(filter, selected, h),
    ),
  )

// SEARCH, SORT, AND LAYOUT

/** The field that narrows the Library to what matches what is typed. */
const searchField = (search: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Role('search'), h.Class('relative px-4')],
    [
      h.label(
        [h.For(LIBRARY_SEARCH_INPUT_ID), h.Class('sr-only')],
        ['Search your Library'],
      ),
      h.span(
        [
          h.Class(
            'text-muted-foreground pointer-events-none absolute top-1/2 left-6.5 -translate-y-1/2',
          ),
        ],
        [icon(h, Search, 'size-[18px]')],
      ),
      h.input([
        h.Id(LIBRARY_SEARCH_INPUT_ID),
        h.Type('search'),
        h.Value(search),
        h.Placeholder('Search your Library'),
        h.Autocomplete('off'),
        h.Attribute('autocorrect', 'off'),
        h.Attribute('autocapitalize', 'off'),
        h.Spellcheck(false),
        h.Attribute('enterkeyhint', 'search'),
        h.OnInput(value => Message.UpdatedLibrarySearchInput({ value })),
        h.Class(
          'bg-muted placeholder:text-muted-foreground h-10 w-full rounded-xl pr-9 pl-9 text-[17px] outline-none [&::-webkit-search-cancel-button]:hidden',
        ),
      ]),
      String.isNonEmpty(search)
        ? h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedClearLibrarySearch()),
              h.AriaLabel('Clear search'),
              h.Class(
                'text-muted-foreground absolute top-1/2 right-5 flex size-8 -translate-y-1/2 items-center justify-center active:opacity-50',
              ),
            ],
            [icon(h, CircleX, 'size-[18px] fill-current stroke-background')],
          )
        : h.empty,
    ],
  )

const sortableKind = (filter: LibraryFilter): Option.Option<SortableKind> =>
  Match.value(filter).pipe(
    Match.withReturnType<Option.Option<SortableKind>>(),
    Match.when('Playlists', () => Option.some('Playlists')),
    Match.when('Albums', () => Option.some('Albums')),
    Match.when('Artists', () => Option.some('Artists')),
    Match.orElse(() => Option.none()),
  )

const layoutKind = (filter: LibraryFilter): Option.Option<LayoutKind> =>
  Match.value(filter).pipe(
    Match.withReturnType<Option.Option<LayoutKind>>(),
    Match.when('Playlists', () => Option.some('Playlists')),
    Match.when('Albums', () => Option.some('Albums')),
    Match.orElse(() => Option.none()),
  )

/** Grid or list, for the kinds that can be either. */
const layoutToggle = (
  prefs: LibraryPrefs,
  kind: LayoutKind,
  h: HtmlBuilder<Message>,
): Html => {
  const isGrid = prefs.layouts[kind] === 'Grid'
  return h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedToggleLibraryLayout({ kind })),
      h.AriaLabel(isGrid ? 'Show as List' : 'Show as Grid'),
      h.Class(
        'text-primary flex size-9 items-center justify-center rounded-full active:bg-muted',
      ),
    ],
    [icon(h, isGrid ? List : LayoutGrid, 'size-[22px]')],
  )
}

/** The order a chip's list is in, which opens the choice of orders. */
const sortButton = (
  prefs: LibraryPrefs,
  kind: SortableKind,
  h: HtmlBuilder<Message>,
): Html => {
  const label = LIBRARY_SORT_LABELS[prefs.sorts[kind]]
  return h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedLibrarySort({ kind })),
      h.AriaLabel(`Sort ${kind}: ${label}`),
      h.Class(
        'text-primary -ml-1 flex h-9 items-center gap-1.5 rounded-full px-1 text-[15px] font-medium active:opacity-50',
      ),
    ],
    [
      icon(h, ArrowDownUp, 'size-[18px]'),
      label,
      icon(h, ChevronDown, 'size-4 opacity-70'),
    ],
  )
}

/** Above a chip's list: its order, and grid or list where it has both. */
const toolbar = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  Option.match(sortableKind(model.libraryFilter), {
    onNone: () => h.empty,
    onSome: kind =>
      h.div(
        [h.Class('-mb-3 flex items-center justify-between px-4')],
        [
          sortButton(model.libraryPrefs, kind, h),
          Option.match(layoutKind(model.libraryFilter), {
            onNone: () => h.empty,
            onSome: layout => layoutToggle(model.libraryPrefs, layout, h),
          }),
        ],
      ),
  })

/** The sheet listing the orders a kind can be sorted in, the current one checked. */
export const librarySortSheet = (
  prefs: LibraryPrefs,
  kind: SortableKind,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col')],
    [
      h.h2(
        [h.Class('px-5 pt-1 pb-3 text-[20px] font-bold tracking-tight')],
        [`Sort ${kind} By`],
      ),
      h.div(
        [
          h.Role('group'),
          h.AriaLabel(`Sort ${kind} By`),
          h.Class('flex flex-col border-t py-2'),
        ],
        Array.map(LIBRARY_SORTS[kind], sort => {
          const isSelected = prefs.sorts[kind] === sort
          return h.button(
            [
              h.Type('button'),
              h.AriaPressed(isSelected ? 'true' : 'false'),
              h.OnClick(Message.SelectedLibrarySort({ kind, sort })),
              h.Class(
                'flex h-14 w-full items-center justify-between px-5 text-left text-[17px] transition-colors active:bg-muted',
              ),
            ],
            [
              LIBRARY_SORT_LABELS[sort],
              isSelected ? icon(h, Check, 'text-primary size-[22px]') : h.empty,
            ],
          )
        }),
      ),
    ],
  )

/** Nothing in the Library matches the search. */
const noMatches = (search: string, h: HtmlBuilder<Message>): Html =>
  emptyState(
    {
      title: 'No matches',
      description: `Nothing in your Library matches “${search.trim()}”.`,
      kind: 'Song',
    },
    h,
  )

const isSearching = (model: PageModel): boolean =>
  String.isNonEmpty(model.librarySearchInput.trim())

const shownPlaylists = (
  model: PageModel,
  library: MyLibrary,
): ReadonlyArray<MyPlaylistSummary> =>
  sortPlaylists(
    Array.filter(library.playlists, playlist =>
      matchesLibrarySearch(model.librarySearchInput, [
        playlist.title,
        Option.getOrElse(playlist.maybeDescription, () => ''),
      ]),
    ),
    model.libraryPrefs.sorts.Playlists,
  )

const shownAlbums = (
  model: PageModel,
  library: MyLibrary,
): ReadonlyArray<AlbumSummary> =>
  Array.filter(sortAlbums(library, model.libraryPrefs.sorts.Albums), album =>
    matchesLibrarySearch(model.librarySearchInput, [
      album.title,
      artistNames(album.artists),
    ]),
  )

const shownArtists = (
  model: PageModel,
  library: MyLibrary,
): ReadonlyArray<ArtistSummary> =>
  Array.filter(sortArtists(library, model.libraryPrefs.sorts.Artists), artist =>
    matchesLibrarySearch(model.librarySearchInput, [artist.name]),
  )

const shownRecentlyViewed = (model: PageModel): ReadonlyArray<LibraryItem> =>
  Array.filter(model.recentlyViewed, item =>
    matchesLibrarySearch(model.librarySearchInput, [item.title, item.subtitle]),
  )

// DOWNLOADS

const downloadHref = (collection: DownloadedCollection): string =>
  Match.value(collection.kind).pipe(
    Match.when('Album', () => albumHref(collection.id)),
    Match.when('Playlist', () => playlistHref(collection.id)),
    Match.when('MyPlaylist', () => myPlaylistHref(collection.id)),
    Match.exhaustive,
  )

/** Every song of the download is on the phone. */
const isWhole = (
  ready: ReadyDownloads,
  collection: DownloadedCollection,
): boolean => {
  const { saved, total } = downloadProgress(ready, collection)
  return saved === total
}

/**
 * A download as a row: its cover, title, and how many songs it holds and
 * how much room they take, with a button to take it off the phone.
 */
const downloadRow = (
  ready: ReadyDownloads,
  collection: DownloadedCollection,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center')],
    [
      h.a(
        [
          h.Href(downloadHref(collection)),
          h.Class(
            'flex min-w-0 flex-1 items-center gap-3 py-1.5 pl-4 transition-colors active:bg-muted/70',
          ),
        ],
        [
          libraryItemArtwork(
            {
              kind: collection.kind === 'Album' ? 'Album' : 'Playlist',
              id: collection.id,
              title: collection.title,
              subtitle: collection.subtitle,
              maybeArtworkUrl: collection.maybeArtworkUrl,
            },
            'size-14',
            'rounded-md',
            h,
          ),
          h.span(
            [h.Class('flex min-w-0 flex-1 flex-col')],
            [
              h.span(
                [h.Class('line-clamp-1 text-[15px] leading-snug font-medium')],
                [collection.title],
              ),
              h.span(
                [
                  h.Class(
                    'text-muted-foreground flex items-center gap-1 text-[13px] leading-snug',
                  ),
                ],
                [
                  isWhole(ready, collection) ? downloadedMark(h) : h.empty,
                  h.span(
                    [h.Class('line-clamp-1')],
                    [downloadSummary(ready, collection)],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(
            Message.ClickedRemoveDownload({
              kind: collection.kind,
              id: collection.id,
              title: collection.title,
            }),
          ),
          h.AriaLabel(`Remove ${collection.title} from Downloads`),
          h.Class(
            'text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-full active:bg-muted mr-2',
          ),
        ],
        [icon(h, Trash2, 'size-5')],
      ),
    ],
  )

/** How much room the downloads take, and how much the phone has left. */
const storageLine = (ready: ReadyDownloads): string => {
  const used = `${formatBytes(totalDownloadedBytes(ready))} downloaded`
  return Option.match(ready.maybeStorage, {
    onNone: () => used,
    onSome: ({ usageBytes, quotaBytes }) =>
      `${used} · ${formatBytes(Math.max(0, quotaBytes - usageBytes))} available`,
  })
}

const downloadRows = (
  ready: ReadyDownloads,
  collections: ReadonlyArray<DownloadedCollection>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Role('list'), h.Class('flex flex-col')],
    Array.map(collections, collection =>
      h.keyed('div')(
        `${collection.kind}:${collection.id}`,
        [h.Role('listitem')],
        [downloadRow(ready, collection, h)],
      ),
    ),
  )

/** Everything downloaded on this phone, with the room it takes. */
const downloadsSection = (
  ready: ReadyDownloads,
  collections: ReadonlyArray<DownloadedCollection>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.AriaLabel('Downloaded'), h.Class('flex flex-col gap-2')],
    [
      h.div(
        [h.Class('flex flex-col px-4')],
        [
          h.h2(
            [h.Class('text-[22px] leading-tight font-bold tracking-tight')],
            ['Downloaded'],
          ),
          h.p(
            [h.Class('text-muted-foreground text-[13px]')],
            [storageLine(ready)],
          ),
          ready.isOutOfSpace
            ? h.p(
                [h.Class('text-destructive text-[13px] font-medium')],
                [
                  'This phone is nearly full. Remove a download, or free up space, then tap Download again.',
                ],
              )
            : h.empty,
        ],
      ),
      downloadRows(ready, collections, h),
    ],
  )

const shownDownloads = (
  model: PageModel,
  ready: ReadyDownloads,
): ReadonlyArray<DownloadedCollection> =>
  Array.filter(ready.collections, collection =>
    matchesLibrarySearch(model.librarySearchInput, [
      collection.title,
      collection.subtitle,
    ]),
  )

/** The downloads matching the search, under their heading, if any match. */
const matchingDownloadsSection = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): Html =>
  model.downloads._tag === 'Ready' &&
  Array.isReadonlyArrayNonEmpty(shownDownloads(model, model.downloads))
    ? downloadsSection(
        model.downloads,
        shownDownloads(model, model.downloads),
        h,
      )
    : h.empty

/** The Downloaded chip: every download, or how to make one. */
const downloadsView = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  model.downloads._tag === 'Ready' &&
  Array.isReadonlyArrayNonEmpty(model.downloads.collections)
    ? Array.isReadonlyArrayNonEmpty(shownDownloads(model, model.downloads))
      ? matchingDownloadsSection(model, h)
      : noMatches(model.librarySearchInput, h)
    : emptyState(
        {
          title: 'No downloads yet',
          description:
            'Open an album or playlist and tap the arrow at the top to keep its songs on this phone, to play without a connection.',
          kind: 'Album',
        },
        h,
      )

const isDownloaded = (
  model: PageModel,
  kind: DownloadedCollection['kind'],
  id: string,
): boolean => Option.isSome(findDownload(model.downloads, kind, id))

// PLAYLISTS

const newPlaylistRow = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedNewPlaylist({ songs: [], suggestedTitle: '' })),
      h.Class(
        'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors active:bg-muted/70',
      ),
    ],
    [
      h.span(
        [
          h.Class(
            'bg-muted text-primary flex size-14 shrink-0 items-center justify-center rounded-md',
          ),
        ],
        [icon(h, Plus, 'size-7')],
      ),
      h.span(
        [h.Class('text-primary text-[15px] font-medium')],
        ['New Playlist…'],
      ),
    ],
  )

const playlistRowSkeleton = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex items-center gap-3 px-4 py-2'), h.AriaLabel('Loading')],
    [
      h.span([h.Class('bg-muted size-14 animate-pulse rounded-md')]),
      h.span([h.Class('bg-muted h-4 w-32 animate-pulse rounded')]),
    ],
  )

const newPlaylistTile = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedNewPlaylist({ songs: [], suggestedTitle: '' })),
      h.Class('pressable flex min-w-0 flex-col text-left'),
    ],
    [
      h.span(
        [
          h.Class(
            'bg-muted text-primary flex aspect-square w-full items-center justify-center rounded-xl',
          ),
        ],
        [icon(h, Plus, 'size-10')],
      ),
      h.span(
        [h.Class('text-primary mt-2 text-[13px] leading-tight font-medium')],
        ['New Playlist…'],
      ),
    ],
  )

/** One of my playlists as a tile in a grid of two: cover, title, length. */
const playlistTile = (
  playlist: MyPlaylistSummary,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [
      h.Href(myPlaylistHref(playlist.id)),
      h.Class('pressable flex min-w-0 flex-col'),
    ],
    [
      playlistCover(
        {
          playlist,
          displayWidth: LIBRARY_ARTWORK_WIDTH,
          shape: ArtworkShape.Card,
          className: 'aspect-square w-full',
        },
        h,
      ),
      h.span(
        [h.Class('mt-2 line-clamp-1 text-[13px] leading-tight font-medium')],
        [playlist.title],
      ),
      h.span(
        [
          h.Class(
            'text-muted-foreground mt-0.5 line-clamp-1 text-[13px] leading-tight',
          ),
        ],
        [playlistLength(playlist)],
      ),
    ],
  )

const playlistItems = (
  model: PageModel,
  playlists: ReadonlyArray<MyPlaylistSummary>,
  isGrid: boolean,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.map(playlists, playlist =>
    h.keyed('div')(
      playlist.id,
      [h.Role('listitem'), h.Class('min-w-0')],
      [
        isGrid
          ? playlistTile(playlist, h)
          : myPlaylistRow(
              playlist,
              h,
              isDownloaded(model, 'MyPlaylist', playlist.id),
            ),
      ],
    ),
  )

/**
 * My playlists, kept on the server so every device sees the same ones, as a
 * list or, under the Playlists chip, a grid. A new one can be started before
 * they load, except while searching.
 */
const playlistsSection = (
  model: PageModel,
  isGrid: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  section(
    'Playlists',
    [
      h.div(
        [
          h.Role('list'),
          h.Class(
            isGrid ? 'grid grid-cols-2 gap-x-3 gap-y-5 px-4' : 'flex flex-col',
          ),
        ],
        [
          isSearching(model)
            ? h.empty
            : isGrid
              ? newPlaylistTile(h)
              : newPlaylistRow(h),
          ...AsyncData.matchData(myLibraryQuery.read(model.myLibrary), {
            onEmpty: (): ReadonlyArray<Html> => [playlistRowSkeleton(h)],
            onFailure: (error): ReadonlyArray<Html> => [
              requestErrorAlert(error, h),
            ],
            onData: (library): ReadonlyArray<Html> =>
              playlistItems(model, shownPlaylists(model, library), isGrid, h),
          }),
        ],
      ),
    ],
    h,
  )

/** The Playlists chip: every playlist, or that none matches the search. */
const playlistsView = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  Option.exists(
    AsyncData.getData(myLibraryQuery.read(model.myLibrary)),
    library =>
      isSearching(model) &&
      Array.isReadonlyArrayEmpty(shownPlaylists(model, library)),
  )
    ? noMatches(model.librarySearchInput, h)
    : playlistsSection(
        model,
        model.libraryPrefs.layouts.Playlists === 'Grid',
        h,
      )

// ALBUMS AND ARTISTS

const albumItem = (album: AlbumSummary): LibraryItem =>
  albumLibraryItem(album, artistNames(album.artists), artwork =>
    artworkUrl(artwork, LIBRARY_ARTWORK_WIDTH),
  )

const albumsShelf = (
  albums: ReadonlyArray<AlbumSummary>,
  h: HtmlBuilder<Message>,
): Html =>
  shelf(
    {
      title: 'Albums',
      items: albums,
      toKey: ({ id }) => id,
      toCard: albumCard,
    },
    h,
  )

const artistsShelf = (
  artists: ReadonlyArray<ArtistSummary>,
  h: HtmlBuilder<Message>,
): Html =>
  shelf(
    {
      title: 'Artists',
      items: artists,
      toKey: ({ id }) => id,
      toCard: artistCard,
    },
    h,
  )

/**
 * Every saved album, as a grid of covers two across or as a list, or that
 * none matches the search.
 */
const albumsView = (
  model: PageModel,
  library: MyLibrary,
  h: HtmlBuilder<Message>,
): Html =>
  isSearching(model) && Array.isReadonlyArrayEmpty(shownAlbums(model, library))
    ? noMatches(model.librarySearchInput, h)
    : model.libraryPrefs.layouts.Albums === 'List'
      ? Array.match(shownAlbums(model, library), {
          onEmpty: () => albumsGrid([], h),
          onNonEmpty: albums =>
            list(albums, { toKey: ({ id }) => id, toRow: albumRow }, h),
        })
      : albumsGrid(shownAlbums(model, library), h)

const albumsGrid = (
  albums: ReadonlyArray<AlbumSummary>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(albums, {
    onEmpty: () =>
      emptyState(
        {
          title: 'No albums yet',
          description:
            'Open an album and tap + at the top to save it to your Library.',
          kind: 'Album',
        },
        h,
      ),
    onNonEmpty: albums =>
      h.div(
        [h.Role('list'), h.Class('grid grid-cols-2 gap-x-3 gap-y-5 px-4')],
        Array.map(albums, album =>
          h.keyed('div')(
            album.id,
            [h.Role('listitem'), h.Class('min-w-0')],
            [albumTile(albumItem(album), h)],
          ),
        ),
      ),
  })

const artistsList = (
  model: PageModel,
  library: MyLibrary,
  h: HtmlBuilder<Message>,
): Html =>
  isSearching(model) && Array.isReadonlyArrayEmpty(shownArtists(model, library))
    ? noMatches(model.librarySearchInput, h)
    : artistsListOf(shownArtists(model, library), h)

const artistsListOf = (
  artists: ReadonlyArray<ArtistSummary>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(artists, {
    onEmpty: () =>
      emptyState(
        {
          title: 'No artists yet',
          description:
            'Open an artist and tap Follow to keep them in your Library.',
          kind: 'Artist',
        },
        h,
      ),
    onNonEmpty: artists =>
      list(artists, { toKey: ({ id }) => id, toRow: artistRow }, h),
  })

// PAGE

/** Renders the saved albums or artists, waiting for the Library to load. */
const whenLoaded = (
  model: PageModel,
  render: (library: MyLibrary) => Html,
  h: HtmlBuilder<Message>,
): Html =>
  AsyncData.matchData(myLibraryQuery.read(model.myLibrary), {
    onEmpty: () => loadingRows(h),
    onFailure: error => requestErrorAlert(error, h),
    onData: render,
  })

/** Whether a search has left nothing at all to show under All. */
const isAllEmptyForSearch = (model: PageModel, library: MyLibrary): boolean =>
  isSearching(model) &&
  Array.isReadonlyArrayEmpty(shownPlaylists(model, library)) &&
  Array.isReadonlyArrayEmpty(shownAlbums(model, library)) &&
  Array.isReadonlyArrayEmpty(shownArtists(model, library)) &&
  Array.isReadonlyArrayEmpty(shownRecentlyViewed(model)) &&
  (model.downloads._tag !== 'Ready' ||
    Array.isReadonlyArrayEmpty(shownDownloads(model, model.downloads)))

/**
 * Everything: my playlists, saved albums and followed artists in their own
 * orders, downloads, and what was opened lately, each narrowed by the
 * search. A section the search empties goes.
 */
const allContent = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Option.match(AsyncData.getData(myLibraryQuery.read(model.myLibrary)), {
    onNone: (): ReadonlyArray<Html> => [
      playlistsSection(model, false, h),
      matchingDownloadsSection(model, h),
      recentlyViewedSection(shownRecentlyViewed(model), h),
    ],
    onSome: (library): ReadonlyArray<Html> =>
      isAllEmptyForSearch(model, library)
        ? [noMatches(model.librarySearchInput, h)]
        : [
            isSearching(model) &&
            Array.isReadonlyArrayEmpty(shownPlaylists(model, library))
              ? h.empty
              : playlistsSection(model, false, h),
            albumsShelf(shownAlbums(model, library), h),
            artistsShelf(shownArtists(model, library), h),
            matchingDownloadsSection(model, h),
            recentlyViewedSection(shownRecentlyViewed(model), h),
          ],
  })

const libraryContent = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Match.value(model.libraryFilter).pipe(
    Match.withReturnType<ReadonlyArray<Html>>(),
    Match.when('All', () => allContent(model, h)),
    Match.when('Playlists', () => [playlistsView(model, h)]),
    Match.when('Albums', () => [
      whenLoaded(model, library => albumsView(model, library, h), h),
    ]),
    Match.when('Artists', () => [
      whenLoaded(model, library => artistsList(model, library, h), h),
    ]),
    Match.when('Downloaded', () => [downloadsView(model, h)]),
    Match.exhaustive,
  )

/**
 * Library: my playlists, the albums I saved and the artists I follow, kept
 * on the server, then what I opened lately on this phone. A search field
 * narrows it, chips pick one kind, and each kind keeps its own order and,
 * for playlists and albums, grid or list.
 */
export const libraryView = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  ...largeTitleHeader('Library', h.empty, h),
  h.div(
    [h.Class('flex flex-col gap-6 pt-1 pb-6')],
    [
      searchField(model.librarySearchInput, h),
      filterChips(model.libraryFilter, model.downloads._tag === 'Ready', h),
      toolbar(model, h),
      h.div([h.Class('flex flex-col gap-8')], libraryContent(model, h)),
    ],
  ),
]
