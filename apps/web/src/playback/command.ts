import { Clock, Data, Duration, Effect, Layer, Option, Schema } from 'effect'
import { SecureRandom } from 'effect/crypto'
import { KeyValueStore } from 'effect/persistence'
import { Command } from 'foldkit'

import { BrowserCrypto, BrowserKeyValueStore } from '@effect/platform-browser'
import { Session } from '@music/shared'

import { Message } from '../message'
import { DEVICE_ID_KEY, deviceNameFromUserAgent } from './domain'
import { PhoneAudioElement, SessionSocket } from './resource'
import { cacheSong, cachedSong } from './songCache'

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

/** Start playback, reporting whether the browser wants a tap first. */
const play = (audio: HTMLAudioElement) =>
  Effect.tryPromise({
    try: () => audio.play(),
    catch: error =>
      new AudioPlayError({
        isNotAllowed:
          error instanceof DOMException && error.name === 'NotAllowedError',
      }),
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
            yield* play(audio)
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

/** Jump to `seconds` now, or as soon as the song's length is known. */
const seekWhenReady = (audio: HTMLAudioElement, seconds: number) => {
  if (seconds <= 0) {
    return
  }
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    audio.currentTime = seconds
  } else {
    audio.addEventListener(
      'loadedmetadata',
      () => {
        audio.currentTime = seconds
      },
      { once: true },
    )
  }
}

/**
 * Play a song from the phone's cache when it is there, so it starts and
 * seeks instantly. Otherwise stream it, and cache it for next time.
 */
export const LoadPhoneAudio = Command.define('LoadPhoneAudio', {
  args: {
    videoId: Schema.String,
    startSeconds: Schema.Number,
    isPlaying: Schema.Boolean,
  },
  messages: [Message.CompletedLoadPhoneAudio],
  execute: ({ videoId, startSeconds, isPlaying }) =>
    PhoneAudioElement.get.pipe(
      Effect.flatMap(audio =>
        Effect.gen(function* () {
          const maybeBlob = yield* cachedSong(videoId)
          releaseBlobUrl(audio)
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
          seekWhenReady(audio, startSeconds)
          if (Option.isNone(maybeBlob)) {
            yield* Effect.forkDetach(cacheSong(videoId))
          }
          if (!isPlaying) {
            audio.pause()
            return false
          }
          return yield* play(audio)
        }),
      ),
      Effect.map(isBlocked => Message.CompletedLoadPhoneAudio({ isBlocked })),
      Effect.catch(() =>
        Effect.succeed(Message.CompletedLoadPhoneAudio({ isBlocked: false })),
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

/** Download the songs that play next, so they start without waiting. */
export const PrefetchSongs = Command.define('PrefetchSongs', {
  args: { videoIds: Schema.Array(Schema.String) },
  messages: [Message.CompletedPrefetchSongs],
  execute: ({ videoIds }) =>
    Effect.forEach(videoIds, cacheSong, { discard: true }).pipe(
      Effect.as(Message.CompletedPrefetchSongs()),
    ),
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
        audio.pause()
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
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
        releaseBlobUrl(audio)
      }),
    ),
    Effect.ignore,
    Effect.as(Message.CompletedStopPhoneAudio()),
  ),
})

/** What the lock screen and Control Center show for the current song. */
export const UpdateMediaSession = Command.define('UpdateMediaSession', {
  args: {
    title: Schema.String,
    artist: Schema.String,
    album: Schema.String,
    maybeArtworkUrl: Schema.Option(Schema.String),
    isPlaying: Schema.Boolean,
  },
  messages: [Message.CompletedUpdateMediaSession],
  execute: ({ title, artist, album, maybeArtworkUrl, isPlaying }) =>
    Effect.sync(() => {
      if (!('mediaSession' in globalThis.navigator)) {
        return
      }
      const { mediaSession } = globalThis.navigator
      mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album,
        artwork: Option.match(maybeArtworkUrl, {
          onNone: () => [],
          onSome: src => [{ src }],
        }),
      })
      mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
    }).pipe(Effect.ignore, Effect.as(Message.CompletedUpdateMediaSession())),
})
