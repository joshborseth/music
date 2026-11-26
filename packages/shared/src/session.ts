import { Option, Schema } from 'effect'

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
  /**
   * Autoplay added it after the queue ran low: a song like the ones before
   * it, from YouTube Music's radio for the last song. Players show these
   * after the songs someone queued.
   */
  autoplay: Schema.Boolean,
})
export type QueueEntry = typeof QueueEntry.Type

// DEVICES

export const DeviceKind = Schema.Literals(['Web', 'Tv'])
export type DeviceKind = typeof DeviceKind.Type

export const Device = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: DeviceKind,
  /** The app is open on it and connected right now. */
  online: Schema.Boolean,
  /** The server asked the TV to wake and open the app, and is waiting. */
  waking: Schema.Boolean,
  /**
   * Whether the TV itself is on, as Home Assistant last saw it, so an
   * offline TV can say whether it is off or only has the app closed. Null
   * when unknown, and for every device that is not a TV.
   */
  poweredOn: Schema.NullOr(Schema.Boolean),
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
/**
 * What happens at the end of a song: go on to the next (`Off`, stopping
 * after the last), go on and start over after the last (`All`), or play the
 * same song again (`One`).
 */
export const RepeatMode = Schema.Literals(['Off', 'All', 'One'])
export type RepeatMode = typeof RepeatMode.Type

/**
 * When the music stops by itself: at a moment (`At`, server epoch ms), or
 * as the song playing ends (`EndOfSong`), whichever song that is by then.
 * The server pauses the session then, wherever it plays. A phone that plays
 * stops on its own too, since a locked phone may not hear the server.
 */
export const SleepTimer = Schema.Union([
  Schema.TaggedStruct('At', { endsAt: Schema.Number }),
  Schema.TaggedStruct('EndOfSong', {}),
])
export type SleepTimer = typeof SleepTimer.Type

/** What kind of thing a queue was started from. */
export const PlayingFromKind = Schema.Literals([
  'Album',
  'Playlist',
  /** One of the playlists made in the app, Liked Songs among them. */
  'MyPlaylist',
  'Artist',
  /** One of Home's mixes, a playlist of YouTube Music's radio for a song. */
  'Mix',
  /** YouTube Music's radio for a song, an album, or an artist. */
  'Radio',
  'Search',
])
export type PlayingFromKind = typeof PlayingFromKind.Type

/**
 * What the queue was started from, so players can say "Playing from
 * <title>" and open it. `id` is what opens it: an album's browse id, a
 * playlist's id (a mix's or a radio's is YouTube Music's radio playlist
 * id, which opens as a playlist), an artist's channel id, or the words
 * searched for.
 */
export const PlayingFrom = Schema.Struct({
  kind: PlayingFromKind,
  title: Schema.String,
  id: Schema.String,
})
export type PlayingFrom = typeof PlayingFrom.Type

/** YouTube Music's radio for a song, as a playlist id: it opens as a mix. */
export const songRadioPlaylistId = (videoId: string): string =>
  `RDAMVM${videoId}`

/** A playlist id of one of YouTube Music's radios or mixes. */
export const isRadioPlaylistId = (playlistId: string): boolean =>
  playlistId.startsWith('RD')

export const SessionState = Schema.Struct({
  devices: Schema.Array(Device),
  activeDeviceId: Schema.NullOr(Schema.String),
  queue: Schema.Array(QueueEntry),
  currentEntryId: Schema.NullOr(Schema.String),
  playing: Schema.Boolean,
  positionSeconds: Schema.Number,
  positionAt: Schema.Number,
  seekSeq: Schema.Number,
  /** Similar songs are added as the queue runs out, so music keeps playing. */
  autoplay: Schema.Boolean,
  repeat: RepeatMode,
  /**
   * The songs after the current one were put in a random order. Turning it
   * off puts them back.
   */
  shuffle: Schema.Boolean,
  /** Null when no sleep timer is set. */
  sleepTimer: Schema.NullOr(SleepTimer),
  /**
   * What the queue was started from (`PlayQueue`). Null when it was not
   * started from anything with a page, such as one song, and in sessions
   * saved before this field.
   */
  playingFrom: Schema.NullOr(PlayingFrom),
  /**
   * Sound Check: every song plays at about the same loudness, turned up or
   * down by the gain the server measured for it (`GET /tv/loudness`). It
   * belongs to the session, so it applies on every device that levels; the
   * TV does, and the phone can't yet (iOS ignores an audio element's
   * volume). On unless someone turns it off.
   */
  soundCheck: Schema.Boolean,
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
  /**
   * What the songs come from. Null or missing when they come from nothing
   * with a page (TV apps built before this field leave it out).
   */
  playingFrom: Schema.optionalKey(Schema.NullOr(PlayingFrom)),
  /**
   * Shuffle the songs, as a Shuffle button does (true), play them in order,
   * as a Play button does (false), or keep the session's shuffle setting, as
   * a tap on one song in a list does (null). The session's shuffle becomes
   * this when it is not null. Clients built before this field leave it out,
   * which reads as null.
   */
  shuffle: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
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
/**
 * Move a song still to come to another place among the songs still to come:
 * just before `beforeEntryId`, or with null, last among the songs of its
 * kind (after the last song someone queued, or for an autoplay song, at the
 * end of the queue). The current song and the songs before it stay put, and
 * autoplay's songs stay after the songs someone queued. See `moveEntry`.
 */
export const MoveEntry = Schema.TaggedStruct('MoveEntry', {
  entryId: Schema.String,
  beforeEntryId: Schema.NullOr(Schema.String),
})
/**
 * Clear the songs still to come that someone queued: "Clear" over Playing
 * Next. The current song and the songs before it stay, and so do the
 * autoplay songs, which then follow the current song. See `clearUpcoming`.
 */
export const ClearUpcoming = Schema.TaggedStruct('ClearUpcoming', {})
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

/**
 * Turn autoplay on or off. Turning it off removes the autoplay songs still
 * to come.
 */
export const SetAutoplay = Schema.TaggedStruct('SetAutoplay', {
  enabled: Schema.Boolean,
})

export const SetRepeat = Schema.TaggedStruct('SetRepeat', { mode: RepeatMode })

/**
 * Shuffle the songs after the current one, or put them back in the order
 * they were in.
 */
export const SetShuffle = Schema.TaggedStruct('SetShuffle', {
  enabled: Schema.Boolean,
})

/** Turn Sound Check on or off (`SessionState.soundCheck`). */
export const SetSoundCheck = Schema.TaggedStruct('SetSoundCheck', {
  enabled: Schema.Boolean,
})

/** A sleep timer as someone picks it: after some minutes, or at the song's end. */
export const SleepTimerChoice = Schema.Union([
  Schema.TaggedStruct('Minutes', { minutes: Schema.Number }),
  Schema.TaggedStruct('EndOfSong', {}),
])
export type SleepTimerChoice = typeof SleepTimerChoice.Type

/** Set the sleep timer, or turn it off with null. */
export const SetSleepTimer = Schema.TaggedStruct('SetSleepTimer', {
  timer: Schema.NullOr(SleepTimerChoice),
})

/** Move playback to another device, waking it first if it can be woken. */
export const Transfer = Schema.TaggedStruct('Transfer', {
  deviceId: Schema.String,
})

/**
 * Turn a device on and open the app on it, without moving playback there:
 * the TV, so it is ready to pick from, or to show what plays.
 */
export const Wake = Schema.TaggedStruct('Wake', {
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
  MoveEntry,
  ClearUpcoming,
  Resume,
  Pause,
  Seek,
  SkipTo,
  Next,
  Previous,
  SetAutoplay,
  SetRepeat,
  SetShuffle,
  SetSoundCheck,
  SetSleepTimer,
  Transfer,
  Wake,
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
   * The house's UTC offset in minutes (-420 for UTC-7), from the server's
   * operating system. The TV shows its clock with it, because Android's own
   * time zone rules can be out of date.
   */
  utcOffsetMinutes: Schema.Number,
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

/**
 * How long a phone took to show the session as it is after coming back on
 * screen, which it posts to `RESYNC_REPORT_PATH` for the server's log. Not
 * part of the socket protocol: the TV never sends it.
 */
export const ResyncReport = Schema.Struct({
  /** How long the page was out of sight. */
  hiddenForMs: Schema.Number,
  /** From showing to the fresh socket opening; null when no socket opened. */
  socketMs: Schema.NullOr(Schema.Number),
  /** From showing to the server's state arriving. */
  stateMs: Schema.Number,
  /** The address the app was opened from (LAN, HTTPS, or the public one). */
  host: Schema.String,
})
export type ResyncReport = typeof ResyncReport.Type

export const RESYNC_REPORT_PATH = '/session/resync'

/** Where a song's audio is served, relative to the server origin. */
export const audioPath = (videoId: string): string =>
  `/audio/${encodeURIComponent(videoId)}`

/** The position a session is at right now, by the server's clock. */
export const positionAt = (state: SessionState, serverNow: number): number =>
  state.playing
    ? state.positionSeconds + Math.max(0, serverNow - state.positionAt) / 1000
    : state.positionSeconds

/**
 * The queue index that plays after `index` when that song ends by itself
 * (or plays on without a gap), in a queue of `length`. None at the end of
 * the queue with repeat off. Every player and the server follow this, so
 * they agree on what comes next; `apps/tv/src/protocol.rs` mirrors it.
 */
export const followingIndex = (
  length: number,
  index: number,
  repeat: RepeatMode,
): Option.Option<number> => {
  if (index < 0 || index >= length) return Option.none()
  if (repeat === 'One') return Option.some(index)
  if (index + 1 < length) return Option.some(index + 1)
  return repeat === 'All' ? Option.some(0) : Option.none()
}

/**
 * The sleep timer stops the music when the song playing ends, so nothing
 * follows it without a gap: the player lets it end (`TrackEnded`).
 */
export const stopsAfterSong = (state: SessionState): boolean =>
  state.sleepTimer?._tag === 'EndOfSong'

/** The longest sleep timer the server takes, in minutes. */
export const MAX_SLEEP_MINUTES = 24 * 60

/**
 * The queue index Next goes to from `index`. Next always moves on, even
 * with repeat one, and starts over after the last song unless repeat is off.
 */
export const skipIndex = (
  length: number,
  index: number,
  repeat: RepeatMode,
): Option.Option<number> =>
  followingIndex(length, index, repeat === 'One' ? 'All' : repeat)

/**
 * The queue after `MoveEntry`, or None when the move changes nothing or can't
 * be made. Only an entry after `currentEntryId` moves (every entry when there
 * is none). It lands just before `beforeEntryId`, kept among the songs still
 * to come and among the songs of its own kind: someone's songs stay before
 * autoplay's. An unknown `beforeEntryId` (removed meanwhile) moves nothing.
 * The server applies moves with this, and the phone shows its own at once
 * with it, so both put the song in the same place.
 */
export const moveEntry = (
  queue: ReadonlyArray<QueueEntry>,
  currentEntryId: string | null,
  entryId: string,
  beforeEntryId: string | null,
): Option.Option<ReadonlyArray<QueueEntry>> => {
  const indexIn = (entries: ReadonlyArray<QueueEntry>, id: string | null) =>
    id === null ? -1 : entries.findIndex(entry => entry.entryId === id)
  const after = indexIn(queue, currentEntryId) + 1
  const from = indexIn(queue, entryId)
  const moving = queue[from]
  if (from < after || moving === undefined) return Option.none()
  const rest = queue.filter(entry => entry.entryId !== entryId)
  const firstAutoplay = rest.findIndex(
    (entry, index) => index >= after && entry.autoplay,
  )
  const autoplayStart = firstAutoplay === -1 ? rest.length : firstAutoplay
  const lowest = moving.autoplay ? autoplayStart : after
  const highest = moving.autoplay ? rest.length : autoplayStart
  const before = indexIn(rest, beforeEntryId)
  if (beforeEntryId !== null && before === -1) return Option.none()
  const to = Math.min(
    highest,
    Math.max(lowest, beforeEntryId === null ? highest : before),
  )
  if (to === from) return Option.none()
  return Option.some([...rest.slice(0, to), moving, ...rest.slice(to)])
}

/**
 * The queue after `ClearUpcoming`, or None when there is nothing to clear.
 * Every song after `currentEntryId` that someone queued goes (every one
 * when there is none); the songs before it and autoplay's songs stay. The
 * server clears with this, and the phone shows its own clear at once with
 * it, so both leave the same songs.
 */
export const clearUpcoming = (
  queue: ReadonlyArray<QueueEntry>,
  currentEntryId: string | null,
): Option.Option<ReadonlyArray<QueueEntry>> => {
  const after =
    (currentEntryId === null
      ? -1
      : queue.findIndex(entry => entry.entryId === currentEntryId)) + 1
  const kept = queue.filter((entry, index) => index < after || entry.autoplay)
  return kept.length === queue.length ? Option.none() : Option.some(kept)
}
