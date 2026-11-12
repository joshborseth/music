import { Array, Match, Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { Disc3, ListMusic, Plus, User } from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { type LibraryItem, songFromQueueTrack } from '../library'
import { Message } from '../message'
import { myLibraryQuery } from '../query'
import { largeTitleHeader } from './chrome'
import { type PageModel } from './page'
import {
  albumHref,
  artistHref,
  myPlaylistRow,
  playlistHref,
  requestErrorAlert,
  section,
  songList,
} from './shared'

const RECENTLY_PLAYED_IN_LIBRARY = 25

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

const libraryCard = (item: LibraryItem, h: HtmlBuilder<Message>): Html => {
  const isArtist = item.kind === 'Artist'
  const shape = isArtist ? 'rounded-full' : 'rounded-xl'
  return h.a(
    [h.Href(libraryItemHref(item)), h.Class('pressable flex min-w-0 flex-col')],
    [
      Option.match(item.maybeArtworkUrl, {
        onNone: () =>
          h.span(
            [
              h.Class(
                cn(
                  'bg-muted text-muted-foreground flex aspect-square w-full items-center justify-center',
                  shape,
                ),
              ),
            ],
            [icon(h, libraryItemIcon(item), 'size-1/3')],
          ),
        onSome: url =>
          h.img([
            h.Src(url),
            h.Alt(''),
            h.Loading('lazy'),
            h.Decoding('async'),
            h.Referrerpolicy('no-referrer'),
            h.Class(cn('bg-muted aspect-square w-full object-cover', shape)),
          ]),
      }),
      h.span(
        [
          h.Class(
            cn(
              'mt-2 line-clamp-1 text-[13px] leading-tight font-medium',
              isArtist && 'text-center',
            ),
          ),
        ],
        [item.title],
      ),
      h.span(
        [
          h.Class(
            cn(
              'text-muted-foreground mt-0.5 line-clamp-1 text-[13px] leading-tight',
              isArtist && 'text-center',
            ),
          ),
        ],
        [item.subtitle],
      ),
    ],
  )
}

const recentlyViewedGrid = (
  items: ReadonlyArray<LibraryItem>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(items, {
    onEmpty: () => h.empty,
    onNonEmpty: items =>
      section(
        'Recently viewed',
        [
          h.div(
            [h.Class('grid grid-cols-2 gap-x-3 gap-y-5 px-4')],
            Array.map(items, item =>
              h.keyed('div')(
                `${item.kind}:${item.id}`,
                [h.Class('min-w-0')],
                [libraryCard(item, h)],
              ),
            ),
          ),
        ],
        h,
      ),
  })

const clearButton = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  Array.isReadonlyArrayEmpty(model.recentlyPlayed) &&
  Array.isReadonlyArrayEmpty(model.recentlyViewed)
    ? h.empty
    : h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedClearLibrary()),
          h.Class('text-primary mb-1.5 text-[17px] active:opacity-50'),
        ],
        ['Clear'],
      )

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

/** My playlists, kept on the server so every device sees the same ones. */
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

/**
 * Library: my playlists, then songs played and pages opened on this
 * device, newest first.
 */
export const libraryView = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  ...largeTitleHeader('Library', clearButton(model, h), h),
  h.div(
    [h.Class('flex flex-col gap-8 pt-2 pb-6')],
    [
      playlistsSection(model, h),
      Array.isReadonlyArrayNonEmpty(model.recentlyPlayed)
        ? section(
            'Recently played',
            [
              songList(
                {
                  songs: Array.map(
                    Array.take(
                      model.recentlyPlayed,
                      RECENTLY_PLAYED_IN_LIBRARY,
                    ),
                    songFromQueueTrack,
                  ),
                  playing: model.playing,
                  swipe: model.swipe,
                  isNumbered: false,
                  isAlbumHidden: false,
                },
                h,
              ),
            ],
            h,
          )
        : h.empty,
      recentlyViewedGrid(model.recentlyViewed, h),
    ],
  ),
]
