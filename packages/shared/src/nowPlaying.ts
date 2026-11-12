import { Schema } from 'effect'

import { DeviceKind } from './session.ts'

/*
 * A feed of what is playing, for things outside the app (the lights in the
 * house) that react to the music without joining the session. JSON text
 * frames over the WebSocket at `/now-playing`: the current value on connect,
 * then a new one whenever the song, play state, player, cover color, or cue
 * changes. Listeners never appear as a device.
 *
 * The lights change with the music on the TV. A listener that sends `Follow`
 * with `Tv` makes the TV hold each song it jumps to (a skip, a tap in the
 * queue, a new queue) until the song is loaded and its color known; then the
 * song starts and the frame carries a `cue` for now. A song that follows the
 * last with no gap can't wait, so the TV says when it will start, and the
 * frame carries its `cue` ahead of time.
 *
 * While a song plays, `clock` says where in it the player is, closely enough
 * to time things to its beats (see `Tv.TvAnalysis` at `/tv/analysis`).
 */

/** A color as `#rrggbb` sRGB. */
export const Hex = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/))

export const NowPlayingTrack = Schema.Struct({
  videoId: Schema.String,
  title: Schema.String,
  artists: Schema.String,
  album: Schema.NullOr(Schema.String),
  artworkUrl: Schema.NullOr(Schema.String),
})
export type NowPlayingTrack = typeof NowPlayingTrack.Type

/** The device playing the music. */
export const NowPlayingDevice = Schema.Struct({
  name: Schema.String,
  kind: DeviceKind,
})
export type NowPlayingDevice = typeof NowPlayingDevice.Type

/**
 * Change the lights to the cover color of `videoId` at server time `at`
 * (epoch ms): the moment that song starts on the TV. Null color: a black,
 * white, or grey cover, or no artwork.
 */
export const Cue = Schema.Struct({
  videoId: Schema.String,
  color: Schema.NullOr(Hex),
  at: Schema.Number,
})
export type Cue = typeof Cue.Type

/**
 * Where the current song is: `positionSeconds` into `videoId` at server time
 * `at` (epoch ms), moving on in real time. It is the position the player
 * hands to its audio output; sound leaves the speakers a little later. A new
 * clock comes only when the position jumps or drifts, not every second.
 */
export const SongClock = Schema.Struct({
  videoId: Schema.String,
  positionSeconds: Schema.Number,
  at: Schema.Number,
})
export type SongClock = typeof SongClock.Type

export const NowPlaying = Schema.TaggedStruct('NowPlaying', {
  /** The current song, or null when the queue is empty or finished. */
  track: Schema.NullOr(NowPlayingTrack),
  playing: Schema.Boolean,
  device: Schema.NullOr(NowPlayingDevice),
  /**
   * The one color the cover reads as, the same one the full player is tinted
   * with. Null for a black, white, or grey cover, or when there is no artwork.
   */
  color: Schema.NullOr(Hex),
  /**
   * When the lights should change for the song that starts on the TV: the
   * current song once it starts after a jump, or the next one when it is
   * about to follow with no gap. Null once the session jumps elsewhere.
   */
  cue: Schema.NullOr(Cue),
  /** Where the song is while it plays. Null while paused or held. */
  clock: Schema.NullOr(SongClock),
})
export type NowPlaying = typeof NowPlaying.Type

export const NowPlayingJson = Schema.fromJsonString(NowPlaying)

/**
 * Sent by a listener, on connect and whenever it changes: the devices whose
 * songs it follows. While one follows `Tv`, the TV holds each song it jumps
 * to until the lights can change with it. An empty list follows nothing.
 */
export const Follow = Schema.TaggedStruct('Follow', {
  kinds: Schema.Array(DeviceKind),
})
export type Follow = typeof Follow.Type

export const FollowJson = Schema.fromJsonString(Follow)

/** Where the now-playing WebSocket lives, relative to the server origin. */
export const NOW_PLAYING_PATH = '/now-playing'
