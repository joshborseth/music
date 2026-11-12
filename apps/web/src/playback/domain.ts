import { Array, Option, Schema, pipe } from 'effect'
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
})
export type LoadedEntry = typeof LoadedEntry.Type

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

export const activeDevice = (
  state: Session.SessionState,
): Option.Option<Session.Device> =>
  Array.findFirst(state.devices, device => device.id === state.activeDeviceId)

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
  maybeSession: Option.none<SessionSnapshot>(),
  phoneAudio: PhoneAudio.Unavailable(),
  phoneAudioSeconds: 0,
  lastProgressAt: 0,
  now: 0,
  playerSheet: PlayerSheet.Closed(),
  maybeNotice: Option.none<string>(),
  maybeScrubSeconds: Option.none<number>(),
  swipe: Swipe.Idle(),
}
