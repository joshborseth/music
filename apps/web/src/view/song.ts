import { Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { type SongDetails } from '@music/shared'

import { Message } from '../message'
import { SyncTitleBarReveal } from '../mount'
import { songQuery } from '../query'
import { type PageModel } from './page'
import {
  ArtworkShape,
  albumLink,
  artistLinks,
  artworkImage,
  formatDuration,
  formatViews,
  joinDetails,
  loadingPage,
  playActions,
  remote,
  section,
  songSection,
} from './shared'

const HERO_ARTWORK_WIDTH = 256

/** Lyrics in a card, selectable so a line can be copied. */
export const lyricsCard = (
  details: SongDetails,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(details.maybeLyrics, {
    onNone: () => h.empty,
    onSome: lyrics =>
      section(
        'Lyrics',
        [
          h.div(
            [h.Class('bg-card mx-4 flex flex-col gap-3 rounded-2xl p-5')],
            [
              h.p(
                [
                  h.Class(
                    'text-[17px] leading-relaxed font-medium whitespace-pre-line select-text',
                  ),
                ],
                [lyrics.text],
              ),
              Option.match(lyrics.maybeSource, {
                onNone: () => h.empty,
                onSome: source =>
                  h.p(
                    [h.Class('text-muted-foreground text-xs')],
                    [`Lyrics from ${source}`],
                  ),
              }),
            ],
          ),
        ],
        h,
      ),
  })

const songHeader = (details: SongDetails, h: HtmlBuilder<Message>): Html => {
  const { song } = details
  return h.header(
    [
      h.Class(
        'flex flex-col items-center gap-1 px-6 pt-[calc(var(--safe-top)+3.75rem)] text-center',
      ),
    ],
    [
      artworkImage(
        {
          artwork: song.artwork,
          displayWidth: HERO_ARTWORK_WIDTH,
          shape: ArtworkShape.Card,
          className:
            'mb-4 aspect-square w-[64vw] max-w-64 shadow-2xl shadow-black/30',
          isEager: true,
        },
        h,
      ),
      h.h1(
        [
          h.OnMount(SyncTitleBarReveal()),
          h.Class(
            'text-[22px] leading-tight font-bold tracking-tight text-balance',
          ),
        ],
        [song.title],
      ),
      h.p(
        [h.Class('text-primary text-[17px] font-medium')],
        artistLinks(song.artists, 'active:opacity-60', h),
      ),
      Option.match(song.maybeAlbum, {
        onNone: () => h.empty,
        onSome: album =>
          h.p(
            [h.Class('text-muted-foreground text-[15px]')],
            ['From ', albumLink(album, h)],
          ),
      }),
      h.p(
        [h.Class('text-muted-foreground text-[13px] font-medium')],
        [
          joinDetails([
            Option.match(song.maybeDurationSeconds, {
              onNone: () => '',
              onSome: formatDuration,
            }),
            Option.match(details.maybeViewCount, {
              onNone: () => '',
              onSome: formatViews,
            }),
          ]),
        ],
      ),
    ],
  )
}

/** The song page: artwork, credits, lyrics, and songs that play next. */
export const songView = (
  model: PageModel,
  videoId: string,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    songQuery.read(model.songs, { videoId }),
    {
      onLoading: () => loadingPage(h),
      onData: details =>
        h.div(
          [h.Class('flex flex-col gap-8 pb-6')],
          [
            h.div(
              [h.Class('flex flex-col gap-5')],
              [
                songHeader(details, h),
                playActions([details.song, ...details.relatedSongs], h),
              ],
            ),
            lyricsCard(details, h),
            songSection(
              {
                title: 'Up next',
                songs: details.relatedSongs,
                playing: model.playing,
                swipe: model.swipe,
              },
              h,
            ),
          ],
        ),
    },
    h,
  )
