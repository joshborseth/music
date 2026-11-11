import { Array, Option } from 'effect'
import type { Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { Session, type Song } from '@music/shared'

import type { Message } from '../message'
import type { Model } from '../model'
import {
  LoadPhoneAudio,
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
  PROGRESS_INTERVAL_MS,
  PhoneAudio,
  PlayerSheet,
  currentEntry,
  loadedEntry,
  sessionPosition,
} from './domain'
import { toQueueTrack } from './queueTrack'
import type { PlaybackServices } from './resource'

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
      const isSameLoad = Option.exists(
        maybeLoaded,
        loaded =>
          loaded.entryId === entry.entryId && loaded.seekSeq === state.seekSeq,
      )
      const nextLoaded: LoadedEntry = {
        entryId: entry.entryId,
        seekSeq: state.seekSeq,
        isPlaying: state.playing,
      }

      if (isSameLoad) {
        const isAlreadyInStep = Option.exists(
          maybeLoaded,
          loaded => loaded.isPlaying === state.playing,
        )
        return isAlreadyInStep
          ? { model }
          : {
              model: withPhoneAudio(
                model,
                PhoneAudio.Loaded({ entry: nextLoaded }),
              ),
              commands: [
                SetPhoneAudioPlaying({ isPlaying: state.playing }),
                updateMediaSession(entry, state.playing),
              ],
            }
      }

      const startSeconds = sessionPosition(snapshot, model.now)
      return {
        model: modifyFields(model, {
          phoneAudio: () => PhoneAudio.Loaded({ entry: nextLoaded }),
          phoneAudioSeconds: () => startSeconds,
        }),
        commands: [
          LoadPhoneAudio({
            src: Session.audioPath(entry.track.videoId),
            startSeconds,
            isPlaying: state.playing,
          }),
          updateMediaSession(entry, state.playing),
        ],
      }
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
          ? PhoneAudio.Blocked({ entry })
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

const togglePlayback = (model: Model): PlaybackReturn =>
  isPlaying(model)
    ? { model, commands: [send({ _tag: 'Pause' })] }
    : { model, commands: [...unlockIfIdle(model), send({ _tag: 'Resume' })] }

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
