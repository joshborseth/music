import {
  Array,
  Clock,
  Duration,
  Effect,
  Match,
  Option,
  Queue,
  Schema,
  Stream,
} from 'effect'
import { Subscription } from 'foldkit'

import { Session } from '@music/shared'

import { Message } from '../message'
import type { Model } from '../model'
import type { MediaKey } from './domain'
import {
  entryIdOf,
  followIntent,
  isLoading,
  isMeantToPlay,
  pauseAudio,
  startAudio,
} from './element'
import {
  PhoneAudioElement,
  type PlaybackServices,
  SessionSocket,
} from './resource'

const CLOCK_TICK = Duration.seconds(1)

const decodeServerMessage = Schema.decodeUnknownOption(
  Session.ServerMessageJson,
)

type SessionSocketMessage =
  | typeof Message.ReceivedSessionState.Type
  | typeof Message.ReceivedSessionNotice.Type
  | typeof Message.ClosedSessionSocket.Type

const streamSessionMessages = (socket: WebSocket) =>
  Stream.callback<Session.ServerMessage | 'Closed'>(queue =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const handleMessage = (event: MessageEvent) => {
          const maybeMessage = decodeServerMessage(event.data)
          if (Option.isSome(maybeMessage)) {
            Queue.offerUnsafe(queue, maybeMessage.value)
          }
        }
        const handleClose = () => {
          Queue.offerUnsafe(queue, 'Closed')
          Queue.endUnsafe(queue)
        }
        socket.addEventListener('message', handleMessage)
        socket.addEventListener('close', handleClose)
        return { handleMessage, handleClose }
      }),
      ({ handleMessage, handleClose }) =>
        Effect.sync(() => {
          socket.removeEventListener('message', handleMessage)
          socket.removeEventListener('close', handleClose)
        }),
    ).pipe(Effect.flatMap(() => Effect.never)),
  ).pipe(
    Stream.mapEffect(message =>
      Match.value(message).pipe(
        Match.withReturnType<Effect.Effect<SessionSocketMessage>>(),
        Match.when('Closed', () =>
          Effect.succeed(Message.ClosedSessionSocket()),
        ),
        Match.tag('State', ({ state, serverNow, ack }) =>
          Clock.currentTimeMillis.pipe(
            Effect.map(receivedAt =>
              Message.ReceivedSessionState({
                state,
                serverNow,
                ack,
                receivedAt,
              }),
            ),
          ),
        ),
        Match.tag('Notice', ({ message: text }) =>
          Effect.succeed(Message.ReceivedSessionNotice({ message: text })),
        ),
        Match.exhaustive,
      ),
    ),
  )

type PhoneAudioMessage =
  | typeof Message.UpdatedPhoneAudioTime.Type
  | typeof Message.EndedPhoneAudio.Type
  | typeof Message.FailedPhoneAudio.Type
  | typeof Message.ChangedPhoneAudioBuffering.Type
  | typeof Message.PausedPhoneAudio.Type
  | typeof Message.ResumedPhoneAudio.Type

/** The audio element events the player listens to. */
const PhoneAudioEvent = Schema.Literals([
  'timeupdate',
  'ended',
  'error',
  'waiting',
  'playing',
  'play',
  'pause',
])
type PhoneAudioEvent = typeof PhoneAudioEvent.Type

/** An audio event and what the element said when it fired. */
interface PhoneAudioSnapshot {
  readonly event: PhoneAudioEvent
  readonly entryId: string
  readonly seconds: number
  readonly maybeError: Option.Option<string>
}

/** A pause this close to the end is the song ending, not someone pausing it. */
const END_SLACK_SECONDS = 0.5

const isAtEnd = (audio: HTMLAudioElement): boolean =>
  audio.ended ||
  (Number.isFinite(audio.duration) &&
    audio.duration - audio.currentTime < END_SLACK_SECONDS)

/**
 * Events worth telling the player about. Nothing comes from the silent clip
 * that unlocks audio, which has no entry. A new song resets the clock to 0
 * before it knows its length, which is no position. Play and pause count
 * only when the app did not ask for them, so the session follows the system
 * pausing the song. A song that ends pauses first, which is no pause.
 */
const isReported = (
  audio: HTMLAudioElement,
  event: PhoneAudioEvent,
): boolean => {
  if (event === 'timeupdate') {
    return audio.readyState >= HTMLMediaElement.HAVE_METADATA
  } else if (event === 'play') {
    return !audio.paused && !isMeantToPlay(audio)
  } else if (event === 'pause') {
    return audio.paused && isMeantToPlay(audio) && !isAtEnd(audio)
  } else {
    return true
  }
}

const toPhoneAudioMessage = ({
  event,
  entryId,
  seconds,
  maybeError,
}: PhoneAudioSnapshot): Effect.Effect<PhoneAudioMessage> =>
  Match.value(event).pipe(
    Match.withReturnType<Effect.Effect<PhoneAudioMessage>>(),
    Match.when('ended', () =>
      Effect.succeed(Message.EndedPhoneAudio({ entryId })),
    ),
    Match.when('error', () =>
      Effect.succeed(
        Message.FailedPhoneAudio({
          entryId,
          error: Option.getOrElse(
            maybeError,
            () => 'The song could not be played',
          ),
        }),
      ),
    ),
    Match.when('waiting', () =>
      Effect.succeed(
        Message.ChangedPhoneAudioBuffering({ entryId, isBuffering: true }),
      ),
    ),
    Match.when('playing', () =>
      Effect.succeed(
        Message.ChangedPhoneAudioBuffering({ entryId, isBuffering: false }),
      ),
    ),
    Match.when('play', () =>
      Effect.succeed(Message.ResumedPhoneAudio({ entryId })),
    ),
    Match.when('pause', () =>
      Effect.succeed(Message.PausedPhoneAudio({ entryId })),
    ),
    Match.when('timeupdate', () =>
      Clock.currentTimeMillis.pipe(
        Effect.map(at =>
          Message.UpdatedPhoneAudioTime({ entryId, seconds, at }),
        ),
      ),
    ),
    Match.exhaustive,
  )

const streamPhoneAudioEvents = (audio: HTMLAudioElement) =>
  Stream.callback<PhoneAudioSnapshot>(queue =>
    Effect.acquireRelease(
      Effect.sync(() =>
        Array.map(PhoneAudioEvent.literals, event => {
          // NOTE: read the element as the event fires. By the time the
          // message is handled it may already play something else.
          const handle = () =>
            Option.match(entryIdOf(audio), {
              onNone: () => undefined,
              onSome: entryId => {
                if (isReported(audio, event)) {
                  if (event === 'play' || event === 'pause') {
                    followIntent(audio, event === 'play')
                  }
                  Queue.offerUnsafe(queue, {
                    event,
                    entryId,
                    seconds: audio.currentTime,
                    maybeError: Option.fromNullishOr(audio.error?.message),
                  })
                }
              },
            })
          audio.addEventListener(event, handle)
          return { event, handle }
        }),
      ),
      listeners =>
        Effect.sync(() =>
          Array.forEach(listeners, ({ event, handle }) =>
            audio.removeEventListener(event, handle),
          ),
        ),
    ).pipe(Effect.flatMap(() => Effect.never)),
  ).pipe(Stream.mapEffect(toPhoneAudioMessage))

const MEDIA_KEY_ACTIONS: ReadonlyArray<
  readonly [MediaKey, MediaSessionAction]
> = [
  ['Play', 'play'],
  ['Pause', 'pause'],
  ['NextTrack', 'nexttrack'],
  ['PreviousTrack', 'previoustrack'],
]

// NOTE: iOS shows ±seconds skip buttons on the lock screen unless the page
// handles the track actions, and it prefers seek buttons when both exist.
const SUPPRESSED_MEDIA_SESSION_ACTIONS: ReadonlyArray<MediaSessionAction> = [
  'seekbackward',
  'seekforward',
]

// NOTE: WebKit drops action handlers set while no media element has a
// player, which is the case at startup, and forgets them all again when its
// last player goes away (a song that fails to load). With no handlers it
// falls back to its own commands, which are the ±seconds skip buttons. So the
// handlers are set again each time the audio element loads or plays a song.
const AUDIO_EVENTS_THAT_RESET_MEDIA_SESSION = ['loadstart', 'playing'] as const

/** The lock screen's play/pause button follows the element, not the session. */
const PLAYBACK_STATE_EVENTS = ['play', 'pause', 'ended'] as const

type MediaSessionMessage =
  | typeof Message.PressedMediaKey.Type
  | typeof Message.ChangedSeekPosition.Type

const hasMediaSession = (): boolean => 'mediaSession' in globalThis.navigator

const setMediaSessionAction = (
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
) => {
  try {
    globalThis.navigator.mediaSession.setActionHandler(action, handler)
  } catch {
    // NOTE: browsers throw for actions they do not support.
  }
}

/**
 * Play and pause the element inside the lock screen's own handler. iOS only
 * counts it as the person's tap there; once the page is suspended (paused on
 * the lock screen for a while), a `play()` made later is refused. The update
 * then catches the session up.
 */
const applyMediaKeyNow = (audio: HTMLAudioElement, key: MediaKey) => {
  if (Option.isNone(entryIdOf(audio))) {
    return
  }
  if (key === 'Play') {
    // NOTE: a song still loading starts once it has loaded; the one it
    // replaces must not come back meanwhile.
    if (!isLoading(audio)) {
      startAudio(audio).catch(() => followIntent(audio, !audio.paused))
    }
  } else if (key === 'Pause') {
    pauseAudio(audio)
  }
}

const streamMediaSessionActions = (audio: HTMLAudioElement) =>
  Stream.callback<MediaSessionMessage>(queue => {
    const register = () => {
      if (!hasMediaSession()) {
        return
      }
      Array.forEach(SUPPRESSED_MEDIA_SESSION_ACTIONS, action =>
        setMediaSessionAction(action, null),
      )
      Array.forEach(MEDIA_KEY_ACTIONS, ([key, action]) =>
        setMediaSessionAction(action, () => {
          applyMediaKeyNow(audio, key)
          Queue.offerUnsafe(queue, Message.PressedMediaKey({ key }))
        }),
      )
      // NOTE: without this the lock screen's scrubber stops working once the
      // handlers above replace WebKit's own commands.
      setMediaSessionAction('seekto', ({ seekTime }) => {
        if (seekTime !== undefined) {
          Queue.offerUnsafe(
            queue,
            Message.ChangedSeekPosition({ seconds: seekTime }),
          )
        }
      })
    }

    const syncPlaybackState = () => {
      if (hasMediaSession() && Option.isSome(entryIdOf(audio))) {
        globalThis.navigator.mediaSession.playbackState = audio.paused
          ? 'paused'
          : 'playing'
      }
    }

    return Effect.acquireRelease(
      Effect.sync(() => {
        register()
        Array.forEach(AUDIO_EVENTS_THAT_RESET_MEDIA_SESSION, name =>
          audio.addEventListener(name, register),
        )
        Array.forEach(PLAYBACK_STATE_EVENTS, name =>
          audio.addEventListener(name, syncPlaybackState),
        )
      }),
      () =>
        Effect.sync(() => {
          Array.forEach(AUDIO_EVENTS_THAT_RESET_MEDIA_SESSION, name =>
            audio.removeEventListener(name, register),
          )
          Array.forEach(PLAYBACK_STATE_EVENTS, name =>
            audio.removeEventListener(name, syncPlaybackState),
          )
          if (hasMediaSession()) {
            Array.forEach(MEDIA_KEY_ACTIONS, ([, action]) =>
              setMediaSessionAction(action, null),
            )
            setMediaSessionAction('seekto', null)
          }
        }),
    ).pipe(Effect.flatMap(() => Effect.never))
  })

const streamSwipePointer = Stream.merge(
  Stream.fromEventListener<PointerEvent>(document, 'pointermove').pipe(
    Stream.map(event =>
      Message.MovedSwipePointer({
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        timeStamp: event.timeStamp,
      }),
    ),
  ),
  Stream.merge(
    Stream.fromEventListener<PointerEvent>(document, 'pointerup').pipe(
      Stream.map(event =>
        Message.ReleasedSwipePointer({
          pointerId: event.pointerId,
          timeStamp: event.timeStamp,
        }),
      ),
    ),
    Stream.fromEventListener<PointerEvent>(document, 'pointercancel').pipe(
      Stream.map(event =>
        Message.CancelledSwipePointer({ pointerId: event.pointerId }),
      ),
    ),
  ),
)

export const subscriptions = Subscription.make<
  Model,
  Message,
  PlaybackServices
>()(entry => ({
  sessionMessages: entry(
    { isConnected: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isConnected: model.connection._tag === 'Connected',
      }),
      dependenciesToStream: ({ isConnected }) =>
        Stream.when(
          Stream.unwrap(
            SessionSocket.get.pipe(
              Effect.map(streamSessionMessages),
              Effect.catchTag('ResourceNotAvailable', () =>
                Effect.succeed(Stream.empty),
              ),
            ),
          ),
          Effect.sync(() => isConnected),
        ),
    },
  ),

  phoneAudioEvents: entry(
    { isAvailable: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isAvailable: model.phoneAudio._tag !== 'Unavailable',
      }),
      dependenciesToStream: ({ isAvailable }) =>
        Stream.when(
          Stream.unwrap(
            PhoneAudioElement.get.pipe(
              Effect.map(streamPhoneAudioEvents),
              Effect.catchTag('ResourceNotAvailable', () =>
                Effect.succeed(Stream.empty),
              ),
            ),
          ),
          Effect.sync(() => isAvailable),
        ),
    },
  ),

  mediaSessionActions: entry(
    { isAvailable: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isAvailable: model.phoneAudio._tag !== 'Unavailable',
      }),
      dependenciesToStream: ({ isAvailable }) =>
        Stream.when(
          Stream.unwrap(
            PhoneAudioElement.get.pipe(
              Effect.map(streamMediaSessionActions),
              Effect.catchTag('ResourceNotAvailable', () =>
                Effect.succeed(Stream.empty),
              ),
            ),
          ),
          Effect.sync(() => isAvailable),
        ),
    },
  ),

  swipePointer: entry(
    { isTracking: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isTracking: model.swipe._tag === 'Tracking',
      }),
      dependenciesToStream: ({ isTracking }) =>
        Stream.when(
          streamSwipePointer,
          Effect.sync(() => isTracking),
        ),
    },
  ),

  clock: entry(
    { isPlaying: Schema.Boolean },
    {
      modelToDependencies: model => ({
        isPlaying: Option.exists(
          model.maybeSession,
          ({ state }) => state.playing,
        ),
      }),
      dependenciesToStream: ({ isPlaying }) =>
        Stream.when(
          Stream.tick(CLOCK_TICK).pipe(
            Stream.mapEffect(() => Clock.currentTimeMillis),
            Stream.map(now => Message.TickedClock({ now })),
          ),
          Effect.sync(() => isPlaying),
        ),
    },
  ),
}))
