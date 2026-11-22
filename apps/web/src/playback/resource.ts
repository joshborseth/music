import { Duration, Effect, Option, Schema } from 'effect'
import { ManagedResource } from 'foldkit'

import { Session } from '@music/shared'

import { Message } from '../message'
import type { Model } from '../model'
import { Connection } from './domain'

const CONNECT_TIMEOUT = Duration.seconds(5)

export const SessionSocket = ManagedResource.tag<WebSocket>()('SessionSocket')
export type SessionSocketService = ManagedResource.ServiceOf<
  typeof SessionSocket
>

/** The audio element this phone plays through when it is the player. */
export const PhoneAudioElement =
  ManagedResource.tag<HTMLAudioElement>()('PhoneAudioElement')
export type PhoneAudioElementService = ManagedResource.ServiceOf<
  typeof PhoneAudioElement
>

export type PlaybackServices = SessionSocketService | PhoneAudioElementService

const sessionUrl = (): string => {
  const url = new URL(Session.SESSION_PATH, globalThis.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

const openSocket = Effect.callback<WebSocket, Error>(resume => {
  const socket = new WebSocket(sessionUrl())

  const handleOpen = () => {
    socket.removeEventListener('error', handleError)
    resume(Effect.succeed(socket))
  }
  const handleError = () => {
    socket.removeEventListener('open', handleOpen)
    resume(Effect.fail(new Error('Could not reach the music server')))
  }

  socket.addEventListener('open', handleOpen)
  socket.addEventListener('error', handleError)

  return Effect.sync(() => {
    socket.removeEventListener('open', handleOpen)
    socket.removeEventListener('error', handleError)
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
  })
}).pipe(
  Effect.timeout(CONNECT_TIMEOUT),
  Effect.catchTag('TimeoutError', () =>
    Effect.fail(new Error('The music server did not answer')),
  ),
)

/** A new key opens a new socket. */
const socketKey = (model: Model): Option.Option<string> =>
  Option.map(
    model.maybeIdentity,
    ({ deviceId }) => `${deviceId}#${model.sessionSocketGeneration}`,
  )

export const managedResources = ManagedResource.make<Model, Message>()(
  entry => ({
    sessionSocket: entry(Schema.Option(Schema.String), {
      resource: SessionSocket,
      modelToMaybeRequirements: model =>
        Connection.match(model.connection, {
          WaitingForIdentity: () => Option.none(),
          Connecting: () => socketKey(model),
          Connected: () => socketKey(model),
          Disconnected: () => Option.none(),
        }),
      acquire: () => openSocket,
      release: socket => Effect.sync(() => socket.close()),
      onAcquired: () => Message.AcquiredSessionSocket(),
      onReleased: () => Message.ReleasedSessionSocket(),
      onAcquireError: error =>
        Message.FailedConnectSessionSocket({
          error: error instanceof Error ? error.message : 'Connection failed',
        }),
    }),

    phoneAudioElement: entry(Schema.Option(Schema.Null), {
      resource: PhoneAudioElement,
      modelToMaybeRequirements: () => Option.some(null),
      acquire: () =>
        Effect.sync(() => {
          const audio = new Audio()
          audio.preload = 'auto'
          return audio
        }),
      release: audio =>
        Effect.sync(() => {
          audio.pause()
          audio.removeAttribute('src')
        }),
      onAcquired: () => Message.AcquiredPhoneAudio(),
      onReleased: () => Message.ReleasedPhoneAudio(),
      onAcquireError: () => Message.FailedAcquirePhoneAudio(),
    }),
  }),
)
