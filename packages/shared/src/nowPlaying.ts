import { Schema } from 'effect'

import { DeviceKind } from './session.ts'

/*
 * A read-only feed of what is playing, for things outside the app (the
 * lights in the house) that react to the music without joining the session.
 * JSON text frames over the WebSocket at `/now-playing`: the current value
 * on connect, then a new one whenever the song, play state, player, or
 * cover color changes. Listeners send nothing and never appear as a device.
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
})
export type NowPlaying = typeof NowPlaying.Type

export const NowPlayingJson = Schema.fromJsonString(NowPlaying)

/** Where the now-playing WebSocket lives, relative to the server origin. */
export const NOW_PLAYING_PATH = '/now-playing'
