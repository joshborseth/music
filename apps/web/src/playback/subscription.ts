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
        Match.tag('State', ({ state, serverNow }) =>
          Clock.currentTimeMillis.pipe(
            Effect.map(receivedAt =>
              Message.ReceivedSessionState({ state, serverNow, receivedAt }),
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

/** The audio element events the player listens to. */
const PhoneAudioEvent = Schema.Literals([
  'timeupdate',
  'ended',
  'error',
  'waiting',
  'playing',
])
type PhoneAudioEvent = typeof PhoneAudioEvent.Type

const toPhoneAudioMessage =
  (audio: HTMLAudioElement) =>
  (event: PhoneAudioEvent): Effect.Effect<PhoneAudioMessage> =>
    Match.value(event).pipe(
      Match.withReturnType<Effect.Effect<PhoneAudioMessage>>(),
      Match.when('ended', () => Effect.succeed(Message.EndedPhoneAudio())),
      Match.when('error', () =>
        Effect.succeed(
          Message.FailedPhoneAudio({
            error: audio.error?.message ?? 'The song could not be played',
          }),
        ),
      ),
      Match.when('waiting', () =>
        Effect.succeed(
          Message.ChangedPhoneAudioBuffering({ isBuffering: true }),
        ),
      ),
      Match.when('playing', () =>
        Effect.succeed(
          Message.ChangedPhoneAudioBuffering({ isBuffering: false }),
        ),
      ),
      Match.when('timeupdate', () =>
        Clock.currentTimeMillis.pipe(
          Effect.map(at =>
            Message.UpdatedPhoneAudioTime({ seconds: audio.currentTime, at }),
          ),
        ),
      ),
      Match.exhaustive,
    )

const streamPhoneAudioEvents = (audio: HTMLAudioElement) =>
  Stream.callback<PhoneAudioEvent>(queue =>
    Effect.acquireRelease(
      Effect.sync(() =>
        Array.map(PhoneAudioEvent.literals, name => {
          const handle = () => Queue.offerUnsafe(queue, name)
          audio.addEventListener(name, handle)
          return { name, handle }
        }),
      ),
      listeners =>
        Effect.sync(() =>
          Array.forEach(listeners, ({ name, handle }) =>
            audio.removeEventListener(name, handle),
          ),
        ),
    ).pipe(Effect.flatMap(() => Effect.never)),
  ).pipe(Stream.mapEffect(toPhoneAudioMessage(audio)))

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
        setMediaSessionAction(action, () =>
          Queue.offerUnsafe(queue, Message.PressedMediaKey({ key })),
        ),
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

    return Effect.acquireRelease(
      Effect.sync(() => {
        register()
        Array.forEach(AUDIO_EVENTS_THAT_RESET_MEDIA_SESSION, name =>
          audio.addEventListener(name, register),
        )
      }),
      () =>
        Effect.sync(() => {
          Array.forEach(AUDIO_EVENTS_THAT_RESET_MEDIA_SESSION, name =>
            audio.removeEventListener(name, register),
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
