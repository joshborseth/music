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
  /** Add similar songs as the queue runs out. */
  readonly autoplay: boolean
  /**
   * The last `seekSeq` from a jump the player did not make itself. A
   * reconnecting player that followed it may report jumps of its own since.
   */
  readonly foreignSeekSeq: number
  /**
   * The server paused because the player went away (`playerLost`), and
   * nothing played or paused since. A player that kept playing meanwhile
   * resumes the session when it reconnects.
   */
  readonly pausedForLostPlayer: boolean
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
  autoplay: true,
  foreignSeekSeq: 0,
  pausedForLostPlayer: false,
  waking: [],
}

/**
 * Messages about a device's own volume. The hub keeps volumes with the
 * connections, because they belong to devices, not to the session.
 */
export type DeviceMessage = Extract<
  Session.ClientMessage,
  { readonly _tag: 'Volume' | 'SetDeviceVolume' }
>

/** Messages that change the session. */
export type SessionMessage = Exclude<Session.ClientMessage, DeviceMessage>

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
  autoplay: model.autoplay,
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
  makeEntryId: () => string,
  autoplay = false,
): ReadonlyArray<Session.QueueEntry> =>
  tracks.map(track => ({ entryId: makeEntryId(), track, autoplay }))

/** Where the autoplay songs still to come start, or the queue's end. */
const autoplayStart = (model: Model): number => {
  const after = indexOf(model, model.currentEntryId) + 1
  const offset = model.queue.slice(after).findIndex(entry => entry.autoplay)
  return offset === -1 ? model.queue.length : after + offset
}

/** Only the active device may report playback, and only for the current entry. */
const isFromPlayer = (model: Model, context: Context, entryId: string) =>
  model.activeDeviceId === context.senderId && model.currentEntryId === entryId

/**
 * A reconnecting player's report wins when it is still the player, its entry
 * is still queued, and no other device jumped the session (a seek, a skip, a
 * transfer) since it last followed it. Its own jumps don't count: the server
 * may have applied them and lost the answer when the connection dropped.
 */
const isFollowedReport = (
  model: Model,
  context: Context,
  report: Session.PlayerReport,
) =>
  model.activeDeviceId === context.senderId &&
  report.seekSeq >= model.foreignSeekSeq &&
  report.seekSeq <= model.seekSeq &&
  indexOf(model, report.entryId) !== -1

/** Move past the current entry after it ended or failed on the player. */
const finishCurrent = (model: Model, now: number): Model => {
  const maybeNext = entryAt(model, indexOf(model, model.currentEntryId) + 1)
  return maybeNext === null
    ? { ...jumpTo(model, model.currentEntryId, 0, now), playing: false }
    : jumpTo(model, maybeNext, 0, now)
}

/**
 * Jumps a player makes on its own before telling the server, so they are
 * already where it plays. Any other jump (a new queue, a removed or failed
 * song, a transfer, another device's command) the player only learns from
 * the server.
 */
const PLAYER_OWN_JUMPS: ReadonlySet<Session.ClientMessage['_tag']> = new Set([
  'Hello',
  'Seek',
  'Next',
  'Previous',
  'SkipTo',
  'TrackEnded',
])

/** Anyone playing, pausing, or taking over ends a pause for a lost player. */
const forgetLostPlayerPause = (
  model: Model,
  message: SessionMessage,
  outcome: Outcome,
): Outcome =>
  outcome.model.pausedForLostPlayer &&
  (message._tag === 'Pause' ||
    message._tag === 'Resume' ||
    outcome.model.playing !== model.playing ||
    outcome.model.activeDeviceId !== model.activeDeviceId)
    ? { ...outcome, model: { ...outcome.model, pausedForLostPlayer: false } }
    : outcome

/** Apply a message, and remember a jump the player did not make itself. */
export const update = (
  model: Model,
  message: SessionMessage,
  context: Context,
): Outcome => {
  const outcome = forgetLostPlayerPause(
    model,
    message,
    transition(model, message, context),
  )
  const isForeignJump =
    outcome.model.seekSeq !== model.seekSeq &&
    !(
      PLAYER_OWN_JUMPS.has(message._tag) &&
      outcome.model.activeDeviceId === context.senderId
    )
  return isForeignJump
    ? {
        ...outcome,
        model: { ...outcome.model, foreignSeekSeq: outcome.model.seekSeq },
      }
    : outcome
}

const transition = (
  model: Model,
  message: SessionMessage,
  context: Context,
): Outcome => {
  const { now } = context
  return Match.value(message).pipe(
    Match.withReturnType<Outcome>(),
    Match.tagsExhaustive({
      Hello: message => {
        const waking = model.waking.filter(id => id !== context.senderId)
        const maybeReport = Option.filter(
          Option.fromNullishOr(message.player),
          report => isFollowedReport(model, context, report),
        )
        if (Option.isSome(maybeReport)) {
          // The player kept going while it was away: the session follows it.
          const report = maybeReport.value
          return changed({
            ...model,
            waking,
            currentEntryId: report.entryId,
            // NOTE: a play or pause the player made wins. Otherwise the
            // player only followed the session, and a pause or resume it
            // missed (from another device) stands, unless the server made
            // it only because the player was gone.
            playing:
              report.playingSetHere || model.pausedForLostPlayer
                ? report.playing
                : model.playing,
            positionSeconds: Math.max(0, report.positionSeconds),
            positionAt: now,
            pausedForLostPlayer: false,
          })
        }
        const isPlayer = model.activeDeviceId === context.senderId
        // NOTE: a player whose report is not followed (the session jumped
        // without it) still keeps a play or pause it made itself.
        const maybeOwnPlaying = Option.flatMap(
          Option.fromNullishOr(message.player),
          report =>
            isPlayer && (report.playingSetHere || model.pausedForLostPlayer)
              ? Option.some(report.playing)
              : Option.none(),
        )
        const reloaded: Model = {
          ...model,
          waking,
          pausedForLostPlayer: isPlayer ? false : model.pausedForLostPlayer,
          // A device that comes back as the player reloads where it left off.
          // NOTE: a TV that was only woken (`Wake`, or a transfer that moved
          // on before it opened) is not the player; jumping would make the
          // device that plays reload for nothing.
          seekSeq: isPlayer ? model.seekSeq + 1 : model.seekSeq,
          ...(isPlayer
            ? { positionSeconds: currentPosition(model, now), positionAt: now }
            : {}),
        }
        return changed(
          Option.match(maybeOwnPlaying, {
            onNone: () => reloaded,
            onSome: playing => ({ ...reloaded, playing }),
          }),
        )
      },

      PlayQueue: message => {
        const queue = toEntries(message.tracks, context.makeEntryId)
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
        const entries = toEntries(message.tracks, context.makeEntryId)
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
        // NOTE: songs someone queues go before the autoplay songs.
        const insertAt =
          message.placement === 'Next'
            ? indexOf(model, model.currentEntryId) + 1
            : autoplayStart(model)
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
          // Resuming while already playing must not move the position back.
          ...settle(claimed, now),
          playing: true,
          // A new player has nothing loaded yet.
          seekSeq:
            claimed.activeDeviceId === model.activeDeviceId
              ? claimed.seekSeq
              : claimed.seekSeq + 1,
        })
      },

      Pause: message => {
        const settled = settle(model, now)
        const maybeAt = Option.filter(
          Option.fromNullishOr(message.at),
          at =>
            model.activeDeviceId === context.senderId &&
            at.entryId === model.currentEntryId &&
            at.seekSeq >= model.foreignSeekSeq,
        )
        return changed({
          ...settled,
          positionSeconds: Option.match(maybeAt, {
            onNone: () => settled.positionSeconds,
            onSome: at => Math.max(0, at.positionSeconds),
          }),
          playing: false,
        })
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

      SetAutoplay: message => {
        if (message.enabled === model.autoplay) return quiet(model)
        if (message.enabled) return changed({ ...model, autoplay: true })
        // The songs autoplay added that have not played yet go too.
        const after = indexOf(model, model.currentEntryId) + 1
        return changed({
          ...model,
          autoplay: false,
          queue: model.queue.filter(
            (entry, index) => index < after || !entry.autoplay,
          ),
        })
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

      Wake: message => {
        const target = message.deviceId
        if (context.isOnline(target) || model.waking.includes(target)) {
          return quiet(model)
        }
        if (!context.isWakeable(target)) {
          return notice(model, "That device can't be turned on from here.")
        }
        return {
          ...changed({ ...model, waking: Array.union(model.waking, [target]) }),
          maybeWake: Option.some(target),
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
    ? changed({
        ...settle(model, now),
        playing: false,
        pausedForLostPlayer: true,
      })
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
      "The TV didn't open Joshify. Is it on the same network?",
    ),
  }
}

/** Songs after the current one that are downloaded whole ahead of time. */
export const DOWNLOAD_AHEAD = 5
/** Songs after those whose links are found ahead, so they start in about a second. */
export const RESOLVE_AHEAD = 5
/** With autoplay on and this few songs left after the current one, add more. */
export const AUTOPLAY_THRESHOLD = 2

export interface Lookahead {
  /** The current song and the next `DOWNLOAD_AHEAD`. */
  readonly download: ReadonlyArray<string>
  /** The `RESOLVE_AHEAD` songs after those. */
  readonly resolve: ReadonlyArray<string>
  /** The last queued song, when autoplay should add songs after it. */
  readonly maybeAutoplayAfter: Option.Option<string>
}

/** What to get ready ahead of time. Nothing once the queue has finished. */
export const lookahead = (model: Model): Lookahead => {
  const index = indexOf(model, model.currentEntryId)
  if (index < 0) {
    return { download: [], resolve: [], maybeAutoplayAfter: Option.none() }
  }
  const videoIds = model.queue.map(entry => entry.track.videoId)
  const remaining = videoIds.length - index - 1
  return {
    download: videoIds.slice(index, index + 1 + DOWNLOAD_AHEAD),
    resolve: videoIds.slice(
      index + 1 + DOWNLOAD_AHEAD,
      index + 1 + DOWNLOAD_AHEAD + RESOLVE_AHEAD,
    ),
    maybeAutoplayAfter:
      model.autoplay && remaining <= AUTOPLAY_THRESHOLD
        ? Option.fromNullishOr(videoIds.at(-1))
        : Option.none(),
  }
}

/** The songs among `videoIds` that are queued without a length. */
export const missingDurations = (
  model: Model,
  videoIds: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  videoIds.filter(videoId =>
    model.queue.some(
      entry =>
        entry.track.videoId === videoId && entry.track.durationSeconds === null,
    ),
  )

/**
 * Fill in a song's length where the queue has none. Without it players can
 * show no progress and the seek bar has no end. Players do not reload: the
 * current entry and `seekSeq` stay as they are.
 */
export const fillDuration = (
  model: Model,
  videoId: string,
  durationSeconds: number,
): Outcome => {
  if (missingDurations(model, [videoId]).length === 0) {
    return unchanged(model)
  }
  return changed({
    ...model,
    queue: model.queue.map(entry =>
      entry.track.videoId === videoId && entry.track.durationSeconds === null
        ? { ...entry, track: { ...entry.track, durationSeconds } }
        : entry,
    ),
  })
}

/** Similar songs autoplay adds at a time. */
export const AUTOPLAY_BATCH = 10

/**
 * Add similar songs to the end of the queue as it runs out. `afterVideoId` is
 * the last queued song they were found for; if the queue changed since, they
 * no longer fit and are dropped. Songs already queued are skipped, so the
 * radio does not loop back. Players do not reload.
 */
export const appendAutoplay = (
  model: Model,
  afterVideoId: string,
  tracks: ReadonlyArray<Session.QueueTrack>,
  makeEntryId: () => string,
): Outcome => {
  if (
    !model.autoplay ||
    model.currentEntryId === null ||
    model.queue.at(-1)?.track.videoId !== afterVideoId
  ) {
    return unchanged(model)
  }
  const queued = new Set(model.queue.map(entry => entry.track.videoId))
  const fresh = tracks
    .filter(track => {
      if (queued.has(track.videoId)) return false
      queued.add(track.videoId)
      return true
    })
    .slice(0, AUTOPLAY_BATCH)
  return fresh.length === 0
    ? unchanged(model)
    : changed({
        ...model,
        queue: [...model.queue, ...toEntries(fresh, makeEntryId, true)],
      })
}
