import { Array, Option, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import {
  ChevronDown,
  Ellipsis,
  Heart,
  Infinity as InfinityIcon,
  ListMusic,
  LoaderCircle,
  MessageSquareQuote,
  Monitor,
  Music,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Smartphone,
  Speaker,
  Trash2,
  Tv,
  X,
} from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Session } from '@music/shared'

import { songFromQueueTrack } from '../library'
import { Message } from '../message'
import { Model } from '../model'
import { DragToDismiss, FollowSeekBarDrags } from '../mount'
import {
  type Output,
  SKIP_SECONDS,
  type SessionSnapshot,
  currentEntry,
  hasNextEntry,
  loadedEntry,
  outputText,
  playbackOutput,
  upcomingEntries,
} from '../playback/domain'
import { displayedPosition } from '../playback/position'
import { SwipeTarget, swipeOn } from '../playback/swipe'
import { artworkBackdropQuery, songQuery } from '../query'
import { type PlayerPanel } from '../sheet'
import { likedVideoIds } from '../update'
import { timedLyrics } from './lyrics'
import { formatDuration } from './shared'
import { onSwipeStart, swipeTransitionClass, swipeableRow } from './swipe'

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
export const thisDeviceName = (model: Model): string =>
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

const progressFraction = (
  model: Model,
  snapshot: SessionSnapshot,
  entry: Session.QueueEntry,
): number => {
  const duration = entry.track.durationSeconds ?? 0
  return duration > 0
    ? Math.min(1, displayedPosition(model, snapshot) / duration)
    : 0
}

// ARTWORK

const artwork = (
  track: Session.QueueTrack,
  className: string,
  h: HtmlBuilder<Message>,
): Html =>
  pipe(
    Option.fromNullishOr(track.artworkUrl),
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

const playPauseButton = (
  isPlaying: boolean,
  isLoading: boolean,
  config: Readonly<{ buttonClass: string; iconClass: string }>,
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

// MINI PLAYER

/** How much of a finger's travel the mini player follows sideways. */
const MINI_PLAYER_SWIPE_FOLLOW = 0.35

/** How much of a finger's travel the artwork follows sideways. */
const ARTWORK_SWIPE_FOLLOW = 0.5

/** How far a swipe goes before the mini player fades as far as it will. */
const SWIPE_FADE_DISTANCE = 320

const miniPlayer = (
  model: Model,
  snapshot: SessionSnapshot,
  entry: Session.QueueEntry,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeElsewhere = elsewhere(model, snapshot)
  const subtitle = Option.match(maybeElsewhere, {
    onNone: () => entry.track.artists,
    onSome: outputText,
  })
  const progress = progressFraction(model, snapshot, entry)
  const maybeSwipe = swipeOn(
    model.swipe,
    target => target._tag === 'MiniPlayer',
  )
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
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedOpenPlayer()),
              h.AriaLabel('Open player'),
              h.Class(
                'flex h-full min-w-0 flex-1 items-center gap-3 pl-2 text-left',
              ),
            ],
            [
              artwork(entry.track, 'size-10 rounded-lg', h),
              h.span(
                [h.Class('flex min-w-0 flex-col')],
                [
                  h.span(
                    [
                      h.Class(
                        'line-clamp-1 text-[15px] leading-tight font-medium',
                      ),
                    ],
                    [entry.track.title],
                  ),
                  h.span(
                    [
                      h.Class(
                        cn(
                          'line-clamp-1 text-[13px] leading-tight',
                          Option.isSome(maybeElsewhere)
                            ? 'text-primary'
                            : 'text-muted-foreground',
                        ),
                      ),
                    ],
                    [subtitle],
                  ),
                ],
              ),
            ],
          ),
          playPauseButton(
            snapshot.state.playing,
            isLoading(model, snapshot),
            { buttonClass: 'size-11', iconClass: 'size-6' },
            h,
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedNextTrack()),
              h.AriaLabel('Next'),
              h.Disabled(!hasNextEntry(snapshot.state)),
              h.Class(
                'flex size-11 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90 disabled:opacity-35 disabled:active:scale-100',
              ),
            ],
            [icon(h, SkipForward, 'size-6 fill-current stroke-[1.5]')],
          ),
          h.div(
            [h.Class('absolute inset-x-6 bottom-0 h-[2px] rounded-full')],
            [
              h.div([
                h.Class('bg-foreground/70 h-full rounded-full'),
                h.Style({ width: `${(progress * 100).toFixed(2)}%` }),
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
  model: Model,
  snapshot: SessionSnapshot,
  entry: Session.QueueEntry,
  h: HtmlBuilder<Message>,
): Html => {
  const duration = entry.track.durationSeconds ?? 0
  const position = Math.min(displayedPosition(model, snapshot), duration)
  const percent = duration > 0 ? (position / duration) * 100 : 0
  return h.div(
    [h.Class('flex flex-col'), h.DataAttribute('no-drag', '')],
    [
      h.div(
        [
          h.OnMount(FollowSeekBarDrags()),
          ...(Option.isSome(model.maybeScrubSeconds)
            ? [h.DataAttribute('scrubbing', '')]
            : []),
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
  model: Model,
  snapshot: SessionSnapshot,
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
      playPauseButton(
        snapshot.state.playing,
        isLoading(model, snapshot),
        { buttonClass: 'size-20', iconClass: 'size-12' },
        h,
      ),
      transportButton(
        Message.ClickedNextTrack(),
        SkipForward,
        'Next',
        'size-9 fill-current stroke-[1.25]',
        h,
        hasNextEntry(snapshot.state),
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

const blockedAudioPrompt = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.phoneAudio._tag === 'Blocked'
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
      h.h2(
        [
          h.Class(
            cn(
              'line-clamp-1 font-bold tracking-tight',
              isLarge ? 'text-[22px] leading-tight' : 'text-[17px]',
            ),
          ),
        ],
        [track.title],
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

const trackButtonClass =
  'flex size-10 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90'

/** Like the song, or open everything else that can be done with it. */
const trackActions = (
  model: Model,
  track: Session.QueueTrack,
  h: HtmlBuilder<Message>,
): Html => {
  const song = songFromQueueTrack(track)
  const isLiked = Array.contains(likedVideoIds(model), track.videoId)
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

/**
 * The big artwork. Swiping it sideways skips; pulling it down closes the
 * player, which the whole sheet follows.
 */
const artworkPanel = (
  model: Model,
  snapshot: SessionSnapshot,
  entry: Session.QueueEntry,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeSwipe = swipeOn(
    model.swipe,
    target => target._tag === 'PlayerArtwork',
  )
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
        entry.track,
        cn(
          'player-artwork aspect-square w-full max-w-[min(100%,24rem,44vh)] rounded-2xl',
          snapshot.state.playing
            ? 'scale-100 shadow-2xl shadow-black/50'
            : 'scale-[0.8] shadow-lg shadow-black/30',
        ),
        h,
      ),
    ],
  )
}

const compactNowPlaying = (
  model: Model,
  entry: Session.QueueEntry,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center gap-3 py-3')],
    [
      artwork(entry.track, 'size-14 rounded-lg shadow-md', h),
      trackTitle(entry.track, false, h),
      trackActions(model, entry.track, h),
    ],
  )

const scrollPanelClass =
  'no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain [mask-image:linear-gradient(transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]'

const plainPanel = (content: Html, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.DataAttribute('sheet-scroll', ''), h.Class(scrollPanelClass)],
    [content],
  )

const lyricsPanel = (
  model: Model,
  snapshot: SessionSnapshot,
  entry: Session.QueueEntry,
  h: HtmlBuilder<Message>,
): Html => {
  const message = (text: string) =>
    plainPanel(
      h.p([h.Class('py-10 text-center text-[17px] text-white/60')], [text]),
      h,
    )
  return AsyncData.matchData(
    songQuery.read(model.songs, { videoId: entry.track.videoId }),
    {
      onEmpty: () =>
        plainPanel(
          h.div(
            [h.Class('flex justify-center py-10 text-white/60')],
            [icon(h, LoaderCircle, 'size-6 animate-spin')],
          ),
          h,
        ),
      onFailure: () => message('Lyrics could not be loaded.'),
      onData: details =>
        Option.match(details.maybeLyrics, {
          onNone: () => message('No lyrics for this song.'),
          onSome: lyrics =>
            Option.match(lyrics.maybeLines, {
              onSome: lines =>
                timedLyrics(
                  lines,
                  displayedPosition(model, snapshot),
                  snapshot.state.playing,
                  lyrics.maybeSource,
                  scrollPanelClass,
                  h,
                ),
              onNone: () =>
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
        }),
    },
  )
}

/**
 * The songs to come: first the ones someone queued, then the similar songs
 * autoplay added, under a switch that turns autoplay on or off.
 */
const queuePanel = (
  model: Model,
  snapshot: SessionSnapshot,
  h: HtmlBuilder<Message>,
): Html => {
  const upcoming = upcomingEntries(snapshot.state)
  const queued = Array.filter(upcoming, entry => !entry.autoplay)
  const autoplayed = Array.filter(upcoming, entry => entry.autoplay)
  const isAutoplayOn = snapshot.state.autoplay
  return h.div(
    [h.DataAttribute('sheet-scroll', ''), h.Class(scrollPanelClass)],
    [
      Array.match(queued, {
        onEmpty: () => h.empty,
        onNonEmpty: entries =>
          h.section(
            [],
            [
              h.h3(
                [h.Class('pt-4 pb-2 text-[17px] font-bold')],
                ['Playing next'],
              ),
              queueList(model, entries, h),
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
                onNonEmpty: entries => queueList(model, entries, h),
              })
            : h.empty,
        ],
      ),
    ],
  )
}

/** Upcoming songs: tap one to jump to it, swipe one away to remove it. */
const queueList = (
  model: Model,
  entries: ReadonlyArray<Session.QueueEntry>,
  h: HtmlBuilder<Message>,
): Html =>
  h.ul(
    [h.Class('-mx-2 flex flex-col pb-4')],
    Array.map(entries, entry =>
      h.keyed('li')(
        entry.entryId,
        [],
        [
          swipeableRow(
            {
              target: SwipeTarget.QueueEntry({
                entryId: entry.entryId,
              }),
              maybeSwipe: swipeOn(
                model.swipe,
                target =>
                  target._tag === 'QueueEntry' &&
                  target.entryId === entry.entryId,
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
      ),
    ),
  )

/** One upcoming song: tap to jump to it, or remove it. */
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
          artwork(entry.track, 'size-12 rounded-md', h),
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
      h.button(
        [
          h.Type('button'),
          h.OnClick(
            Message.ClickedRemoveQueueEntry({
              entryId: entry.entryId,
            }),
          ),
          h.AriaLabel(`Remove ${entry.track.title}`),
          h.Class(
            'flex size-10 shrink-0 items-center justify-center rounded-full text-white/60 active:bg-white/10',
          ),
        ],
        [icon(h, X, 'size-5')],
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

const deviceButton = (
  model: Model,
  snapshot: SessionSnapshot,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeElsewhere = elsewhere(model, snapshot)
  return h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedDevices()),
      h.AriaLabel('Choose where to play'),
      h.Class(
        cn(
          'flex h-11 min-w-0 items-center gap-2 rounded-full px-4 text-[13px] font-semibold active:bg-white/10',
          Option.isSome(maybeElsewhere) ? 'text-primary' : 'text-white/70',
        ),
      ),
    ],
    [
      icon(
        h,
        Option.match(maybeElsewhere, {
          onNone: () => Speaker,
          onSome: ({ device }) => deviceIcon(device, false),
        }),
        'size-5 shrink-0',
      ),
      h.span(
        [h.Class('line-clamp-1')],
        [
          Option.match(maybeElsewhere, {
            onNone: () => thisDeviceName(model),
            onSome: outputText,
          }),
        ],
      ),
    ],
  )
}

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
 * the app keeps. The top starts as `color` itself and fades into the cover,
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
              'absolute inset-0 size-full scale-[1.6] object-cover opacity-90 blur-[72px] saturate-[1.8]',
            ),
          ]),
      }),
      h.div([
        h.Class(
          'absolute inset-0 bg-gradient-to-b from-black/25 via-black/40 to-black/70',
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

const playerSheet = (
  model: Model,
  snapshot: SessionSnapshot,
  entry: Session.QueueEntry,
  h: HtmlBuilder<Message>,
): Html => {
  const isOpen = model.playerSheet._tag === 'Open'
  const panel = model.playerPanel
  const color = backdropColor(model, entry.track)
  return h.div(
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
      playerBackdrop(color, entry.track, h),
      h.div(
        [
          h.Class(
            'relative mx-auto flex h-full w-full max-w-xl flex-col px-6 pt-[calc(var(--safe-top)+0.25rem)] pb-[max(var(--safe-bottom),1rem)]',
          ),
        ],
        [
          h.div(
            [h.Class('flex items-center justify-between')],
            [
              h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.ClickedClosePlayer()),
                  h.AriaLabel('Close player'),
                  h.Class(
                    'flex size-10 items-center justify-center rounded-full text-white/80 active:bg-white/10',
                  ),
                ],
                [icon(h, ChevronDown, 'size-7')],
              ),
              h.span([
                h.AriaHidden(true),
                h.Class('h-[5px] w-10 rounded-full bg-white/35'),
              ]),
              h.span([h.Class('size-10')]),
            ],
          ),
          panel === 'Artwork'
            ? artworkPanel(model, snapshot, entry, h)
            : compactNowPlaying(model, entry, h),
          panel === 'Lyrics' ? lyricsPanel(model, snapshot, entry, h) : h.empty,
          panel === 'Queue' ? queuePanel(model, snapshot, h) : h.empty,
          h.div(
            [h.Class('flex flex-col gap-3 pt-2')],
            [
              panel === 'Artwork'
                ? h.div(
                    [h.Class('flex items-center gap-2')],
                    [
                      trackTitle(entry.track, true, h),
                      trackActions(model, entry.track, h),
                    ],
                  )
                : h.empty,
              seekBar(model, snapshot, entry, h),
              transportControls(model, snapshot, h),
              blockedAudioPrompt(model, h),
              h.div(
                [h.Class('flex items-center justify-between pt-1')],
                [
                  panelToggle('Lyrics', panel, MessageSquareQuote, 'Lyrics', h),
                  deviceButton(model, snapshot, h),
                  panelToggle('Queue', panel, ListMusic, 'Up next', h),
                ],
              ),
            ],
          ),
        ],
      ),
      statusBarColor(color, h),
    ],
  )
}

// NOTICE

const noticeToast = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeNotice, {
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
          h.div(
            [],
            [
              miniPlayer(model, snapshot, entry, h),
              playerSheet(model, snapshot, entry, h),
            ],
          ),
      }),
      noticeToast(model, h),
    ],
  )
}

/** Whether the mini player is showing, so pages can leave room for it. */
export const hasMiniPlayer = (model: Model): boolean =>
  Option.exists(model.maybeSession, snapshot =>
    Option.isSome(currentEntry(snapshot.state)),
  )
