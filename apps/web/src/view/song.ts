import { Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { badge } from '@/components/ui/badge'
import { type SongDetails } from '@music/shared'

import { Message } from '../message'
import { Model } from '../model'
import { songQuery } from '../query'
import {
  ArtworkShape,
  albumLink,
  artistLinks,
  artworkImage,
  formatDuration,
  formatViews,
  loadingPage,
  remote,
  rowList,
  section,
  songRow,
} from './shared'

const HERO_ARTWORK_WIDTH = 288

const lyricsSection = (details: SongDetails, h: HtmlBuilder<Message>): Html =>
  Option.match(details.maybeLyrics, {
    onNone: () => h.empty,
    onSome: lyrics =>
      section(
        'Lyrics',
        [
          h.p(
            [h.Class('text-base leading-relaxed whitespace-pre-line')],
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
        h,
      ),
  })

const songHeader = (details: SongDetails, h: HtmlBuilder<Message>): Html => {
  const { song } = details
  return h.header(
    [h.Class('flex flex-col items-center gap-3 text-center')],
    [
      artworkImage(
        {
          artwork: song.artwork,
          displayWidth: HERO_ARTWORK_WIDTH,
          shape: ArtworkShape.Square,
          className: 'size-72 max-w-full shadow-lg',
          isEager: true,
        },
        h,
      ),
      h.h1([h.Class('text-2xl font-bold tracking-tight')], [song.title]),
      h.p([h.Class('text-base font-medium')], artistLinks(song.artists, h)),
      Option.match(song.maybeAlbum, {
        onNone: () => h.empty,
        onSome: album =>
          h.p(
            [h.Class('text-muted-foreground text-sm')],
            ['From ', albumLink(album, h)],
          ),
      }),
      h.div(
        [h.Class('flex flex-wrap justify-center gap-2')],
        [
          Option.match(song.maybeDurationSeconds, {
            onNone: () => h.empty,
            onSome: seconds =>
              badge({ variant: 'secondary' }, [formatDuration(seconds)], h),
          }),
          Option.match(details.maybeViewCount, {
            onNone: () => h.empty,
            onSome: viewCount =>
              badge({ variant: 'secondary' }, [formatViews(viewCount)], h),
          }),
        ],
      ),
    ],
  )
}

/** The song page: artwork, credits, lyrics, and songs that play next. */
export const songView = (
  model: Model,
  videoId: string,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    songQuery.read(model.songs, { videoId }),
    {
      onLoading: () => loadingPage(h),
      onData: details =>
        h.div(
          [h.Class('flex flex-col gap-8')],
          [
            songHeader(details, h),
            lyricsSection(details, h),
            rowList(
              {
                title: 'Up next',
                items: details.relatedSongs,
                toKey: song => song.videoId,
                toRow: (song, h) =>
                  songRow(
                    {
                      song,
                      maybeTrackNumber: Option.none(),
                      isAlbumHidden: false,
                    },
                    h,
                  ),
              },
              h,
            ),
          ],
        ),
    },
    h,
  )
