import { Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../message'
import { playlistQuery } from '../query'
import { collectionView } from './collection'
import { type PageModel } from './page'
import { loadingPage, remote } from './shared'

/** The playlist page: cover, title, and its songs in order. */
export const playlistView = (
  model: PageModel,
  playlistId: string,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    playlistQuery.read(model.playlists, { playlistId }),
    {
      onLoading: () => loadingPage(h),
      onData: ({ playlist, maybeDescription, maybeLengthSummary, tracks }) =>
        collectionView(
          {
            title: playlist.title,
            artwork: playlist.artwork,
            credits: [
              Option.getOrElse(playlist.maybeSubtitle, () => 'Playlist'),
            ],
            details: '',
            maybeDescription,
          },
          {
            tracks,
            isNumbered: false,
            footer: Option.match(maybeLengthSummary, {
              onNone: () => '',
              onSome: summary => summary.replaceAll(' • ', ' · '),
            }),
            playing: model.playing,
            swipe: model.swipe,
          },
          h,
        ),
    },
    h,
  )
