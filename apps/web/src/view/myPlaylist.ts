import { Array, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { type MyPlaylistDetails } from '@music/shared'

import { downloadStatus } from '../downloads/domain'
import { Message } from '../message'
import { myPlaylistQuery } from '../query'
import {
  HERO_ARTWORK_CLASS,
  HERO_ARTWORK_WIDTH,
  collectionView,
} from './collection'
import { type PageModel } from './page'
import { editingPlaylistView } from './playlistEditor'
import {
  ArtworkShape,
  emptyState,
  loadingPage,
  playlistCover,
  playlistLength,
  remote,
} from './shared'

/** Under an empty playlist of mine: a way to fill it from here. */
const addSongsButton = (playlistId: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('-mt-14 flex justify-center pb-6')],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedAddSongs({ playlistId })),
          h.Class(
            'pressable bg-primary text-primary-foreground h-11 rounded-full px-6 text-[17px] font-semibold',
          ),
        ],
        ['Add Songs'],
      ),
    ],
  )

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
      onData: details =>
        model.playlistEditor._tag === 'Editing' &&
        model.playlistEditor.playlistId === playlistId
          ? editingPlaylistView(
              details,
              model.playlistEditor.titleInput,
              model.playlistEditor.descriptionInput,
              h,
            )
          : playlistPage(model, details, h),
    },
    h,
  )

const playlistPage = (
  model: PageModel,
  { playlist, songs }: MyPlaylistDetails,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('contents')],
    [
      collectionView(
        {
          title: playlist.title,
          artwork: Option.getOrElse(Array.head(playlist.covers), () => []),
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
          maybeDescription: playlist.maybeDescription,
          download: downloadStatus(model.downloads, 'MyPlaylist', playlist.id),
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
              title: playlist.isLiked ? 'No liked songs yet' : 'No songs yet',
              description: playlist.isLiked
                ? 'Tap the heart on a song you love, and it shows up here.'
                : 'Add songs here, or tap ⋯ beside any song and choose Add to a Playlist.',
              kind: 'Playlist',
            },
            h,
          )
        : h.empty,
      Array.isReadonlyArrayEmpty(songs) && !playlist.isLiked
        ? addSongsButton(playlist.id, h)
        : h.empty,
    ],
  )
