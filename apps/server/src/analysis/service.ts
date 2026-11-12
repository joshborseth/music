import { Database } from 'bun:sqlite'
import {
  Array,
  Config,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from 'effect'
import { ChildProcessSpawner } from 'effect/process'

import { Tv } from '@music/shared'

import { AudioStore } from '../audioStore.ts'
import { ANALYZER_VERSION } from './analyze.ts'
import { decodeAudio } from './decode.ts'
import { WorkerReply, type WorkerRequest } from './protocol.ts'

/*
 * Each song's beats, sections, and drops for the TV's visuals, worked out
 * once from the cached audio and kept in a SQLite file. ffmpeg decodes the
 * song and a worker thread analyzes it, so the server's event loop stays
 * free for playback. Songs the prefetcher downloads are analyzed in the
 * background, one at a time, so the analysis is ready before Play; a song
 * asked for before then is analyzed on the spot.
 */

/** How long an analysis waits for its song to finish downloading. */
const AUDIO_WAIT = Duration.minutes(2)
/** A downloaded song is written to disk just after it finishes. */
const STORED_RETRIES = 40
const STORED_POLL = Duration.millis(250)
const ANALYSIS_TIMEOUT = Duration.seconds(90)
/** A song that failed is not tried again for this long. */
/** Songs decoded and analyzed at the same time, at most. */
const ANALYSES_AT_ONCE = 2
const FAILURE_RETRY_MS = 10 * 60 * 1000

export class AnalysisError extends Schema.TaggedError<AnalysisError>()(
  'AnalysisError',
  {
    videoId: Schema.String,
    /** `AudioUnavailable`: the song could not be had; `Failed`: decoding or analysis broke. */
    reason: Schema.Literals(['AudioUnavailable', 'Failed']),
    message: Schema.String,
  },
) {}

// CACHE

const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE song_analysis (
    video_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    analysis TEXT NOT NULL,
    analyzed_at INTEGER NOT NULL
  ) STRICT;
  `,
]

const AnalysisJson = Schema.fromJsonString(Schema.toCodecJson(Tv.TvAnalysis))
const encodeAnalysis = Schema.encodeSync(AnalysisJson)
const decodeAnalysis = Schema.decodeUnknownOption(AnalysisJson)

const CacheRow = Schema.Struct({ analysis: Schema.String })
const decodeCacheRow = Schema.decodeUnknownOption(CacheRow)

const VersionRow = Schema.Struct({ user_version: Schema.Number })
const decodeVersionRow = Schema.decodeUnknownOption(VersionRow)

export interface AnalysisCache {
  /** The song's analysis, if one was made by the current analyzer. */
  readonly get: (videoId: string) => Option.Option<Tv.TvAnalysis>
  readonly put: (analysis: Tv.TvAnalysis, now: number) => void
}

export const makeAnalysisCache = (
  db: Database,
  version: number = ANALYZER_VERSION,
): AnalysisCache => {
  db.run('PRAGMA journal_mode = WAL')
  const schemaVersion = Option.match(
    decodeVersionRow(db.query('PRAGMA user_version').get()),
    { onNone: () => 0, onSome: row => row.user_version },
  )
  db.transaction(() => {
    Array.forEach(MIGRATIONS.slice(schemaVersion), step => db.run(step))
    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`)
  })()

  const select = db.query(
    'SELECT analysis FROM song_analysis WHERE video_id = ? AND version = ?',
  )
  const upsert = db.query(
    `INSERT INTO song_analysis (video_id, version, analysis, analyzed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (video_id) DO UPDATE SET
       version = excluded.version,
       analysis = excluded.analysis,
       analyzed_at = excluded.analyzed_at`,
  )

  return {
    get: videoId =>
      Option.flatMap(decodeCacheRow(select.get(videoId, version)), row =>
        decodeAnalysis(row.analysis),
      ),
    put: (analysis, now) => {
      upsert.run(analysis.videoId, version, encodeAnalysis(analysis), now)
    },
  }
}

// SERVICE

export class SongAnalysis extends Context.Service<
  SongAnalysis,
  {
    /** The song's analysis: from the cache, or worked out now. */
    readonly analysis: (
      videoId: string,
    ) => Effect.Effect<Tv.TvAnalysis, AnalysisError>
    /** Queues the song for analysis in the background, unless it has one. */
    readonly warm: (videoId: string) => Effect.Effect<void>
  }
>()('music/SongAnalysis') {}

export type AnalyzeSong = (
  videoId: string,
) => Effect.Effect<Tv.TvAnalysis, AnalysisError>

/**
 * Builds the service on a cache and an analyzer. An analysis runs in the
 * service's scope, so a request that hangs up still lets it finish and be
 * kept; requests for the same song share one analysis.
 */
export const makeSongAnalysis = Effect.fnUntraced(function* (
  cache: AnalysisCache,
  analyzeSong: AnalyzeSong,
  now: () => number,
) {
  const scope = yield* Scope.Scope
  const pending = new Map<
    string,
    Deferred.Deferred<Tv.TvAnalysis, AnalysisError>
  >()
  const failures = new Map<string, { at: number; error: AnalysisError }>()
  const queued = new Set<string>()
  const background = yield* Queue.unbounded<string>()

  const recentFailure = (videoId: string): Option.Option<AnalysisError> => {
    const failure = failures.get(videoId)
    if (failure === undefined) return Option.none()
    if (now() - failure.at < FAILURE_RETRY_MS) return Option.some(failure.error)
    failures.delete(videoId)
    return Option.none()
  }

  const start = (videoId: string) =>
    Effect.gen(function* () {
      const existing = pending.get(videoId)
      if (existing !== undefined) return existing
      const deferred = yield* Deferred.make<Tv.TvAnalysis, AnalysisError>()
      pending.set(videoId, deferred)
      // Unmarked before anyone waiting resumes, so a later ask looks again.
      const settle = (result: Exit.Exit<Tv.TvAnalysis, AnalysisError>) =>
        Effect.sync(() => pending.delete(videoId)).pipe(
          Effect.andThen(Deferred.done(deferred, result)),
        )
      yield* analyzeSong(videoId).pipe(
        Effect.tap(analysis => Effect.sync(() => cache.put(analysis, now()))),
        Effect.tapError(error =>
          Effect.sync(() => failures.set(videoId, { at: now(), error })),
        ),
        Effect.exit,
        Effect.flatMap(settle),
        Effect.onInterrupt(() =>
          settle(
            Exit.fail(
              new AnalysisError({
                videoId,
                reason: 'Failed',
                message: 'The analysis was interrupted',
              }),
            ),
          ),
        ),
        Effect.forkIn(scope),
      )
      return deferred
    })

  const analysis = (
    videoId: string,
  ): Effect.Effect<Tv.TvAnalysis, AnalysisError> =>
    Effect.suspend(() =>
      Option.match(cache.get(videoId), {
        onSome: Effect.succeed,
        onNone: () =>
          Option.match(recentFailure(videoId), {
            onSome: Effect.fail,
            onNone: () => Effect.flatMap(start(videoId), Deferred.await),
          }),
      }),
    )

  // The background worker: one song at a time, failures only logged.
  yield* Queue.take(background).pipe(
    Effect.tap(videoId => Effect.sync(() => queued.delete(videoId))),
    Effect.flatMap(videoId =>
      analysis(videoId).pipe(
        Effect.catchTag('AnalysisError', error =>
          Effect.logWarning(
            'Analyzing a song in the background failed',
            videoId,
            error.message,
          ),
        ),
      ),
    ),
    Effect.forever,
    Effect.forkIn(scope),
  )

  const warm = (videoId: string) =>
    Effect.suspend(() => {
      if (
        queued.has(videoId) ||
        pending.has(videoId) ||
        Option.isSome(recentFailure(videoId)) ||
        Option.isSome(cache.get(videoId))
      ) {
        return Effect.void
      }
      queued.add(videoId)
      return Effect.asVoid(Queue.offer(background, videoId))
    })

  return SongAnalysis.of({ analysis, warm })
})

// ANALYZING

/** Analyzes `samples` in a worker thread, ended if the fiber is interrupted. */
export const analyzeInWorker = (
  videoId: string,
  samples: Float32Array<ArrayBuffer>,
): Effect.Effect<Tv.TvAnalysis, AnalysisError> => {
  const failed = (message: string) =>
    new AnalysisError({ videoId, reason: 'Failed', message })
  const decodeReply = Schema.decodeUnknownEffect(WorkerReply)
  return Effect.callback<Tv.TvAnalysis, AnalysisError>(resume => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url))
    worker.addEventListener('message', event => {
      worker.terminate()
      resume(
        decodeReply(event.data).pipe(
          Effect.mapError(() => failed('The worker sent a malformed reply')),
          Effect.flatMap(reply =>
            reply._tag === 'Done'
              ? Effect.succeed(reply.analysis)
              : Effect.fail(failed(reply.message)),
          ),
        ),
      )
    })
    worker.addEventListener('error', event => {
      worker.terminate()
      resume(Effect.fail(failed(event.message)))
    })
    const request: WorkerRequest = { videoId, samples }
    worker.postMessage(request, [samples.buffer])
    return Effect.sync(() => worker.terminate())
  }).pipe(
    Effect.timeoutOrElse({
      duration: ANALYSIS_TIMEOUT,
      orElse: () => Effect.fail(failed('The analysis took too long')),
    }),
  )
}

/** The song's file once it is whole on disk, downloading it if needed. */
const storedFile = (store: AudioStore['Service'], videoId: string) =>
  store.ensure(videoId).pipe(
    Effect.timeoutOrElse({
      duration: AUDIO_WAIT,
      orElse: () =>
        Effect.fail(
          new AnalysisError({
            videoId,
            reason: 'AudioUnavailable',
            message: 'The song took too long to download',
          }),
        ),
    }),
    Effect.andThen(
      store.open(videoId).pipe(
        Effect.flatMap(source =>
          source._tag === 'Stored'
            ? Effect.succeed(source.path)
            : Effect.fail(
                new AnalysisError({
                  videoId,
                  reason: 'AudioUnavailable',
                  message: 'The song is not on disk yet',
                }),
              ),
        ),
        Effect.retry({
          schedule: Schedule.spaced(STORED_POLL),
          times: STORED_RETRIES,
        }),
      ),
    ),
    Effect.catchTag('AudioUnavailableError', error =>
      Effect.fail(
        new AnalysisError({
          videoId,
          reason: 'AudioUnavailable',
          message: error.message,
        }),
      ),
    ),
  )

export const SongAnalysisLive = Layer.effect(SongAnalysis)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const store = yield* AudioStore
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
    const file = yield* Config.String('ANALYSIS_DB_PATH').pipe(
      Config.withDefault(
        path.join(home, '.local', 'share', 'music', 'analysis.sqlite'),
      ),
    )
    const ffmpeg = yield* Config.String('FFMPEG_PATH').pipe(
      Config.withDefault('ffmpeg'),
    )
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.orDie)
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(file, { create: true, strict: true })),
      database => Effect.sync(() => database.close()),
    )

    // Decoding and analyzing hold a whole song in memory and a CPU core,
    // and the route is open to the LAN: only this many run at once.
    const working = yield* Semaphore.make(ANALYSES_AT_ONCE)

    const analyzeSong: AnalyzeSong = videoId =>
      Effect.gen(function* () {
        const songPath = yield* storedFile(store, videoId)
        return yield* decodeAndAnalyze(videoId, songPath).pipe(
          working.withPermits(1),
        )
      }).pipe(
        Effect.withSpan('SongAnalysis.analyze', { attributes: { videoId } }),
      )

    const decodeAndAnalyze = (videoId: string, songPath: string) =>
      Effect.gen(function* () {
        const samples = yield* decodeAudio(ffmpeg, songPath).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
          Effect.mapError(
            error =>
              new AnalysisError({
                videoId,
                reason: 'Failed',
                message: error.message,
              }),
          ),
        )
        return yield* analyzeInWorker(videoId, samples)
      })

    return yield* makeSongAnalysis(makeAnalysisCache(db), analyzeSong, () =>
      Date.now(),
    )
  }),
)
