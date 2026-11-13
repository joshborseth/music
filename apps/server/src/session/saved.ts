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
    pausedForLostPlayer: saved.playing,
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
