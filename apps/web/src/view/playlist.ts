import { Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { type PlaylistDetails } from '@music/shared'

import { downloadStatus } from '../downloads/domain'
import { Message } from '../message'
import { playlistQuery } from '../query'
import { collectionView } from './collection'
import { type PageModel } from './page'
import { artistLinks, joinDetails, loadingPage, remote } from './shared'

const formatLengthSummary = (summary: string): string =>
  summary.replaceAll(' • ', ' · ')

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
    playlistQuery.read(model.playlists, { playlistId }),
    {
      onLoading: () => loadingPage(h),
      onData: details => {
        const lines = playlistHeaderLines(details, h)
        return collectionView(
          {
            title: details.playlist.title,
            artwork: details.playlist.artwork,
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
          },
          h,
        )
      },
    },
    h,
  )
