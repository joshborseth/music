import { Array, Match, Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { Disc3, ListMusic, Plus, User } from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { type AlbumSummary, type MyLibrary } from '@music/shared'

import {
  LIBRARY_ARTWORK_WIDTH,
  LIBRARY_FILTER_CHIPS,
  type LibraryFilter,
  type LibraryItem,
  albumLibraryItem,
} from '../library'
import { Message } from '../message'
import { myLibraryQuery } from '../query'
import { largeTitleHeader } from './chrome'
import { type PageModel } from './page'
import {
  albumCard,
  albumHref,
  artistCard,
  artistHref,
  artistNames,
  artistRow,
  artworkUrl,
  emptyState,
  list,
  loadingRows,
  myPlaylistRow,
  playlistHref,
  requestErrorAlert,
  section,
  shelf,
} from './shared'

const RECENTLY_VIEWED_IN_LIBRARY = 10

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
                ['Recently viewed'],
              ),
              h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.ClickedClearRecentlyViewed()),
                  h.AriaLabel('Clear recently viewed'),
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

/** Chips that narrow the Library to one kind of thing; tapped again, back to all. */
const filterChips = (selected: LibraryFilter, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('group'),
      h.AriaLabel('Show'),
      h.Class('no-scrollbar flex gap-2 overflow-x-auto px-4'),
    ],
    Array.map(LIBRARY_FILTER_CHIPS, filter => filterChip(filter, selected, h)),
  )

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

/**
 * My playlists, kept on the server so every device sees the same ones. A
 * new one can be started before they load.
 */
const playlistsSection = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  section(
    'Playlists',
    [
      h.div(
        [h.Role('list'), h.Class('flex flex-col')],
        [
          newPlaylistRow(h),
          ...AsyncData.matchData(myLibraryQuery.read(model.myLibrary), {
            onEmpty: (): ReadonlyArray<Html> => [playlistRowSkeleton(h)],
            onFailure: (error): ReadonlyArray<Html> => [
              requestErrorAlert(error, h),
            ],
            onData: ({ playlists }): ReadonlyArray<Html> =>
              Array.map(playlists, playlist =>
                h.keyed('div')(
                  playlist.id,
                  [h.Role('listitem')],
                  [myPlaylistRow(playlist, h)],
                ),
              ),
          }),
        ],
      ),
    ],
    h,
  )

// ALBUMS AND ARTISTS

const albumItem = (album: AlbumSummary): LibraryItem =>
  albumLibraryItem(album, artistNames(album.artists), artwork =>
    artworkUrl(artwork, LIBRARY_ARTWORK_WIDTH),
  )

const albumsShelf = (library: MyLibrary, h: HtmlBuilder<Message>): Html =>
  shelf(
    {
      title: 'Albums',
      items: library.albums,
      toKey: ({ id }) => id,
      toCard: albumCard,
    },
    h,
  )

const artistsShelf = (library: MyLibrary, h: HtmlBuilder<Message>): Html =>
  shelf(
    {
      title: 'Artists',
      items: library.artists,
      toKey: ({ id }) => id,
      toCard: artistCard,
    },
    h,
  )

/** Every saved album as a grid of covers, two across. */
const albumsGrid = (library: MyLibrary, h: HtmlBuilder<Message>): Html =>
  Array.match(library.albums, {
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

const artistsList = (library: MyLibrary, h: HtmlBuilder<Message>): Html =>
  Array.match(library.artists, {
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

const libraryContent = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Match.value(model.libraryFilter).pipe(
    Match.withReturnType<ReadonlyArray<Html>>(),
    Match.when('All', () => [
      playlistsSection(model, h),
      ...Option.match(AsyncData.getData(myLibraryQuery.read(model.myLibrary)), {
        onNone: (): ReadonlyArray<Html> => [],
        onSome: library => [albumsShelf(library, h), artistsShelf(library, h)],
      }),
      recentlyViewedSection(model.recentlyViewed, h),
    ]),
    Match.when('Playlists', () => [playlistsSection(model, h)]),
    Match.when('Albums', () => [
      whenLoaded(model, library => albumsGrid(library, h), h),
    ]),
    Match.when('Artists', () => [
      whenLoaded(model, library => artistsList(library, h), h),
    ]),
    Match.exhaustive,
  )

/**
 * Library: my playlists, the albums I saved and the artists I follow, kept
 * on the server, then what I opened lately on this phone.
 */
export const libraryView = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  ...largeTitleHeader('Library', h.empty, h),
  h.div(
    [h.Class('flex flex-col gap-6 pt-1 pb-6')],
    [
      filterChips(model.libraryFilter, h),
      h.div([h.Class('flex flex-col gap-8')], libraryContent(model, h)),
    ],
  ),
]
