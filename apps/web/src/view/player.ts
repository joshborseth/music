import { Array, Option, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder, createLazy } from 'foldkit/html'
import {
  ChevronDown,
  Ellipsis,
  Heart,
  type IconNode,
  Infinity as InfinityIcon,
  ListMusic,
  LoaderCircle,
  Menu,
  MessageSquareQuote,
  Monitor,
  Moon,
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  RotateCw,
  Shuffle,
  SkipBack,
  SkipForward,
  Smartphone,
  Speaker,
  Trash2,
  Tv,
} from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Session } from '@music/shared'

import { songFromQueueTrack } from '../library'
import { Message } from '../message'
import { Model } from '../model'
import {
  DragToDismiss,
  FollowQueueDrags,
  FollowSeekBarDrags,
  Marquee,
} from '../mount'
import {
  type Output,
  SKIP_SECONDS,
  type SessionSnapshot,
  SleepCountdown,
  countdownText,
  currentEntry,
  hasNextEntry,
  loadedEntry,
  outputText,
  playbackOutput,
  sleepCountdown,
  upcomingEntries,
} from '../playback/domain'
import { displayedPosition } from '../playback/position'
import { Swipe, SwipeTarget, swipeOn } from '../playback/swipe'
import { artworkBackdropQuery, songQuery } from '../query'
import { searchUrl } from '../route'
import { type PlayerPanel } from '../sheet'
import { likedVideoIds } from '../update'
import { timedLyrics } from './lyrics'
import {
  albumHref,
  artistHref,
  formatDuration,
  myPlaylistHref,
  playlistHref,
  sizedArtworkUrl,
} from './shared'
import { onSwipeStart, swipeTransitionClass, swipeableRow } from './swipe'

// PLAYING FROM

/** The page that opens what the queue plays from. */
const playingFromHref = ({ kind, id }: Session.PlayingFrom): string => {
  if (kind === 'Album') {
    return albumHref(id)
  } else if (kind === 'Artist') {
    return artistHref(id)
  } else if (kind === 'MyPlaylist') {
    return myPlaylistHref(id)
  } else if (kind === 'Search') {
    return searchUrl(id, 'Top')
  } else {
    return playlistHref(id)
  }
}

const PLAYING_FROM_KIND_NAMES: Readonly<
  Record<Session.PlayingFromKind, string>
> = {
  Album: 'Album',
  Playlist: 'Playlist',
  MyPlaylist: 'Playlist',
  Artist: 'Artist',
  Mix: 'Mix',
  Radio: 'Radio',
  Search: 'Search',
}

/** Its name as the player shows it: a search shows the words in quotes. */
const playingFromName = ({ kind, title }: Session.PlayingFrom): string =>
  kind === 'Search' ? `“${title}”` : title

const playingFromLabel = (playingFrom: Session.PlayingFrom): string =>
  `Playing from ${PLAYING_FROM_KIND_NAMES[playingFrom.kind].toLowerCase()} ${playingFromName(playingFrom)}`

/**
 * "Playing from" and the album, playlist, artist, mix, radio, or search the
 * queue was started from, at the top of the player. Tapping it opens it.
 */
const playingFromHeader = (
  playingFrom: Session.PlayingFrom,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [
      h.Href(playingFromHref(playingFrom)),
      h.AriaLabel(playingFromLabel(playingFrom)),
      h.Class(
        'col-start-2 flex min-w-0 flex-col items-center px-2 pt-2 text-center leading-tight active:opacity-60',
      ),
    ],
    [
      h.span(
        [
          h.Class(
            'text-[11px] font-semibold tracking-[0.06em] text-white/60 uppercase',
          ),
        ],
        [`Playing from ${PLAYING_FROM_KIND_NAMES[playingFrom.kind]}`],
      ),
      h.span(
        [h.Class('max-w-full truncate text-[13px] font-semibold')],
        [playingFromName(playingFrom)],
      ),
    ],
  )

// STATUS

/** The phone has asked for audio and is still waiting for it. */
const isBuffering = (model: Model): boolean =>
  Option.exists(
    loadedEntry(model.phoneAudio),
    entry => entry.isPlaying && entry.isBuffering,
  )

export const deviceIcon = (device: Session.Device, isThisOne: boolean) => {
  if (device.kind === 'Tv') {
    return Tv
  } else if (isThisOne || /iPhone|iPad|Android/.test(device.name)) {
    return Smartphone
  } else {
    return Monitor
  }
}

/** Where the music plays, when it is not this phone. */
const elsewhere = (
  model: Model,
  snapshot: SessionSnapshot,
): Option.Option<Output> =>
  playbackOutput(
    snapshot.state,
    Option.map(model.maybeIdentity, ({ deviceId }) => deviceId),
  )

/** This phone's own name, as the device picker shows it. */
export const thisDeviceName = (model: Pick<Model, 'maybeIdentity'>): string =>
  Option.match(model.maybeIdentity, {
    onNone: () => 'This phone',
    onSome: ({ deviceName }) => `This ${deviceName}`,
  })

/**
 * Waiting for sound: this phone's audio is loading, or the device that
 * should play is still turning on.
 */
const isLoading = (model: Model, snapshot: SessionSnapshot): boolean =>
  isBuffering(model) ||
  Option.exists(
    elsewhere(model, snapshot),
    ({ status }) => status === 'TurningOn',
  )

/** How far the mini player's line reaches, as its CSS width. */
const progressWidth = (track: Session.QueueTrack, position: number): string => {
  const duration = track.durationSeconds ?? 0
  const progress = duration > 0 ? Math.min(1, position / duration) : 0
  return `${(progress * 100).toFixed(2)}%`
}

// ARTWORK

/** The width of the big cover at its largest: 24rem. */
const BIG_ARTWORK_WIDTH = 384

const artwork = (
  track: Session.QueueTrack,
  className: string,
  displayWidth: number,
  h: HtmlBuilder<Message>,
): Html =>
  pipe(
    Option.fromNullishOr(track.artworkUrl),
    Option.map(url => sizedArtworkUrl(url, displayWidth)),
    Option.match({
      onNone: () =>
        h.div(
          [
            h.Class(
              cn(
                'flex shrink-0 items-center justify-center bg-white/10 text-white/60',
                className,
              ),
            ),
          ],
          [icon(h, Music, 'size-1/3')],
        ),
      onSome: url =>
        h.img([
          h.Src(url),
          h.Alt(''),
          h.Referrerpolicy('no-referrer'),
          h.Class(cn('shrink-0 object-cover', className)),
        ]),
    }),
  )

const playPauseIcon = (isPlaying: boolean, isLoading: boolean) => {
  if (isLoading) {
    return LoaderCircle
  } else if (isPlaying) {
    return Pause
  } else {
    return Play
  }
}

type PlayPauseLook = Readonly<{ buttonClass: string; iconClass: string }>

const MINI_PLAY_PAUSE: PlayPauseLook = {
  buttonClass: 'size-11',
  iconClass: 'size-6',
}

const PLAYER_PLAY_PAUSE: PlayPauseLook = {
  buttonClass: 'size-20',
  iconClass: 'size-12',
}

const playPauseButton = (
  isPlaying: boolean,
  isLoading: boolean,
  config: PlayPauseLook,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedTogglePlayback()),
      h.AriaLabel(isPlaying ? 'Pause' : 'Play'),
      h.Class(
        cn(
          'flex shrink-0 items-center justify-center rounded-full transition-transform active:scale-90',
          config.buttonClass,
        ),
      ),
    ],
    [
      icon(
        h,
        playPauseIcon(isPlaying, isLoading),
        cn(
          config.iconClass,
          isLoading ? 'animate-spin' : 'fill-current stroke-[1.5]',
        ),
      ),
    ],
  )

// MEMOIZATION

/*
 * The clock ticks several times a second while a song plays, and each tick
 * draws the app again. Each part of the player is kept in its own slot and
 * drawn again only when what it shows changes, so a tick redraws the seek
 * bar, the progress line, and the lyrics' rows that moved on, and nothing
 * else. Every argument is compared by reference, so each part takes only
 * the values it shows, never the Model. A slot's node must sit at one place
 * in the page, so each place has its own.
 */
const lazyMiniPlayer = createLazy()
const lazyPlayerSheet = createLazy()
const lazyMiniTrack = createLazy()
const lazyMiniPlayPause = createLazy()
const lazyMiniNext = createLazy()
const lazyBackdrop = createLazy()
const lazyHeader = createLazy()
const lazyArtwork = createLazy()
const lazyCompactNowPlaying = createLazy()
const lazyUntimedLyrics = createLazy()
const lazyQueue = createLazy()
const lazyTitleRow = createLazy()
const lazyTransport = createLazy()
const lazyBlockedAudio = createLazy()
const lazyPanelBar = createLazy()
const lazyStatusBar = createLazy()
const lazyNotice = createLazy()

const NO_SWIPE: Swipe = Swipe.Idle()

/**
 * The swipe a part follows: the one on `isTarget`, or none. Swipes on
 * anything else leave the part alone.
 */
const swipeFor = (
  swipe: Swipe,
  isTarget: (target: SwipeTarget) => boolean,
): Swipe => (Option.isSome(swipeOn(swipe, isTarget)) ? swipe : NO_SWIPE)

// MINI PLAYER

/** How much of a finger's travel the mini player follows sideways. */
const MINI_PLAYER_SWIPE_FOLLOW = 0.35

/** How much of a finger's travel the artwork follows sideways. */
const ARTWORK_SWIPE_FOLLOW = 0.5

/** How far a swipe goes before the mini player fades as far as it will. */
const SWIPE_FADE_DISTANCE = 320

/** The song and where it plays: tap to open the player. */
const miniPlayerTrack = (
  track: Session.QueueTrack,
  subtitle: string,
  isElsewhere: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedOpenPlayer()),
      h.AriaLabel('Open player'),
      h.Class('flex h-full min-w-0 flex-1 items-center gap-3 pl-2 text-left'),
    ],
    [
      artwork(track, 'size-10 rounded-lg', 40, h),
      h.span(
        [h.Class('flex min-w-0 flex-col')],
        [
          h.span(
            [h.Class('line-clamp-1 text-[15px] leading-tight font-medium')],
            [track.title],
          ),
          h.span(
            [
              h.Class(
                cn(
                  'line-clamp-1 text-[13px] leading-tight',
                  isElsewhere ? 'text-primary' : 'text-muted-foreground',
                ),
              ),
            ],
            [subtitle],
          ),
        ],
      ),
    ],
  )

const miniPlayerNext = (hasNext: boolean, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedNextTrack()),
      h.AriaLabel('Next'),
      h.Disabled(!hasNext),
      h.Class(
        'flex size-11 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90 disabled:opacity-35 disabled:active:scale-100',
      ),
    ],
    [icon(h, SkipForward, 'size-6 fill-current stroke-[1.5]')],
  )

const isMiniPlayer = (target: SwipeTarget): boolean =>
  target._tag === 'MiniPlayer'

const miniPlayer = (
  track: Session.QueueTrack,
  subtitle: string,
  isElsewhere: boolean,
  isPlaying: boolean,
  isLoading: boolean,
  hasNext: boolean,
  swipe: Swipe,
  width: string,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeSwipe = swipeOn(swipe, isMiniPlayer)
  const swipeX = Option.match(maybeSwipe, {
    onNone: () => 0,
    onSome: ({ deltaX }) => deltaX,
  })
  return h.div(
    [
      onSwipeStart(SwipeTarget.MiniPlayer(), h),
      h.Class(
        'fixed inset-x-3 bottom-[calc(var(--tab-bar-space)+0.5rem)] z-20 mx-auto max-w-md touch-pan-y select-none',
      ),
    ],
    [
      h.div(
        [
          h.Class(
            cn(
              'floating relative flex h-[var(--mini-player-height)] items-center gap-1 overflow-hidden rounded-[1.375rem] pr-1.5',
              swipeTransitionClass(maybeSwipe),
            ),
          ),
          h.Style({
            viewTransitionName: 'mini-player',
            transform: `translateX(${swipeX * MINI_PLAYER_SWIPE_FOLLOW}px)`,
            opacity: (
              1 -
              Math.min(Math.abs(swipeX), SWIPE_FADE_DISTANCE) /
                SWIPE_FADE_DISTANCE /
                2
            ).toFixed(3),
          }),
        ],
        [
          lazyMiniTrack(miniPlayerTrack, [track, subtitle, isElsewhere, h]),
          lazyMiniPlayPause(playPauseButton, [
            isPlaying,
            isLoading,
            MINI_PLAY_PAUSE,
            h,
          ]),
          lazyMiniNext(miniPlayerNext, [hasNext, h]),
          h.div(
            [h.Class('absolute inset-x-6 bottom-0 h-[2px] rounded-full')],
            [
              h.div([
                h.Class('bg-foreground/70 h-full rounded-full'),
                h.Style({ width }),
              ]),
            ],
          ),
        ],
      ),
    ],
  )
}

// FULL PLAYER

const seekBar = (
  track: Session.QueueTrack,
  displayed: number,
  isScrubbing: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const duration = track.durationSeconds ?? 0
  const position = Math.min(displayed, duration)
  const percent = duration > 0 ? (position / duration) * 100 : 0
  return h.div(
    [h.Class('flex flex-col'), h.DataAttribute('no-drag', '')],
    [
      h.div(
        [
          h.OnMount(FollowSeekBarDrags()),
          ...(isScrubbing ? [h.DataAttribute('scrubbing', '')] : []),
          h.Class('seek-area -my-2 flex touch-none items-center py-2'),
        ],
        [
          h.input([
            h.Type('range'),
            h.AriaLabel('Position'),
            h.Min('0'),
            h.Max(duration.toString()),
            h.Step('1'),
            h.Value(Math.floor(position).toString()),
            h.OnInput(value =>
              Message.UpdatedScrubPosition({ seconds: Number(value) }),
            ),
            h.OnChange(value =>
              Message.ChangedSeekPosition({ seconds: Number(value) }),
            ),
            h.Style({ '--progress': `${percent.toFixed(2)}%` }),
            h.Class('seek-bar'),
          ]),
        ],
      ),
      h.div(
        [
          h.Class(
            'flex justify-between text-[11px] font-medium text-white/55 tabular-nums',
          ),
        ],
        [
          h.span([], [formatDuration(Math.floor(position))]),
          h.span(
            [],
            [`-${formatDuration(Math.max(0, Math.ceil(duration - position)))}`],
          ),
        ],
      ),
    ],
  )
}

const transportButton = (
  onClick: Message,
  iconNode: typeof SkipBack,
  label: string,
  className: string,
  h: HtmlBuilder<Message>,
  isEnabled = true,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(onClick),
      h.AriaLabel(label),
      h.Disabled(!isEnabled),
      h.Class(
        'flex size-14 items-center justify-center rounded-full transition-transform active:scale-90 active:bg-white/10 disabled:opacity-35 disabled:active:scale-100 disabled:active:bg-transparent',
      ),
    ],
    [icon(h, iconNode, className)],
  )

const transportControls = (
  isPlaying: boolean,
  isLoading: boolean,
  hasNext: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center justify-between')],
    [
      transportButton(
        Message.ClickedSkipBy({ seconds: -SKIP_SECONDS }),
        RotateCcw,
        `Back ${SKIP_SECONDS} seconds`,
        'size-6 text-white/60',
        h,
      ),
      transportButton(
        Message.ClickedPreviousTrack(),
        SkipBack,
        'Previous',
        'size-9 fill-current stroke-[1.25]',
        h,
      ),
      playPauseButton(isPlaying, isLoading, PLAYER_PLAY_PAUSE, h),
      transportButton(
        Message.ClickedNextTrack(),
        SkipForward,
        'Next',
        'size-9 fill-current stroke-[1.25]',
        h,
        hasNext,
      ),
      transportButton(
        Message.ClickedSkipBy({ seconds: SKIP_SECONDS }),
        RotateCw,
        `Forward ${SKIP_SECONDS} seconds`,
        'size-6 text-white/60',
        h,
      ),
    ],
  )

const blockedAudioPrompt = (
  isBlocked: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  isBlocked
    ? h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedStartBlockedAudio()),
          h.Class(
            'pressable flex h-11 items-center justify-center gap-2 rounded-full bg-white text-[15px] font-semibold text-black',
          ),
        ],
        [icon(h, Play, 'size-4 fill-current'), 'Tap to start audio'],
      )
    : h.empty

const trackTitle = (
  track: Session.QueueTrack,
  isLarge: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex min-w-0 flex-1 flex-col')],
    [
      marqueeText(
        track.title,
        cn(
          'font-bold tracking-tight',
          isLarge ? 'text-[22px] leading-tight' : 'text-[17px]',
        ),
        h,
      ),
      h.p(
        [
          h.Class(
            cn(
              'line-clamp-1 text-white/65',
              isLarge ? 'text-[17px]' : 'text-[15px]',
            ),
          ),
        ],
        [track.artists],
      ),
    ],
  )

/**
 * One line of text. When it is too long to fit, it rests ending in "…" on a
 * whole letter, then now and then scrolls slowly sideways, its copy
 * following a gap behind, until the copy is back where it started, as the
 * player does in music apps. Nothing fades: the resting line is a separate
 * element from the moving one (`styles.css`, MARQUEE). `Marquee` measures it.
 */
const marqueeText = (
  text: string,
  className: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.h2(
    [h.OnMount(Marquee()), h.Class(cn('marquee', className))],
    [
      h.span([h.Class('marquee-rest')], [text]),
      h.span(
        [h.AriaHidden(true), h.Class('marquee-track')],
        [
          h.span([h.Class('marquee-text')], [text]),
          h.span([h.Class('marquee-copy')], [text]),
        ],
      ),
    ],
  )

const trackButtonClass =
  'flex size-10 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90'

/** Like the song, or open everything else that can be done with it. */
const trackActions = (
  track: Session.QueueTrack,
  isLiked: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const song = songFromQueueTrack(track)
  return h.div(
    [h.Class('flex shrink-0 items-center')],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedToggleLiked({ song })),
          h.AriaLabel(
            isLiked ? 'Remove from Liked Songs' : 'Add to Liked Songs',
          ),
          h.AriaPressed(isLiked ? 'true' : 'false'),
          h.Class(
            cn(trackButtonClass, isLiked ? 'text-rose-400' : 'text-white/70'),
          ),
        ],
        [icon(h, Heart, cn('size-6', isLiked && 'fill-current'))],
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedSongActions({ song })),
          h.AriaLabel(`More for ${track.title}`),
          h.Class(cn(trackButtonClass, 'text-white/70')),
        ],
        [icon(h, Ellipsis, 'size-6')],
      ),
    ],
  )
}

const isPlayerArtwork = (target: SwipeTarget): boolean =>
  target._tag === 'PlayerArtwork'

/**
 * The big artwork. Swiping it sideways skips; pulling it down closes the
 * player, which the whole sheet follows.
 */
const artworkPanel = (
  track: Session.QueueTrack,
  isPlaying: boolean,
  swipe: Swipe,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeSwipe = swipeOn(swipe, isPlayerArtwork)
  const swipeX = Option.match(maybeSwipe, {
    onNone: () => 0,
    onSome: swipe => (swipe.axis === 'Horizontal' ? swipe.deltaX : 0),
  })
  return h.div(
    [
      onSwipeStart(SwipeTarget.PlayerArtwork(), h),
      h.Class(
        cn(
          'flex min-h-0 flex-1 touch-none items-center justify-center py-4 select-none',
          swipeTransitionClass(maybeSwipe),
        ),
      ),
      h.Style({
        transform: `translateX(${swipeX * ARTWORK_SWIPE_FOLLOW}px)`,
      }),
    ],
    [
      artwork(
        track,
        cn(
          'player-artwork aspect-square w-full max-w-[min(100%,24rem,44vh)] rounded-2xl',
          isPlaying
            ? 'scale-100 shadow-2xl shadow-black/50'
            : 'scale-[0.8] shadow-lg shadow-black/30',
        ),
        BIG_ARTWORK_WIDTH,
        h,
      ),
    ],
  )
}

const compactNowPlaying = (
  track: Session.QueueTrack,
  isLiked: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center gap-3 py-3')],
    [
      artwork(track, 'size-14 rounded-lg shadow-md', 56, h),
      trackTitle(track, false, h),
      trackActions(track, isLiked, h),
    ],
  )

/** The big title under the artwork, with the like and ⋯ buttons. */
const titleRow = (
  track: Session.QueueTrack,
  isLiked: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center gap-2')],
    [trackTitle(track, true, h), trackActions(track, isLiked, h)],
  )

const scrollPanelClass =
  'no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain'

const plainPanel = (content: Html, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.DataAttribute('sheet-scroll', ''), h.Class(scrollPanelClass)],
    [content],
  )

type SongDetailsData = ReturnType<typeof songQuery.read>

/** The song's lyrics when they are timed, line by line. */
const maybeTimedLyrics = (details: SongDetailsData) =>
  pipe(
    AsyncData.getData(details),
    Option.flatMap(({ maybeLyrics }) => maybeLyrics),
    Option.flatMap(lyrics =>
      Option.map(lyrics.maybeLines, lines => ({
        lines,
        maybeSource: lyrics.maybeSource,
      })),
    ),
  )

/**
 * The lyrics panel while the song's details load or fail, and for a song
 * without timed lyrics. None of it moves with the song.
 */
const untimedLyricsPanel = (
  details: SongDetailsData,
  h: HtmlBuilder<Message>,
): Html => {
  const message = (text: string) =>
    plainPanel(
      h.p([h.Class('py-10 text-center text-[17px] text-white/60')], [text]),
      h,
    )
  return AsyncData.matchData(details, {
    onEmpty: () =>
      plainPanel(
        h.div(
          [h.Class('flex justify-center py-10 text-white/60')],
          [icon(h, LoaderCircle, 'size-6 animate-spin')],
        ),
        h,
      ),
    onFailure: () =>
      plainPanel(
        h.div(
          [h.Class('flex flex-col items-center gap-4 py-10')],
          [
            h.p(
              [h.Class('text-center text-[17px] text-white/60')],
              ['Lyrics could not be loaded.'],
            ),
            h.button(
              [
                h.Type('button'),
                h.OnClick(Message.ClickedRetryLyrics()),
                h.Class(
                  'flex h-10 items-center gap-2 rounded-full bg-white/15 px-5 text-[15px] font-semibold text-white active:scale-95 active:bg-white/25',
                ),
              ],
              [icon(h, RotateCw, 'size-4'), 'Try Again'],
            ),
          ],
        ),
        h,
      ),
    onData: ({ maybeLyrics }) =>
      Option.match(maybeLyrics, {
        onNone: () => message('No lyrics for this song.'),
        onSome: lyrics =>
          plainPanel(
            h.div(
              [h.Class('flex flex-col gap-6 py-6')],
              [
                h.p(
                  [
                    h.Class(
                      'text-[26px] leading-snug font-bold tracking-tight whitespace-pre-line text-white/90 select-text',
                    ),
                  ],
                  [lyrics.text],
                ),
                Option.match(lyrics.maybeSource, {
                  onNone: () => h.empty,
                  onSome: source =>
                    h.p(
                      [h.Class('text-xs text-white/50')],
                      [`Lyrics from ${source}`],
                    ),
                }),
              ],
            ),
            h,
          ),
      }),
  })
}

const lyricsPanel = (
  details: SongDetailsData,
  position: number,
  isPlaying: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeTimedLyrics(details), {
    onNone: () => lazyUntimedLyrics(untimedLyricsPanel, [details, h]),
    onSome: ({ lines, maybeSource }) =>
      timedLyrics(lines, position, isPlaying, maybeSource, scrollPanelClass, h),
  })

/** Lyrics not asked for yet: one value, so the player can be kept. */
const NO_SONG_DETAILS: SongDetailsData = AsyncData.Idle()

/**
 * The song's details while the lyrics show. Elsewhere the player never
 * reads them, so they stay one value and the player is kept.
 */
const lyricsDetails = (
  model: Model,
  track: Session.QueueTrack,
): SongDetailsData => {
  if (model.playerPanel !== 'Lyrics') {
    return NO_SONG_DETAILS
  }
  const details = songQuery.read(model.songs, { videoId: track.videoId })
  return AsyncData.isIdle(details) ? NO_SONG_DETAILS : details
}

/** A switch in the queue's header: shuffle or repeat. */
const queueToggle = (
  config: Readonly<{
    label: string
    isOn: boolean
    iconNode: Parameters<typeof icon>[1]
    message: Message
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(config.message),
      h.AriaPressed(config.isOn ? 'true' : 'false'),
      h.Class(
        cn(
          'flex h-10 flex-1 items-center justify-center gap-2 rounded-xl text-[15px] font-semibold transition-colors active:scale-95',
          config.isOn ? 'bg-white text-neutral-900' : 'bg-white/10 text-white',
        ),
      ),
    ],
    [icon(h, config.iconNode, 'size-[18px]'), config.label],
  )

/** Shuffle and repeat, above the songs to come. */
const queueControls = (
  state: Session.SessionState,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex gap-3 pt-4')],
    [
      queueToggle(
        {
          label: 'Shuffle',
          isOn: state.shuffle,
          iconNode: Shuffle,
          message: Message.ClickedToggleShuffle(),
        },
        h,
      ),
      queueToggle(
        {
          label: state.repeat === 'One' ? 'Repeat One' : 'Repeat',
          isOn: state.repeat !== 'Off',
          iconNode: state.repeat === 'One' ? Repeat1 : Repeat,
          message: Message.ClickedCycleRepeat(),
        },
        h,
      ),
    ],
  )

/**
 * The songs to come: first the ones someone queued, then the similar songs
 * autoplay added, under a switch that turns autoplay on or off. Shuffle and
 * repeat sit above them.
 */
const queuePanel = (
  state: Session.SessionState,
  color: string,
  swipe: Swipe,
  h: HtmlBuilder<Message>,
): Html => {
  const upcoming = upcomingEntries(state)
  const queued = Array.filter(upcoming, entry => !entry.autoplay)
  const autoplayed = Array.filter(upcoming, entry => entry.autoplay)
  const isAutoplayOn = state.autoplay
  return h.div(
    [
      h.DataAttribute('sheet-scroll', ''),
      h.Class(
        'no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8',
      ),
      // NOTE: a dragged row is lifted onto the player's own color, darkened,
      // and must be solid so the rows it passes don't show through.
      h.Style({ '--queue-lift': `color-mix(in oklab, ${color}, black 35%)` }),
    ],
    [
      queueControls(state, h),
      Array.match(queued, {
        onEmpty: () => h.empty,
        onNonEmpty: entries =>
          h.section(
            [],
            [
              h.div(
                [h.Class('flex items-center justify-between pt-4 pb-2')],
                [
                  h.div(
                    [h.Class('flex min-w-0 flex-col')],
                    [
                      h.h3(
                        [h.Class('text-[17px] font-bold')],
                        ['Playing Next'],
                      ),
                      Option.match(Option.fromNullishOr(state.playingFrom), {
                        onNone: () => h.empty,
                        onSome: playingFrom =>
                          h.a(
                            [
                              h.Href(playingFromHref(playingFrom)),
                              h.AriaLabel(playingFromLabel(playingFrom)),
                              h.Class(
                                'truncate text-[13px] text-white/60 active:opacity-60',
                              ),
                            ],
                            [
                              `From ${playingFromName(playingFrom)}${playingFrom.kind === 'Radio' ? ' Radio' : ''}`,
                            ],
                          ),
                      }),
                    ],
                  ),
                  h.button(
                    [
                      h.Type('button'),
                      h.OnClick(Message.ClickedClearUpcoming()),
                      h.AriaLabel('Clear Playing Next'),
                      h.Class(
                        '-my-2 -mr-2 h-10 rounded-full px-3 text-[15px] font-semibold text-white/80 active:bg-white/10',
                      ),
                    ],
                    ['Clear'],
                  ),
                ],
              ),
              queueList(entries, swipe, h),
            ],
          ),
      }),
      h.section(
        [],
        [
          h.div(
            [h.Class('flex items-center gap-3 pt-4 pb-2')],
            [
              h.div(
                [h.Class('flex min-w-0 flex-1 flex-col')],
                [
                  h.h3([h.Class('text-[17px] font-bold')], ['Autoplay']),
                  h.p(
                    [h.Class('text-[13px] text-white/60')],
                    [
                      isAutoplayOn
                        ? 'Similar music keeps playing after your queue.'
                        : Array.isReadonlyArrayEmpty(queued)
                          ? 'Nothing else is queued. Playback stops after this song.'
                          : 'Playback stops after your queue.',
                    ],
                  ),
                ],
              ),
              h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.ClickedToggleAutoplay()),
                  h.AriaLabel('Autoplay'),
                  h.AriaPressed(isAutoplayOn ? 'true' : 'false'),
                  h.Class(
                    cn(
                      'flex size-10 shrink-0 items-center justify-center rounded-full transition-colors active:scale-90',
                      isAutoplayOn
                        ? 'bg-white text-neutral-900'
                        : 'bg-white/10 text-white/70',
                    ),
                  ),
                ],
                [icon(h, InfinityIcon, 'size-5')],
              ),
            ],
          ),
          isAutoplayOn
            ? Array.match(autoplayed, {
                onEmpty: () => h.empty,
                onNonEmpty: entries => queueList(entries, swipe, h),
              })
            : h.empty,
        ],
      ),
    ],
  )
}

/**
 * Upcoming songs: tap one to jump to it, swipe one away to remove it, or
 * drag one by its handle to move it (`FollowQueueDrags`). A row being
 * dragged is lifted onto a solid surface above the rows it passes.
 */
const queueList = (
  entries: ReadonlyArray<Session.QueueEntry>,
  swipe: Swipe,
  h: HtmlBuilder<Message>,
): Html =>
  h.ul(
    [h.Class('-mx-2 flex flex-col pb-4'), h.OnMount(FollowQueueDrags())],
    Array.map(entries, entry => queueItem(entry, swipe, h)),
  )

const queueItem = (
  entry: Session.QueueEntry,
  swipe: Swipe,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    entry.entryId,
    [
      h.DataAttribute('queue-entry', entry.entryId),
      h.Class(
        'rounded-lg data-dragging:relative data-dragging:z-10 data-dragging:bg-(--queue-lift) data-dragging:shadow-[0_12px_28px_-10px_rgb(0_0_0/0.7)] data-dragging:ring-1 data-dragging:ring-white/15',
      ),
    ],
    [
      swipeableRow(
        {
          target: SwipeTarget.QueueEntry({ entryId: entry.entryId }),
          maybeSwipe: swipeOn(
            swipe,
            target =>
              target._tag === 'QueueEntry' && target.entryId === entry.entryId,
          ),
          maybeRightReveal: Option.none(),
          maybeLeftReveal: Option.some({
            label: 'Remove',
            icon: Trash2,
            isDestructive: true,
          }),
          surfaceClass: 'bg-neutral-800',
        },
        queueRow(entry, h),
        h,
      ),
    ],
  )

/** One upcoming song: tap to jump to it, or drag its handle to move it. */
const queueRow = (entry: Session.QueueEntry, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex items-center')],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedQueueEntry({ entryId: entry.entryId })),
          h.Class(
            'flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-1.5 text-left active:bg-white/10',
          ),
        ],
        [
          artwork(entry.track, 'size-12 rounded-md', 48, h),
          h.span(
            [h.Class('flex min-w-0 flex-col')],
            [
              h.span(
                [h.Class('line-clamp-1 text-[15px] font-medium')],
                [entry.track.title],
              ),
              h.span(
                [h.Class('line-clamp-1 text-[13px] text-white/60')],
                [entry.track.artists],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [
          h.DataAttribute('reorder-handle', ''),
          h.DataAttribute('no-drag', ''),
          h.AriaHidden(true),
          h.Class(
            'flex h-14 w-12 shrink-0 cursor-grab touch-none items-center justify-center text-white/45 select-none [-webkit-touch-callout:none]',
          ),
        ],
        [icon(h, Menu, 'size-[22px]')],
      ),
    ],
  )

const panelToggle = (
  panel: PlayerPanel,
  activePanel: PlayerPanel,
  iconNode: typeof ListMusic,
  label: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.SelectedPlayerPanel({ panel })),
      h.AriaLabel(label),
      h.AriaPressed(panel === activePanel ? 'true' : 'false'),
      h.Class(
        cn(
          'flex size-11 items-center justify-center rounded-full transition-colors active:scale-90',
          panel === activePanel ? 'bg-white/90 text-black' : 'text-white/70',
        ),
      ),
    ],
    [icon(h, iconNode, 'size-[22px]')],
  )

/** Where the music plays, as the player's device button shows it. */
type DeviceLabel = Readonly<{
  iconNode: IconNode
  text: string
  isElsewhere: boolean
}>

const deviceLabel = (model: Model, snapshot: SessionSnapshot): DeviceLabel =>
  Option.match(elsewhere(model, snapshot), {
    onNone: () => ({
      iconNode: Speaker,
      text: thisDeviceName(model),
      isElsewhere: false,
    }),
    onSome: output => ({
      iconNode: deviceIcon(output.device, false),
      text: outputText(output),
      isElsewhere: true,
    }),
  })

const deviceButton = (
  iconNode: IconNode,
  text: string,
  isElsewhere: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedDevices()),
      h.AriaLabel('Choose where to play'),
      h.Class(
        cn(
          'flex h-11 min-w-0 items-center gap-2 rounded-full px-4 text-[13px] font-semibold active:bg-white/10',
          isElsewhere ? 'text-primary' : 'text-white/70',
        ),
      ),
    ],
    [
      icon(h, iconNode, 'size-5 shrink-0'),
      h.span([h.Class('line-clamp-1')], [text]),
    ],
  )

/** Lyrics, where the music plays, and the queue, along the bottom. */
const panelBar = (
  panel: PlayerPanel,
  iconNode: IconNode,
  text: string,
  isElsewhere: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center justify-between pt-1')],
    [
      panelToggle('Lyrics', panel, MessageSquareQuote, 'Lyrics', h),
      deviceButton(iconNode, text, isElsewhere, h),
      panelToggle('Queue', panel, ListMusic, 'Up next', h),
    ],
  )

/** What the sleep timer button says: nothing until a timer is set. */
const sleepTimerText = (snapshot: SessionSnapshot, now: number): string =>
  Option.match(sleepCountdown(snapshot, now), {
    onNone: () => '',
    onSome: countdown =>
      SleepCountdown.match(countdown, {
        Remaining: ({ seconds }) => countdownText(seconds),
        EndOfSong: () => 'End of song',
      }),
  })

/**
 * The sleep timer, top right: a moon to set one, or a moon with the time
 * left once one is set, wherever the music plays.
 */
const sleepTimerButton = (text: string, h: HtmlBuilder<Message>): Html =>
  text === ''
    ? h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedSleepTimer()),
          h.AriaLabel('Sleep Timer'),
          h.Class(
            'flex size-10 items-center justify-center rounded-full text-white/80 active:bg-white/10',
          ),
        ],
        [icon(h, Moon, 'size-[22px]')],
      )
    : h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedSleepTimer()),
          h.AriaLabel(`Sleep Timer: ${text}`),
          h.Class(
            'flex h-8 items-center gap-1.5 rounded-full bg-white/15 px-3 text-[13px] font-semibold text-white tabular-nums active:bg-white/25',
          ),
        ],
        [icon(h, Moon, 'size-3.5 fill-current'), text],
      )

/** The backdrop's color until the server sends the cover's own. */
const NEUTRAL_BACKDROP = 'oklch(0.205 0 0)'

/**
 * The solid color from the cover that the player sits on, so the player is
 * already the cover's color while the image loads.
 */
const backdropColor = (model: Model, track: Session.QueueTrack): string =>
  pipe(
    Option.fromNullishOr(track.artworkUrl),
    Option.flatMap(artworkUrl =>
      AsyncData.getData(
        artworkBackdropQuery.read(model.artworkBackdrops, { artworkUrl }),
      ),
    ),
    Option.flatMap(Option.fromNullishOr),
    Option.getOrElse(() => NEUTRAL_BACKDROP),
  )

/**
 * The cover itself, blurred over the whole player and darkened toward the
 * bottom so the controls read, on the solid `color`. The one blur and fade
 * the app keeps. The blurred cover is dimmed before it is laid down, so even
 * a white cover leaves a dark grey under the white controls: `color` itself
 * is never lighter than oklch 0.36 (`apps/server/src/palette/extract.ts`). The top starts as `color` itself and fades into the cover,
 * because iOS fills the status bar above the player with that one solid
 * color (see `statusBarColor`), and a blurred image under it would show a
 * seam.
 */
const playerBackdrop = (
  color: string,
  track: Session.QueueTrack,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.AriaHidden(true),
      h.Class('pointer-events-none absolute inset-0 overflow-hidden'),
      h.Style({ backgroundColor: color }),
    ],
    [
      Option.match(Option.fromNullishOr(track.artworkUrl), {
        onNone: () => h.empty,
        onSome: url =>
          h.img([
            h.Src(url),
            h.Alt(''),
            h.Referrerpolicy('no-referrer'),
            h.Class(
              'absolute inset-0 size-full scale-[1.6] object-cover opacity-90 blur-[72px] brightness-[0.58] saturate-[1.8]',
            ),
          ]),
      }),
      h.div([
        h.Class(
          'absolute inset-0 bg-gradient-to-b from-black/20 via-black/40 to-black/70',
        ),
      ]),
      h.div([
        h.Class('absolute inset-x-0 top-0 h-40'),
        h.Style({
          backgroundImage: `linear-gradient(to bottom, ${color} 0.75rem, transparent)`,
        }),
      ]),
    ],
  )

/**
 * Tells iOS what color to fill the status bar with while the player is
 * open. It must be `fixed` (here, fixed to the sheet), so WebKit takes this
 * strip as the top edge rather than the full-screen sheet, whose color it
 * would ignore in favor of the page's (see `.status-bar-color` in
 * styles.css).
 */
const statusBarColor = (color: string, h: HtmlBuilder<Message>): Html =>
  h.div([
    h.AriaHidden(true),
    h.Class('status-bar-color z-10'),
    h.Style({ backgroundColor: color }),
  ])

/**
 * The top of the player: Close, the grabber, what the queue plays from, and
 * the sleep timer.
 */
const playerHeader = (
  playingFrom: Session.PlayingFrom | null,
  sleepText: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class(
        'relative grid h-10 grid-cols-[minmax(2.5rem,1fr)_minmax(0,max-content)_minmax(2.5rem,1fr)] items-center',
      ),
    ],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedClosePlayer()),
          h.AriaLabel('Close player'),
          h.Class(
            'col-start-1 flex size-10 items-center justify-center justify-self-start rounded-full text-white/80 active:bg-white/10',
          ),
        ],
        [icon(h, ChevronDown, 'size-7')],
      ),
      h.span([
        h.AriaHidden(true),
        h.Class(
          cn(
            'absolute left-1/2 h-[5px] w-10 -translate-x-1/2 rounded-full bg-white/35',
            playingFrom === null ? 'top-1/2 -translate-y-1/2' : '-top-0.5',
          ),
        ),
      ]),
      Option.match(Option.fromNullishOr(playingFrom), {
        onNone: () => h.empty,
        onSome: from => playingFromHeader(from, h),
      }),
      h.div(
        [h.Class('col-start-3 justify-self-end')],
        [sleepTimerButton(sleepText, h)],
      ),
    ],
  )

const isQueueEntry = (target: SwipeTarget): boolean =>
  target._tag === 'QueueEntry'

const playerSheet = (
  isOpen: boolean,
  panel: PlayerPanel,
  state: Session.SessionState,
  track: Session.QueueTrack,
  color: string,
  isLiked: boolean,
  deviceIconNode: IconNode,
  deviceText: string,
  isElsewhere: boolean,
  sleepText: string,
  isLoading: boolean,
  isBlocked: boolean,
  position: number,
  isScrubbing: boolean,
  details: SongDetailsData,
  swipe: Swipe,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Role('dialog'),
      h.AriaModal(true),
      h.AriaLabel('Player'),
      h.AriaHidden(!isOpen),
      h.Inert(!isOpen),
      h.DataAttribute('state', isOpen ? 'open' : 'closed'),
      h.OnMount(DragToDismiss({ sheet: 'Player' })),
      h.Class(
        'sheet fixed inset-0 z-40 flex flex-col overflow-hidden text-white',
      ),
    ],
    [
      lazyBackdrop(playerBackdrop, [color, track, h]),
      h.div(
        [
          h.Class(
            'relative mx-auto flex h-full w-full max-w-xl flex-col px-6 pt-[calc(var(--safe-top)+0.25rem)] pb-[max(var(--safe-bottom),1rem)]',
          ),
        ],
        [
          lazyHeader(playerHeader, [state.playingFrom, sleepText, h]),
          panel === 'Artwork'
            ? lazyArtwork(artworkPanel, [
                track,
                state.playing,
                swipeFor(swipe, isPlayerArtwork),
                h,
              ])
            : lazyCompactNowPlaying(compactNowPlaying, [track, isLiked, h]),
          panel === 'Lyrics'
            ? lyricsPanel(details, position, state.playing, h)
            : h.empty,
          panel === 'Queue'
            ? lazyQueue(queuePanel, [
                state,
                color,
                swipeFor(swipe, isQueueEntry),
                h,
              ])
            : h.empty,
          h.div(
            [h.Class('flex flex-col gap-3 pt-2')],
            [
              panel === 'Artwork'
                ? lazyTitleRow(titleRow, [track, isLiked, h])
                : h.empty,
              seekBar(track, position, isScrubbing, h),
              lazyTransport(transportControls, [
                state.playing,
                isLoading,
                hasNextEntry(state),
                h,
              ]),
              lazyBlockedAudio(blockedAudioPrompt, [isBlocked, h]),
              lazyPanelBar(panelBar, [
                panel,
                deviceIconNode,
                deviceText,
                isElsewhere,
                h,
              ]),
            ],
          ),
        ],
      ),
      lazyStatusBar(statusBarColor, [color, h]),
    ],
  )

/** The swipe the full player follows: on its artwork or a queue row. */
const isPlayerSwipe = (target: SwipeTarget): boolean =>
  isPlayerArtwork(target) || isQueueEntry(target)

// NOTICE

const noticeToast = (
  maybeNotice: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeNotice, {
    onNone: () => h.empty,
    onSome: notice =>
      h.div(
        [
          h.Class(
            'pointer-events-none fixed inset-x-0 bottom-[calc(var(--tab-bar-space)+var(--mini-player-height)+1.25rem)] z-50 flex justify-center px-6',
          ),
        ],
        [
          h.button(
            [
              h.Type('button'),
              h.Role('status'),
              h.OnClick(Message.ClickedDismissNotice()),
              h.Class(
                'toast floating pointer-events-auto rounded-full px-4 py-2.5 text-[15px] font-medium',
              ),
            ],
            [notice],
          ),
        ],
      ),
  })

/**
 * The mini player and the full player for the song playing. Each takes the
 * values it shows, worked out here, and is kept until one of them changes:
 * only a tick of the clock moves the position, so typing, scrolling, and
 * pages loading leave both alone.
 */
const nowPlayingView = (
  model: Model,
  snapshot: SessionSnapshot,
  entry: Session.QueueEntry,
  h: HtmlBuilder<Message>,
): Html => {
  const { state } = snapshot
  const { track } = entry
  const position = displayedPosition(model, snapshot)
  const loading = isLoading(model, snapshot)
  const device = deviceLabel(model, snapshot)
  const color = backdropColor(model, track)
  return h.div(
    [],
    [
      lazyMiniPlayer(miniPlayer, [
        track,
        device.isElsewhere ? device.text : track.artists,
        device.isElsewhere,
        state.playing,
        loading,
        hasNextEntry(state),
        swipeFor(model.swipe, isMiniPlayer),
        progressWidth(track, position),
        h,
      ]),
      lazyPlayerSheet(playerSheet, [
        model.playerSheet._tag === 'Open',
        model.playerPanel,
        state,
        track,
        color,
        Array.contains(likedVideoIds(model), track.videoId),
        device.iconNode,
        device.text,
        device.isElsewhere,
        sleepTimerText(snapshot, model.now),
        loading,
        model.phoneAudio._tag === 'Blocked',
        position,
        Option.isSome(model.maybeScrubSeconds),
        lyricsDetails(model, track),
        swipeFor(model.swipe, isPlayerSwipe),
        h,
      ]),
    ],
  )
}

/** The mini player, the full player, and any notice. */
export const playerView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const maybeNowPlaying = Option.flatMap(model.maybeSession, snapshot =>
    Option.map(currentEntry(snapshot.state), entry => ({ snapshot, entry })),
  )
  return h.div(
    [],
    [
      Option.match(maybeNowPlaying, {
        onNone: () => h.empty,
        onSome: ({ snapshot, entry }) =>
          nowPlayingView(model, snapshot, entry, h),
      }),
      lazyNotice(noticeToast, [model.maybeNotice, h]),
    ],
  )
}

/** Whether the mini player is showing, so pages can leave room for it. */
export const hasMiniPlayer = (model: Model): boolean =>
  Option.exists(model.maybeSession, snapshot =>
    Option.isSome(currentEntry(snapshot.state)),
  )
