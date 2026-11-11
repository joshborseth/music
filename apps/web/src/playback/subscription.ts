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

const MEDIA_SESSION_ACTIONS: ReadonlyArray<
  readonly [MediaKey, MediaSessionAction]
> = [
  ['Play', 'play'],
  ['Pause', 'pause'],
  ['NextTrack', 'nexttrack'],
  ['PreviousTrack', 'previoustrack'],
]

// NOTE: iOS shows ±10 second skip buttons on the lock screen unless the page
// handles the track actions, and it prefers seek buttons when both exist.
const SUPPRESSED_MEDIA_SESSION_ACTIONS: ReadonlyArray<MediaSessionAction> = [
  'seekbackward',
  'seekforward',
]

const hasMediaSession = (): boolean => 'mediaSession' in globalThis.navigator

const clearMediaSessionAction = (action: MediaSessionAction) => {
  try {
    globalThis.navigator.mediaSession.setActionHandler(action, null)
  } catch {
    // NOTE: browsers throw for actions they do not support.
  }
}

const streamMediaKeys = Stream.callback<MediaKey>(queue =>
  Effect.acquireRelease(
    Effect.sync(() => {
      if (hasMediaSession()) {
        Array.forEach(SUPPRESSED_MEDIA_SESSION_ACTIONS, clearMediaSessionAction)
        Array.forEach(MEDIA_SESSION_ACTIONS, ([key, action]) =>
          globalThis.navigator.mediaSession.setActionHandler(action, () =>
            Queue.offerUnsafe(queue, key),
          ),
        )
      }
    }),
    () =>
      Effect.sync(() => {
        if (hasMediaSession()) {
          Array.forEach(MEDIA_SESSION_ACTIONS, ([, action]) =>
            clearMediaSessionAction(action),
          )
        }
      }),
  ).pipe(Effect.flatMap(() => Effect.never)),
).pipe(Stream.map(key => Message.PressedMediaKey({ key })))

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
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () => streamMediaKeys,
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
