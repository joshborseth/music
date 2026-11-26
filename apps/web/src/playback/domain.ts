import { Array, Match, Option, Schema, pipe } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { Session } from '@music/shared'

import { Swipe } from './swipe'

// MODEL

/** The WebSocket to the shared playback session. */
export const Connection = defineTaggedUnion({
  WaitingForIdentity: {},
  Connecting: {},
  Connected: {},
  Disconnected: {},
})
export type Connection = typeof Connection.Type

/**
 * Whether the session on screen is known to be current. Coming back after
 * the page slept, the phone shows the session it last heard of until the
 * server's state arrives on a fresh socket (`Waiting`), and the player looks
 * unconfirmed meanwhile. It keeps when the page showed and when the socket
 * opened, to report how long catching up took.
 */
export const Resync = defineTaggedUnion({
  Current: {},
  Waiting: {
    shownAt: Schema.Number,
    hiddenForMs: Schema.Number,
    maybeSocketOpenedAt: Schema.Option(Schema.Number),
  },
})
export type Resync = typeof Resync.Type

/** This device's name and id, as the session knows it. */
export const DeviceIdentity = Schema.Struct({
  deviceId: Schema.String,
  deviceName: Schema.String,
})
export type DeviceIdentity = typeof DeviceIdentity.Type

/** The latest session state and how far this device's clock is from the server's. */
export const SessionSnapshot = Schema.Struct({
  state: Session.SessionState,
  clockOffsetMs: Schema.Number,
})
export type SessionSnapshot = typeof SessionSnapshot.Type

/** Which entry, at which seek generation, the phone's audio element plays. */
export const LoadedEntry = Schema.Struct({
  entryId: Schema.String,
  seekSeq: Schema.Number,
  isPlaying: Schema.Boolean,
  /** Waiting for audio data: show that it is loading. */
  isBuffering: Schema.Boolean,
  /**
   * This phone played or paused by itself (a tap, the lock screen, the
   * system pausing it, the queue ending) since it last followed the server.
   * A reconnect report says so, and the server then keeps it.
   */
  isPlayingSetHere: Schema.Boolean,
})
export type LoadedEntry = typeof LoadedEntry.Type

/**
 * Changes this phone made by itself, as the player, before telling the
 * server: a move, a seek, a play or pause. Each `State` says how many of this
 * connection's messages it includes (`ack`). One that does not include every
 * message carrying such a change was sent before the server heard of it, so
 * the phone keeps its own song, position, and play or pause over it.
 */
export const LocalChanges = Schema.Struct({
  /** Changes whose message is not on the socket yet, so its number is unknown. */
  unsent: Schema.Number,
  /** The `ack` that includes every change sent so far. */
  untilAck: Schema.Number,
  /**
   * Jumps among those changes (seek, next, previous, a queue tap, the queue
   * ending), each of which moves the server's `seekSeq` on by one. A state
   * that includes them and moved `seekSeq` by exactly that much made no
   * jump the phone has not made already.
   */
  ownJumps: Schema.Number,
})
export type LocalChanges = typeof LocalChanges.Type

/**
 * A change this phone made to the queue: a song moved (`MoveEntry`), or the
 * songs to come cleared (`ClearUpcoming`). The phone shows it at once and
 * makes it again on top of every `State` that does not include it yet, so a
 * state sent before the server heard of it never undoes it. `maybeSeq` is
 * this connection's number for the message, once it went out.
 */
export const QueueEdit = defineTaggedUnion({
  Move: {
    entryId: Schema.String,
    /** None: last among the songs of its kind. */
    maybeBeforeEntryId: Schema.Option(Schema.String),
    maybeSeq: Schema.Option(Schema.Number),
  },
  ClearUpcoming: { maybeSeq: Schema.Option(Schema.Number) },
})
export type QueueEdit = typeof QueueEdit.Type

/** The phone's own audio output. */
export const PhoneAudio = defineTaggedUnion({
  Unavailable: {},
  Idle: {},
  Loaded: { entry: LoadedEntry },
  /** The browser refused to start audio without a tap. */
  Blocked: { entry: LoadedEntry },
})
export type PhoneAudio = typeof PhoneAudio.Type

export const PlayerSheet = defineTaggedUnion({
  Closed: {},
  Open: {},
})
export type PlayerSheet = typeof PlayerSheet.Type

/**
 * How a list starts playing, as in Apple Music: a Play button plays it in
 * order and turns shuffle off, a Shuffle button shuffles it and turns shuffle
 * on, and a tap on one song keeps the session's shuffle as it is.
 */
export const PlayOrder = Schema.Literals(['KeepShuffle', 'InOrder', 'Shuffled'])
export type PlayOrder = typeof PlayOrder.Type

/** `PlayQueue.shuffle` for each way of playing: null keeps the setting. */
export const SHUFFLE_FOR_ORDER: Record<PlayOrder, boolean | null> = {
  KeepShuffle: null,
  InOrder: false,
  Shuffled: true,
}

export const MediaKey = Schema.Literals([
  'Play',
  'Pause',
  'NextTrack',
  'PreviousTrack',
])
export type MediaKey = typeof MediaKey.Type

// CONSTANTS

/** Where this device's session identity is kept between visits. */
export const DEVICE_ID_KEY = 'music:device-id'

/** Songs the phone downloads ahead of the current one. */
export const PREFETCH_COUNT = 5

/** A server seek this close to where the phone already is needs no jump. */
export const SEEK_TOLERANCE_SECONDS = 1.5

/** How far the skip buttons jump. */
export const SKIP_SECONDS = 15

/** How often the playing device reports its position to the server. */
export const PROGRESS_INTERVAL_MS = 1000

/** Previous restarts the song when it is past this point, like the server. */
export const RESTART_THRESHOLD_SECONDS = 3

// HELPERS

/**
 * The songs in a random order, the same for the same `seed`: update stays
 * pure, and a seed from the clock is random enough for a shuffle.
 */
export const seededShuffle = <A>(
  items: ReadonlyArray<A>,
  seed: number,
): ReadonlyArray<A> => {
  // NOTE: mulberry32, a small, well-mixed 32-bit generator.
  let state = Math.trunc(seed) >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
  const shuffled = [...items]
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1))
    const here = shuffled[index]
    const there = shuffled[other]
    if (here !== undefined && there !== undefined) {
      shuffled[index] = there
      shuffled[other] = here
    }
  }
  return shuffled
}

/**
 * A session this phone makes for itself when the server can't be reached:
 * `tracks` from `startIndex`, played here. With shuffle, the chosen song
 * comes first and the rest in a random order, as on the server. Entry ids
 * start with `local-`, which the server never uses.
 */
export const offlineSessionState = (
  previous: Option.Option<Session.SessionState>,
  deviceId: string,
  tracks: ReadonlyArray<Session.QueueTrack>,
  startIndex: number,
  shuffle: boolean,
  playingFrom: Session.PlayingFrom | null,
  serverNow: number,
): Session.SessionState => {
  const seekSeq = Option.match(previous, {
    onNone: () => 1,
    onSome: state => state.seekSeq + 1,
  })
  const start = Math.min(Math.max(0, Math.trunc(startIndex)), tracks.length - 1)
  const ordered = shuffle
    ? [
        ...tracks.slice(start, start + 1),
        ...seededShuffle(
          [...tracks.slice(0, start), ...tracks.slice(start + 1)],
          serverNow + seekSeq,
        ),
      ]
    : tracks
  const queue = Array.map(ordered, (track, index): Session.QueueEntry => ({
    entryId: `local-${seekSeq}-${index}`,
    track,
    autoplay: false,
  }))
  const currentIndex = shuffle ? 0 : start
  return {
    devices: Option.match(previous, {
      onNone: () => [],
      onSome: state => state.devices,
    }),
    activeDeviceId: deviceId,
    queue,
    currentEntryId: queue[currentIndex]?.entryId ?? null,
    playing: queue.length > 0,
    positionSeconds: 0,
    positionAt: serverNow,
    seekSeq,
    autoplay: Option.exists(previous, state => state.autoplay),
    repeat: Option.match(previous, {
      onNone: (): Session.RepeatMode => 'Off',
      onSome: state => state.repeat,
    }),
    shuffle,
    soundCheck: Option.match(previous, {
      onNone: () => true,
      onSome: state => state.soundCheck,
    }),
    sleepTimer: Option.match(previous, {
      onNone: () => null,
      onSome: state => state.sleepTimer,
    }),
    playingFrom,
  }
}

export const currentEntry = (
  state: Session.SessionState,
): Option.Option<Session.QueueEntry> =>
  pipe(
    Option.fromNullishOr(state.currentEntryId),
    Option.flatMap(entryId =>
      Array.findFirst(state.queue, entry => entry.entryId === entryId),
    ),
  )

export const upcomingEntries = (
  state: Session.SessionState,
): ReadonlyArray<Session.QueueEntry> =>
  pipe(
    Array.findFirstIndex(
      state.queue,
      entry => entry.entryId === state.currentEntryId,
    ),
    Option.match({
      onNone: () => state.queue,
      onSome: index => Array.drop(state.queue, index + 1),
    }),
  )

/** The entry at `index`'s place in the queue after a move, if any. */
const entryAtIndex = (
  state: Session.SessionState,
  maybeIndex: Option.Option<number>,
): Option.Option<Session.QueueEntry> =>
  Option.flatMap(maybeIndex, index => Array.get(state.queue, index))

const currentIndex = (state: Session.SessionState): number =>
  Option.getOrElse(
    Array.findFirstIndex(
      state.queue,
      entry => entry.entryId === state.currentEntryId,
    ),
    () => -1,
  )

/** What plays when the current song ends by itself, as `repeat` says. */
export const followingEntry = (
  state: Session.SessionState,
): Option.Option<Session.QueueEntry> =>
  entryAtIndex(
    state,
    Session.followingIndex(
      state.queue.length,
      currentIndex(state),
      state.repeat,
    ),
  )

/** Where Next goes: on, even with repeat one, and around with repeat on. */
export const skippedToEntry = (
  state: Session.SessionState,
): Option.Option<Session.QueueEntry> =>
  entryAtIndex(
    state,
    Session.skipIndex(state.queue.length, currentIndex(state), state.repeat),
  )

/** The repeat button steps off → all → one → off, as in Apple Music. */
export const nextRepeatMode = (mode: Session.RepeatMode): Session.RepeatMode =>
  Match.value(mode).pipe(
    Match.when('Off', () => 'All' as const),
    Match.when('All', () => 'One' as const),
    Match.when('One', () => 'Off' as const),
    Match.exhaustive,
  )

/** Next does nothing once the last song plays, unless the queue repeats. */
export const hasNextEntry = (state: Session.SessionState): boolean =>
  Option.isSome(skippedToEntry(state))

export const activeDevice = (
  state: Session.SessionState,
): Option.Option<Session.Device> =>
  Array.findFirst(state.devices, device => device.id === state.activeDeviceId)

/**
 * What a device is doing, as the player and the device picker tell it.
 * - `Playing`, `Paused`: it is the player, with the app open.
 * - `Reconnecting`: it is the player and went away while playing; the server
 *   waits a few seconds for it before pausing.
 * - `TurningOn`: the server asked it to turn on and open the app.
 * - `Ready`: the app is open on it, but something else plays.
 * - `Closed`: the app is not open on it (a TV that is on, or not known to be off).
 * - `Off`: a TV that is off.
 */
export type DeviceStatus =
  | 'Playing'
  | 'Paused'
  | 'Reconnecting'
  | 'TurningOn'
  | 'Ready'
  | 'Closed'
  | 'Off'

export const deviceStatus = (
  state: Session.SessionState,
  device: Session.Device,
): DeviceStatus => {
  const isPlayer = state.activeDeviceId === device.id
  const hasSong = state.currentEntryId !== null
  if (device.waking) {
    return 'TurningOn'
  } else if (isPlayer && device.online && hasSong) {
    return state.playing ? 'Playing' : 'Paused'
  } else if (isPlayer && hasSong && state.playing) {
    return 'Reconnecting'
  } else if (device.online) {
    return 'Ready'
  } else if (device.poweredOn === false) {
    return 'Off'
  } else {
    return 'Closed'
  }
}

/** Another device, and what it is doing. */
export interface Output {
  readonly device: Session.Device
  readonly status: DeviceStatus
}

/**
 * Where the music plays, or plays when Play is pressed, when that is not
 * this device. Like the server, a player that has gone away and is not
 * playing or turning on counts for nothing: Play here then plays here.
 */
export const playbackOutput = (
  state: Session.SessionState,
  maybeMyDeviceId: Option.Option<string>,
): Option.Option<Output> =>
  pipe(
    activeDevice(state),
    Option.filter(device => !Option.contains(maybeMyDeviceId, device.id)),
    Option.map(device => ({ device, status: deviceStatus(state, device) })),
    Option.filter(
      ({ device, status }) =>
        device.online || status === 'TurningOn' || status === 'Reconnecting',
    ),
  )

/** Why a TV's app is not open, in a few words. */
const closedText = (device: Session.Device): string => {
  if (device.kind !== 'Tv') {
    return 'Not connected'
  } else if (device.poweredOn === true) {
    return "On · Joshify isn't open"
  } else {
    return "Joshify isn't open"
  }
}

/** A device's status in a few words. */
export const deviceStatusText = (
  device: Session.Device,
  status: DeviceStatus,
): string =>
  Match.value(status).pipe(
    Match.when('Playing', () => 'Playing'),
    Match.when('Paused', () => 'Paused'),
    Match.when('Reconnecting', () => 'Reconnecting…'),
    Match.when('TurningOn', () =>
      device.kind === 'Tv' ? 'Turning on and opening Joshify…' : 'Waking…',
    ),
    Match.when('Ready', () =>
      device.kind === 'Tv' ? 'Joshify is open' : 'Connected',
    ),
    Match.when('Closed', () => closedText(device)),
    Match.when('Off', () => 'Off'),
    Match.exhaustive,
  )

/** Where the music is, as the mini player and the player say it. */
export const outputText = ({ device, status }: Output): string =>
  Match.value(status).pipe(
    Match.when('Paused', () => `Paused on ${device.name}`),
    Match.when('Reconnecting', () => `Reconnecting to ${device.name}…`),
    Match.when('TurningOn', () => `Turning on ${device.name}…`),
    Match.orElse(() => `Playing on ${device.name}`),
  )

export const isActiveDevice = (
  state: Session.SessionState,
  deviceId: string,
): boolean => state.activeDeviceId === deviceId

/** Where the session is right now, by this device's clock. */
export const sessionPosition = (
  snapshot: SessionSnapshot,
  now: number,
): number => Session.positionAt(snapshot.state, now + snapshot.clockOffsetMs)

export const loadedEntry = (audio: PhoneAudio): Option.Option<LoadedEntry> =>
  PhoneAudio.match(audio, {
    Unavailable: () => Option.none(),
    Idle: () => Option.none(),
    Loaded: ({ entry }) => Option.some(entry),
    Blocked: ({ entry }) => Option.some(entry),
  })

/** What the sleep timer waits for, as the player shows it. */
export const SleepCountdown = defineTaggedUnion({
  Remaining: { seconds: Schema.Number },
  EndOfSong: {},
})
export type SleepCountdown = typeof SleepCountdown.Type

/** The sleep timer, with the whole seconds left by this device's clock. */
export const sleepCountdown = (
  snapshot: SessionSnapshot,
  now: number,
): Option.Option<SleepCountdown> => {
  const timer = snapshot.state.sleepTimer
  if (timer === null) {
    return Option.none()
  }
  return Option.some(
    timer._tag === 'EndOfSong'
      ? SleepCountdown.EndOfSong()
      : SleepCountdown.Remaining({
          seconds: Math.max(
            0,
            Math.ceil((timer.endsAt - (now + snapshot.clockOffsetMs)) / 1000),
          ),
        }),
  )
}

/** Seconds left as a clock: "4:05", or "1:00:00" from an hour up. */
export const countdownText = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = (seconds % 60).toString().padStart(2, '0')
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`
}

/** The sleep timer's choices, as Apple Music and Spotify offer them. */
export const SLEEP_TIMER_MINUTES: ReadonlyArray<number> = [5, 15, 30, 45, 60]

/** A readable name for this device, from its user agent. */
export const deviceNameFromUserAgent = (userAgent: string): string => {
  if (/iPhone/.test(userAgent)) {
    return 'iPhone'
  } else if (/iPad/.test(userAgent)) {
    return 'iPad'
  } else if (/Android/.test(userAgent)) {
    return 'Android'
  } else if (/Macintosh/.test(userAgent)) {
    return 'Mac'
  } else {
    return 'Browser'
  }
}

/** The playback fields of the Model before anything is known. */
export const initialPlaybackModel = {
  maybeIdentity: Option.none<DeviceIdentity>(),
  connection: Connection.WaitingForIdentity(),
  sessionSocketGeneration: 0,
  maybePageHiddenAt: Option.none<number>(),
  resync: Resync.Current(),
  maybeSession: Option.none<SessionSnapshot>(),
  phoneAudio: PhoneAudio.Unavailable(),
  phoneAudioSeconds: 0,
  lastProgressAt: 0,
  now: 0,
  playerSheet: PlayerSheet.Closed(),
  maybeNotice: Option.none<string>(),
  maybeScrubSeconds: Option.none<number>(),
  localChanges: { unsent: 0, untilAck: 0, ownJumps: 0 },
  queueEdits: [],
  isOfflineSession: false,
  swipe: Swipe.Idle(),
}
