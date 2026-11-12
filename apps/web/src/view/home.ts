import { Array, Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { Play, Speaker, Tv } from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  LIKED_PLAYLIST_ID,
  type MyLibrary,
  type MyPlaylistSummary,
  Session,
  type Song,
} from '@music/shared'

import { songFromQueueTrack } from '../library'
import { Message } from '../message'
import { myLibraryQuery, myPlaylistQuery } from '../query'
import { largeTitleHeader } from './chrome'
import { type PageModel } from './page'
import {
  ArtworkShape,
  type NowPlaying,
  type PlayOn,
  artistNames,
  artworkImage,
  emptyState,
  equalizer,
  loadingShelf,
  myPlaylistCard,
  remote,
  shelf,
  songGridShelf,
} from './shared'

const RECENT_CARD_ARTWORK_WIDTH = 140
const RECENTLY_PLAYED_ON_HOME = 12

/** A recently played song as a card that plays it, with the ones after it. */
const recentCard = (
  songs: ReadonlyArray<Song>,
  index: number,
  playing: NowPlaying,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(Array.get(songs, index), {
    onNone: () => h.empty,
    onSome: song => {
      const isCurrent = Option.contains(playing.maybeVideoId, song.videoId)
      return h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedPlaySongs({ songs, startIndex: index })),
          h.AriaLabel(`Play ${song.title}`),
          h.Class(
            'pressable flex w-[34vw] max-w-36 shrink-0 snap-start flex-col text-left',
          ),
        ],
        [
          h.span(
            [h.Class('relative')],
            [
              artworkImage(
                {
                  artwork: song.artwork,
                  displayWidth: RECENT_CARD_ARTWORK_WIDTH,
                  shape: ArtworkShape.Card,
                  className: 'aspect-square w-full',
                },
                h,
              ),
              h.span(
                [
                  h.Class(
                    'absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-full bg-black/55 text-white',
                  ),
                ],
                [
                  isCurrent
                    ? equalizer(playing.isPlaying, '', h)
                    : icon(h, Play, 'size-3.5 fill-current ml-0.5'),
                ],
              ),
            ],
          ),
          h.span(
            [
              h.Class(
                'mt-2 line-clamp-1 text-[13px] leading-tight font-medium',
              ),
            ],
            [song.title],
          ),
          h.span(
            [
              h.Class(
                'text-muted-foreground mt-0.5 line-clamp-1 text-[13px] leading-tight',
              ),
            ],
            [artistNames(song.artists)],
          ),
        ],
      )
    },
  })

type RecentSong = Readonly<{ song: Song; index: number }>

const recentlyPlayedShelf = (
  recentlyPlayed: ReadonlyArray<Session.QueueTrack>,
  playing: NowPlaying,
  h: HtmlBuilder<Message>,
): Html => {
  const songs = Array.map(
    Array.take(recentlyPlayed, RECENTLY_PLAYED_ON_HOME),
    songFromQueueTrack,
  )
  return shelf<RecentSong>(
    {
      title: 'Recently played',
      items: Array.map(songs, (song, index) => ({ song, index })),
      toKey: ({ song }) => song.videoId,
      toCard: ({ index }, h) => recentCard(songs, index, playing, h),
    },
    h,
  )
}

const LIKED_SONGS_ON_HOME = 24

/** My playlists as covers, Liked songs first. */
const playlistsShelf = (
  playlists: ReadonlyArray<MyPlaylistSummary>,
  h: HtmlBuilder<Message>,
): Html =>
  shelf(
    {
      title: 'Your playlists',
      items: playlists,
      toKey: ({ id }) => id,
      toCard: myPlaylistCard,
    },
    h,
  )

const likedSongsShelf = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  Option.match(
    AsyncData.getData(
      myPlaylistQuery.read(model.myPlaylists, {
        playlistId: LIKED_PLAYLIST_ID,
      }),
    ),
    {
      onNone: () => h.empty,
      onSome: ({ songs }) =>
        songGridShelf(
          {
            title: 'Liked songs',
            songs: Array.take(songs, LIKED_SONGS_ON_HOME),
            playing: model.playing,
          },
          h,
        ),
    },
  )

/** True once there is nothing of mine to show: no plays, likes, or playlists. */
const isNothingYet = (model: PageModel, library: MyLibrary): boolean =>
  Array.isReadonlyArrayEmpty(model.recentlyPlayed) &&
  Array.isReadonlyArrayEmpty(library.likedVideoIds) &&
  Array.every(library.playlists, playlist => playlist.isLiked)

/**
 * Where songs play, and the way to the device picker even when nothing
 * plays: to turn the TV on, or to pick it before choosing a song.
 */
const playOnButton = (playOn: PlayOn, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedDevices()),
      h.AriaLabel(
        Option.match(playOn.maybeDeviceName, {
          onNone: () => 'Choose where to play',
          onSome: name => `Playing on ${name}. Choose where to play`,
        }),
      ),
      h.Class(
        cn(
          'mb-1 flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-full px-2 text-[15px] font-semibold active:opacity-50',
          Option.isSome(playOn.maybeDeviceName)
            ? 'bg-primary/15 text-primary px-3'
            : 'text-primary',
        ),
      ),
    ],
    [
      icon(h, playOn.isTv ? Tv : Speaker, 'size-[22px] shrink-0'),
      Option.match(playOn.maybeDeviceName, {
        onNone: () => h.empty,
        onSome: name => h.span([h.Class('line-clamp-1 max-w-32')], [name]),
      }),
    ],
  )

/** Home: only my music. What I played lately, my playlists, my likes. */
export const homeView = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  ...largeTitleHeader('Home', playOnButton(model.playOn, h), h),
  remote(
    myLibraryQuery.read(model.myLibrary),
    {
      onLoading: () =>
        h.div(
          [h.Class('flex flex-col gap-8 pt-2 pb-6')],
          [
            recentlyPlayedShelf(model.recentlyPlayed, model.playing, h),
            loadingShelf(h),
          ],
        ),
      onData: library =>
        isNothingYet(model, library)
          ? emptyState(
              {
                title: 'Your music lives here',
                description:
                  'Search for a song, then play it, like it, or add it to a playlist.',
                kind: 'Song',
              },
              h,
            )
          : h.div(
              [h.Class('flex flex-col gap-8 pt-2 pb-6')],
              [
                recentlyPlayedShelf(model.recentlyPlayed, model.playing, h),
                playlistsShelf(library.playlists, h),
                likedSongsShelf(model, h),
              ],
            ),
    },
    h,
  ),
]
