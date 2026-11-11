import { Array, Match, Option, pipe } from 'effect'

import { Session } from '@music/shared'

/*
 * The session's state transitions, kept pure so they can be tested without
 * sockets or clocks. `hub.ts` runs them and carries out what they ask for.
 */

/** The session minus `devices`, which the hub derives from connections. */
export interface Model {
  readonly activeDeviceId: string | null
  readonly queue: ReadonlyArray<Session.QueueEntry>
  readonly currentEntryId: string | null
  readonly playing: boolean
  readonly positionSeconds: number
  readonly positionAt: number
  readonly seekSeq: number
  /** Devices the server asked to wake that have not connected yet. */
  readonly waking: ReadonlyArray<string>
}

export const initialModel: Model = {
  activeDeviceId: null,
  queue: [],
  currentEntryId: null,
  playing: false,
  positionSeconds: 0,
  positionAt: 0,
  seekSeq: 0,
  waking: [],
}

/** What the hub knows about the world when a message arrives. */
export interface Context {
  readonly now: number
  readonly senderId: string
  readonly isOnline: (deviceId: string) => boolean
  readonly isWakeable: (deviceId: string) => boolean
  readonly makeEntryId: () => string
}

/** What a transition asks the hub to do besides storing the new model. */
export interface Outcome {
  readonly model: Model
  /** Every device needs the new state. False for quiet progress updates. */
  readonly broadcast: boolean
  readonly maybeWake: Option.Option<string>
  readonly maybeNotice: Option.Option<string>
}

/** A player reporting a position this far off the server's guess resyncs. */
const DRIFT_TOLERANCE_SECONDS = 2
/** Previous restarts the song when it is past this point. */
const RESTART_THRESHOLD_SECONDS = 3

const changed = (model: Model): Outcome => ({
  model,
  broadcast: true,
  maybeWake: Option.none(),
  maybeNotice: Option.none(),
})

const quiet = (model: Model): Outcome => ({
  ...changed(model),
  broadcast: false,
})

/** Re-send the state as is, e.g. after the device list changed. */
export const refresh = (model: Model): Outcome => changed(model)

export const unchanged = (model: Model): Outcome => quiet(model)

const notice = (model: Model, message: string): Outcome => ({
  ...quiet(model),
  maybeNotice: Option.some(message),
})

export const toSessionState = (
  model: Model,
  devices: ReadonlyArray<Session.Device>,
): Session.SessionState => ({
  devices,
  activeDeviceId: model.activeDeviceId,
  queue: model.queue,
  currentEntryId: model.currentEntryId,
  playing: model.playing,
  positionSeconds: model.positionSeconds,
  positionAt: model.positionAt,
  seekSeq: model.seekSeq,
})

export const currentPosition = (model: Model, now: number): number =>
  model.playing
    ? model.positionSeconds + Math.max(0, now - model.positionAt) / 1000
    : model.positionSeconds

const indexOf = (model: Model, entryId: string | null): number =>
  entryId === null
    ? -1
    : model.queue.findIndex(entry => entry.entryId === entryId)

const entryAt = (model: Model, index: number): string | null =>
  model.queue[index]?.entryId ?? null

/** Jump to an entry (or nowhere) at a position, telling players to reload. */
const jumpTo = (
  model: Model,
  entryId: string | null,
  positionSeconds: number,
  now: number,
): Model => ({
  ...model,
  currentEntryId: entryId,
  playing: entryId === null ? false : model.playing,
  positionSeconds,
  positionAt: now,
  seekSeq: model.seekSeq + 1,
})

/** Anchor the extrapolated position at `now`, e.g. before pausing. */
const settle = (model: Model, now: number): Model => ({
  ...model,
  positionSeconds: currentPosition(model, now),
  positionAt: now,
})

const isPlayable = (model: Model, deviceId: string, context: Context) =>
  context.isOnline(deviceId) || model.waking.includes(deviceId)

/** Make the sender the player when nothing else can play. */
const claimIfIdle = (model: Model, context: Context): Model =>
  model.activeDeviceId !== null &&
  isPlayable(model, model.activeDeviceId, context)
    ? model
    : { ...model, activeDeviceId: context.senderId }

const toEntries = (
  tracks: ReadonlyArray<Session.QueueTrack>,
  context: Context,
): ReadonlyArray<Session.QueueEntry> =>
  tracks.map(track => ({ entryId: context.makeEntryId(), track }))

/** Only the active device may report playback, and only for the current entry. */
const isFromPlayer = (model: Model, context: Context, entryId: string) =>
  model.activeDeviceId === context.senderId && model.currentEntryId === entryId

/** Move past the current entry after it ended or failed on the player. */
const finishCurrent = (model: Model, now: number): Model => {
  const maybeNext = entryAt(model, indexOf(model, model.currentEntryId) + 1)
  return maybeNext === null
    ? { ...jumpTo(model, model.currentEntryId, 0, now), playing: false }
    : jumpTo(model, maybeNext, 0, now)
}

export const update = (
  model: Model,
  message: Session.ClientMessage,
  context: Context,
): Outcome => {
  const { now } = context
  return Match.value(message).pipe(
    Match.withReturnType<Outcome>(),
    Match.tagsExhaustive({
      Hello: () => {
        const isWaking = model.waking.includes(context.senderId)
        return changed({
          ...model,
          waking: model.waking.filter(id => id !== context.senderId),
          // A device that comes back as the player reloads where it left off.
          seekSeq:
            isWaking || model.activeDeviceId === context.senderId
              ? model.seekSeq + 1
              : model.seekSeq,
          ...(model.activeDeviceId === context.senderId
            ? { positionSeconds: currentPosition(model, now), positionAt: now }
            : {}),
        })
      },

      PlayQueue: message => {
        const queue = toEntries(message.tracks, context)
        const start = Math.min(
          Math.max(0, Math.trunc(message.startIndex)),
          queue.length - 1,
        )
        return changed(
          claimIfIdle(
            {
              ...jumpTo(
                { ...model, queue },
                entryAt({ ...model, queue }, start),
                0,
                now,
              ),
              playing: queue.length > 0,
            },
            context,
          ),
        )
      },

      Enqueue: message => {
        const entries = toEntries(message.tracks, context)
        if (entries.length === 0) return quiet(model)
        if (model.currentEntryId === null) {
          return update(
            model,
            {
              _tag: 'PlayQueue',
              tracks: [
                ...model.queue.map(entry => entry.track),
                ...message.tracks,
              ],
              startIndex: model.queue.length,
            },
            context,
          )
        }
        const insertAt =
          message.placement === 'Next'
            ? indexOf(model, model.currentEntryId) + 1
            : model.queue.length
        return changed({
          ...model,
          queue: [
            ...model.queue.slice(0, insertAt),
            ...entries,
            ...model.queue.slice(insertAt),
          ],
        })
      },

      RemoveEntry: message => {
        const index = indexOf(model, message.entryId)
        if (index === -1) return quiet(model)
        const queue = model.queue.filter(
          entry => entry.entryId !== message.entryId,
        )
        if (message.entryId !== model.currentEntryId) {
          return changed({ ...model, queue })
        }
        const maybeReplacement =
          queue[index]?.entryId ?? queue[index - 1]?.entryId ?? null
        return changed(jumpTo({ ...model, queue }, maybeReplacement, 0, now))
      },

      Resume: () => {
        if (model.queue.length === 0) return quiet(model)
        const withEntry =
          model.currentEntryId === null
            ? jumpTo(model, entryAt(model, 0), 0, now)
            : model
        const claimed = claimIfIdle(withEntry, context)
        return changed({
          ...claimed,
          playing: true,
          positionAt: now,
          // A new player has nothing loaded yet.
          seekSeq:
            claimed.activeDeviceId === model.activeDeviceId
              ? claimed.seekSeq
              : claimed.seekSeq + 1,
        })
      },

      Pause: () => {
        return changed({ ...settle(model, now), playing: false })
      },

      Seek: message => {
        return model.currentEntryId === null
          ? quiet(model)
          : changed(
              jumpTo(
                model,
                model.currentEntryId,
                Math.max(0, message.positionSeconds),
                now,
              ),
            )
      },

      SkipTo: message => {
        return indexOf(model, message.entryId) === -1
          ? quiet(model)
          : changed({
              ...jumpTo(model, message.entryId, 0, now),
              playing: true,
            })
      },

      Next: () => {
        const maybeNext = entryAt(
          model,
          indexOf(model, model.currentEntryId) + 1,
        )
        return maybeNext === null
          ? quiet(model)
          : changed(jumpTo(model, maybeNext, 0, now))
      },

      Previous: () => {
        const index = indexOf(model, model.currentEntryId)
        if (index === -1) return quiet(model)
        const restart =
          currentPosition(model, now) > RESTART_THRESHOLD_SECONDS || index === 0
        return changed(
          jumpTo(
            model,
            restart ? model.currentEntryId : entryAt(model, index - 1),
            0,
            now,
          ),
        )
      },

      Transfer: message => {
        const target = message.deviceId
        if (target === model.activeDeviceId) return quiet(model)
        const online = context.isOnline(target)
        if (!online && !context.isWakeable(target)) {
          return notice(model, 'That device is offline.')
        }
        const moved: Model = {
          ...settle(model, now),
          activeDeviceId: target,
          seekSeq: model.seekSeq + 1,
          waking: online ? model.waking : Array.union(model.waking, [target]),
        }
        return {
          ...changed(moved),
          maybeWake: online ? Option.none() : Option.some(target),
        }
      },

      Progress: message => {
        if (!isFromPlayer(model, context, message.entryId)) return quiet(model)
        const drift = Math.abs(
          currentPosition(model, now) - message.positionSeconds,
        )
        const anchored: Model = {
          ...model,
          positionSeconds: message.positionSeconds,
          positionAt: now,
        }
        return drift > DRIFT_TOLERANCE_SECONDS
          ? changed(anchored)
          : quiet(anchored)
      },

      Advanced: message => {
        if (!isFromPlayer(model, context, message.fromEntryId))
          return quiet(model)
        const maybeNext = entryAt(
          model,
          indexOf(model, message.fromEntryId) + 1,
        )
        // The player already started the next entry, so seekSeq stays put.
        return maybeNext === null
          ? quiet(model)
          : changed({
              ...model,
              currentEntryId: maybeNext,
              positionSeconds: 0,
              positionAt: now,
            })
      },

      TrackEnded: message => {
        return isFromPlayer(model, context, message.entryId)
          ? changed(finishCurrent(model, now))
          : quiet(model)
      },

      TrackFailed: message => {
        if (!isFromPlayer(model, context, message.entryId)) return quiet(model)
        const title = pipe(
          model.queue[indexOf(model, message.entryId)],
          Option.fromNullishOr,
          Option.match({
            onNone: () => 'a song',
            onSome: entry => `“${entry.track.title}”`,
          }),
        )
        return {
          ...changed(finishCurrent(model, now)),
          maybeNotice: Option.some(
            `Couldn't play ${title}: ${message.message}`,
          ),
        }
      },
    }),
  )
}

/** The active device went away for good: stop where it was. */
export const playerLost = (
  model: Model,
  deviceId: string,
  now: number,
): Outcome =>
  model.activeDeviceId === deviceId && model.playing
    ? changed({ ...settle(model, now), playing: false })
    : quiet(model)

/** A device that was asked to wake never connected. */
export const wakeTimedOut = (
  model: Model,
  deviceId: string,
  now: number,
): Outcome => {
  if (!model.waking.includes(deviceId)) return quiet(model)
  const stopped: Model = {
    ...settle(model, now),
    waking: model.waking.filter(id => id !== deviceId),
    playing: model.activeDeviceId === deviceId ? false : model.playing,
  }
  return {
    ...changed(stopped),
    maybeNotice: Option.some(
      "The TV didn't open Music. Is it on the same network?",
    ),
  }
}

/** Songs after the current one that are downloaded whole ahead of time. */
export const DOWNLOAD_AHEAD = 5
/** Songs after those whose links are found ahead, so they start in about a second. */
export const RESOLVE_AHEAD = 5
/** With this few songs left after the current one, look past the queue's end. */
export const QUEUE_END_THRESHOLD = 2

export interface Lookahead {
  /** The current song and the next `DOWNLOAD_AHEAD`. */
  readonly download: ReadonlyArray<string>
  /** The `RESOLVE_AHEAD` songs after those. */
  readonly resolve: ReadonlyArray<string>
  /** The last queued song, when the queue is about to run out. */
  readonly maybeEndingAt: Option.Option<string>
}

/** What to get ready ahead of time. Nothing once the queue has finished. */
export const lookahead = (model: Model): Lookahead => {
  const index = indexOf(model, model.currentEntryId)
  if (index < 0) {
    return { download: [], resolve: [], maybeEndingAt: Option.none() }
  }
  const videoIds = model.queue.map(entry => entry.track.videoId)
  const remaining = videoIds.length - index - 1
  return {
    download: videoIds.slice(index, index + 1 + DOWNLOAD_AHEAD),
    resolve: videoIds.slice(
      index + 1 + DOWNLOAD_AHEAD,
      index + 1 + DOWNLOAD_AHEAD + RESOLVE_AHEAD,
    ),
    maybeEndingAt:
      remaining <= QUEUE_END_THRESHOLD
        ? Option.fromNullishOr(videoIds.at(-1))
        : Option.none(),
  }
}
