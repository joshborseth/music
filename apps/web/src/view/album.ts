import { Array, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { type AlbumDetails } from '@music/shared'

import { Message } from '../message'
import { Model } from '../model'
import { albumQuery } from '../query'
import {
  ArtworkShape,
  artistLinks,
  artworkImage,
  joinDetails,
  list,
  loadingPage,
  playActions,
  remote,
  section,
  songRow,
} from './shared'

const HERO_ARTWORK_WIDTH = 256

const albumHeader = (details: AlbumDetails, h: HtmlBuilder<Message>): Html => {
  const { album } = details
  return h.header(
    [h.Class('flex flex-col items-center gap-3 text-center')],
    [
      artworkImage(
        {
          artwork: album.artwork,
          displayWidth: HERO_ARTWORK_WIDTH,
          shape: ArtworkShape.Square,
          className: 'size-64 max-w-full shadow-lg',
          isEager: true,
        },
        h,
      ),
      h.h1([h.Class('text-2xl font-bold tracking-tight')], [album.title]),
      h.p([h.Class('text-base font-medium')], artistLinks(album.artists, h)),
      h.p(
        [h.Class('text-muted-foreground text-sm')],
        [
          joinDetails([
            Option.getOrElse(album.maybeKind, () => ''),
            Option.getOrElse(album.maybeYear, () => ''),
            Option.match(details.maybeLengthSummary, {
              onNone: () => '',
              onSome: summary => summary.replaceAll(' • ', ' · '),
            }),
          ]),
        ],
      ),
      Option.match(details.maybeDescription, {
        onNone: () => h.empty,
        onSome: text =>
          h.details(
            [h.Class('group text-muted-foreground text-left text-sm')],
            [
              h.summary(
                [
                  h.Class(
                    'line-clamp-3 cursor-pointer list-none group-open:line-clamp-none [&::-webkit-details-marker]:hidden',
                  ),
                ],
                [text],
              ),
            ],
          ),
      }),
    ],
  )
}

type NumberedTrack = Readonly<{
  trackNumber: number
  song: AlbumDetails['tracks'][number]
}>

/** The album page: cover, credits, and the numbered tracklist. */
export const albumView = (
  model: Model,
  albumId: string,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    albumQuery.read(model.albums, { albumId }),
    {
      onLoading: () => loadingPage(h),
      onData: details =>
        h.div(
          [h.Class('flex flex-col gap-8')],
          [
            albumHeader(details, h),
            playActions(details.tracks, h),
            section(
              'Tracks',
              [
                list<NumberedTrack>(
                  Array.map(details.tracks, (song, index) => ({
                    trackNumber: index + 1,
                    song,
                  })),
                  {
                    toKey: ({ song }) => song.videoId,
                    toRow: ({ song, trackNumber }, h) =>
                      songRow(
                        {
                          song,
                          maybeTrackNumber: Option.some(trackNumber),
                          isAlbumHidden: true,
                          maybeOnPlay: Option.some(
                            Message.ClickedPlaySongs({
                              songs: details.tracks,
                              startIndex: trackNumber - 1,
                            }),
                          ),
                        },
                        h,
                      ),
                  },
                  h,
                ),
              ],
              h,
            ),
          ],
        ),
    },
    h,
  )
