import { Array, Match, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'
import { Play } from 'lucide'

import { icon } from '@/lib/icons'
import { type HomeShelf, Session, type Song } from '@music/shared'

import { songFromQueueTrack } from '../library'
import { Message } from '../message'
import { homeQuery } from '../query'
import { largeTitleHeader } from './chrome'
import { type PageModel } from './page'
import {
  ArtworkShape,
  type NowPlaying,
  albumCard,
  artistCard,
  artistNames,
  artworkImage,
  equalizer,
  loadingShelf,
  playlistCard,
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

const feedShelf = (
  homeShelf: HomeShelf,
  playing: NowPlaying,
  h: HtmlBuilder<Message>,
): Html =>
  Match.valueTags(homeShelf, {
    SongShelf: ({ title, songs }) =>
      songGridShelf({ title, songs, playing }, h),
    AlbumShelf: ({ title, albums }) =>
      shelf(
        { title, items: albums, toKey: ({ id }) => id, toCard: albumCard },
        h,
      ),
    PlaylistShelf: ({ title, playlists }) =>
      shelf(
        {
          title,
          items: playlists,
          toKey: ({ id }) => id,
          toCard: playlistCard,
        },
        h,
      ),
    ArtistShelf: ({ title, artists }) =>
      shelf(
        { title, items: artists, toKey: ({ id }) => id, toCard: artistCard },
        h,
      ),
  })

const LOADING_SHELF_COUNT = 3

/** Home: what was played lately, then YouTube Music's recommendations. */
export const homeView = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const playing = model.playing
  return [
    ...largeTitleHeader('Home', h.empty, h),
    h.div(
      [h.Class('flex flex-col gap-8 pt-2 pb-6')],
      [
        recentlyPlayedShelf(model.recentlyPlayed, playing, h),
        remote(
          homeQuery.read(model.home),
          {
            onLoading: () =>
              h.div(
                [h.Class('flex flex-col gap-8'), h.AriaLabel('Loading')],
                Array.makeBy(LOADING_SHELF_COUNT, () => loadingShelf(h)),
              ),
            onData: ({ shelves }) =>
              h.div(
                [h.Class('flex flex-col gap-8')],
                Array.map(shelves, homeShelf =>
                  h.keyed('div')(
                    `${homeShelf._tag}:${homeShelf.title}`,
                    [],
                    [feedShelf(homeShelf, playing, h)],
                  ),
                ),
              ),
          },
          h,
        ),
      ],
    ),
  ]
}
