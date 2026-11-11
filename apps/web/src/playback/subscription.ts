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
import { type MediaKey, PhoneAudio } from './domain'
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

const streamPhoneAudioEvents = (audio: HTMLAudioElement) =>
  Stream.callback<'TimeUpdate' | 'Ended' | 'Error'>(queue =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const handleTimeUpdate = () => Queue.offerUnsafe(queue, 'TimeUpdate')
        const handleEnded = () => Queue.offerUnsafe(queue, 'Ended')
        const handleError = () => Queue.offerUnsafe(queue, 'Error')
        audio.addEventListener('timeupdate', handleTimeUpdate)
        audio.addEventListener('ended', handleEnded)
        audio.addEventListener('error', handleError)
        return { handleTimeUpdate, handleEnded, handleError }
      }),
      ({ handleTimeUpdate, handleEnded, handleError }) =>
        Effect.sync(() => {
          audio.removeEventListener('timeupdate', handleTimeUpdate)
          audio.removeEventListener('ended', handleEnded)
          audio.removeEventListener('error', handleError)
        }),
    ).pipe(Effect.flatMap(() => Effect.never)),
  ).pipe(
    Stream.mapEffect((event): Effect.Effect<PhoneAudioMessage> => {
      if (event === 'Ended') {
        return Effect.succeed(Message.EndedPhoneAudio())
      } else if (event === 'Error') {
        return Effect.succeed(
          Message.FailedPhoneAudio({
            error: audio.error?.message ?? 'The song could not be played',
          }),
        )
      } else {
        return Clock.currentTimeMillis.pipe(
          Effect.map(at =>
            Message.UpdatedPhoneAudioTime({ seconds: audio.currentTime, at }),
          ),
        )
      }
    }),
  )

const MEDIA_SESSION_ACTIONS: ReadonlyArray<
  readonly [MediaKey, MediaSessionAction]
> = [
  ['Play', 'play'],
  ['Pause', 'pause'],
  ['NextTrack', 'nexttrack'],
  ['PreviousTrack', 'previoustrack'],
]

const hasMediaSession = (): boolean => 'mediaSession' in globalThis.navigator

const streamMediaKeys = Stream.callback<MediaKey>(queue =>
  Effect.acquireRelease(
    Effect.sync(() => {
      if (hasMediaSession()) {
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
            globalThis.navigator.mediaSession.setActionHandler(action, null),
          )
        }
      }),
  ).pipe(Effect.flatMap(() => Effect.never)),
).pipe(Stream.map(key => Message.PressedMediaKey({ key })))

const isPhonePlaying = (model: Model): boolean =>
  PhoneAudio.match(model.phoneAudio, {
    Unavailable: () => false,
    Idle: () => false,
    Loaded: () => true,
    Blocked: () => true,
  })

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
    { isPhonePlaying: Schema.Boolean },
    {
      modelToDependencies: model => ({ isPhonePlaying: isPhonePlaying(model) }),
      dependenciesToStream: ({ isPhonePlaying }) =>
        Stream.when(
          streamMediaKeys,
          Effect.sync(() => isPhonePlaying),
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
