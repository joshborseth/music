import { Schema } from 'effect'

/*
 * The playback session protocol: JSON text frames over the WebSocket at
 * `/session`. The web app and the Rust TV app (`apps/tv/src/protocol.rs`)
 * both speak it, so every field is plain JSON (nullable, never Option) and
 * every message carries a `_tag`. Change both sides together, and update the
 * shared fixtures in `fixtures/session/` that both test suites decode.
 */

// QUEUE

/** A song as the player needs it: enough to fetch audio and show it. */
export const QueueTrack = Schema.Struct({
  videoId: Schema.String,
  title: Schema.String,
  /** Every credited artist, joined for display. */
  artists: Schema.String,
  album: Schema.NullOr(Schema.String),
  durationSeconds: Schema.NullOr(Schema.Number),
  artworkUrl: Schema.NullOr(Schema.String),
})
export type QueueTrack = typeof QueueTrack.Type

/**
 * One slot in the queue. The same song can be queued twice, so players
 * follow `entryId`, never the song or its position.
 */
export const QueueEntry = Schema.Struct({
  entryId: Schema.String,
  track: QueueTrack,
})
export type QueueEntry = typeof QueueEntry.Type

// DEVICES

export const DeviceKind = Schema.Literals(['Web', 'Tv'])
export type DeviceKind = typeof DeviceKind.Type

export const Device = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: DeviceKind,
  online: Schema.Boolean,
  /** The server asked the TV to wake and open the app, and is waiting. */
  waking: Schema.Boolean,
  /**
   * The device's own output volume, from 0 to 1, as it last reported it.
   * Null when it can't be set from another device (the phone, whose
   * buttons the browser can't reach, and TV apps built before this field).
   */
  volume: Schema.NullOr(Schema.Number),
})
export type Device = typeof Device.Type

// STATE

/**
 * Everything every device sees. The server owns it; the active device plays
 * it and reports progress back.
 *
 * Position is an anchor: `positionSeconds` was true at server time
 * `positionAt` (epoch ms), and moves on in real time while `playing`.
 * `seekSeq` increases whenever the position jumps (seek, skip, transfer), so
 * the active player knows to load or seek even when the entry is unchanged.
 */
export const SessionState = Schema.Struct({
  devices: Schema.Array(Device),
  activeDeviceId: Schema.NullOr(Schema.String),
  queue: Schema.Array(QueueEntry),
  currentEntryId: Schema.NullOr(Schema.String),
  playing: Schema.Boolean,
  positionSeconds: Schema.Number,
  positionAt: Schema.Number,
  seekSeq: Schema.Number,
})
export type SessionState = typeof SessionState.Type

// CLIENT → SERVER

/**
 * What a player is already doing when it reconnects. A phone keeps playing
 * while its connection is down (a locked screen, a Wi-Fi blip), and may
 * pause, seek, or move to the next song meanwhile.
 */
export const PlayerReport = Schema.Struct({
  entryId: Schema.String,
  positionSeconds: Schema.Number,
  playing: Schema.Boolean,
  /**
   * The player played or paused by itself (a tap, the lock screen, a call)
   * and no state from the server agreed yet. Otherwise it only followed the
   * session, which may have changed since without it.
   */
  playingSetHere: Schema.Boolean,
  /** The last `seekSeq` this player followed. */
  seekSeq: Schema.Number,
})
export type PlayerReport = typeof PlayerReport.Type

/** The first message on every connection. */
export const Hello = Schema.TaggedStruct('Hello', {
  deviceId: Schema.String,
  name: Schema.String,
  kind: DeviceKind,
  /**
   * Null when nothing is loaded. TV apps built before this field leave it
   * out, so it may be missing.
   */
  player: Schema.optionalKey(Schema.NullOr(PlayerReport)),
})

/** Replace the queue and start playing it. */
export const PlayQueue = Schema.TaggedStruct('PlayQueue', {
  tracks: Schema.Array(QueueTrack),
  startIndex: Schema.Number,
})

export const Placement = Schema.Literals(['Next', 'Last'])
export type Placement = typeof Placement.Type

export const Enqueue = Schema.TaggedStruct('Enqueue', {
  tracks: Schema.Array(QueueTrack),
  placement: Placement,
})

export const RemoveEntry = Schema.TaggedStruct('RemoveEntry', {
  entryId: Schema.String,
})
export const Resume = Schema.TaggedStruct('Resume', {})
/** Where a player stopped, and the session jump it was following. */
export const StoppedAt = Schema.Struct({
  entryId: Schema.String,
  positionSeconds: Schema.Number,
  seekSeq: Schema.Number,
})
export type StoppedAt = typeof StoppedAt.Type

export const Pause = Schema.TaggedStruct('Pause', {
  /**
   * Where the player stopped, when the player itself pauses, so every device
   * and the next resume agree on the spot. It counts only while that entry
   * is still current and no other device has moved the position since the
   * player last followed it. Null or missing otherwise.
   */
  at: Schema.optionalKey(Schema.NullOr(StoppedAt)),
})
export const Seek = Schema.TaggedStruct('Seek', {
  positionSeconds: Schema.Number,
})
export const SkipTo = Schema.TaggedStruct('SkipTo', { entryId: Schema.String })
export const Next = Schema.TaggedStruct('Next', {})
export const Previous = Schema.TaggedStruct('Previous', {})

/** Move playback to another device, waking it first if it can be woken. */
export const Transfer = Schema.TaggedStruct('Transfer', {
  deviceId: Schema.String,
})

/** The active player's position, about once a second while playing. */
export const Progress = Schema.TaggedStruct('Progress', {
  entryId: Schema.String,
  positionSeconds: Schema.Number,
  playing: Schema.Boolean,
})

/** The player already moved on to the next entry without a gap. */
export const Advanced = Schema.TaggedStruct('Advanced', {
  fromEntryId: Schema.String,
})

/** The entry finished and the player has nothing after it. */
export const TrackEnded = Schema.TaggedStruct('TrackEnded', {
  entryId: Schema.String,
})

export const TrackFailed = Schema.TaggedStruct('TrackFailed', {
  entryId: Schema.String,
  message: Schema.String,
})

/**
 * The sender's own output volume (0 to 1), when it connects and whenever it
 * changes, however it changed (a remote, `SetVolume`). Null when it can't be
 * set.
 */
export const Volume = Schema.TaggedStruct('Volume', {
  level: Schema.NullOr(Schema.Number),
})

/** Ask a device to change its output volume (0 to 1). */
export const SetDeviceVolume = Schema.TaggedStruct('SetDeviceVolume', {
  deviceId: Schema.String,
  level: Schema.Number,
})

export const ClientMessage = Schema.Union([
  Hello,
  PlayQueue,
  Enqueue,
  RemoveEntry,
  Resume,
  Pause,
  Seek,
  SkipTo,
  Next,
  Previous,
  Transfer,
  Progress,
  Advanced,
  TrackEnded,
  TrackFailed,
  Volume,
  SetDeviceVolume,
])
export type ClientMessage = typeof ClientMessage.Type

// SERVER → CLIENT

/** The whole session, sent on connect and after every change. */
export const State = Schema.TaggedStruct('State', {
  state: SessionState,
  /** The server clock when this was sent, to correct for clock skew. */
  serverNow: Schema.Number,
  /**
   * How many messages from this connection the state includes, counting
   * `Hello` as the first. A player that changed something itself keeps its
   * change until this covers the message that carried it.
   */
  ack: Schema.Number,
})

/** Something went wrong that the person should hear about. */
export const Notice = Schema.TaggedStruct('Notice', {
  message: Schema.String,
})

/** Change this device's output volume (0 to 1), as `SetDeviceVolume` asked. */
export const SetVolume = Schema.TaggedStruct('SetVolume', {
  level: Schema.Number,
})

export const ServerMessage = Schema.Union([State, Notice, SetVolume])
export type ServerMessage = typeof ServerMessage.Type

export const ClientMessageJson = Schema.fromJsonString(ClientMessage)
export const ServerMessageJson = Schema.fromJsonString(ServerMessage)

/** Where the session WebSocket lives, relative to the server origin. */
export const SESSION_PATH = '/session'

/** Where a song's audio is served, relative to the server origin. */
export const audioPath = (videoId: string): string =>
  `/audio/${encodeURIComponent(videoId)}`

/** The position a session is at right now, by the server's clock. */
export const positionAt = (state: SessionState, serverNow: number): number =>
  state.playing
    ? state.positionSeconds + Math.max(0, serverNow - state.positionAt) / 1000
    : state.positionSeconds
