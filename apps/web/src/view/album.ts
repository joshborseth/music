import { Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../message'
import { albumQuery } from '../query'
import { collectionView } from './collection'
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
    albumQuery.read(model.albums, { albumId }),
    {
      onLoading: () => loadingPage(h),
      onData: ({
        album,
        maybeDescription,
        maybeLengthSummary,
        tracks,
        explicitVideoIds,
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
          },
          h,
        ),
    },
    h,
  )
