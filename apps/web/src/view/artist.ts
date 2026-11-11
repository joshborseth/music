import { Array, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { type ArtistDetails } from '@music/shared'

import { Message } from '../message'
import { Model } from '../model'
import { artistQuery } from '../query'
import {
  ArtworkShape,
  albumCard,
  artistCard,
  artworkImage,
  loadingPage,
  playActions,
  playFrom,
  remote,
  rowList,
  shelf,
  songRow,
} from './shared'

const HERO_ARTWORK_WIDTH = 192

const description = (
  maybeDescription: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeDescription, {
    onNone: () => h.empty,
    onSome: text =>
      h.details(
        [h.Class('group text-muted-foreground text-sm')],
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
  })

const artistHeader = (details: ArtistDetails, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('flex flex-col items-center gap-3 text-center')],
    [
      artworkImage(
        {
          artwork: details.artist.artwork,
          displayWidth: HERO_ARTWORK_WIDTH,
          shape: ArtworkShape.Round,
          className: 'size-48 shadow-lg',
          isEager: true,
        },
        h,
      ),
      h.h1(
        [h.Class('text-3xl font-bold tracking-tight')],
        [details.artist.name],
      ),
      description(details.maybeDescription, h),
    ],
  )

/** The artist page: photo, bio, top songs, releases, similar artists. */
export const artistView = (
  model: Model,
  artistId: string,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    artistQuery.read(model.artists, { artistId }),
    {
      onLoading: () => loadingPage(h),
      onData: details =>
        h.div(
          [h.Class('flex flex-col gap-8')],
          [
            artistHeader(details, h),
            Array.isReadonlyArrayNonEmpty(details.topSongs)
              ? playActions(details.topSongs, h)
              : h.empty,
            rowList(
              {
                title: 'Top songs',
                items: details.topSongs,
                toKey: song => song.videoId,
                toRow: (song, h) =>
                  songRow(
                    {
                      song,
                      maybeTrackNumber: Option.none(),
                      isAlbumHidden: false,
                      swipe: model.swipe,
                      maybeOnPlay: Option.some(
                        playFrom(details.topSongs, song.videoId),
                      ),
                    },
                    h,
                  ),
              },
              h,
            ),
            shelf(
              {
                title: 'Albums',
                items: details.albums,
                toKey: album => album.id,
                toCard: albumCard,
              },
              h,
            ),
            shelf(
              {
                title: 'Singles & EPs',
                items: details.singles,
                toKey: album => album.id,
                toCard: albumCard,
              },
              h,
            ),
            shelf(
              {
                title: 'Fans also like',
                items: details.similarArtists,
                toKey: artist => artist.id,
                toCard: artistCard,
              },
              h,
            ),
          ],
        ),
    },
    h,
  )
