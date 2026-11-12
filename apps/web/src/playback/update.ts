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

/**
 * Load `entry` into the phone's audio element, following `state` for
 * whether it plays. `seekSeq` is the session jump this load follows.
 */
const loadEntry = (
  model: Model,
  state: Session.SessionState,
  entry: Session.QueueEntry,
  seekSeq: number,
  startSeconds: number,
): PlaybackReturn => ({
  model: modifyFields(model, {
    phoneAudio: () =>
      PhoneAudio.Loaded({
        entry: {
          entryId: entry.entryId,
          seekSeq,
          isPlaying: state.playing,
          isBuffering: state.playing,
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
 */
const moveHere = (
  model: Model,
  { snapshot, loaded }: PlayingHere,
  entry: Session.QueueEntry,
  message: Session.ClientMessage,
): PlaybackReturn => {
  const state = modifyFields(snapshot.state, {
    currentEntryId: () => entry.entryId,
    positionSeconds: () => 0,
    positionAt: () => model.now + snapshot.clockOffsetMs,
  })
  const moved = loadEntry(
    modifyFields(model, {
      maybeSession: () => Option.some({ ...snapshot, state }),
      maybeScrubSeconds: () => Option.none(),
    }),
    state,
    entry,
    loaded.seekSeq,
    0,
  )
  return {
    model: moved.model,
    commands: [...(moved.commands ?? []), send(message)],
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
        onNone: () => loadEntry(model, state, entry, state.seekSeq, target),
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
          seekSeq: loaded.seekSeq,
        }),
      })
    : null

export const acquireSessionSocket = (model: Model): PlaybackReturn =>
  Option.match(model.maybeIdentity, {
    onNone: () => ({ model }),
    onSome: ({ deviceId, deviceName }) => ({
      model: modifyFields(model, { connection: () => Connection.Connected() }),
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

export const receiveSessionState = (
  model: Model,
  state: Session.SessionState,
  serverNow: number,
  receivedAt: number,
): PlaybackReturn =>
  reconcilePhoneAudio(
    modifyFields(model, {
      maybeSession: () =>
        Option.some({ state, clockOffsetMs: serverNow - receivedAt }),
      now: () => receivedAt,
    }),
  )

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
    onNone: () => ({
      model,
      commands: [send({ _tag: 'TrackEnded', entryId })],
    }),
    onSome: ({ here, next }) =>
      moveHere(model, here, next, { _tag: 'Advanced', fromEntryId: entryId }),
  })
}

export const failPhoneAudio = (
  model: Model,
  entryId: string,
  error: string,
): PlaybackReturn =>
  Option.isSome(loadedIfCurrent(model, entryId))
    ? {
        model,
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
          entry: { ...loaded, isPlaying: isNowPlaying },
        }),
      )
      return {
        model: followed,
        commands: isThisDevicePlaying(model)
          ? [send(isNowPlaying ? { _tag: 'Resume' } : { _tag: 'Pause' })]
          : [],
      }
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

/** Play or pause: on this phone at once when it plays, and on the server. */
const setPlaying = (model: Model, nextIsPlaying: boolean): PlaybackReturn => {
  const optimistic = withPlayingSession(model, nextIsPlaying)
  const message: Session.ClientMessage = nextIsPlaying
    ? { _tag: 'Resume' }
    : { _tag: 'Pause' }
  return Option.match(loadedEntry(model.phoneAudio), {
    onNone: () => ({
      model: optimistic,
      commands: [...unlockIfIdle(model), send(message)],
    }),
    onSome: entry => ({
      model: withPhoneAudio(
        optimistic,
        PhoneAudio.Loaded({
          entry: { ...entry, isPlaying: nextIsPlaying },
        }),
      ),
      commands: [
        SetPhoneAudioPlaying({ isPlaying: nextIsPlaying }),
        send(message),
      ],
    }),
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
        return {
          model: optimistic,
          commands: [
            ...(Option.isSome(loadedEntry(model.phoneAudio))
              ? [SeekPhoneAudio({ seconds: target })]
              : []),
            send({ _tag: 'Seek', positionSeconds: target }),
          ],
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
      if (
        model.phoneAudioSeconds > RESTART_THRESHOLD_SECONDS ||
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
