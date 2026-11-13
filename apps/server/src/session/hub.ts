import {
  Config,
  Context,
  Effect,
  FiberMap,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Queue,
  Schedule,
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
import { TimedLyrics } from '../lyrics/service.ts'
import { Prefetcher } from '../prefetch.ts'
import { toQueueTrack } from '../tvCatalog/mapping.ts'
import { YouTubeMusic } from '../youtubeMusic/service.ts'
import {
  type Model,
  type Outcome,
  appendAutoplay,
  fillDuration,
  initialModel,
  lookahead,
  missingDurations,
  playerLost,
  refresh,
  toSessionState,
  unchanged,
  update,
  wakeTimedOut,
} from './model.ts'
import {
  SavedSessionJson,
  fromSaved,
  nextEntryNumber,
  toSaved,
} from './saved.ts'
import { readUtcOffsetMinutes } from './utcOffset.ts'
import { TvWaker } from './wake.ts'

/*
 * One shared playback session for every device. Each WebSocket sends `Hello`
 * first, then commands and (if it is the player) progress. Every change is
 * sent to every connection as a full `State`. Transitions are serialized by
 * one lock so all devices see the same order.
 */

/** Changes this close together are written to disk once. */
const SAVE_AFTER = '1 second'
/** How long the player may drop off (Wi-Fi blip, app restart) before pausing. */
const PLAYER_GRACE = '15 seconds'
/** How long a woken TV gets to open the app and connect. */
const WAKE_TIMEOUT = '60 seconds'
/** Only the latest state matters to a slow client. */
const MAILBOX_SIZE = 32
/** Timed lyrics are looked up for the current song and the one after it. */
const LYRICS_AHEAD = 2
const MAX_WARMED_LYRICS = 500
/** Song lengths remembered before the memory starts over. */
const KNOWN_DURATIONS_CAPACITY = 2000
/** How often to ask Home Assistant whether the TV is on, while a phone looks. */
const POWER_POLL_INTERVAL = '20 seconds'
/** How often to read the house's UTC offset, to catch a clock change. */
const UTC_OFFSET_INTERVAL = '1 minute'
/** Device names remembered, to show a player that went away. */
const KNOWN_DEVICES_CAPACITY = 200

/** A volume from a client, kept between 0 and 1. */
const clampVolume = (level: number): number =>
  Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0

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
    const timedLyrics = yield* TimedLyrics
    const lock = yield* Semaphore.make(1)
    const timers = yield* FiberMap.make<string>()
    const hubScope = yield* Scope.Scope
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
    const savedFile = yield* Config.String('SESSION_STATE_PATH').pipe(
      Config.withDefault(
        path.join(home, '.local', 'share', 'music', 'session.json'),
      ),
    )

    // Start from the session saved before the last restart, if any.
    let model: Model = yield* fs.readFileString(savedFile).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SavedSessionJson)),
      Effect.map(saved => fromSaved(saved, Date.now())),
      Effect.tap(restored =>
        Effect.logInfo(
          `Restored the session: ${restored.queue.length} songs in the queue`,
        ),
      ),
      Effect.catchTag('PlatformError', () => Effect.succeed(initialModel)),
      Effect.catch(error =>
        Effect.as(
          Effect.logWarning('The saved session could not be read', error),
          initialModel,
        ),
      ),
    )
    const latestState = yield* SubscriptionRef.make(toSessionState(model, []))

    /** Write the session now, replacing the file in one step. */
    const save = Effect.gen(function* () {
      const text = yield* Schema.encodeEffect(SavedSessionJson)(
        toSaved(model, Date.now()),
      )
      const partial = `${savedFile}.partial`
      yield* fs.makeDirectory(path.dirname(savedFile), { recursive: true })
      yield* fs.writeFileString(partial, text)
      yield* fs.rename(partial, savedFile)
    }).pipe(
      Effect.catch(error =>
        Effect.logWarning('The session could not be saved', error),
      ),
    )
    yield* Effect.addFinalizer(() => save)
    const connections = new Map<number, Connection>()
    /** Each connection's own volume, as its device last reported it. */
    const volumes = new Map<number, number | null>()
    /** Every device seen, so a player that went offline keeps its name. */
    const knownDevices = new Map<
      string,
      { readonly name: string; readonly kind: Session.DeviceKind }
    >()
    /** Whether each TV is on, as Home Assistant last said. */
    const poweredOn = new Map<string, boolean>()
    let utcOffsetMinutes = yield* readUtcOffsetMinutes
    let nextConnectionId = 0
    let nextEntryId = nextEntryNumber(model.queue)

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
      for (const [connectionId, connection] of connections) {
        byId.set(connection.deviceId, {
          id: connection.deviceId,
          name: connection.name,
          kind: connection.kind,
          online: true,
          waking: false,
          poweredOn: poweredOn.get(connection.deviceId) ?? null,
          volume: volumes.get(connectionId) ?? null,
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
            poweredOn: poweredOn.get(device.id) ?? null,
            volume: null,
          })
        }
      }
      // NOTE: the player stays listed while it is away (a locked phone, a
      // closed TV app), so every device can say where the session is.
      const maybeAway = Option.flatMap(
        Option.fromNullishOr(model.activeDeviceId),
        id =>
          byId.has(id)
            ? Option.none()
            : Option.map(Option.fromNullishOr(knownDevices.get(id)), known => ({
                id,
                ...known,
              })),
      )
      if (Option.isSome(maybeAway)) {
        const away = maybeAway.value
        byId.set(away.id, {
          id: away.id,
          name: away.name,
          kind: away.kind,
          online: false,
          waking: model.waking.includes(away.id),
          poweredOn: null,
          volume: null,
        })
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
          utcOffsetMinutes,
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

    /** Pass a volume change on to every connection of that device. */
    const forwardVolume = (deviceId: string, level: number) =>
      Effect.forEach(
        connections.values(),
        connection =>
          connection.deviceId === deviceId
            ? Queue.offer(
                connection.mailbox,
                encodeServerMessage({
                  _tag: 'SetVolume',
                  level: clampVolume(level),
                }),
              )
            : Effect.void,
        { discard: true },
      )

    /** The state as it is, for one connection waiting on its `ack`. */
    const replyState = (connection: Connection) =>
      Effect.suspend(() =>
        stateFor(connection, toSessionState(model, devices()), Date.now()),
      )

    let maybeCountedEntryId = Option.none<string>()
    let maybeAutoplayAfter = Option.none<string>()

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
     * As the queue runs out with autoplay on, add the songs YouTube Music
     * would play after its last one. They then get ready like any queued
     * song. Once per last song.
     */
    const extendWithAutoplay = (maybeAfter: Option.Option<string>) =>
      Effect.suspend(() => {
        if (Option.isNone(maybeAfter)) {
          maybeAutoplayAfter = Option.none()
          return Effect.void
        }
        const last = maybeAfter.value
        if (Option.contains(maybeAutoplayAfter, last)) return Effect.void
        maybeAutoplayAfter = Option.some(last)
        return youTubeMusic.getUpNext(last).pipe(
          Effect.flatMap(songs =>
            apply(current =>
              appendAutoplay(
                current,
                last,
                songs.map(toQueueTrack),
                makeEntryId,
              ),
            ),
          ),
          Effect.tapError(error =>
            Effect.logWarning('Autoplay found no songs', error),
          ),
          Effect.ignore,
          Effect.forkIn(hubScope),
          Effect.asVoid,
        )
      })

    /**
     * Song lengths looked up so far (`None`: YouTube gave none), and the
     * lookups still running, so each song is asked for once.
     */
    const knownDurations = new Map<string, Option.Option<number>>()
    const lookingUpDurations = new Set<string>()

    const lookUpDuration = (videoId: string) =>
      Effect.suspend(() => {
        const known = knownDurations.get(videoId)
        if (known !== undefined) return Effect.succeed(known)
        return youTubeMusic.getDurationSeconds(videoId).pipe(
          Effect.tap(maybeSeconds =>
            Effect.sync(() => {
              if (knownDurations.size >= KNOWN_DURATIONS_CAPACITY) {
                knownDurations.clear()
              }
              knownDurations.set(videoId, maybeSeconds)
            }),
          ),
        )
      })

    /**
     * Fill in the length of songs queued without one (Home's rows give none),
     * so players can show progress and seek. A failed lookup is tried again
     * with the next change.
     */
    const fillMissingDurations = (videoIds: ReadonlyArray<string>) =>
      Effect.forEach(
        missingDurations(model, videoIds).filter(
          videoId => !lookingUpDurations.has(videoId),
        ),
        videoId => {
          lookingUpDurations.add(videoId)
          return lookUpDuration(videoId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: seconds =>
                  apply(current => fillDuration(current, videoId, seconds)),
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => lookingUpDurations.delete(videoId)),
            ),
            Effect.ignore,
            Effect.forkIn(hubScope),
          )
        },
        { discard: true },
      )

    /** Songs whose timed lyrics were already looked up ahead of time. */
    const warmedLyrics = new Set<string>()

    /** Look up timed lyrics for the current and next songs before they show. */
    const warmLyrics = (videoIds: ReadonlyArray<string>) =>
      Effect.forEach(
        videoIds
          .slice(0, LYRICS_AHEAD)
          .filter(videoId => !warmedLyrics.has(videoId)),
        videoId => {
          if (warmedLyrics.size >= MAX_WARMED_LYRICS) warmedLyrics.clear()
          warmedLyrics.add(videoId)
          return youTubeMusic.getSong(videoId).pipe(
            Effect.flatMap(details => timedLyrics.warm(details.song)),
            Effect.ignore,
            Effect.forkIn(hubScope),
          )
        },
        { discard: true },
      )

    /** Keep the current song and the next five ready, and look ahead further. */
    const prepareAhead = Effect.suspend(() => {
      const ahead = lookahead(model)
      return Effect.all(
        [
          countPlay,
          fillMissingDurations(ahead.download),
          warmLyrics(ahead.download),
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
          extendWithAutoplay(ahead.maybeAutoplayAfter),
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
            yield* FiberMap.run(
              timers,
              'save',
              Effect.andThen(Effect.sleep(SAVE_AFTER), save),
            )
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

    const makeEntryId = () => `e${(nextEntryId++).toString(36)}`

    const contextFor = (senderId: string) => ({
      now: Date.now(),
      senderId,
      isOnline,
      isWakeable,
      makeEntryId,
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
                  Effect.sync(() => {
                    connections.delete(connectionId)
                    volumes.delete(connectionId)
                  }),
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
              if (knownDevices.size >= KNOWN_DEVICES_CAPACITY) {
                knownDevices.clear()
              }
              knownDevices.set(message.deviceId, {
                name: message.name,
                kind: message.kind,
              })
              // A phone that opens the app sees fresh TV power at once.
              if (message.kind === 'Web') {
                yield* Effect.forkIn(checkPower, hubScope)
              }
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
            // NOTE: progress comes every second, and a dragged volume slider
            // many times a second. Neither needs an answer.
            const maybeReplyTo =
              message._tag === 'Progress' || message._tag === 'SetDeviceVolume'
                ? Option.none<Connection>()
                : Option.orElse(joining, () =>
                    Option.fromNullishOr(connections.get(connectionId)),
                  )
            if (message._tag === 'SetDeviceVolume') {
              yield* forwardVolume(message.deviceId, message.level)
            }
            yield* apply(current => {
              // NOTE: a connection joins as its Hello is applied, and each
              // message is counted as it is applied, both under the lock. So
              // no state reaches a connection before it includes the Hello,
              // and none claims a message still waiting for the lock.
              if (Option.isSome(joining)) {
                connections.set(connectionId, joining.value)
              }
              received += 1
              return Match.value(message).pipe(
                Match.withReturnType<Outcome>(),
                Match.tag('Volume', ({ level }) => {
                  volumes.set(
                    connectionId,
                    level === null ? null : clampVolume(level),
                  )
                  return refresh(current)
                }),
                // NOTE: the device answers with `Volume` once it changed.
                Match.tag('SetDeviceVolume', () => unchanged(current)),
                Match.orElse(sessionMessage =>
                  update(current, sessionMessage, contextFor(from)),
                ),
              )
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

    const hasWebConnection = () => {
      for (const connection of connections.values()) {
        if (connection.kind === 'Web') return true
      }
      return false
    }

    /** Ask Home Assistant whether each TV is on, and tell phones when it changes. */
    const checkPower = Effect.forEach(
      waker.devices,
      device =>
        waker.isPoweredOn(device.id).pipe(
          Effect.flatMap(maybeOn => {
            const before = poweredOn.get(device.id)
            Option.match(maybeOn, {
              onNone: () => poweredOn.delete(device.id),
              onSome: on => poweredOn.set(device.id, on),
            })
            return before === poweredOn.get(device.id)
              ? Effect.void
              : apply(refresh)
          }),
        ),
      { discard: true },
    )

    yield* Effect.suspend(() =>
      hasWebConnection() ? checkPower : Effect.void,
    ).pipe(
      Effect.repeat(Schedule.spaced(POWER_POLL_INTERVAL)),
      Effect.forkIn(hubScope),
    )

    yield* readUtcOffsetMinutes.pipe(
      Effect.flatMap(minutes => {
        if (minutes === utcOffsetMinutes) return Effect.void
        utcOffsetMinutes = minutes
        return apply(refresh)
      }),
      Effect.repeat(Schedule.spaced(UTC_OFFSET_INTERVAL)),
      Effect.forkIn(hubScope),
    )

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
