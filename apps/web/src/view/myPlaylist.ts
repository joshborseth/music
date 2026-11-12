import { Array, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../message'
import { myPlaylistQuery } from '../query'
import {
  HERO_ARTWORK_CLASS,
  HERO_ARTWORK_WIDTH,
  collectionView,
} from './collection'
import { type PageModel } from './page'
import {
  ArtworkShape,
  emptyState,
  loadingPage,
  playlistCover,
  playlistLength,
  remote,
} from './shared'

/** One of my playlists: its cover, its songs, and how to play them. */
export const myPlaylistView = (
  model: PageModel,
  playlistId: string,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    myPlaylistQuery.read(model.myPlaylists, { playlistId }),
    {
      onLoading: () => loadingPage(h),
      onData: ({ playlist, songs }) =>
        h.div(
          [h.Class('contents')],
          [
            collectionView(
              {
                title: playlist.title,
                artwork: Option.getOrElse(
                  Array.head(playlist.covers),
                  () => [],
                ),
                maybeCover: Option.some(
                  playlistCover(
                    {
                      playlist,
                      displayWidth: HERO_ARTWORK_WIDTH,
                      shape: ArtworkShape.Card,
                      className: HERO_ARTWORK_CLASS,
                      isEager: true,
                    },
                    h,
                  ),
                ),
                credits: [],
                details: playlistLength(playlist),
                maybeDescription: Option.none(),
              },
              {
                tracks: songs,
                isNumbered: false,
                footer: '',
                playing: model.playing,
                swipe: model.swipe,
              },
              h,
            ),
            Array.isReadonlyArrayEmpty(songs)
              ? emptyState(
                  {
                    title: playlist.isLiked
                      ? 'No liked songs yet'
                      : 'No songs yet',
                    description: playlist.isLiked
                      ? 'Tap the heart on a song you love, and it shows up here.'
                      : 'Tap ⋯ beside any song and choose Add to a Playlist.',
                    kind: 'Playlist',
                  },
                  h,
                )
              : h.empty,
          ],
        ),
    },
    h,
  )
