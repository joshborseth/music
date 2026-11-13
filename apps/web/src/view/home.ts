import { Array, Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { Play, Speaker, Tv } from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  type HomeFeed,
  LIKED_PLAYLIST_ID,
  type MyLibrary,
  type MyPlaylistSummary,
  type Song,
} from '@music/shared'

import { Message } from '../message'
import {
  homeQuery,
  myLibraryQuery,
  myPlaylistQuery,
  newReleasesQuery,
  songRadioQuery,
} from '../query'
import { largeTitleHeader } from './chrome'
import { type PageModel } from './page'
import {
  ArtworkShape,
  type NowPlaying,
  type PlayOn,
  albumCard,
  artistCard,
  artistNames,
  artworkImage,
  emptyState,
  equalizer,
  loadingRows,
  loadingShelf,
  myPlaylistCard,
  namedSection,
  playlistCard,
  remote,
  shelf,
  songGridShelf,
} from './shared'

const RECENT_CARD_ARTWORK_WIDTH = 140

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

/**
 * The songs played lately on any device, newest first, that played on
 * their own: an album more than one song played from is in Jump back in.
 */
const recentlyPlayedShelf = (
  songs: ReadonlyArray<Song>,
  playing: NowPlaying,
  h: HtmlBuilder<Message>,
): Html =>
  shelf<RecentSong>(
    {
      title: 'Recently played',
      items: Array.map(songs, (song, index) => ({ song, index })),
      toKey: ({ song }) => song.videoId,
      toCard: ({ index }, h) => recentCard(songs, index, playing, h),
    },
    h,
  )

/** The albums more than one song played from lately. */
const jumpBackInShelf = (feed: HomeFeed, h: HtmlBuilder<Message>): Html =>
  shelf(
    {
      title: 'Jump back in',
      items: feed.jumpBackIn,
      toKey: ({ id }) => id,
      toCard: albumCard,
    },
    h,
  )

/**
 * Mixes made from the artists I play and like most. Each opens as a
 * playlist: the radio of one of their songs.
 */
const mixesShelf = (feed: HomeFeed, h: HtmlBuilder<Message>): Html =>
  shelf(
    {
      title: 'Your mixes',
      items: feed.mixes,
      toKey: ({ id }) => id,
      toCard: playlistCard,
    },
    h,
  )

/**
 * The song YouTube Music's radio starts from: the latest song played whose
 * radio was asked for. A song that just started has not been asked for yet,
 * so the shelf keeps showing the one before it until Home reloads.
 */
const radioSeed = (model: PageModel, feed: HomeFeed): Option.Option<Song> =>
  Array.findFirst(
    [...Option.toArray(feed.maybeLastPlayed), ...feed.recentlyPlayed],
    ({ videoId }) =>
      !AsyncData.isIdle(songRadioQuery.read(model.songRadios, { videoId })),
  )

const RADIO_EYEBROW = 'More like'

/** YouTube Music's radio for the song played last. Hidden if it fails. */
const radioShelf = (
  model: PageModel,
  feed: HomeFeed,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(radioSeed(model, feed), {
    onNone: () => h.empty,
    onSome: seed =>
      AsyncData.matchData(
        songRadioQuery.read(model.songRadios, { videoId: seed.videoId }),
        {
          onEmpty: () =>
            namedSection(RADIO_EYEBROW, seed.title, [loadingRows(h)], h),
          onFailure: () => h.empty,
          onData: songs =>
            songGridShelf(
              {
                title: seed.title,
                maybeEyebrow: Option.some(RADIO_EYEBROW),
                songs,
                playing: model.playing,
              },
              h,
            ),
        },
      ),
  })

const LIKED_SONGS_ON_HOME = 24

/**
 * My playlists as covers. Liked songs has its own shelf of songs on Home,
 * so it is not repeated here.
 */
const playlistsShelf = (
  playlists: ReadonlyArray<MyPlaylistSummary>,
  h: HtmlBuilder<Message>,
): Html =>
  shelf(
    {
      title: 'Your playlists',
      items: Array.filter(playlists, ({ isLiked }) => !isLiked),
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
            title: 'Liked Songs',
            songs: Array.take(songs, LIKED_SONGS_ON_HOME),
            playing: model.playing,
          },
          h,
        ),
    },
  )

/** The latest releases of the artists I follow. Hidden until they load. */
const newReleasesShelf = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  Option.match(AsyncData.getData(newReleasesQuery.read(model.newReleases)), {
    onNone: () => h.empty,
    onSome: releases =>
      shelf(
        {
          title: 'New from artists you follow',
          items: releases,
          toKey: ({ id }) => id,
          toCard: albumCard,
        },
        h,
      ),
  })

const followedArtistsShelf = (
  library: MyLibrary,
  h: HtmlBuilder<Message>,
): Html =>
  shelf(
    {
      title: 'Artists you follow',
      items: library.artists,
      toKey: ({ id }) => id,
      toCard: artistCard,
    },
    h,
  )

/**
 * The shelves made from the play history and my likes, once they have
 * loaded: what played lately, my mixes, and more like the last song.
 */
const historyShelves = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  AsyncData.matchData(homeQuery.read(model.home), {
    onEmpty: (): ReadonlyArray<Html> => [loadingShelf(h)],
    onFailure: (): ReadonlyArray<Html> => [],
    onData: (feed): ReadonlyArray<Html> => [
      jumpBackInShelf(feed, h),
      recentlyPlayedShelf(feed.recentlyPlayed, model.playing, h),
      mixesShelf(feed, h),
      radioShelf(model, feed, h),
    ],
  })

/**
 * True once there is nothing of mine to show: nothing played on any device,
 * and no likes, playlists, saved albums, or followed artists.
 */
const isNothingYet = (model: PageModel, library: MyLibrary): boolean =>
  Option.exists(AsyncData.getData(homeQuery.read(model.home)), feed =>
    Option.isNone(feed.maybeLastPlayed),
  ) &&
  Array.isReadonlyArrayEmpty(library.likedVideoIds) &&
  Array.every(library.playlists, playlist => playlist.isLiked) &&
  Array.isReadonlyArrayEmpty(library.albums) &&
  Array.isReadonlyArrayEmpty(library.artists)

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

/**
 * Home: only my music. What played lately on any device, mixes of what I
 * play most, more like the last song, what the artists I follow released,
 * my likes, my playlists, and the artists I follow.
 */
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
          [loadingShelf(h), loadingShelf(h)],
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
                ...historyShelves(model, h),
                newReleasesShelf(model, h),
                likedSongsShelf(model, h),
                playlistsShelf(library.playlists, h),
                followedArtistsShelf(library, h),
              ],
            ),
    },
    h,
  ),
]
