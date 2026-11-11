import { Array, Option } from 'effect'
import type { Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { Session, type Song } from '@music/shared'

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
  type MediaKey,
  PREFETCH_COUNT,
  PROGRESS_INTERVAL_MS,
  PhoneAudio,
  PlayerSheet,
  SEEK_TOLERANCE_SECONDS,
  type SessionSnapshot,
  currentEntry,
  loadedEntry,
  sessionPosition,
  upcomingEntries,
} from './domain'
import { displayedPosition } from './position'
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
const updateMediaSession = (
  entry: Session.QueueEntry,
  isEntryPlaying: boolean,
) =>
  UpdateMediaSession({
    title: entry.track.title,
    artist: entry.track.artists,
    album: entry.track.album ?? '',
    maybeArtworkUrl: Option.fromNullishOr(entry.track.artworkUrl),
    isPlaying: isEntryPlaying,
  })

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
      const prefetch = PrefetchSongs({
        videoIds: Array.map(
          Array.take(upcomingEntries(state), PREFETCH_COUNT),
          upcoming => upcoming.track.videoId,
        ),
      })
      const maybeSameEntry = Option.filter(
        maybeLoaded,
        loaded => loaded.entryId === entry.entryId,
      )

      return Option.match(maybeSameEntry, {
        onNone: () => ({
          model: modifyFields(model, {
            phoneAudio: () =>
              PhoneAudio.Loaded({
                entry: {
                  entryId: entry.entryId,
                  seekSeq: state.seekSeq,
                  isPlaying: state.playing,
                  isBuffering: state.playing,
                },
              }),
            phoneAudioSeconds: () => target,
          }),
          commands: [
            LoadPhoneAudio({
              videoId: entry.track.videoId,
              startSeconds: target,
              isPlaying: state.playing,
            }),
            updateMediaSession(entry, state.playing),
            prefetch,
          ],
        }),
        onSome: loaded => {
          const isNewSeek = loaded.seekSeq !== state.seekSeq
          const isPlayingChanged = loaded.isPlaying !== state.playing
          if (!isNewSeek && !isPlayingChanged) {
            return { model }
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
                ? [
                    SetPhoneAudioPlaying({ isPlaying: state.playing }),
                    updateMediaSession(entry, state.playing),
                  ]
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

export const acquireSessionSocket = (model: Model): PlaybackReturn =>
  Option.match(model.maybeIdentity, {
    onNone: () => ({ model }),
    onSome: ({ deviceId, deviceName }) => ({
      model: modifyFields(model, { connection: () => Connection.Connected() }),
      commands: [
        send({ _tag: 'Hello', deviceId, name: deviceName, kind: 'Web' }),
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
  seconds: number,
  at: number,
): PlaybackReturn => {
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

export const endPhoneAudio = (model: Model): PlaybackReturn =>
  Option.match(loadedEntry(model.phoneAudio), {
    onNone: () => ({ model }),
    onSome: ({ entryId }) => ({
      model,
      commands: [send({ _tag: 'TrackEnded', entryId })],
    }),
  })

export const failPhoneAudio = (model: Model, error: string): PlaybackReturn =>
  Option.match(loadedEntry(model.phoneAudio), {
    onNone: () => ({ model }),
    onSome: ({ entryId }) => ({
      model,
      commands: [send({ _tag: 'TrackFailed', entryId, message: error })],
    }),
  })

// REMOTE CONTROL

/** Taps that might make this phone the player also unlock its audio. */
const unlockIfIdle = (model: Model) =>
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

const togglePlayback = (model: Model): PlaybackReturn => {
  const nextIsPlaying = !isPlaying(model)
  const optimistic = withOptimisticSession(model, (state, snapshot) =>
    modifyFields(state, {
      playing: () => nextIsPlaying,
      positionSeconds: () => sessionPosition(snapshot, model.now),
      positionAt: () => model.now + snapshot.clockOffsetMs,
    }),
  )
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

export const changePhoneAudioBuffering = (
  model: Model,
  isBuffering: boolean,
): PlaybackReturn =>
  PhoneAudio.match(model.phoneAudio, {
    Unavailable: () => ({ model }),
    Idle: () => ({ model }),
    Loaded: ({ entry }) => ({
      model: withPhoneAudio(
        model,
        PhoneAudio.Loaded({ entry: { ...entry, isBuffering } }),
      ),
    }),
    Blocked: () => ({ model }),
  })

export const clickTogglePlayback = togglePlayback

export const pressMediaKey = (model: Model, key: MediaKey): PlaybackReturn => {
  if (key === 'Play') {
    return { model, commands: [send({ _tag: 'Resume' })] }
  } else if (key === 'Pause') {
    return { model, commands: [send({ _tag: 'Pause' })] }
  } else if (key === 'NextTrack') {
    return { model, commands: [send({ _tag: 'Next' })] }
  } else {
    return { model, commands: [send({ _tag: 'Previous' })] }
  }
}

export const clickPlaySongs = (
  model: Model,
  songs: ReadonlyArray<Song>,
  startIndex: number,
): PlaybackReturn =>
  Array.isReadonlyArrayNonEmpty(songs)
    ? {
        model,
        commands: [
          ...unlockIfIdle(model),
          send({
            _tag: 'PlayQueue',
            tracks: Array.map(songs, toQueueTrack),
            startIndex,
          }),
        ],
      }
    : { model }

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

export const openPlayer = (model: Model): PlaybackReturn => ({
  model: modifyFields(model, { playerSheet: () => PlayerSheet.Open() }),
})

export const closePlayer = (model: Model): PlaybackReturn => ({
  model: modifyFields(model, { playerSheet: () => PlayerSheet.Closed() }),
})

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
    Next: () => sendCommand(model, { _tag: 'Next' }),
    Previous: () => sendCommand(model, { _tag: 'Previous' }),
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
