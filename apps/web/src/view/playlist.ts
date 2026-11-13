import { Array, Option, pipe } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { type Artwork, type PlaylistDetails, Session } from '@music/shared'

import { downloadStatus } from '../downloads/domain'
import { Message } from '../message'
import {
  HERO_ARTWORK_CLASS,
  HERO_ARTWORK_WIDTH,
  collectionView,
} from './collection'
import { playlistData } from './offlineData'
import { type PageModel } from './page'
import {
  ArtworkShape,
  MOSAIC_COVERS,
  artistLinks,
  coverMosaic,
  joinDetails,
  loadingPage,
  remote,
} from './shared'

const formatLengthSummary = (summary: string): string =>
  summary.replaceAll(' • ', ' · ')

/** One image whatever its size: Google's image links end in `=w120-h120…`. */
const imageKey = (artwork: Artwork): Option.Option<string> =>
  Option.map(Array.head(artwork), ({ url }) => url.split(/[=?]/)[0] ?? url)

/**
 * The covers to show two by two when the playlist only borrows one of its
 * songs' covers, as an artist's Top songs does: its own cover is the same
 * image as one of its songs', and its songs come from four albums or more.
 * None when the playlist has a cover of its own.
 */
export const borrowedCoverMosaic = (
  details: PlaylistDetails,
): Option.Option<ReadonlyArray<Artwork>> =>
  Option.flatMap(imageKey(details.playlist.artwork), playlistKey => {
    const covers = pipe(
      details.tracks,
      Array.map(({ artwork }) =>
        Option.map(imageKey(artwork), key => ({ key, artwork })),
      ),
      Array.getSomes,
      Array.dedupeWith((left, right) => left.key === right.key),
    )
    const isBorrowed = Array.some(covers, ({ key }) => key === playlistKey)
    return isBorrowed && covers.length >= MOSAIC_COVERS
      ? Option.some(
          Array.map(
            Array.take(covers, MOSAIC_COVERS),
            ({ artwork }) => artwork,
          ),
        )
      : Option.none()
  })

/**
 * Who made the playlist, in the accent color only when it opens their
 * artist page. Anyone else (YouTube Music, someone's channel) is plain text
 * in the details, as is "Playlist · 2024" when nobody is named.
 */
const playlistHeaderLines = (
  details: PlaylistDetails,
  h: HtmlBuilder<Message>,
): Readonly<{ credits: ReadonlyArray<Html | string>; details: string }> => {
  const lengthSummary = Option.match(details.maybeLengthSummary, {
    onNone: () => '',
    onSome: formatLengthSummary,
  })
  return Option.match(details.maybeOwner, {
    onNone: () => ({
      credits: [],
      details: joinDetails([
        Option.getOrElse(details.playlist.maybeSubtitle, () => 'Playlist'),
        lengthSummary,
      ]),
    }),
    onSome: owner =>
      Option.isSome(owner.maybeId)
        ? {
            credits: artistLinks([owner], 'active:opacity-60', h),
            details: lengthSummary,
          }
        : {
            credits: [],
            details: joinDetails([owner.name, lengthSummary]),
          },
  })
}

/**
 * The playlist page: cover, title, who made it, how many songs and how
 * long, its description, and its songs in order.
 */
export const playlistView = (
  model: PageModel,
  playlistId: string,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    playlistData(model, playlistId),
    {
      missing: 'playlist',
      onLoading: () => loadingPage(h),
      onData: details => {
        const lines = playlistHeaderLines(details, h)
        return collectionView(
          {
            title: details.playlist.title,
            artwork: details.playlist.artwork,
            maybeCover: Option.map(borrowedCoverMosaic(details), covers =>
              coverMosaic(
                {
                  covers,
                  displayWidth: HERO_ARTWORK_WIDTH,
                  shape: ArtworkShape.Card,
                  className: HERO_ARTWORK_CLASS,
                  isEager: true,
                },
                h,
              ),
            ),
            credits: lines.credits,
            details: lines.details,
            maybeDescription: details.maybeDescription,
            download: downloadStatus(
              model.downloads,
              'Playlist',
              details.playlist.id,
            ),
          },
          {
            tracks: details.tracks,
            isNumbered: false,
            footer: '',
            playing: model.playing,
            swipe: model.swipe,
            maybePlayingFrom: Option.some({
              kind: Session.isRadioPlaylistId(details.playlist.id)
                ? 'Mix'
                : 'Playlist',
              title: details.playlist.title,
              id: details.playlist.id,
            }),
          },
          h,
        )
      },
    },
    h,
  )
