import { Array, Option } from 'effect'
import type { Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { Session, type Song } from '@music/shared'

import { LockScroll, UnlockScroll } from '../command'
import type { Message } from '../message'
import type { Model } from '../model'
import {
  LoadPhoneAudio,
  PrefetchSongs,
  SeekPhoneAudio,
  SendLocalChange,
  SendToSession,
  SetPhoneAudioPlaying,
  StopPhoneAudio,
  UnlockPhoneAudio,
  UpdateMediaSession,
  WaitBeforeHideNotice,
  WaitBeforeReconnect,
} from './command'
import {
  Connection,
  type LoadedEntry,
  type MediaKey,
  PREFETCH_COUNT,
  PROGRESS_INTERVAL_MS,
  PhoneAudio,
  PlayerSheet,
  RESTART_THRESHOLD_SECONDS,
  SEEK_TOLERANCE_SECONDS,
  type SessionSnapshot,
  currentEntry,
  loadedEntry,
  sessionPosition,
  upcomingEntries,
} from './domain'
import { displayedPosition, playbackPosition } from './position'
import { toQueueTrack } from './queueTrack'
import type { PlaybackServices } from './resource'
import {
  Swipe,
  SwipeAction,
  type SwipeTarget,
  type TrackingSwipe,
  moveSwipe,
  releasedSwipeAction,
  startSwipe,
} from './swipe'

type PlaybackReturn = Update.Return<Model, Message, PlaybackServices>

const send = (message: Session.ClientMessage) => SendToSession({ message })

/**
 * Send a change this phone already made as the player. The model counts it
 * until its message is on the socket (see `LocalChanges`).
 */
const sendLocalChange = (
  model: Model,
  message: Session.ClientMessage,
): {
  readonly model: Model
  readonly command: ReturnType<typeof SendLocalChange>
} => ({
  model: modifyFields(model, {
    localChanges: changes =>
      modifyFields(changes, { unsent: unsent => unsent + 1 }),
  }),
  command: SendLocalChange({ message }),
})

const showNotice = (model: Model, message: string): PlaybackReturn => ({
  model: modifyFields(model, { maybeNotice: () => Option.some(message) }),
  commands: [WaitBeforeHideNotice({ message })],
})

const isPlaying = (model: Model): boolean =>
  Option.exists(model.maybeSession, ({ state }) => state.playing)

const myDeviceId = (model: Model): Option.Option<string> =>
  Option.map(model.maybeIdentity, ({ deviceId }) => deviceId)

const isThisDevicePlaying = (model: Model): boolean =>
  Option.exists(model.maybeSession, ({ state }) =>
    Option.contains(myDeviceId(model), state.activeDeviceId ?? ''),
  )

const withPhoneAudio = (model: Model, phoneAudio: PhoneAudio): Model =>
  modifyFields(model, { phoneAudio: () => phoneAudio })

/** Keep the lock screen in step with the current song. */
const updateMediaSession = (entry: Session.QueueEntry) =>
  UpdateMediaSession({
    title: entry.track.title,
    artist: entry.track.artists,
    album: entry.track.album ?? '',
    maybeArtworkUrl: Option.fromNullishOr(entry.track.artworkUrl),
  })

/** Keep the current song and the next ones cached on the phone. */
const prefetchFrom = (state: Session.SessionState, entry: Session.QueueEntry) =>
  PrefetchSongs({
    videoIds: [
      entry.track.videoId,
      ...Array.map(
        Array.take(upcomingEntries(state), PREFETCH_COUNT),
        upcoming => upcoming.track.videoId,
      ),
    ],
  })

/** How a load relates to the session. */
interface LoadContext {
  /** The session jump this load follows. */
  readonly seekSeq: number
  readonly startSeconds: number
  readonly isPlayingSetHere: boolean
}

/** Load `entry` into the phone's audio element, playing as `state` does. */
const loadEntry = (
  model: Model,
  state: Session.SessionState,
  entry: Session.QueueEntry,
  { seekSeq, startSeconds, isPlayingSetHere }: LoadContext,
): PlaybackReturn => ({
  model: modifyFields(model, {
    phoneAudio: () =>
      PhoneAudio.Loaded({
        entry: {
          entryId: entry.entryId,
          seekSeq,
          isPlaying: state.playing,
          isBuffering: state.playing,
          isPlayingSetHere,
        },
      }),
    phoneAudioSeconds: () => startSeconds,
  }),
  commands: [
    LoadPhoneAudio({
      entryId: entry.entryId,
      videoId: entry.track.videoId,
      startSeconds,
      isPlaying: state.playing,
    }),
    updateMediaSession(entry),
    prefetchFrom(state, entry),
  ],
})

/** This phone is the player and has the session's current entry loaded. */
interface PlayingHere {
  readonly snapshot: SessionSnapshot
  readonly loaded: LoadedEntry
  readonly index: number
}

const playingHere = (model: Model): Option.Option<PlayingHere> =>
  Option.flatMap(model.maybeSession, snapshot =>
    isThisDevicePlaying(model)
      ? Option.flatMap(
          Option.filter(
            loadedEntry(model.phoneAudio),
            loaded => loaded.entryId === snapshot.state.currentEntryId,
          ),
          loaded =>
            Option.map(
              Array.findFirstIndex(
                snapshot.state.queue,
                queued => queued.entryId === loaded.entryId,
              ),
              index => ({ snapshot, loaded, index }),
            ),
        )
      : Option.none(),
  )

/**
 * Start another entry on this phone at once, before the server hears of it.
 * A locked phone may not get the server's answer quickly, or at all, and iOS
 * stops a page that goes quiet in the background. The phone's `seekSeq`
 * stays put: if the server never hears of this, the next `Hello` reports it.
 * `isPlaying` is whether the message starts playback (SkipTo does).
 */
const moveHere = (
  model: Model,
  { snapshot, loaded }: PlayingHere,
  entry: Session.QueueEntry,
  message: Session.ClientMessage,
  isPlaying: boolean = snapshot.state.playing,
): PlaybackReturn => {
  const state = modifyFields(snapshot.state, {
    currentEntryId: () => entry.entryId,
    playing: () => isPlaying,
    positionSeconds: () => 0,
    positionAt: () => model.now + snapshot.clockOffsetMs,
  })
  const sent = sendLocalChange(model, message)
  const moved = loadEntry(
    modifyFields(sent.model, {
      maybeSession: () => Option.some({ ...snapshot, state }),
      maybeScrubSeconds: () => Option.none(),
    }),
    state,
    entry,
    {
      seekSeq: loaded.seekSeq,
      startSeconds: 0,
      isPlayingSetHere:
        loaded.isPlayingSetHere || isPlaying !== snapshot.state.playing,
    },
  )
  return {
    model: moved.model,
    commands: [...(moved.commands ?? []), sent.command],
  }
}

/**
 * Make the phone's audio element match the session: load the current entry
 * when the server names this phone as the player, stop it when it does not.
 */
const reconcilePhoneAudio = (model: Model): PlaybackReturn => {
  if (model.phoneAudio._tag === 'Unavailable') {
    return { model }
  }
  const maybeLoaded = loadedEntry(model.phoneAudio)
  const maybeTarget = Option.flatMap(model.maybeSession, snapshot =>
    isThisDevicePlaying(model)
      ? Option.map(currentEntry(snapshot.state), entry => ({ snapshot, entry }))
      : Option.none(),
  )

  return Option.match(maybeTarget, {
    onNone: () =>
      Option.isSome(maybeLoaded)
        ? {
            model: withPhoneAudio(model, PhoneAudio.Idle()),
            commands: [StopPhoneAudio()],
          }
        : { model },
    onSome: ({ snapshot, entry }) => {
      const { state } = snapshot
      const target = sessionPosition(snapshot, model.now)
      const prefetch = prefetchFrom(state, entry)
      const maybeSameEntry = Option.filter(
        maybeLoaded,
        loaded => loaded.entryId === entry.entryId,
      )

      return Option.match(maybeSameEntry, {
        onNone: () =>
          loadEntry(model, state, entry, {
            seekSeq: state.seekSeq,
            startSeconds: target,
            isPlayingSetHere: false,
          }),
        onSome: loaded => {
          const isNewSeek = loaded.seekSeq !== state.seekSeq
          const isPlayingChanged = loaded.isPlaying !== state.playing
          if (!isNewSeek && !isPlayingChanged) {
            // The queue may have changed: keep the next songs cached.
            return { model, commands: [prefetch] }
          }
          const needsJump =
            isNewSeek &&
            Math.abs(model.phoneAudioSeconds - target) > SEEK_TOLERANCE_SECONDS
          return {
            model: modifyFields(model, {
              phoneAudio: () =>
                PhoneAudio.Loaded({
                  entry: {
                    ...loaded,
                    seekSeq: state.seekSeq,
                    isPlaying: state.playing,
                  },
                }),
              phoneAudioSeconds: seconds => (needsJump ? target : seconds),
            }),
            commands: [
              ...(needsJump ? [SeekPhoneAudio({ seconds: target })] : []),
              ...(isPlayingChanged
                ? [SetPhoneAudioPlaying({ isPlaying: state.playing })]
                : []),
              prefetch,
            ],
          }
        },
      })
    },
  })
}

// SESSION

export const completeLoadDeviceIdentity = (
  model: Model,
  deviceId: string,
  deviceName: string,
): PlaybackReturn => ({
  model: modifyFields(model, {
    maybeIdentity: () => Option.some({ deviceId, deviceName }),
    connection: () => Connection.Connecting(),
  }),
})

/**
 * What this phone is playing, for the server to follow when it reconnects.
 * While the connection was down (a locked screen, a Wi-Fi blip) the phone
 * kept playing, and may have paused, sought, or moved on.
 */
const playerReport = (model: Model): Session.PlayerReport | null =>
  isThisDevicePlaying(model)
    ? Option.match(loadedEntry(model.phoneAudio), {
        onNone: () => null,
        onSome: loaded => ({
          entryId: loaded.entryId,
          positionSeconds: model.phoneAudioSeconds,
          playing: model.phoneAudio._tag === 'Loaded' && loaded.isPlaying,
          playingSetHere: loaded.isPlayingSetHere,
          seekSeq: loaded.seekSeq,
        }),
      })
    : null

export const acquireSessionSocket = (model: Model): PlaybackReturn =>
  Option.match(model.maybeIdentity, {
    onNone: () => ({ model }),
    onSome: ({ deviceId, deviceName }) => ({
      model: modifyFields(model, {
        connection: () => Connection.Connected(),
        // NOTE: a new connection counts its messages from 1 again. What the
        // phone changed while it was away goes in the Hello's report.
        localChanges: changes => modifyFields(changes, { untilAck: () => 0 }),
      }),
      commands: [
        send({
          _tag: 'Hello',
          deviceId,
          name: deviceName,
          kind: 'Web',
          player: playerReport(model),
        }),
      ],
    }),
  })

export const loseSessionSocket = (model: Model): PlaybackReturn => ({
  model: modifyFields(model, { connection: () => Connection.Disconnected() }),
  commands: [WaitBeforeReconnect()],
})

export const completeWaitBeforeReconnect = (model: Model): PlaybackReturn =>
  model.connection._tag === 'Disconnected'
    ? {
        model: modifyFields(model, {
          connection: () => Connection.Connecting(),
        }),
      }
    : { model }

/**
 * Keep what this phone changed by itself while a server state predates it.
 * A state whose `ack` does not include every message carrying such a change
 * was sent before the server heard of it, so the phone keeps its own song,
 * position, and play or pause over it. The queue and devices are always
 * news, and a state that names another player is always followed.
 */
const keepLocalChanges = (
  model: Model,
  state: Session.SessionState,
  serverNow: number,
  ack: number,
): { readonly state: Session.SessionState; readonly phoneAudio: PhoneAudio } =>
  Option.match(loadedEntry(model.phoneAudio), {
    onNone: () => ({ state, phoneAudio: model.phoneAudio }),
    onSome: loaded => {
      const isServerBehind =
        model.localChanges.unsent > 0 || ack < model.localChanges.untilAck
      const isKept =
        isServerBehind &&
        Option.contains(myDeviceId(model), state.activeDeviceId ?? '') &&
        Array.some(state.queue, queued => queued.entryId === loaded.entryId)
      return isKept
        ? {
            state: modifyFields(state, {
              currentEntryId: () => loaded.entryId,
              playing: () => isPlaying(model),
              positionSeconds: () => model.phoneAudioSeconds,
              positionAt: () => serverNow,
            }),
            phoneAudio: model.phoneAudio,
          }
        : {
            state,
            phoneAudio: isServerBehind
              ? model.phoneAudio
              : withLoadedEntry(model.phoneAudio, entry => ({
                  ...entry,
                  isPlayingSetHere: false,
                })),
          }
    },
  })

/** A local change's message went out, or could not (no connection). */
export const completeSendLocalChange = (
  model: Model,
  maybeSeq: Option.Option<number>,
): PlaybackReturn => ({
  model: modifyFields(model, {
    localChanges: ({ unsent, untilAck }) => ({
      unsent: Math.max(0, unsent - 1),
      untilAck: Option.match(maybeSeq, {
        onNone: () => untilAck,
        onSome: seq => Math.max(untilAck, seq),
      }),
    }),
  }),
})

/** Change the loaded entry, whether it plays or the browser blocked it. */
const withLoadedEntry = (
  phoneAudio: PhoneAudio,
  change: (entry: LoadedEntry) => LoadedEntry,
): PhoneAudio =>
  PhoneAudio.match(phoneAudio, {
    Unavailable: () => phoneAudio,
    Idle: () => phoneAudio,
    Loaded: ({ entry }) => PhoneAudio.Loaded({ entry: change(entry) }),
    Blocked: ({ entry }) => PhoneAudio.Blocked({ entry: change(entry) }),
  })

export const receiveSessionState = (
  model: Model,
  state: Session.SessionState,
  serverNow: number,
  ack: number,
  receivedAt: number,
): PlaybackReturn => {
  const kept = keepLocalChanges(model, state, serverNow, ack)
  return reconcilePhoneAudio(
    modifyFields(model, {
      maybeSession: () =>
        Option.some({
          state: kept.state,
          clockOffsetMs: serverNow - receivedAt,
        }),
      phoneAudio: () => kept.phoneAudio,
      now: () => receivedAt,
    }),
  )
}

export const receiveNotice = showNotice

export const completeWaitBeforeHideNotice = (
  model: Model,
  message: string,
): PlaybackReturn =>
  Option.contains(model.maybeNotice, message)
    ? { model: modifyFields(model, { maybeNotice: () => Option.none() }) }
    : { model }

// PHONE AUDIO

export const acquirePhoneAudio = (model: Model): PlaybackReturn =>
  reconcilePhoneAudio(withPhoneAudio(model, PhoneAudio.Idle()))

export const releasePhoneAudio = (model: Model): PlaybackReturn => ({
  model: withPhoneAudio(model, PhoneAudio.Unavailable()),
})

/** The loaded entry, when an audio event or result is about it. */
const loadedIfCurrent = (
  model: Model,
  entryId: string,
): Option.Option<LoadedEntry> =>
  Option.filter(
    loadedEntry(model.phoneAudio),
    loaded => loaded.entryId === entryId,
  )

/** A song finished loading: record whether the browser wanted a tap first. */
export const completeLoadPhoneAudio = (
  model: Model,
  entryId: string,
  isBlocked: boolean,
): PlaybackReturn =>
  Option.isSome(loadedIfCurrent(model, entryId))
    ? completeStartPhoneAudio(model, isBlocked)
    : { model }

/** Record whether the browser refused to start audio without a tap. */
export const completeStartPhoneAudio = (
  model: Model,
  isBlocked: boolean,
): PlaybackReturn =>
  Option.match(loadedEntry(model.phoneAudio), {
    onNone: () => ({ model }),
    onSome: entry => ({
      model: withPhoneAudio(
        model,
        isBlocked
          ? PhoneAudio.Blocked({ entry: { ...entry, isBuffering: false } })
          : PhoneAudio.Loaded({ entry }),
      ),
    }),
  })

export const updatePhoneAudioTime = (
  model: Model,
  entryId: string,
  seconds: number,
  at: number,
): PlaybackReturn => {
  if (Option.isNone(loadedIfCurrent(model, entryId))) {
    return { model }
  }
  const nextModel = modifyFields(model, {
    phoneAudioSeconds: () => seconds,
    now: () => at,
  })
  const isDueForProgress = at - model.lastProgressAt >= PROGRESS_INTERVAL_MS
  return Option.match(loadedEntry(model.phoneAudio), {
    onNone: () => ({ model: nextModel }),
    onSome: entry =>
      isDueForProgress && isThisDevicePlaying(model)
        ? {
            model: modifyFields(nextModel, { lastProgressAt: () => at }),
            commands: [
              send({
                _tag: 'Progress',
                entryId: entry.entryId,
                positionSeconds: seconds,
                playing: isPlaying(model),
              }),
            ],
          }
        : { model: nextModel },
  })
}

/**
 * The song ended: start the next one right away and tell the server it
 * already did. Waiting for the server's answer leaves a locked phone silent,
 * and iOS soon stops a page that plays nothing.
 */
export const endPhoneAudio = (
  model: Model,
  entryId: string,
): PlaybackReturn => {
  if (Option.isNone(loadedIfCurrent(model, entryId))) {
    return { model }
  }
  const maybeNext = Option.flatMap(playingHere(model), here =>
    Option.map(Array.get(here.snapshot.state.queue, here.index + 1), next => ({
      here,
      next,
    })),
  )
  return Option.match(maybeNext, {
    onNone: () => stopAtQueueEnd(model, entryId),
    onSome: ({ here, next }) =>
      moveHere(model, here, next, { _tag: 'Advanced', fromEntryId: entryId }),
  })
}

/**
 * The last song ended: stop at its start, paused, like the server will. A
 * phone that reconnects later then reports it stopped, not still playing.
 */
const stopAtQueueEnd = (model: Model, entryId: string): PlaybackReturn => {
  const sent = sendLocalChange(model, { _tag: 'TrackEnded', entryId })
  return {
    model: modifyFields(
      withOptimisticSession(sent.model, (state, snapshot) =>
        modifyFields(state, {
          playing: () => false,
          positionSeconds: () => 0,
          positionAt: () => model.now + snapshot.clockOffsetMs,
        }),
      ),
      {
        phoneAudio: phoneAudio =>
          withLoadedEntry(phoneAudio, entry => ({
            ...entry,
            isPlaying: false,
            isBuffering: false,
            isPlayingSetHere: true,
          })),
        phoneAudioSeconds: () => 0,
      },
    ),
    commands: [
      SetPhoneAudioPlaying({ isPlaying: false }),
      SeekPhoneAudio({ seconds: 0 }),
      sent.command,
    ],
  }
}

/**
 * The song could not be played. The phone holds nothing playable now: the
 * server's answer loads what comes next, and if the answer is lost with the
 * connection, the phone reports nothing on reconnecting and is reloaded,
 * which tries the song again.
 */
export const failPhoneAudio = (
  model: Model,
  entryId: string,
  error: string,
): PlaybackReturn =>
  Option.isSome(loadedIfCurrent(model, entryId))
    ? {
        model: withPhoneAudio(model, PhoneAudio.Idle()),
        commands: [send({ _tag: 'TrackFailed', entryId, message: error })],
      }
    : { model }

/**
 * The system played or paused the song by itself: a call, Siri, unplugged
 * headphones, or another app's audio. The session follows, so the lock
 * screen's play button works afterwards and other devices show the truth.
 */
export const followPhoneAudio = (
  model: Model,
  entryId: string,
  isNowPlaying: boolean,
): PlaybackReturn =>
  Option.match(loadedIfCurrent(model, entryId), {
    onNone: () => ({ model }),
    onSome: loaded => {
      const followed = withPhoneAudio(
        withPlayingSession(model, isNowPlaying),
        PhoneAudio.Loaded({
          entry: { ...loaded, isPlaying: isNowPlaying, isPlayingSetHere: true },
        }),
      )
      if (!isThisDevicePlaying(model)) {
        return { model: followed }
      }
      const sent = sendLocalChange(
        followed,
        playingMessage(model, isNowPlaying),
      )
      return { model: sent.model, commands: [sent.command] }
    },
  })

// REMOTE CONTROL

/** Taps that might make this phone the player also unlock its audio. */
export const unlockIfIdle = (model: Model) =>
  Option.isSome(loadedEntry(model.phoneAudio)) ? [] : [UnlockPhoneAudio()]

/** Change the session locally before the server confirms, so taps feel instant. */
const withOptimisticSession = (
  model: Model,
  change: (
    state: Session.SessionState,
    snapshot: SessionSnapshot,
  ) => Session.SessionState,
): Model =>
  modifyFields(model, {
    maybeSession: Option.map(snapshot =>
      modifyFields(snapshot, { state: state => change(state, snapshot) }),
    ),
  })

/** The session playing or paused from where it is now, by this phone. */
const withPlayingSession = (model: Model, nextIsPlaying: boolean): Model =>
  withOptimisticSession(model, (state, snapshot) =>
    modifyFields(state, {
      playing: () => nextIsPlaying,
      positionSeconds: () => playbackPosition(model, snapshot),
      positionAt: () => model.now + snapshot.clockOffsetMs,
    }),
  )

/**
 * Resume or Pause. A pause from this phone while it plays says where the
 * song stopped, so the server and every device agree on the spot.
 */
const playingMessage = (
  model: Model,
  nextIsPlaying: boolean,
): Session.ClientMessage => {
  if (nextIsPlaying) {
    return { _tag: 'Resume' }
  }
  return Option.match(playingHere(model), {
    onNone: () => ({ _tag: 'Pause' }),
    onSome: () => ({ _tag: 'Pause', positionSeconds: model.phoneAudioSeconds }),
  })
}

/** Play or pause: on this phone at once when it plays, and on the server. */
const setPlaying = (model: Model, nextIsPlaying: boolean): PlaybackReturn => {
  const optimistic = withPlayingSession(model, nextIsPlaying)
  const message = playingMessage(model, nextIsPlaying)
  return Option.match(loadedEntry(model.phoneAudio), {
    onNone: () => ({
      model: optimistic,
      commands: [...unlockIfIdle(model), send(message)],
    }),
    onSome: entry => {
      const sent = sendLocalChange(optimistic, message)
      return {
        model: withPhoneAudio(
          sent.model,
          PhoneAudio.Loaded({
            entry: {
              ...entry,
              isPlaying: nextIsPlaying,
              isPlayingSetHere: true,
            },
          }),
        ),
        commands: [
          SetPhoneAudioPlaying({ isPlaying: nextIsPlaying }),
          sent.command,
        ],
      }
    },
  })
}

/** Jump to a position: locally right away, and on the server. */
export const seekTo = (model: Model, seconds: number): PlaybackReturn =>
  Option.match(
    Option.flatMap(model.maybeSession, ({ state }) => currentEntry(state)),
    {
      onNone: () => ({ model }),
      onSome: entry => {
        const duration = entry.track.durationSeconds ?? Number.POSITIVE_INFINITY
        const target = Math.min(Math.max(0, seconds), Math.max(0, duration - 1))
        const optimistic = modifyFields(
          withOptimisticSession(model, (state, snapshot) =>
            modifyFields(state, {
              positionSeconds: () => target,
              positionAt: () => model.now + snapshot.clockOffsetMs,
            }),
          ),
          {
            phoneAudioSeconds: () => target,
            maybeScrubSeconds: () => Option.none(),
          },
        )
        const seek: Session.ClientMessage = {
          _tag: 'Seek',
          positionSeconds: target,
        }
        if (Option.isNone(loadedEntry(model.phoneAudio))) {
          return { model: optimistic, commands: [send(seek)] }
        }
        const sent = sendLocalChange(optimistic, seek)
        return {
          model: sent.model,
          commands: [SeekPhoneAudio({ seconds: target }), sent.command],
        }
      },
    },
  )

export const skipBy = (model: Model, seconds: number): PlaybackReturn =>
  Option.match(model.maybeSession, {
    onNone: () => ({ model }),
    onSome: snapshot =>
      seekTo(model, displayedPosition(model, snapshot) + seconds),
  })

export const scrub = (model: Model, seconds: number): PlaybackReturn => ({
  model: modifyFields(model, { maybeScrubSeconds: () => Option.some(seconds) }),
})

/** A drag on the seek bar ended without a seek: show playback again. */
export const cancelScrub = (model: Model): PlaybackReturn => ({
  model: modifyFields(model, { maybeScrubSeconds: () => Option.none() }),
})

export const changePhoneAudioBuffering = (
  model: Model,
  entryId: string,
  isBuffering: boolean,
): PlaybackReturn =>
  PhoneAudio.match(model.phoneAudio, {
    Unavailable: () => ({ model }),
    Idle: () => ({ model }),
    Loaded: ({ entry }) =>
      entry.entryId === entryId
        ? {
            model: withPhoneAudio(
              model,
              PhoneAudio.Loaded({ entry: { ...entry, isBuffering } }),
            ),
          }
        : { model },
    Blocked: () => ({ model }),
  })

export const clickTogglePlayback = (model: Model): PlaybackReturn =>
  setPlaying(model, !isPlaying(model))

/** Next: on this phone at once when it plays, like the lock screen needs. */
export const skipToNext = (model: Model): PlaybackReturn =>
  Option.match(
    Option.flatMap(playingHere(model), here =>
      Option.map(
        Array.get(here.snapshot.state.queue, here.index + 1),
        next => ({ here, next }),
      ),
    ),
    {
      onNone: () => sendCommand(model, { _tag: 'Next' }),
      onSome: ({ here, next }) => moveHere(model, here, next, { _tag: 'Next' }),
    },
  )

/**
 * Previous restarts the song past its first few seconds, otherwise goes back
 * one, like the server does. On this phone at once when it plays.
 */
export const skipToPrevious = (model: Model): PlaybackReturn =>
  Option.match(playingHere(model), {
    onNone: () => sendCommand(model, { _tag: 'Previous' }),
    onSome: here => {
      const maybePrevious = Array.get(here.snapshot.state.queue, here.index - 1)
      // NOTE: paused, the session's position is exactly the server's, which
      // decides a Previous the phone sends; playing, the phone's own clock
      // is truer, and the phone names what it chose.
      const position = here.snapshot.state.playing
        ? model.phoneAudioSeconds
        : sessionPosition(here.snapshot, model.now)
      if (
        position > RESTART_THRESHOLD_SECONDS ||
        Option.isNone(maybePrevious)
      ) {
        return seekTo(model, 0)
      }
      const previous = maybePrevious.value
      // NOTE: SkipTo names the very entry, but it also starts playback, so
      // a paused session asks for Previous instead.
      return moveHere(
        model,
        here,
        previous,
        here.snapshot.state.playing
          ? { _tag: 'SkipTo', entryId: previous.entryId }
          : { _tag: 'Previous' },
      )
    },
  })

/** A tapped queue row plays: on this phone at once when it plays. */
export const clickQueueEntry = (
  model: Model,
  entryId: string,
): PlaybackReturn =>
  Option.match(
    Option.flatMap(playingHere(model), here =>
      Option.map(
        Array.findFirst(
          here.snapshot.state.queue,
          queued => queued.entryId === entryId,
        ),
        target => ({ here, target }),
      ),
    ),
    {
      onNone: () => sendCommand(model, { _tag: 'SkipTo', entryId }),
      onSome: ({ here, target }) =>
        moveHere(model, here, target, { _tag: 'SkipTo', entryId }, true),
    },
  )

export const pressMediaKey = (model: Model, key: MediaKey): PlaybackReturn => {
  if (key === 'Play') {
    return setPlaying(model, true)
  } else if (key === 'Pause') {
    return setPlaying(model, false)
  } else if (key === 'NextTrack') {
    return skipToNext(model)
  } else {
    return skipToPrevious(model)
  }
}

/** Replace the queue with `songs` and play from `startIndex`. */
export const playSongs = (
  model: Model,
  songs: ReadonlyArray<Song>,
  startIndex: number,
): PlaybackReturn =>
  Array.isReadonlyArrayNonEmpty(songs)
    ? {
        model,
        commands: [
          send({
            _tag: 'PlayQueue',
            tracks: Array.map(songs, toQueueTrack),
            startIndex,
          }),
        ],
      }
    : { model }

export const clickPlaySongs = (
  model: Model,
  songs: ReadonlyArray<Song>,
  startIndex: number,
): PlaybackReturn => {
  const play = playSongs(model, songs, startIndex)
  return {
    model: play.model,
    commands: [...unlockIfIdle(model), ...(play.commands ?? [])],
  }
}

export const clickEnqueueSongs = (
  model: Model,
  songs: ReadonlyArray<Song>,
  placement: Session.Placement,
): PlaybackReturn => {
  const enqueue = showNotice(
    model,
    placement === 'Next' ? 'Playing next' : 'Added to queue',
  )
  return {
    model: enqueue.model,
    commands: [
      ...unlockIfIdle(model),
      send({
        _tag: 'Enqueue',
        tracks: Array.map(songs, toQueueTrack),
        placement,
      }),
      ...(enqueue.commands ?? []),
    ],
  }
}

export const clickDevice = (
  model: Model,
  deviceId: string,
): PlaybackReturn => ({
  model,
  commands: [
    ...(Option.contains(myDeviceId(model), deviceId)
      ? unlockIfIdle(model)
      : []),
    send({ _tag: 'Transfer', deviceId }),
  ],
})

export const sendCommand = (
  model: Model,
  message: Session.ClientMessage,
): PlaybackReturn => ({ model, commands: [send(message)] })

/** The page underneath stays put while the player covers it. */
export const openPlayer = (model: Model): PlaybackReturn =>
  model.playerSheet._tag === 'Open'
    ? { model }
    : {
        model: modifyFields(model, { playerSheet: () => PlayerSheet.Open() }),
        commands: [LockScroll()],
      }

export const closePlayer = (model: Model): PlaybackReturn =>
  model.playerSheet._tag === 'Open'
    ? {
        model: modifyFields(model, { playerSheet: () => PlayerSheet.Closed() }),
        commands: [UnlockScroll()],
      }
    : { model }

export const startBlockedAudio = (model: Model): PlaybackReturn => ({
  model,
  commands: [SetPhoneAudioPlaying({ isPlaying: true })],
})

// SWIPE

const trackingPointer = (
  model: Model,
  pointerId: number,
): Option.Option<TrackingSwipe> =>
  model.swipe._tag === 'Tracking' && model.swipe.pointerId === pointerId
    ? Option.some(model.swipe)
    : Option.none()

const runSwipeAction = (model: Model, action: SwipeAction): PlaybackReturn =>
  SwipeAction.match(action, {
    Next: () => skipToNext(model),
    Previous: () => skipToPrevious(model),
    ClosePlayer: () => closePlayer(model),
    PlayNext: ({ song }) => clickEnqueueSongs(model, [song], 'Next'),
    AddToQueue: ({ song }) => clickEnqueueSongs(model, [song], 'Last'),
    RemoveEntry: ({ entryId }) =>
      sendCommand(model, { _tag: 'RemoveEntry', entryId }),
  })

export const pressSwipeable = (
  model: Model,
  target: SwipeTarget,
  pointerId: number,
  clientX: number,
  clientY: number,
  timeStamp: number,
): PlaybackReturn =>
  model.swipe._tag === 'Tracking'
    ? { model }
    : {
        model: modifyFields(model, {
          swipe: () =>
            startSwipe(target, pointerId, clientX, clientY, timeStamp),
        }),
      }

export const moveSwipePointer = (
  model: Model,
  pointerId: number,
  clientX: number,
  clientY: number,
  timeStamp: number,
): PlaybackReturn =>
  Option.match(trackingPointer(model, pointerId), {
    onNone: () => ({ model }),
    onSome: swipe => ({
      model: modifyFields(model, {
        swipe: () => moveSwipe(swipe, clientX, clientY, timeStamp),
      }),
    }),
  })

export const releaseSwipePointer = (
  model: Model,
  pointerId: number,
  timeStamp: number,
): PlaybackReturn =>
  Option.match(trackingPointer(model, pointerId), {
    onNone: () => ({ model }),
    onSome: swipe => {
      const idleModel = modifyFields(model, { swipe: () => Swipe.Idle() })
      return Option.match(releasedSwipeAction(swipe, timeStamp), {
        onNone: () => ({ model: idleModel }),
        onSome: action => runSwipeAction(idleModel, action),
      })
    },
  })

export const cancelSwipePointer = (
  model: Model,
  pointerId: number,
): PlaybackReturn =>
  Option.isSome(trackingPointer(model, pointerId))
    ? { model: modifyFields(model, { swipe: () => Swipe.Idle() }) }
    : { model }
