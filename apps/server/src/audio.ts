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
} from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

/*
 * Audio for every player comes through here. yt-dlp finds the song's AAC
 * stream (itag 140) using the proof-of-origin token service on this machine,
 * and `/audio/:videoId` relays it. YouTube only accepts a fresh link a few
 * seconds after issuing it (`available_at`), so resolving waits for that and
 * the hub resolves upcoming songs ahead of time. Relaying keeps YouTube's IP-bound URLs on
 * this machine, gives every player one stable URL with byte ranges, and
 * always asks YouTube for a byte range: a plain request is throttled to
 * playback speed, a ranged one arrives in a fraction of a second.
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
const VIDEO_ID = /^[\w-]{6,20}$/

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
    /** Resolve songs in the background so they start without waiting. */
    readonly warm: (videoIds: ReadonlyArray<string>) => Effect.Effect<void>
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
      warm: videoIds =>
        Effect.forEach(
          videoIds,
          videoId =>
            Effect.forkDetach(Effect.ignore(Cache.get(cache, videoId))),
          { discard: true },
        ),
    })
  }),
)

// HTTP

const RANGE = /^bytes=(\d*)-(\d*)$/

/** The upstream Range to ask for: always a range, never the whole file. */
const upstreamRange = (
  maybeRequested: string | undefined,
  maybeSize: Option.Option<number>,
): string => {
  const match = maybeRequested === undefined ? null : RANGE.exec(maybeRequested)
  if (match !== null && (match[1] !== '' || match[2] !== '')) {
    return `bytes=${match[1]}-${match[2]}`
  }
  return Option.match(maybeSize, {
    onNone: () => 'bytes=0-',
    onSome: size => `bytes=0-${size - 1}`,
  })
}

const PASSED_HEADERS = ['content-length', 'content-range', 'last-modified']

const fetchUpstream = (videoId: string, audio: ResolvedAudio, range: string) =>
  Effect.tryPromise({
    try: signal =>
      fetch(audio.url, {
        headers: { ...audio.headers, range, 'accept-encoding': 'identity' },
        signal,
      }),
    catch: cause =>
      new AudioUnavailableError({
        videoId,
        message:
          cause instanceof Error ? cause.message : 'YouTube did not answer',
      }),
  })

const isExpired = (response: Response) =>
  response.status === 403 || response.status === 410

/** `GET /audio/:videoId`: the song's AAC audio, with byte-range support. */
export const AudioRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const audioSource = yield* AudioSource
    yield* router.add('GET', '/audio/:videoId', relay(audioSource))
  }),
)

const relay = (audioSource: AudioSource['Service']) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const params = yield* HttpRouter.params
    const videoId = params['videoId'] ?? ''
    if (!VIDEO_ID.test(videoId)) {
      return HttpServerResponse.text('Not a video id', { status: 400 })
    }
    const requestedRange = request.headers['range']

    const attempt = Effect.gen(function* () {
      const audio = yield* audioSource.resolve(videoId)
      const range = upstreamRange(requestedRange, audio.maybeSize)
      return yield* fetchUpstream(videoId, audio, range)
    })

    const upstream = yield* attempt.pipe(
      Effect.flatMap(response =>
        isExpired(response)
          ? Effect.andThen(audioSource.invalidate(videoId), attempt)
          : Effect.succeed(response),
      ),
      Effect.tapError(error =>
        Effect.logWarning('Audio relay failed', videoId, error),
      ),
      Effect.option,
    )

    return Option.match(upstream, {
      onNone: () =>
        HttpServerResponse.text('Audio unavailable', { status: 502 }),
      onSome: response => {
        if (!response.ok) {
          return HttpServerResponse.text('Audio unavailable', {
            status: response.status === 416 ? 416 : 502,
          })
        }
        const headers = new Headers({
          'content-type': 'audio/mp4',
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=3600',
        })
        for (const name of PASSED_HEADERS) {
          const value = response.headers.get(name)
          if (value !== null) headers.set(name, value)
        }
        // Answer a plain request with 200, even though YouTube was asked for
        // a range of the whole file.
        const status = requestedRange === undefined ? 200 : response.status
        if (status === 200) headers.delete('content-range')
        return HttpServerResponse.fromWeb(
          new Response(response.body, { status, headers }),
        )
      },
    })
  })
