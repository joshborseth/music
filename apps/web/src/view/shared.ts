import { Array, Option, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import {
  CircleAlert,
  Disc3,
  ListEnd,
  ListStart,
  Music,
  Play,
  RotateCw,
  User,
} from 'lucide'

import { Alert } from '@/components/ui/alert'
import { button } from '@/components/ui/button'
import { Empty } from '@/components/ui/empty'
import { Item } from '@/components/ui/item'
import { skeleton } from '@/components/ui/skeleton'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  type AlbumLink,
  type AlbumSummary,
  type ArtistLink,
  type ArtistSummary,
  type Artwork,
  type Song,
} from '@music/shared'

import { Message } from '../message'
import { type RequestError } from '../query'
import { albumRouter, artistRouter, songRouter } from '../route'

// FORMATTING

const SECONDS_PER_MINUTE = 60

/** `270` → `4:30`. */
export const formatDuration = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

/** `168462775` → `168.5M views`. */
export const formatViews = (viewCount: number): string =>
  `${compactNumber.format(viewCount)} views`

/** Joins the non-empty parts with a middle dot. */
export const joinDetails = (parts: ReadonlyArray<string>): string =>
  pipe(
    parts,
    Array.filter(part => part.length > 0),
    Array.join(' · '),
  )

export const artistNames = (artists: ReadonlyArray<ArtistLink>): string =>
  pipe(
    artists,
    Array.map(({ name }) => name),
    Array.join(', '),
  )

// LINKS

export const songHref = (videoId: string): string => songRouter({ videoId })

export const artistHref = (artistId: string): string =>
  artistRouter({ artistId })

export const albumHref = (albumId: string): string => albumRouter({ albumId })

const linkClass = 'hover:underline underline-offset-4'

/** Artist credits, each linking to its artist page when it has one. */
export const artistLinks = (
  artists: ReadonlyArray<ArtistLink>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> =>
  pipe(
    artists,
    Array.map(artist =>
      Option.match(artist.maybeId, {
        onNone: (): Html | string => artist.name,
        onSome: artistId =>
          h.a(
            [h.Href(artistHref(artistId)), h.Class(linkClass)],
            [artist.name],
          ),
      }),
    ),
    Array.intersperse(', '),
  )

export const albumLink = (album: AlbumLink, h: HtmlBuilder<Message>): Html =>
  h.a([h.Href(albumHref(album.id)), h.Class(linkClass)], [album.name])

// ARTWORK

const RETINA_SCALE = 2

/** The smallest image at least `displayWidth` pixels wide on a retina screen. */
export const artworkUrl = (
  artwork: Artwork,
  displayWidth: number,
): Option.Option<string> =>
  pipe(
    Array.findFirst(
      artwork,
      ({ width }) => width >= displayWidth * RETINA_SCALE,
    ),
    Option.orElse(() => Array.last(artwork)),
    Option.map(({ url }) => url),
  )

export const ArtworkShape = {
  Square: 'rounded-md',
  Round: 'rounded-full',
} as const
export type ArtworkShape = (typeof ArtworkShape)[keyof typeof ArtworkShape]

type ArtworkConfig = Readonly<{
  artwork: Artwork
  displayWidth: number
  shape: ArtworkShape
  className: string
  isEager?: boolean
}>

/** An image with a placeholder for items that have no artwork. */
export const artworkImage = (
  config: ArtworkConfig,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(artworkUrl(config.artwork, config.displayWidth), {
    onNone: () =>
      h.div(
        [
          h.Class(
            cn(
              'bg-muted text-muted-foreground flex shrink-0 items-center justify-center',
              config.shape,
              config.className,
            ),
          ),
        ],
        [icon(h, Music, 'size-1/3')],
      ),
    onSome: url =>
      h.img([
        h.Src(url),
        h.Alt(''),
        h.Loading(config.isEager === true ? 'eager' : 'lazy'),
        h.Decoding('async'),
        h.Referrerpolicy('no-referrer'),
        h.Class(
          cn('bg-muted shrink-0 object-cover', config.shape, config.className),
        ),
      ]),
  })

// ROWS

const ROW_ARTWORK_WIDTH = 48

const rowLink = (href: string, row: Html, h: HtmlBuilder<Message>): Html =>
  h.a([h.Href(href), h.Class('block rounded-lg')], [row])

const rowClass = 'hover:bg-muted/60 active:bg-muted px-2 py-2'

type SongRowConfig = Readonly<{
  song: Song
  maybeTrackNumber: Option.Option<number>
  isAlbumHidden: boolean
  /** Adds a play button beside the row that sends this Message. */
  maybeOnPlay: Option.Option<Message>
}>

/** A song in a list: artwork or track number, title, credits, length. */
export const songRow = (
  config: SongRowConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const { song } = config
  const details = joinDetails([
    artistNames(song.artists),
    config.isAlbumHidden
      ? ''
      : Option.match(song.maybeAlbum, {
          onNone: () => '',
          onSome: ({ name }) => name,
        }),
  ])

  const media = Option.match(config.maybeTrackNumber, {
    onNone: () =>
      Item.media(
        { variant: 'image', className: 'size-12' },
        [
          artworkImage(
            {
              artwork: song.artwork,
              displayWidth: ROW_ARTWORK_WIDTH,
              shape: ArtworkShape.Square,
              className: 'size-12',
            },
            h,
          ),
        ],
        h,
      ),
    onSome: trackNumber =>
      Item.media(
        { className: 'text-muted-foreground w-6 tabular-nums' },
        [trackNumber.toString()],
        h,
      ),
  })

  const row = rowLink(
    songHref(song.videoId),
    Item(
      { size: 'sm', className: rowClass },
      [
        media,
        Item.content(
          { className: 'min-w-0' },
          [
            Item.title({ className: 'line-clamp-1' }, [song.title], h),
            Item.description({ className: 'line-clamp-1' }, [details], h),
          ],
          h,
        ),
        Option.match(song.maybeDurationSeconds, {
          onNone: () => h.empty,
          onSome: seconds =>
            Item.actions(
              { className: 'text-muted-foreground text-xs tabular-nums' },
              [formatDuration(seconds)],
              h,
            ),
        }),
      ],
      h,
    ),
    h,
  )

  return Option.match(config.maybeOnPlay, {
    onNone: () => row,
    onSome: onPlay =>
      h.div(
        [h.Class('flex items-center gap-1')],
        [
          h.div([h.Class('min-w-0 flex-1')], [row]),
          button(
            {
              onClick: onPlay,
              variant: 'ghost',
              size: 'icon-lg',
              className: 'text-muted-foreground rounded-full',
            },
            [
              icon(h, Play, 'size-4'),
              h.span([h.Class('sr-only')], [`Play ${song.title}`]),
            ],
            h,
          ),
        ],
      ),
  })
}

/** Play these songs now, next, or after everything queued. */
export const playActions = (
  songs: ReadonlyArray<Song>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-wrap justify-center gap-2')],
    [
      button(
        {
          onClick: Message.ClickedPlaySongs({ songs, startIndex: 0 }),
          className: 'rounded-full px-5',
        },
        [icon(h, Play, 'size-4'), 'Play'],
        h,
      ),
      button(
        {
          onClick: Message.ClickedEnqueueSongs({ songs, placement: 'Next' }),
          variant: 'secondary',
          className: 'rounded-full',
        },
        [icon(h, ListStart, 'size-4'), 'Play next'],
        h,
      ),
      button(
        {
          onClick: Message.ClickedEnqueueSongs({ songs, placement: 'Last' }),
          variant: 'secondary',
          className: 'rounded-full',
        },
        [icon(h, ListEnd, 'size-4'), 'Add to queue'],
        h,
      ),
    ],
  )

/** Play `songs` from the one with this id. */
export const playFrom = (
  songs: ReadonlyArray<Song>,
  videoId: string,
): Message =>
  Message.ClickedPlaySongs({
    songs,
    startIndex: Option.getOrElse(
      Array.findFirstIndex(songs, song => song.videoId === videoId),
      () => 0,
    ),
  })

/** An artist in a list: round photo, name, audience. */
export const artistRow = (
  artist: ArtistSummary,
  h: HtmlBuilder<Message>,
): Html =>
  rowLink(
    artistHref(artist.id),
    Item(
      { size: 'sm', className: rowClass },
      [
        Item.media(
          { variant: 'image', className: 'size-12 rounded-full' },
          [
            artworkImage(
              {
                artwork: artist.artwork,
                displayWidth: ROW_ARTWORK_WIDTH,
                shape: ArtworkShape.Round,
                className: 'size-12',
              },
              h,
            ),
          ],
          h,
        ),
        Item.content(
          { className: 'min-w-0' },
          [
            Item.title({}, [artist.name], h),
            Option.match(artist.maybeAudience, {
              onNone: () => h.empty,
              onSome: audience => Item.description({}, [audience], h),
            }),
          ],
          h,
        ),
      ],
      h,
    ),
    h,
  )

const albumDetails = (album: AlbumSummary): string =>
  joinDetails([
    Option.getOrElse(album.maybeKind, () => ''),
    artistNames(album.artists),
    Option.getOrElse(album.maybeYear, () => ''),
  ])

/** An album in a list: cover, title, kind, artists, year. */
export const albumRow = (album: AlbumSummary, h: HtmlBuilder<Message>): Html =>
  rowLink(
    albumHref(album.id),
    Item(
      { size: 'sm', className: rowClass },
      [
        Item.media(
          { variant: 'image', className: 'size-12' },
          [
            artworkImage(
              {
                artwork: album.artwork,
                displayWidth: ROW_ARTWORK_WIDTH,
                shape: ArtworkShape.Square,
                className: 'size-12',
              },
              h,
            ),
          ],
          h,
        ),
        Item.content(
          { className: 'min-w-0' },
          [
            Item.title({ className: 'line-clamp-1' }, [album.title], h),
            Item.description(
              { className: 'line-clamp-1' },
              [albumDetails(album)],
              h,
            ),
          ],
          h,
        ),
      ],
      h,
    ),
    h,
  )

// CARDS

const CARD_ARTWORK_WIDTH = 144

/** An album cover card for a horizontal shelf. */
export const albumCard = (album: AlbumSummary, h: HtmlBuilder<Message>): Html =>
  h.a(
    [
      h.Href(albumHref(album.id)),
      h.Class('flex w-36 shrink-0 snap-start flex-col gap-1.5'),
    ],
    [
      artworkImage(
        {
          artwork: album.artwork,
          displayWidth: CARD_ARTWORK_WIDTH,
          shape: ArtworkShape.Square,
          className: 'size-36',
        },
        h,
      ),
      h.span([h.Class('line-clamp-2 text-sm font-medium')], [album.title]),
      h.span(
        [h.Class('text-muted-foreground text-xs')],
        [
          joinDetails([
            Option.getOrElse(album.maybeKind, () => ''),
            Option.getOrElse(album.maybeYear, () => ''),
          ]),
        ],
      ),
    ],
  )

/** An artist photo card for a horizontal shelf. */
export const artistCard = (
  artist: ArtistSummary,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [
      h.Href(artistHref(artist.id)),
      h.Class('flex w-28 shrink-0 snap-start flex-col items-center gap-1.5'),
    ],
    [
      artworkImage(
        {
          artwork: artist.artwork,
          displayWidth: CARD_ARTWORK_WIDTH,
          shape: ArtworkShape.Round,
          className: 'size-28',
        },
        h,
      ),
      h.span(
        [h.Class('line-clamp-2 text-center text-sm font-medium')],
        [artist.name],
      ),
    ],
  )

/** A titled horizontal row of cards that scrolls sideways. */
export const shelf = <A>(
  config: Readonly<{
    title: string
    items: ReadonlyArray<A>
    toKey: (item: A) => string
    toCard: (item: A, h: HtmlBuilder<Message>) => Html
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(config.items, {
    onEmpty: () => h.empty,
    onNonEmpty: items =>
      section(
        config.title,
        [
          h.div(
            [
              h.Class(
                'no-scrollbar -mx-4 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pb-1',
              ),
            ],
            Array.map(items, item =>
              h.keyed('div')(
                config.toKey(item),
                [h.Class('contents')],
                [config.toCard(item, h)],
              ),
            ),
          ),
        ],
        h,
      ),
  })

/** A titled vertical list of rows. */
export const rowList = <A>(
  config: Readonly<{
    title: string
    items: ReadonlyArray<A>
    toKey: (item: A) => string
    toRow: (item: A, h: HtmlBuilder<Message>) => Html
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(config.items, {
    onEmpty: () => h.empty,
    onNonEmpty: items => section(config.title, [list(items, config, h)], h),
  })

/** Rows keyed by a stable id, without a heading. */
export const list = <A>(
  items: ReadonlyArray<A>,
  config: Readonly<{
    toKey: (item: A) => string
    toRow: (item: A, h: HtmlBuilder<Message>) => Html
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Role('list'), h.Class('-mx-2 flex flex-col')],
    Array.map(items, item =>
      h.keyed('div')(
        config.toKey(item),
        [h.Role('listitem')],
        [config.toRow(item, h)],
      ),
    ),
  )

export const section = (
  title: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('flex flex-col gap-2')],
    [
      h.h2([h.Class('text-lg font-semibold tracking-tight')], [title]),
      ...children,
    ],
  )

// LOADING AND ERRORS

const SKELETON_ROW_COUNT = 8

/** Placeholder rows while a list loads. */
export const loadingRows = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-3 py-2'), h.AriaLabel('Loading')],
    Array.makeBy(SKELETON_ROW_COUNT, () =>
      h.div(
        [h.Class('flex items-center gap-3')],
        [
          skeleton({ className: 'size-12 shrink-0' }, [], h),
          h.div(
            [h.Class('flex flex-1 flex-col gap-2')],
            [
              skeleton({ className: 'h-4 w-3/5' }, [], h),
              skeleton({ className: 'h-3 w-2/5' }, [], h),
            ],
          ),
        ],
      ),
    ),
  )

/** Placeholder for a detail page header and its first rows. */
export const loadingPage = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-6')],
    [
      h.div(
        [h.Class('flex flex-col items-center gap-3')],
        [
          skeleton({ className: 'size-56' }, [], h),
          skeleton({ className: 'h-6 w-48' }, [], h),
          skeleton({ className: 'h-4 w-32' }, [], h),
        ],
      ),
      loadingRows(h),
    ],
  )

const requestErrorText = (error: RequestError): string =>
  ({
    NotFound: 'YouTube Music has nothing at this address.',
    YouTubeUnavailable:
      'YouTube Music did not answer. It may be busy; try again in a moment.',
    ServerUnreachable:
      'Could not reach the music server. Check that it is running.',
  })[error]

/** An error message with a retry button. */
export const requestErrorAlert = (
  error: RequestError,
  h: HtmlBuilder<Message>,
): Html =>
  Alert(
    { variant: 'destructive' },
    [
      icon(h, CircleAlert),
      Alert.title({}, ['Something went wrong'], h),
      Alert.description({}, [requestErrorText(error)], h),
      error === 'NotFound'
        ? h.empty
        : Alert.action(
            {},
            [
              button(
                {
                  onClick: Message.ClickedRetry(),
                  variant: 'outline',
                  size: 'sm',
                },
                [icon(h, RotateCw, 'size-3.5', 'inline-start'), 'Retry'],
                h,
              ),
            ],
            h,
          ),
    ],
    h,
  )

/** Renders remote data with shared loading and error states. */
export const remote = <A>(
  asyncData: AsyncData.AsyncData<A, RequestError>,
  config: Readonly<{
    onLoading: () => Html
    onData: (data: A) => Html
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  AsyncData.matchData(asyncData, {
    onEmpty: config.onLoading,
    onFailure: error => requestErrorAlert(error, h),
    onData: config.onData,
  })

const emptyStateIcons = { Song: Music, Artist: User, Album: Disc3 } as const

/** A centered message for empty screens. */
export const emptyState = (
  config: Readonly<{
    title: string
    description: string
    kind: 'Song' | 'Artist' | 'Album'
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  Empty(
    { className: 'py-16' },
    [
      Empty.header(
        {},
        [
          Empty.media(
            { variant: 'icon' },
            [icon(h, emptyStateIcons[config.kind])],
            h,
          ),
          Empty.title({}, [config.title], h),
          Empty.description({}, [config.description], h),
        ],
        h,
      ),
    ],
    h,
  )
