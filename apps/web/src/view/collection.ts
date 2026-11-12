import { Array, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { cn } from '@/lib/utils'
import { type Artwork, type Song } from '@music/shared'

import { Message } from '../message'
import { SyncTitleBarReveal } from '../mount'
import { type Swipe } from '../playback/swipe'
import {
  ArtworkShape,
  type NowPlaying,
  artworkImage,
  expandableText,
  playActions,
  songList,
} from './shared'

export const HERO_ARTWORK_WIDTH = 256

export const HERO_ARTWORK_CLASS =
  'mb-4 aspect-square w-[64vw] max-w-64 shadow-2xl shadow-black/30'

export type CollectionHeader = Readonly<{
  title: string
  artwork: Artwork
  /** Drawn in place of `artwork`. */
  maybeCover?: Option.Option<Html>
  credits: ReadonlyArray<Html | string>
  details: string
  maybeDescription: Option.Option<string>
}>

/** An album or playlist: cover, title, who made it, and how to play it. */
export const collectionView = (
  header: CollectionHeader,
  config: Readonly<{
    tracks: ReadonlyArray<Song>
    isNumbered: boolean
    footer: string
    playing: NowPlaying
    swipe: Swipe
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-5 pb-6')],
    [
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
        ],
      ),
      playActions(config.tracks, h),
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
