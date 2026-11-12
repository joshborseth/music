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
  Stream,
  SubscriptionRef,
} from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import type { Socket } from 'effect/socket'

import { Session } from '@music/shared'

import { AudioStore } from '../audioStore.ts'
import { Prefetcher } from '../prefetch.ts'
import { YouTubeMusic } from '../youtubeMusic/service.ts'
import {
  type Model,
  type Outcome,
  initialModel,
  lookahead,
  playerLost,
  refresh,
  toSessionState,
  unchanged,
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
/** Songs from YouTube's "up next" to find links for as the queue runs out. */
const QUEUE_END_RESOLVES = 3

interface Connection {
  readonly deviceId: string
  readonly name: string
  readonly kind: Session.DeviceKind
  readonly mailbox: Queue.Queue<string>
  /** How many of this connection's messages the session has taken in. */
  readonly acked: () => number
}

export class SessionHub extends Context.Service<
  SessionHub,
  {
    readonly handle: (
      socket: Socket.Socket,
    ) => Effect.Effect<void, never, Scope.Scope>
    /** The session as every device last saw it, then each change. */
    readonly states: Stream.Stream<Session.SessionState>
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
    const audioStore = yield* AudioStore
    const prefetcher = yield* Prefetcher
    const youTubeMusic = yield* YouTubeMusic
    const lock = yield* Semaphore.make(1)
    const timers = yield* FiberMap.make<string>()
    const hubScope = yield* Scope.Scope

    let model: Model = initialModel
    const latestState = yield* SubscriptionRef.make(
      toSessionState(initialModel, []),
    )
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

    const stateFor = (
      connection: Connection,
      state: Session.SessionState,
      serverNow: number,
    ) =>
      Queue.offer(
        connection.mailbox,
        encodeServerMessage({
          _tag: 'State',
          state,
          serverNow,
          ack: connection.acked(),
        }),
      )

    const broadcastState = Effect.suspend(() => {
      const state = toSessionState(model, devices())
      const serverNow = Date.now()
      return Effect.andThen(
        SubscriptionRef.set(latestState, state),
        Effect.forEach(
          connections.values(),
          connection => stateFor(connection, state, serverNow),
          { discard: true },
        ),
      )
    })

    /** The state as it is, for one connection waiting on its `ack`. */
    const replyState = (connection: Connection) =>
      Effect.suspend(() =>
        stateFor(connection, toSessionState(model, devices()), Date.now()),
      )

    let maybeCountedEntryId = Option.none<string>()
    let maybeQueueEndFor = Option.none<string>()

    /** A song counts as played once it is current and playing. */
    const countPlay = Effect.suspend(() => {
      const entryId = model.currentEntryId
      if (
        !model.playing ||
        entryId === null ||
        Option.contains(maybeCountedEntryId, entryId)
      ) {
        return Effect.void
      }
      maybeCountedEntryId = Option.some(entryId)
      const entry = model.queue.find(queued => queued.entryId === entryId)
      return entry === undefined
        ? Effect.void
        : audioStore.markPlayed(entry.track.videoId)
    })

    /**
     * As the queue runs out, find links for the first songs YouTube Music
     * would play after it, so adding one of them starts fast. Once per
     * last song.
     */
    const prepareQueueEnd = (maybeEndingAt: Option.Option<string>) =>
      Effect.suspend(() => {
        if (Option.isNone(maybeEndingAt)) {
          maybeQueueEndFor = Option.none()
          return prefetcher.plan('QueueEnd', [])
        }
        const last = maybeEndingAt.value
        if (Option.contains(maybeQueueEndFor, last)) return Effect.void
        maybeQueueEndFor = Option.some(last)
        const queued = new Set(model.queue.map(entry => entry.track.videoId))
        return youTubeMusic.getUpNext(last).pipe(
          Effect.flatMap(songs =>
            prefetcher.plan(
              'QueueEnd',
              songs
                .filter(song => !queued.has(song.videoId))
                .slice(0, QUEUE_END_RESOLVES)
                .map((song, index) => ({
                  videoId: song.videoId,
                  kind: 'Resolve' as const,
                  priority: 30 + index,
                })),
            ),
          ),
          Effect.ignore,
          Effect.forkIn(hubScope),
          Effect.asVoid,
        )
      })

    /** Keep the current song and the next five ready, and look ahead further. */
    const prepareAhead = Effect.suspend(() => {
      const ahead = lookahead(model)
      return Effect.all(
        [
          countPlay,
          audioStore.protect(ahead.download),
          prefetcher.plan('Queue', [
            ...ahead.download.map((videoId, index) => ({
              videoId,
              kind: 'Download' as const,
              priority: index,
            })),
            ...ahead.resolve.map((videoId, index) => ({
              videoId,
              kind: 'Resolve' as const,
              priority: 20 + index,
            })),
          ]),
          prepareQueueEnd(ahead.maybeEndingAt),
        ],
        { discard: true },
      )
    })

    /**
     * Run one transition under the lock and carry out what it asks for. A
     * transition that changes nothing still answers `replyTo`, whose `ack`
     * then covers its message.
     */
    const apply = (
      transition: (model: Model) => Outcome,
      maybeReplyTo: Option.Option<Connection> = Option.none(),
    ): Effect.Effect<void> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const outcome = transition(model)
          model = outcome.model
          if (outcome.broadcast) {
            yield* broadcastState
            yield* prepareAhead
          } else if (Option.isSome(maybeReplyTo)) {
            yield* replyState(maybeReplyTo.value)
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
        let received = 0

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
            let maybeJoining = Option.none<Connection>()
            if (Option.isNone(maybeDeviceId)) {
              if (message._tag !== 'Hello') return
              maybeDeviceId = Option.some(message.deviceId)
              senderId = message.deviceId
              yield* FiberMap.remove(timers, `lost:${message.deviceId}`)
              yield* FiberMap.remove(timers, `wake:${message.deviceId}`)
              maybeJoining = Option.some({
                deviceId: message.deviceId,
                name: message.name,
                kind: message.kind,
                mailbox,
                acked: () => received,
              })
            }
            const joining = maybeJoining
            const from = senderId
            // NOTE: progress comes every second and needs no answer.
            const maybeReplyTo =
              message._tag === 'Progress'
                ? Option.none<Connection>()
                : Option.orElse(joining, () =>
                    Option.fromNullishOr(connections.get(connectionId)),
                  )
            yield* apply(current => {
              // NOTE: a connection joins as its Hello is applied, and each
              // message is counted as it is applied, both under the lock. So
              // no state reaches a connection before it includes the Hello,
              // and none claims a message still waiting for the lock.
              if (Option.isSome(joining)) {
                connections.set(connectionId, joining.value)
              }
              received += 1
              return update(current, message, contextFor(from))
            }, maybeReplyTo)
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

    return SessionHub.of({
      handle,
      states: SubscriptionRef.changes(latestState),
    })
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
