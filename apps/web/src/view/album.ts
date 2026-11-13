import { Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { downloadStatus } from '../downloads/domain'
import { Message } from '../message'
import { collectionView } from './collection'
import { albumData } from './offlineData'
import { type PageModel } from './page'
import {
  artistLinks,
  artistNames,
  joinDetails,
  loadingPage,
  remote,
} from './shared'

const formatLengthSummary = (summary: string): string =>
  summary.replaceAll(' • ', ' · ')

/** The album page: cover, credits, and the numbered tracklist. */
export const albumView = (
  model: PageModel,
  albumId: string,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    albumData(model, albumId),
    {
      missing: 'album',
      onLoading: () => loadingPage(h),
      onData: ({
        album,
        maybeDescription,
        maybeLengthSummary,
        tracks,
        explicitVideoIds,
        maybeRadio,
      }) =>
        collectionView(
          {
            title: album.title,
            artwork: album.artwork,
            credits: artistLinks(album.artists, 'active:opacity-60', h),
            details: joinDetails([
              Option.getOrElse(album.maybeKind, () => ''),
              Option.getOrElse(album.maybeYear, () => ''),
            ]),
            maybeDescription,
            download: downloadStatus(model.downloads, 'Album', album.id),
          },
          {
            tracks,
            isNumbered: true,
            footer: Option.match(maybeLengthSummary, {
              onNone: () => '',
              onSome: formatLengthSummary,
            }),
            playing: model.playing,
            swipe: model.swipe,
            maybeAlbumContext: Option.some({
              artistNames: artistNames(album.artists),
              explicitVideoIds,
            }),
            maybeRadio,
            maybePlayingFrom: Option.some({
              kind: 'Album',
              title: album.title,
              id: album.id,
            }),
          },
          h,
        ),
    },
    h,
  )
