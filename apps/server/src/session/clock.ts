import type { NowPlaying } from '@music/shared'

import type { Model } from './model.ts'

/*
 * The song clock on `/now-playing`, for listeners that time things to the
 * beat (the house lights). The session itself only re-anchors its position
 * when the player strays by seconds, which is plenty for a progress bar but
 * not for a beat, so the hub keeps this finer clock beside it.
 */

/**
 * How far the player's reported position may stray from the clock listeners
 * have before they get a new one. A beat at 180 BPM is a third of a second.
 */
export const CLOCK_TOLERANCE_SECONDS = 0.04

/** Where the session's current song is, while it plays. */
export const songClock = (model: Model): NowPlaying.SongClock | null => {
  if (!model.playing) return null
  const entry = model.queue.find(
    ({ entryId }) => entryId === model.currentEntryId,
  )
  return entry === undefined
    ? null
    : {
        videoId: entry.track.videoId,
        positionSeconds: model.positionSeconds,
        at: model.positionAt,
      }
}

/**
 * The clock to give listeners: the latest one, unless it still agrees with
 * the one they have. Each `Progress` re-anchors the session, so without this
 * listeners would hear of a new clock every second.
 */
export const nextClock = (
  previous: NowPlaying.SongClock | null,
  current: NowPlaying.SongClock | null,
): NowPlaying.SongClock | null => {
  if (
    previous === null ||
    current === null ||
    previous.videoId !== current.videoId
  ) {
    return current
  }
  const expected = previous.positionSeconds + (current.at - previous.at) / 1000
  return Math.abs(expected - current.positionSeconds) > CLOCK_TOLERANCE_SECONDS
    ? current
    : previous
}
