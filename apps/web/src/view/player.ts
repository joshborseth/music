import { Array, Option, pipe } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'
import {
  ChevronDown,
  LoaderCircle,
  Monitor,
  Music,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Smartphone,
  Trash2,
  Tv,
  X,
} from 'lucide'

import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Session } from '@music/shared'

import { Message } from '../message'
import { Model } from '../model'
import {
  SKIP_SECONDS,
  type SessionSnapshot,
  activeDevice,
  currentEntry,
  loadedEntry,
  upcomingEntries,
} from '../playback/domain'
import { displayedPosition } from '../playback/position'
import { SwipeTarget, type TrackingSwipe, swipeOn } from '../playback/swipe'
import { formatDuration } from './shared'
import { onSwipeStart, swipeTransitionClass, swipeableRow } from './swipe'

// POSITION

/** The phone has asked for audio and is still waiting for it. */
const isBuffering = (model: Model): boolean =>
  Option.exists(
    loadedEntry(model.phoneAudio),
    entry => entry.isPlaying && entry.isBuffering,
  )

const deviceIcon = (device: Session.Device, isThisDevice: boolean) => {
  if (device.kind === 'Tv') {
    return Tv
  } else if (isThisDevice) {
    return Smartphone
  } else {
    return Monitor
  }
}

const whereText = (model: Model, snapshot: SessionSnapshot): string =>
  Option.match(activeDevice(snapshot.state), {
    onNone: () => '',
    onSome: device =>
      Option.exists(
        model.maybeIdentity,
        ({ deviceId }) => deviceId === device.id,
      )
        ? ''
        : `Playing on ${device.name}`,
  })

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
                'bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-md',
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
          h.Class(cn('bg-muted shrink-0 rounded-md object-cover', className)),
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
  size: 'icon-lg' | 'icon',
  h: HtmlBuilder<Message>,
): Html =>
  button(
    {
      onClick: Message.ClickedTogglePlayback(),
      variant: size === 'icon' ? 'ghost' : 'default',
      size,
      className: size === 'icon' ? 'rounded-full' : 'size-16 rounded-full',
    },
    [
      icon(
        h,
        playPauseIcon(isPlaying, isLoading),
        cn(size === 'icon' ? 'size-5' : 'size-7', isLoading && 'animate-spin'),
      ),
      h.span([h.Class('sr-only')], [isPlaying ? 'Pause' : 'Play']),
    ],
    h,
  )

// MINI PLAYER

/** How much of a finger's sideways travel the mini player follows. */
const MINI_PLAYER_SWIPE_FOLLOW = 0.35

/** How much of a finger's travel the full player follows, sideways and down. */
const SHEET_SWIPE_FOLLOW_X = 0.35
const SHEET_SWIPE_FOLLOW_Y = 0.55

/** How far a swipe goes before the mini player fades as far as it will. */
const SWIPE_FADE_DISTANCE = 320

const miniPlayer = (
  model: Model,
  snapshot: SessionSnapshot,
  entry: Session.QueueEntry,
  h: HtmlBuilder<Message>,
): Html => {
  const where = whereText(model, snapshot)
  const duration = entry.track.durationSeconds ?? 0
  const progress =
    duration > 0
      ? Math.min(1, displayedPosition(model, snapshot) / duration)
      : 0
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
        'bg-card/95 border-border fixed inset-x-0 bottom-0 z-20 mx-auto max-w-xl touch-pan-y overflow-hidden border-t backdrop-blur select-none pb-[env(safe-area-inset-bottom)]',
      ),
    ],
    [
      h.div(
        [h.Class('bg-muted h-0.5 w-full')],
        [
          h.div([
            h.Class('bg-primary h-full'),
            h.Style({ width: `${(progress * 100).toFixed(2)}%` }),
          ]),
        ],
      ),
      h.div(
        [
          h.Class(
            cn(
              'flex items-center gap-3 px-3 py-2',
              swipeTransitionClass(maybeSwipe),
            ),
          ),
          h.Style({
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
              h.Class('flex min-w-0 flex-1 items-center gap-3 text-left'),
            ],
            [
              artwork(entry.track, 'size-11', h),
              h.div(
                [h.Class('min-w-0')],
                [
                  h.p(
                    [h.Class('line-clamp-1 text-sm font-medium')],
                    [entry.track.title],
                  ),
                  h.p(
                    [h.Class('text-muted-foreground line-clamp-1 text-xs')],
                    [where === '' ? entry.track.artists : where],
                  ),
                ],
              ),
            ],
          ),
          playPauseButton(
            snapshot.state.playing,
            isBuffering(model),
            'icon',
            h,
          ),
          button(
            {
              onClick: Message.ClickedNextTrack(),
              variant: 'ghost',
              size: 'icon',
              className: 'rounded-full',
            },
            [
              icon(h, SkipForward, 'size-5'),
              h.span([h.Class('sr-only')], ['Next']),
            ],
            h,
          ),
        ],
      ),
    ],
  )
}

// SHEET

const seekBar = (
  model: Model,
  snapshot: SessionSnapshot,
  entry: Session.QueueEntry,
  h: HtmlBuilder<Message>,
): Html => {
  const duration = entry.track.durationSeconds ?? 0
  const position = Math.min(displayedPosition(model, snapshot), duration)
  return h.div(
    [h.Class('flex flex-col gap-1.5')],
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
        h.Class('accent-primary h-6 w-full cursor-pointer touch-none'),
      ]),
      h.div(
        [
          h.Class(
            'text-muted-foreground flex justify-between text-xs tabular-nums',
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
  h: HtmlBuilder<Message>,
): Html =>
  button(
    {
      onClick,
      variant: 'ghost',
      size: 'icon-lg',
      className: 'size-12 rounded-full',
    },
    [icon(h, iconNode, 'size-6'), h.span([h.Class('sr-only')], [label])],
    h,
  )

const transportControls = (
  model: Model,
  snapshot: SessionSnapshot,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center justify-between px-2')],
    [
      transportButton(Message.ClickedPreviousTrack(), SkipBack, 'Previous', h),
      transportButton(
        Message.ClickedSkipBy({ seconds: -SKIP_SECONDS }),
        RotateCcw,
        `Back ${SKIP_SECONDS} seconds`,
        h,
      ),
      playPauseButton(snapshot.state.playing, isBuffering(model), 'icon-lg', h),
      transportButton(
        Message.ClickedSkipBy({ seconds: SKIP_SECONDS }),
        RotateCw,
        `Forward ${SKIP_SECONDS} seconds`,
        h,
      ),
      transportButton(Message.ClickedNextTrack(), SkipForward, 'Next', h),
    ],
  )

const deviceStatus = (device: Session.Device, isActive: boolean): string => {
  if (device.waking) {
    return 'Turning on…'
  } else if (!device.online) {
    return 'Off: tap to turn on'
  } else if (isActive) {
    return 'Playing'
  } else {
    return ''
  }
}

const devicePicker = (
  model: Model,
  snapshot: SessionSnapshot,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('flex flex-col gap-2')],
    [
      h.h2(
        [h.Class('text-muted-foreground text-xs font-semibold uppercase')],
        ['Play on'],
      ),
      h.div(
        [h.Class('flex flex-col gap-1')],
        Array.map(snapshot.state.devices, device => {
          const isThisDevice = Option.exists(
            model.maybeIdentity,
            ({ deviceId }) => deviceId === device.id,
          )
          const isActive = snapshot.state.activeDeviceId === device.id
          const status = deviceStatus(device, isActive)
          return h.keyed('button')(
            device.id,
            [
              h.Type('button'),
              h.OnClick(Message.ClickedDevice({ deviceId: device.id })),
              h.AriaPressed(isActive ? 'true' : 'false'),
              h.Class(
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-left',
                  isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                ),
              ),
            ],
            [
              icon(h, deviceIcon(device, isThisDevice), 'size-5'),
              h.span(
                [h.Class('flex-1 text-sm font-medium')],
                [isThisDevice ? `This ${device.name}` : device.name],
              ),
              h.span([h.Class('text-muted-foreground text-xs')], [status]),
            ],
          )
        }),
      ),
    ],
  )

const queueList = (
  model: Model,
  snapshot: SessionSnapshot,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(upcomingEntries(snapshot.state), {
    onEmpty: () => h.empty,
    onNonEmpty: entries =>
      h.section(
        [h.Class('flex flex-col gap-2')],
        [
          h.h2(
            [h.Class('text-muted-foreground text-xs font-semibold uppercase')],
            ['Up next'],
          ),
          h.ul(
            [h.Class('flex flex-col')],
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
                    },
                    queueRow(entry, h),
                    h,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
  })

const queueRow = (entry: Session.QueueEntry, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex items-center gap-1')],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedQueueEntry({ entryId: entry.entryId })),
          h.Class(
            'hover:bg-muted flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left',
          ),
        ],
        [
          artwork(entry.track, 'size-10', h),
          h.div(
            [h.Class('min-w-0')],
            [
              h.p([h.Class('line-clamp-1 text-sm')], [entry.track.title]),
              h.p(
                [h.Class('text-muted-foreground line-clamp-1 text-xs')],
                [entry.track.artists],
              ),
            ],
          ),
        ],
      ),
      button(
        {
          onClick: Message.ClickedRemoveQueueEntry({
            entryId: entry.entryId,
          }),
          variant: 'ghost',
          size: 'icon',
          className: 'rounded-full',
        },
        [
          icon(h, X, 'size-4'),
          h.span([h.Class('sr-only')], [`Remove ${entry.track.title}`]),
        ],
        h,
      ),
    ],
  )

const blockedAudioPrompt = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.phoneAudio._tag === 'Blocked'
    ? button(
        {
          onClick: Message.ClickedStartBlockedAudio(),
          className: 'w-full',
        },
        [icon(h, Play, 'size-4'), 'Tap to start audio'],
        h,
      )
    : h.empty

const playerHeader = (where: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex items-center justify-between')],
    [
      button(
        {
          onClick: Message.ClickedClosePlayer(),
          variant: 'ghost',
          size: 'icon-lg',
          className: 'rounded-full',
        },
        [
          icon(h, ChevronDown, 'size-6'),
          h.span([h.Class('sr-only')], ['Close player']),
        ],
        h,
      ),
      h.p(
        [h.Class('text-muted-foreground text-xs font-medium')],
        [where === '' ? 'Playing on this device' : where],
      ),
      h.div([h.Class('size-9')]),
    ],
  )

/** The full player follows a swipe on its artwork: sideways to skip, down to close. */
const sheetSwipeStyle = (maybeSwipe: Option.Option<TrackingSwipe>) =>
  Option.match(maybeSwipe, {
    onNone: () => ({ transform: 'translate(0px, 0px)' }),
    onSome: swipe => {
      const pullDown = swipe.axis === 'Vertical' ? Math.max(0, swipe.deltaY) : 0
      const sideways = swipe.axis === 'Horizontal' ? swipe.deltaX : 0
      return {
        transform: `translate(${sideways * SHEET_SWIPE_FOLLOW_X}px, ${pullDown * SHEET_SWIPE_FOLLOW_Y}px)`,
      }
    },
  })

const playerSheet = (
  model: Model,
  snapshot: SessionSnapshot,
  entry: Session.QueueEntry,
  h: HtmlBuilder<Message>,
): Html => {
  const where = whereText(model, snapshot)
  const maybeSwipe = swipeOn(
    model.swipe,
    target => target._tag === 'PlayerArtwork',
  )
  return h.div(
    [
      h.Role('dialog'),
      h.AriaModal(true),
      h.AriaLabel('Player'),
      h.Class(
        cn(
          'bg-background fixed inset-0 z-30 overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)] pb-[max(env(safe-area-inset-bottom),2rem)]',
          swipeTransitionClass(maybeSwipe),
          Option.isSome(maybeSwipe) && 'rounded-t-3xl shadow-2xl',
        ),
      ),
      h.Style(sheetSwipeStyle(maybeSwipe)),
    ],
    [
      h.div(
        [h.Class('mx-auto flex w-full max-w-xl flex-col gap-6 px-6')],
        [
          h.div(
            [
              onSwipeStart(SwipeTarget.PlayerArtwork(), h),
              h.Class('flex touch-none flex-col gap-1 pt-2 select-none'),
            ],
            [
              h.div([
                h.AriaHidden(true),
                h.Class('bg-muted-foreground/40 mx-auto h-1 w-10 rounded-full'),
              ]),
              playerHeader(where, h),
            ],
          ),
          h.div(
            [
              onSwipeStart(SwipeTarget.PlayerArtwork(), h),
              h.Class('touch-none select-none'),
            ],
            [
              artwork(
                entry.track,
                cn(
                  'aspect-square w-full shadow-xl transition-transform duration-300',
                  snapshot.state.playing ? 'scale-100' : 'scale-90',
                ),
                h,
              ),
            ],
          ),
          h.div(
            [h.Class('flex flex-col gap-1')],
            [
              h.h2(
                [h.Class('text-xl font-bold tracking-tight')],
                [entry.track.title],
              ),
              h.p(
                [h.Class('text-muted-foreground text-sm')],
                [entry.track.artists],
              ),
            ],
          ),
          seekBar(model, snapshot, entry, h),
          transportControls(model, snapshot, h),
          blockedAudioPrompt(model, h),
          devicePicker(model, snapshot, h),
          queueList(model, snapshot, h),
        ],
      ),
    ],
  )
}

// NOTICE

const noticeToast = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeNotice, {
    onNone: () => h.empty,
    onSome: notice =>
      h.button(
        [
          h.Type('button'),
          h.Role('status'),
          h.OnClick(Message.ClickedDismissNotice()),
          h.Class(
            'bg-foreground text-background fixed inset-x-4 bottom-24 z-40 mx-auto max-w-sm rounded-full px-4 py-2 text-center text-sm shadow-lg',
          ),
        ],
        [notice],
      ),
  })

/** The mini player, the full player when open, and any notice. */
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
          model.playerSheet._tag === 'Open'
            ? playerSheet(model, snapshot, entry, h)
            : miniPlayer(model, snapshot, entry, h),
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
