import { Array, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'
import { CircleArrowDown, LoaderCircle } from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { type Artwork, type RadioStation, type Song } from '@music/shared'

import { DownloadStatus, formatBytes } from '../downloads/domain'
import { Message } from '../message'
import { SyncTitleBarReveal } from '../mount'
import { type Swipe } from '../playback/swipe'
import {
  type AlbumContext,
  ArtworkShape,
  type NowPlaying,
  artworkImage,
  artworkUrl,
  expandableText,
  playActions,
  songList,
} from './shared'

export const HERO_ARTWORK_WIDTH = 256
const BACKDROP_ARTWORK_WIDTH = 120

export const HERO_ARTWORK_CLASS =
  'mb-4 aspect-square w-[64vw] max-w-64 shadow-2xl shadow-black/30'

/**
 * The artwork, blurred into a soft glow behind the top of the page. It
 * starts in the page color at the very top, because iOS fills the status
 * bar above it with that color (see `.status-bar-color` in styles.css).
 */
export const artworkGlow = (artwork: Artwork, h: HtmlBuilder<Message>): Html =>
  Option.match(artworkUrl(artwork, BACKDROP_ARTWORK_WIDTH), {
    onNone: () => h.empty,
    onSome: url =>
      h.div(
        [
          h.AriaHidden(true),
          h.Class(
            'pointer-events-none absolute inset-x-0 top-0 -z-10 h-[28rem] overflow-hidden',
          ),
        ],
        [
          h.img([
            h.Src(url),
            h.Alt(''),
            h.Referrerpolicy('no-referrer'),
            h.Class(
              'size-full scale-150 object-cover opacity-60 blur-3xl saturate-150 dark:opacity-45',
            ),
          ]),
          h.div([
            h.Class(
              'from-background/0 via-background/60 to-background absolute inset-0 bg-gradient-to-b',
            ),
          ]),
          h.div([
            h.Class(
              'from-background to-background/0 absolute inset-x-0 top-0 h-24 bg-gradient-to-b',
            ),
          ]),
        ],
      ),
  })

export type CollectionHeader = Readonly<{
  title: string
  artwork: Artwork
  /** Drawn in place of `artwork`, which then only tints the page. */
  maybeCover?: Option.Option<Html>
  credits: ReadonlyArray<Html | string>
  details: string
  maybeDescription: Option.Option<string>
  /** Whether it is downloaded on this phone, for the badge under the title. */
  download?: DownloadStatus
}>

/**
 * The download badge under the title: how far a download has got, or that
 * it is all on the phone and how much room it takes.
 */
const downloadBadge = (
  status: DownloadStatus,
  h: HtmlBuilder<Message>,
): Html => {
  const badge = (
    iconNode: typeof CircleArrowDown,
    text: string,
    iconClass: string,
  ) =>
    h.p(
      [
        h.Class(
          'text-primary mt-1 flex items-center gap-1.5 text-[13px] font-semibold',
        ),
      ],
      [icon(h, iconNode, cn('size-4', iconClass)), text],
    )
  return DownloadStatus.match(status, {
    Unavailable: () => h.empty,
    NotDownloaded: () => h.empty,
    Downloading: ({ saved, total }) =>
      badge(LoaderCircle, `Downloading ${saved} of ${total}`, 'animate-spin'),
    Incomplete: ({ saved, total }) =>
      badge(CircleArrowDown, `${saved} of ${total} downloaded`, ''),
    Downloaded: ({ bytes }) =>
      badge(CircleArrowDown, `Downloaded · ${formatBytes(bytes)}`, ''),
  })
}

/** An album or playlist: cover, title, who made it, and how to play it. */
export const collectionView = (
  header: CollectionHeader,
  config: Readonly<{
    tracks: ReadonlyArray<Song>
    isNumbered: boolean
    footer: string
    playing: NowPlaying
    swipe: Swipe
    maybeAlbumContext?: Option.Option<AlbumContext>
    maybeRadio?: Option.Option<RadioStation>
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('relative isolate flex flex-col gap-5 pb-6')],
    [
      artworkGlow(header.artwork, h),
      h.header(
        [
          h.Class(
            'flex flex-col items-center gap-1 px-6 pt-[calc(var(--safe-top)+3.75rem)] text-center',
          ),
        ],
        [
          Option.getOrElse(header.maybeCover ?? Option.none(), () =>
            artworkImage(
              {
                artwork: header.artwork,
                displayWidth: HERO_ARTWORK_WIDTH,
                shape: ArtworkShape.Card,
                className: HERO_ARTWORK_CLASS,
                isEager: true,
              },
              h,
            ),
          ),
          h.h1(
            [
              h.OnMount(SyncTitleBarReveal()),
              h.Class(
                'text-[22px] leading-tight font-bold tracking-tight text-balance',
              ),
            ],
            [header.title],
          ),
          Array.isReadonlyArrayEmpty(header.credits)
            ? h.empty
            : h.p(
                [h.Class('text-primary text-[17px] font-medium')],
                header.credits,
              ),
          header.details === ''
            ? h.empty
            : h.p(
                [h.Class('text-muted-foreground text-[13px] font-medium')],
                [header.details],
              ),
          header.download === undefined
            ? h.empty
            : downloadBadge(header.download, h),
        ],
      ),
      playActions(config.tracks, h, config.maybeRadio ?? Option.none()),
      Option.match(header.maybeDescription, {
        onNone: () => h.empty,
        onSome: text => expandableText(text, h),
      }),
      h.section(
        [h.AriaLabel('Tracks'), h.Class('border-t')],
        [
          songList(
            {
              songs: config.tracks,
              playing: config.playing,
              swipe: config.swipe,
              isNumbered: config.isNumbered,
              isAlbumHidden: true,
              maybeAlbumContext: config.maybeAlbumContext ?? Option.none(),
            },
            h,
          ),
        ],
      ),
      config.footer === ''
        ? h.empty
        : h.p(
            [h.Class(cn('text-muted-foreground px-4 text-[13px]'))],
            [config.footer],
          ),
    ],
  )
