import { Option, Schema } from 'effect'

import { Session } from '@music/shared'

import { type Model, currentPosition, initialModel } from './model.ts'

/*
 * The session as it is kept on disk, so a server restart (a deploy, a
 * crash) does not lose what was playing. The hub writes it shortly after
 * every change and once more as it shuts down, and reads it back at start.
 */

export const SavedSession = Schema.Struct({
  version: Schema.Literal(1),
  /** When it was written (epoch ms): where a playing song had got to. */
  savedAt: Schema.Number,
  activeDeviceId: Schema.NullOr(Schema.String),
  queue: Schema.Array(Session.QueueEntry),
  currentEntryId: Schema.NullOr(Schema.String),
  playing: Schema.Boolean,
  positionSeconds: Schema.Number,
  seekSeq: Schema.Number,
  foreignSeekSeq: Schema.Number,
  autoplay: Schema.Boolean,
  // Added later: files saved before have none.
  repeat: Schema.optionalKey(Session.RepeatMode),
  shuffle: Schema.optionalKey(Schema.Boolean),
  unshuffled: Schema.optionalKey(Schema.Array(Schema.String)),
  sleepTimer: Schema.optionalKey(Schema.NullOr(Session.SleepTimer)),
  /**
   * The server paused only because the player went away. A deploy closes
   * every socket and can take longer to stop than `PLAYER_GRACE`, so the
   * pause for the lost player is often what gets written.
   */
  pausedForLostPlayer: Schema.optionalKey(Schema.Boolean),
})
export type SavedSession = typeof SavedSession.Type

export const SavedSessionJson = Schema.fromJsonString(SavedSession)

/** What to write for `model` at `now`. */
export const toSaved = (model: Model, now: number): SavedSession => ({
  version: 1,
  savedAt: now,
  activeDeviceId: model.activeDeviceId,
  queue: model.queue,
  currentEntryId: model.currentEntryId,
  playing: model.playing,
  positionSeconds: currentPosition(model, now),
  seekSeq: model.seekSeq,
  foreignSeekSeq: model.foreignSeekSeq,
  autoplay: model.autoplay,
  repeat: model.repeat,
  shuffle: model.shuffle,
  unshuffled: model.unshuffled,
  sleepTimer: model.sleepTimer,
  pausedForLostPlayer: model.pausedForLostPlayer,
})

/**
 * The session to start from. Every device is offline after a restart, so
 * a song that was playing is paused where it had got to, as if its player
 * had gone away (`playerLost`): a player that kept playing through the
 * restart takes the session back when it reconnects.
 */
export const fromSaved = (saved: SavedSession, now: number): Model => {
  const current = saved.queue.find(
    entry => entry.entryId === saved.currentEntryId,
  )
  if (current === undefined) {
    return { ...initialModel, autoplay: saved.autoplay }
  }
  const length = current.track.durationSeconds ?? Number.POSITIVE_INFINITY
  return {
    ...initialModel,
    activeDeviceId: saved.activeDeviceId,
    queue: saved.queue,
    currentEntryId: saved.currentEntryId,
    playing: false,
    positionSeconds: Math.max(0, Math.min(saved.positionSeconds, length)),
    positionAt: now,
    seekSeq: saved.seekSeq,
    foreignSeekSeq: saved.foreignSeekSeq,
    autoplay: saved.autoplay,
    repeat: saved.repeat ?? 'Off',
    shuffle: saved.shuffle ?? false,
    unshuffled: saved.unshuffled ?? [],
    // NOTE: a pause the server made because the player went away, before
    // or during the restart, still yields to a player that played on.
    pausedForLostPlayer: saved.playing || (saved.pausedForLostPlayer ?? false),
    // NOTE: a player that played on through the restart takes the session
    // back, and must still stop when its timer said. One whose time passed
    // while the server was down has nothing left to stop.
    sleepTimer:
      saved.sleepTimer?._tag === 'At' && saved.sleepTimer.endsAt <= now
        ? null
        : (saved.sleepTimer ?? null),
  }
}

const ENTRY_ID = /^e([0-9a-z]+)$/

/** The next free number for `makeEntryId`, after every id in `queue`. */
export const nextEntryNumber = (
  queue: ReadonlyArray<Session.QueueEntry>,
): number =>
  queue.reduce((next, entry) => {
    const maybeNumber = Option.fromNullishOr(ENTRY_ID.exec(entry.entryId)).pipe(
      Option.flatMap(match => Option.fromNullishOr(match[1])),
      Option.map(digits => Number.parseInt(digits, 36)),
    )
    return Option.isSome(maybeNumber) && maybeNumber.value >= next
      ? maybeNumber.value + 1
      : next
  }, 0)
