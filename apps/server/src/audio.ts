import {
  Cache,
  Config,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
} from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { AudioStore, type SongSource } from './audioStore.ts'

/*
 * Audio for every player comes through here. yt-dlp finds the song's AAC
 * stream (itag 140) using the proof-of-origin token service on this machine.
 * YouTube only accepts a fresh link a few seconds after issuing it
 * (`available_at`), so resolving waits for that. `AudioStore` then downloads
 * the whole song once (always as a byte range: a plain request is throttled
 * to playback speed). `/audio/:videoId` serves it while it downloads, then
 * from disk.
 */

/** yt-dlp could not produce a playable audio stream for a song. */
export class AudioUnavailableError extends Schema.TaggedError<AudioUnavailableError>()(
  'AudioUnavailableError',
  { videoId: Schema.String, message: Schema.String },
) {}

export interface ResolvedAudio {
  readonly url: string
  /** The links only work with the same headers yt-dlp used (User-Agent). */
  readonly headers: Readonly<Record<string, string>>
  readonly maybeSize: Option.Option<number>
  readonly expiresAt: number
}

/** The parts of yt-dlp's `--dump-json` output this needs. */
const YtDlpFormat = Schema.Struct({
  url: Schema.String,
  filesize: Schema.optional(Schema.NullOr(Schema.Number)),
  filesize_approx: Schema.optional(Schema.NullOr(Schema.Number)),
  http_headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** YouTube refuses the link until this time (epoch seconds). */
  available_at: Schema.optional(Schema.NullOr(Schema.Number)),
})
const decodeYtDlpFormat = Schema.decodeUnknownEffect(
  Schema.fromJsonString(YtDlpFormat),
)

/** AAC in MP4: every player (Safari, Chrome, the TV's decoder) can play it. */
const FORMAT = '140/bestaudio[ext=m4a]'
const RESOLVE_CONCURRENCY = 3
const CACHE_CAPACITY = 200
const EXPIRY_MARGIN_MS = 10 * 60 * 1000
const FAILURE_TTL = Duration.seconds(30)
const DEFAULT_URL_LIFETIME_MS = 60 * 60 * 1000
/** What a YouTube video id looks like; also keeps ids safe as file names. */
export const VIDEO_ID = /^[\w-]{6,20}$/

const expiresAtFromUrl = (url: string, now: number): number => {
  const maybeExpire = Number(new URL(url).searchParams.get('expire'))
  return Number.isFinite(maybeExpire) && maybeExpire > 0
    ? maybeExpire * 1000
    : now + DEFAULT_URL_LIFETIME_MS
}

export class AudioSource extends Context.Service<
  AudioSource,
  {
    readonly resolve: (
      videoId: string,
    ) => Effect.Effect<ResolvedAudio, AudioUnavailableError>
    readonly invalidate: (videoId: string) => Effect.Effect<void>
    /** Whether a link (or a recent failure) is cached, so `resolve` runs no yt-dlp. */
    readonly isResolved: (videoId: string) => Effect.Effect<boolean>
  }
>()('music/AudioSource') {}

export const AudioSourceLive = Layer.effect(AudioSource)(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const ytDlp = yield* Config.String('YTDLP_PATH').pipe(
      Config.withDefault('yt-dlp'),
    )
    const jsRuntime = yield* Config.String('YTDLP_JS_RUNTIME').pipe(
      Config.withDefault('bun'),
    )
    const semaphore = yield* Semaphore.make(RESOLVE_CONCURRENCY)

    const lookup = (videoId: string) =>
      Effect.gen(function* () {
        const command = ChildProcess.make(ytDlp, [
          '--js-runtimes',
          jsRuntime,
          '--no-playlist',
          '--no-warnings',
          '--format',
          FORMAT,
          '--dump-json',
          `https://music.youtube.com/watch?v=${videoId}`,
        ])
        const output = yield* spawner
          .string(command)
          .pipe(semaphore.withPermits(1))
        const format = yield* decodeYtDlpFormat(output.trim())
        const now = Date.now()
        const waitMs = (format.available_at ?? 0) * 1000 - now
        if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs))
        return {
          url: format.url,
          headers: format.http_headers ?? {},
          maybeSize: Option.fromNullishOr(
            format.filesize ?? format.filesize_approx,
          ),
          expiresAt: expiresAtFromUrl(format.url, now),
        } satisfies ResolvedAudio
      }).pipe(
        Effect.mapError(
          cause =>
            new AudioUnavailableError({
              videoId,
              message:
                cause._tag === 'SchemaError'
                  ? 'yt-dlp returned no audio stream'
                  : cause.message,
            }),
        ),
        Effect.withSpan('AudioSource.resolve', { attributes: { videoId } }),
      )

    const cache = yield* Cache.makeWith(lookup, {
      capacity: CACHE_CAPACITY,
      timeToLive: Exit.match({
        onFailure: () => FAILURE_TTL,
        onSuccess: audio =>
          Duration.millis(
            Math.max(60_000, audio.expiresAt - Date.now() - EXPIRY_MARGIN_MS),
          ),
      }),
    })

    return AudioSource.of({
      resolve: videoId => Cache.get(cache, videoId),
      invalidate: videoId => Cache.invalidate(cache, videoId),
      isResolved: videoId => Cache.has(cache, videoId),
    })
  }),
)

// HTTP

const RANGE = /^bytes=(\d*)-(\d*)$/
/** A song's audio never changes, so browsers may keep it for good. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

type ByteRange = Readonly<{ start: number; end: number }>

/**
 * The bytes a Range header asks for, clamped to the file. `None` means no
 * usable range (send the whole file); `Some(None)` means it cannot be met.
 */
const requestedBytes = (
  header: string | undefined,
  size: number,
): Option.Option<Option.Option<ByteRange>> => {
  const match = header === undefined ? null : RANGE.exec(header)
  if (match === null) {
    return Option.none()
  }
  const first = match[1] ?? ''
  const last = match[2] ?? ''
  if (first === '' && last === '') {
    return Option.none()
  }
  const start = first === '' ? Math.max(0, size - Number(last)) : Number(first)
  const end =
    first === '' || last === '' ? size - 1 : Math.min(Number(last), size - 1)
  return Option.some(
    start <= end && start < size ? Option.some({ start, end }) : Option.none(),
  )
}

/** `GET /audio/:videoId`: the song's AAC audio from the disk cache, with byte ranges. */
export const AudioRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const store = yield* AudioStore
    yield* router.add('GET', '/audio/:videoId', serveSong(store))
  }),
)

/** The bytes `start` through `end` of a song, from disk or as they arrive. */
const songBody = (
  source: SongSource,
  start: number,
  end: number,
  options: { status: number; headers: Record<string, string> },
) =>
  source._tag === 'Stored'
    ? HttpServerResponse.file(source.path, {
        ...options,
        contentType: 'audio/mp4',
        offset: start,
        bytesToRead: end - start + 1,
      })
    : Effect.succeed(
        HttpServerResponse.stream(
          Stream.fromAsyncIterable(
            source.download.read(start, end),
            cause => cause,
          ),
          {
            ...options,
            contentType: 'audio/mp4',
            contentLength: end - start + 1,
          },
        ),
      )

const serveSong = (store: AudioStore['Service']) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const params = yield* HttpRouter.params
    const videoId = params['videoId'] ?? ''
    if (!VIDEO_ID.test(videoId)) {
      return HttpServerResponse.text('Not a video id', { status: 400 })
    }
    const maybeSource = yield* store.open(videoId).pipe(
      Effect.tapError(error =>
        Effect.logWarning('Audio unavailable', videoId, error.message),
      ),
      Effect.option,
    )
    if (Option.isNone(maybeSource)) {
      return HttpServerResponse.text('Audio unavailable', { status: 502 })
    }
    const source = maybeSource.value
    const size = source._tag === 'Stored' ? source.size : source.download.size
    const headers = {
      'accept-ranges': 'bytes',
      'cache-control': CACHE_CONTROL,
    }
    const unavailable = Effect.orElseSucceed(() =>
      HttpServerResponse.text('Audio unavailable', { status: 502 }),
    )
    return yield* Option.match(requestedBytes(request.headers['range'], size), {
      onNone: () =>
        songBody(source, 0, size - 1, { status: 200, headers }).pipe(
          unavailable,
        ),
      onSome: Option.match({
        onNone: () =>
          Effect.succeed(
            HttpServerResponse.empty({
              status: 416,
              headers: { 'content-range': `bytes */${size}` },
            }),
          ),
        onSome: ({ start, end }) =>
          songBody(source, start, end, {
            status: 206,
            headers: {
              ...headers,
              'content-range': `bytes ${start}-${end}/${size}`,
            },
          }).pipe(unavailable),
      }),
    })
  })
