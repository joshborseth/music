import { Clock, Data, Duration, Effect, Layer, Option, Schema } from 'effect'
import { SecureRandom } from 'effect/crypto'
import { KeyValueStore } from 'effect/persistence'
import { Command } from 'foldkit'

import { BrowserCrypto, BrowserKeyValueStore } from '@effect/platform-browser'
import { Session } from '@music/shared'

import { Message } from '../message'
import { DEVICE_ID_KEY, deviceNameFromUserAgent } from './domain'
import { followIntent, markEntry, pauseAudio, startAudio } from './element'
import { PhoneAudioElement, SessionSocket } from './resource'
import { cachedSong, prefetchSongs, recordPlay } from './songCache'

const RECONNECT_DELAY = Duration.seconds(2)
const NOTICE_DURATION = Duration.seconds(6)

/**
 * A very short silent WAV. Playing it from a tap lets iOS play this audio
 * element later without one, when the server makes this phone the player.
 */
const SILENT_AUDIO =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='

const encodeClientMessage = Schema.encodeSync(Session.ClientMessageJson)

// SESSION

export const LoadDeviceIdentity = Command.define('LoadDeviceIdentity', {
  messages: [Message.CompletedLoadDeviceIdentity],
  execute: Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore
    const maybeStored = Option.fromNullishOr(
      yield* store
        .get(DEVICE_ID_KEY)
        .pipe(Effect.orElseSucceed(() => undefined)),
    )
    const deviceId = yield* Option.match(maybeStored, {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.gen(function* () {
          const random = yield* SecureRandom.SecureRandom
          const generated = yield* random.uuidV4()
          yield* store.set(DEVICE_ID_KEY, generated).pipe(Effect.ignore)
          return generated
        }),
    })
    return Message.CompletedLoadDeviceIdentity({
      deviceId,
      deviceName: deviceNameFromUserAgent(globalThis.navigator.userAgent),
    })
  }).pipe(
    Effect.provide(
      Layer.merge(
        BrowserKeyValueStore.layerLocalStorage,
        BrowserCrypto.layerSecureRandom,
      ),
    ),
  ),
})

export const SendToSession = Command.define('SendToSession', {
  args: { message: Session.ClientMessage },
  messages: [Message.CompletedSendToSession],
  execute: ({ message }) =>
    SessionSocket.get.pipe(
      Effect.flatMap(socket =>
        Effect.try(() => socket.send(encodeClientMessage(message))),
      ),
      Effect.ignore,
      Effect.as(Message.CompletedSendToSession()),
    ),
})

export const WaitBeforeReconnect = Command.define('WaitBeforeReconnect', {
  messages: [Message.CompletedWaitBeforeReconnect],
  execute: Effect.sleep(RECONNECT_DELAY).pipe(
    Effect.as(Message.CompletedWaitBeforeReconnect()),
  ),
})

export const WaitBeforeHideNotice = Command.define('WaitBeforeHideNotice', {
  args: { message: Schema.String },
  messages: [Message.CompletedWaitBeforeHideNotice],
  execute: ({ message }) =>
    Effect.sleep(NOTICE_DURATION).pipe(
      Effect.as(Message.CompletedWaitBeforeHideNotice({ message })),
    ),
})

export const ReadClock = Command.define('ReadClock', {
  messages: [Message.TickedClock],
  execute: Clock.currentTimeMillis.pipe(
    Effect.map(now => Message.TickedClock({ now })),
  ),
})

// PHONE AUDIO

class AudioPlayError extends Data.TaggedError('AudioPlayError')<{
  readonly isNotAllowed: boolean
}> {}

/**
 * Start playback, reporting whether the browser wants a tap first. A refused
 * start leaves the element paused, and the app no longer means it to play.
 */
const play = (audio: HTMLAudioElement) =>
  Effect.tryPromise({
    try: () => startAudio(audio),
    catch: error => {
      followIntent(audio, !audio.paused)
      return new AudioPlayError({
        isNotAllowed:
          error instanceof DOMException && error.name === 'NotAllowedError',
      })
    },
  }).pipe(
    Effect.as(false),
    Effect.catchTag('AudioPlayError', ({ isNotAllowed }) =>
      Effect.succeed(isNotAllowed),
    ),
  )

export const UnlockPhoneAudio = Command.define('UnlockPhoneAudio', {
  messages: [Message.CompletedUnlockPhoneAudio],
  execute: PhoneAudioElement.get.pipe(
    Effect.flatMap(audio =>
      audio.src === '' || audio.src === SILENT_AUDIO
        ? Effect.gen(function* () {
            audio.src = SILENT_AUDIO
            // NOTE: not `startAudio`: this clip is no song, so it leaves
            // what the app means the element to do alone.
            yield* Effect.tryPromise(() => audio.play()).pipe(Effect.ignore)
            if (audio.src === SILENT_AUDIO) {
              audio.pause()
            }
          })
        : Effect.void,
    ),
    Effect.ignore,
    Effect.as(Message.CompletedUnlockPhoneAudio()),
  ),
})

/** The Blob URL each audio element plays, so it can be released later. */
const blobUrls = new WeakMap<HTMLAudioElement, string>()

const releaseBlobUrl = (audio: HTMLAudioElement) => {
  const url = blobUrls.get(audio)
  if (url !== undefined) {
    URL.revokeObjectURL(url)
    blobUrls.delete(audio)
  }
}

/** A seek waiting for the song's length to be known. */
const pendingSeeks = new WeakMap<HTMLAudioElement, () => void>()

const cancelPendingSeek = (audio: HTMLAudioElement) => {
  const pending = pendingSeeks.get(audio)
  if (pending !== undefined) {
    audio.removeEventListener('loadedmetadata', pending)
    pendingSeeks.delete(audio)
  }
}

/**
 * Jump to `seconds` now, or as soon as the song's length is known. A later
 * seek or load replaces one that is still waiting, so a quick skip never
 * lands the next song where the previous one was headed.
 */
const seekWhenReady = (audio: HTMLAudioElement, seconds: number) => {
  cancelPendingSeek(audio)
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    audio.currentTime = seconds
    return
  }
  const seek = () => {
    pendingSeeks.delete(audio)
    audio.currentTime = seconds
  }
  pendingSeeks.set(audio, seek)
  audio.addEventListener('loadedmetadata', seek, { once: true })
}

/**
 * Play a song from the phone's cache when it is there, so it starts and
 * seeks instantly. Otherwise stream it; `PrefetchSongs`, which always
 * comes with this, caches it for next time.
 */
export const LoadPhoneAudio = Command.define('LoadPhoneAudio', {
  args: {
    entryId: Schema.String,
    videoId: Schema.String,
    startSeconds: Schema.Number,
    isPlaying: Schema.Boolean,
  },
  messages: [Message.CompletedLoadPhoneAudio],
  execute: ({ entryId, videoId, startSeconds, isPlaying }) =>
    PhoneAudioElement.get.pipe(
      Effect.flatMap(audio =>
        Effect.gen(function* () {
          const maybeBlob = yield* cachedSong(videoId)
          cancelPendingSeek(audio)
          // NOTE: the song being replaced stops as the app's own pause, so
          // it never reads as the system pausing the new one.
          pauseAudio(audio)
          releaseBlobUrl(audio)
          markEntry(audio, Option.some(entryId))
          Option.match(maybeBlob, {
            onNone: () => {
              audio.src = Session.audioPath(videoId)
            },
            onSome: blob => {
              const url = URL.createObjectURL(blob)
              blobUrls.set(audio, url)
              audio.src = url
            },
          })
          if (startSeconds > 0) {
            seekWhenReady(audio, startSeconds)
          }
          if (!isPlaying) {
            pauseAudio(audio)
            return false
          }
          const isBlocked = yield* play(audio)
          yield* recordPlay(videoId)
          return isBlocked
        }),
      ),
      Effect.map(isBlocked =>
        Message.CompletedLoadPhoneAudio({ entryId, isBlocked }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          Message.CompletedLoadPhoneAudio({ entryId, isBlocked: false }),
        ),
      ),
    ),
})

/** Jump within the song already loaded, without loading it again. */
export const SeekPhoneAudio = Command.define('SeekPhoneAudio', {
  args: { seconds: Schema.Number },
  messages: [Message.CompletedSeekPhoneAudio],
  execute: ({ seconds }) =>
    PhoneAudioElement.get.pipe(
      Effect.flatMap(audio =>
        Effect.sync(() => seekWhenReady(audio, Math.max(0, seconds))),
      ),
      Effect.ignore,
      Effect.as(Message.CompletedSeekPhoneAudio()),
    ),
})

/**
 * Keep the current song and the ones that play next on the phone, in play
 * order, so they start without waiting.
 */
export const PrefetchSongs = Command.define('PrefetchSongs', {
  args: { videoIds: Schema.Array(Schema.String) },
  messages: [Message.CompletedPrefetchSongs],
  execute: ({ videoIds }) =>
    prefetchSongs(videoIds).pipe(Effect.as(Message.CompletedPrefetchSongs())),
})

export const SetPhoneAudioPlaying = Command.define('SetPhoneAudioPlaying', {
  args: { isPlaying: Schema.Boolean },
  messages: [Message.CompletedSetPhoneAudioPlaying],
  execute: ({ isPlaying }) =>
    PhoneAudioElement.get.pipe(
      Effect.flatMap(audio => {
        if (isPlaying) {
          return play(audio)
        }
        pauseAudio(audio)
        return Effect.succeed(false)
      }),
      Effect.map(isBlocked =>
        Message.CompletedSetPhoneAudioPlaying({ isBlocked }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
        ),
      ),
    ),
})

export const StopPhoneAudio = Command.define('StopPhoneAudio', {
  messages: [Message.CompletedStopPhoneAudio],
  execute: PhoneAudioElement.get.pipe(
    Effect.flatMap(audio =>
      Effect.sync(() => {
        cancelPendingSeek(audio)
        markEntry(audio, Option.none())
        pauseAudio(audio)
        audio.removeAttribute('src')
        audio.load()
        releaseBlobUrl(audio)
        clearMediaSession()
      }),
    ),
    Effect.ignore,
    Effect.as(Message.CompletedStopPhoneAudio()),
  ),
})

/** The lock screen forgets the song once this phone stops playing it. */
const clearMediaSession = () => {
  if ('mediaSession' in globalThis.navigator) {
    globalThis.navigator.mediaSession.metadata = null
    globalThis.navigator.mediaSession.playbackState = 'none'
  }
}

/**
 * What the lock screen and Control Center show for the current song. Whether
 * it plays follows the audio element itself (see `subscription.ts`).
 */
export const UpdateMediaSession = Command.define('UpdateMediaSession', {
  args: {
    title: Schema.String,
    artist: Schema.String,
    album: Schema.String,
    maybeArtworkUrl: Schema.Option(Schema.String),
  },
  messages: [Message.CompletedUpdateMediaSession],
  execute: ({ title, artist, album, maybeArtworkUrl }) =>
    Effect.sync(() => {
      if (!('mediaSession' in globalThis.navigator)) {
        return
      }
      globalThis.navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album,
        artwork: Option.match(maybeArtworkUrl, {
          onNone: () => [],
          onSome: src => [{ src }],
        }),
      })
    }).pipe(Effect.ignore, Effect.as(Message.CompletedUpdateMediaSession())),
})
