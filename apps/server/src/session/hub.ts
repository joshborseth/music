import {
  Context,
  Effect,
  FiberMap,
  Layer,
  Option,
  Queue,
  Schema,
  Scope,
  Semaphore,
} from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import type { Socket } from 'effect/socket'

import { Session } from '@music/shared'

import { AudioSource } from '../audio.ts'
import {
  type Model,
  type Outcome,
  initialModel,
  playerLost,
  refresh,
  toSessionState,
  unchanged,
  upcomingVideoIds,
  update,
  wakeTimedOut,
} from './model.ts'
import { TvWaker } from './wake.ts'

/*
 * One shared playback session for every device. Each WebSocket sends `Hello`
 * first, then commands and (if it is the player) progress. Every change is
 * sent to every connection as a full `State`. Transitions are serialized by
 * one lock so all devices see the same order.
 */

/** How long the player may drop off (Wi-Fi blip, app restart) before pausing. */
const PLAYER_GRACE = '15 seconds'
/** How long a woken TV gets to open the app and connect. */
const WAKE_TIMEOUT = '60 seconds'
/** Only the latest state matters to a slow client. */
const MAILBOX_SIZE = 32

interface Connection {
  readonly deviceId: string
  readonly name: string
  readonly kind: Session.DeviceKind
  readonly mailbox: Queue.Queue<string>
}

export class SessionHub extends Context.Service<
  SessionHub,
  {
    readonly handle: (
      socket: Socket.Socket,
    ) => Effect.Effect<void, never, Scope.Scope>
  }
>()('music/SessionHub') {}

const encodeServerMessage = Schema.encodeSync(Session.ServerMessageJson)
const decodeClientMessage = Schema.decodeUnknownOption(
  Session.ClientMessageJson,
)
const textDecoder = new TextDecoder()

export const SessionHubLive = Layer.effect(SessionHub)(
  Effect.gen(function* () {
    const waker = yield* TvWaker
    const audioSource = yield* AudioSource
    const lock = yield* Semaphore.make(1)
    const timers = yield* FiberMap.make<string>()
    const hubScope = yield* Scope.Scope

    let model: Model = initialModel
    const connections = new Map<number, Connection>()
    let nextConnectionId = 0
    let nextEntryId = 0

    const isOnline = (deviceId: string) => {
      for (const connection of connections.values()) {
        if (connection.deviceId === deviceId) return true
      }
      return false
    }

    const isWakeable = (deviceId: string) =>
      waker.devices.some(device => device.id === deviceId)

    const devices = (): ReadonlyArray<Session.Device> => {
      const byId = new Map<string, Session.Device>()
      for (const connection of connections.values()) {
        byId.set(connection.deviceId, {
          id: connection.deviceId,
          name: connection.name,
          kind: connection.kind,
          online: true,
          waking: false,
        })
      }
      for (const device of waker.devices) {
        if (!byId.has(device.id)) {
          byId.set(device.id, {
            id: device.id,
            name: device.name,
            kind: 'Tv',
            online: false,
            waking: model.waking.includes(device.id),
          })
        }
      }
      return [...byId.values()]
    }

    const sendAll = (text: string) =>
      Effect.forEach(
        connections.values(),
        connection => Queue.offer(connection.mailbox, text),
        { discard: true },
      )

    const broadcastState = Effect.suspend(() =>
      sendAll(
        encodeServerMessage({
          _tag: 'State',
          state: toSessionState(model, devices()),
          serverNow: Date.now(),
        }),
      ),
    )

    const warmUpcoming = Effect.suspend(() =>
      audioSource.warm(upcomingVideoIds(model)),
    )

    /** Run one transition under the lock and carry out what it asks for. */
    const apply = (
      transition: (model: Model) => Outcome,
    ): Effect.Effect<void> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const outcome = transition(model)
          model = outcome.model
          if (outcome.broadcast) {
            yield* broadcastState
            yield* warmUpcoming
          }
          if (Option.isSome(outcome.maybeNotice)) {
            yield* sendAll(
              encodeServerMessage({
                _tag: 'Notice',
                message: outcome.maybeNotice.value,
              }),
            )
          }
          if (Option.isSome(outcome.maybeWake)) {
            yield* startWaking(outcome.maybeWake.value)
          }
        }),
      )

    const startWaking = (deviceId: string) =>
      Effect.gen(function* () {
        yield* FiberMap.run(
          timers,
          `wake:${deviceId}`,
          Effect.sleep(WAKE_TIMEOUT).pipe(
            Effect.andThen(
              apply(current => wakeTimedOut(current, deviceId, Date.now())),
            ),
          ),
        )
        yield* waker.wake(deviceId).pipe(
          Effect.catch(error =>
            Effect.andThen(
              Effect.logWarning('Waking the TV failed', error.message),
              Effect.andThen(
                FiberMap.remove(timers, `wake:${deviceId}`),
                apply(current => wakeTimedOut(current, deviceId, Date.now())),
              ),
            ),
          ),
          Effect.forkIn(hubScope),
        )
      })

    const contextFor = (senderId: string) => ({
      now: Date.now(),
      senderId,
      isOnline,
      isWakeable,
      makeEntryId: () => `e${(nextEntryId++).toString(36)}`,
    })

    const handle = (socket: Socket.Socket) =>
      Effect.gen(function* () {
        const writer = yield* socket.writer
        const reader = yield* socket.reader
        const mailbox = yield* Queue.sliding<string>(MAILBOX_SIZE)
        yield* Queue.take(mailbox).pipe(
          Effect.flatMap(text => writer.write(text)),
          Effect.forever,
          Effect.ignore,
          Effect.forkScoped,
        )

        const connectionId = nextConnectionId++
        let maybeDeviceId = Option.none<string>()
        let senderId = ''

        yield* Effect.addFinalizer(() =>
          Option.match(maybeDeviceId, {
            onNone: () => Effect.void,
            onSome: deviceId =>
              Effect.gen(function* () {
                yield* lock.withPermits(1)(
                  Effect.sync(() => connections.delete(connectionId)),
                )
                yield* apply(refresh)
                if (!isOnline(deviceId)) {
                  yield* FiberMap.run(
                    timers,
                    `lost:${deviceId}`,
                    Effect.sleep(PLAYER_GRACE).pipe(
                      Effect.andThen(
                        apply(current =>
                          isOnline(deviceId)
                            ? unchanged(current)
                            : playerLost(current, deviceId, Date.now()),
                        ),
                      ),
                    ),
                  )
                }
              }),
          }),
        )

        const receive = (message: Session.ClientMessage) =>
          Effect.gen(function* () {
            if (Option.isNone(maybeDeviceId)) {
              if (message._tag !== 'Hello') return
              maybeDeviceId = Option.some(message.deviceId)
              senderId = message.deviceId
              yield* FiberMap.remove(timers, `lost:${message.deviceId}`)
              yield* FiberMap.remove(timers, `wake:${message.deviceId}`)
              yield* lock.withPermits(1)(
                Effect.sync(() =>
                  connections.set(connectionId, {
                    deviceId: message.deviceId,
                    name: message.name,
                    kind: message.kind,
                    mailbox,
                  }),
                ),
              )
            }
            const from = senderId
            yield* apply(current => update(current, message, contextFor(from)))
          })

        yield* Effect.gen(function* () {
          while (true) {
            const frames = yield* reader.pull
            for (const frame of frames) {
              const text =
                typeof frame === 'string' ? frame : textDecoder.decode(frame)
              const maybeMessage = decodeClientMessage(text)
              if (Option.isSome(maybeMessage)) {
                yield* receive(maybeMessage.value)
              }
            }
          }
        }).pipe(Effect.ignore)
      }).pipe(Effect.ignore)

    return SessionHub.of({ handle })
  }),
)

/** `GET /session`: the session WebSocket. */
export const SessionRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const hub = yield* SessionHub
    yield* router.add(
      'GET',
      Session.SESSION_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const socket = yield* Effect.orDie(request.upgrade)
        yield* hub.handle(socket)
        return HttpServerResponse.empty()
      }),
    )
  }),
)
