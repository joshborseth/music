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
import { type DecodeError, decodeAudio, measureLoudness } from './decode.ts'
import { type Loudness } from './loudness.ts'
import { WorkerReply, type WorkerRequest } from './protocol.ts'

/*
 * Each song's beats, sections, and drops for the TV's visuals, worked out
 * once from the cached audio and kept in a SQLite file. ffmpeg decodes the
 * song and a worker thread analyzes it, so the server's event loop stays
 * free for playback. Songs the prefetcher downloads are analyzed in the
 * background, one at a time, so the analysis is ready before Play; a song
 * asked for before then is analyzed on the spot. The same ffmpeg pass
 * measures the song's loudness for Sound Check (`loudness.ts`).
 */

/** How long an analysis waits for its song to finish downloading. */
const AUDIO_WAIT = Duration.minutes(2)
/** A downloaded song is written to disk just after it finishes. */
const STORED_RETRIES = 40
const STORED_POLL = Duration.millis(250)
const ANALYSIS_TIMEOUT = Duration.seconds(90)
/** Songs decoded and analyzed (or measured) at the same time, at most. */
const ANALYSES_AT_ONCE = 2
/** A song that failed is not tried again for this long. */
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
  // Sound Check. Kept apart from the analysis, so a new analyzer version
  // doesn't measure every song again, and songs analyzed before this only
  // need the quick measurement. A null peak is a silent song's.
  `
  CREATE TABLE song_loudness (
    video_id TEXT PRIMARY KEY,
    integrated_lufs REAL NOT NULL,
    true_peak_dbtp REAL,
    measured_at INTEGER NOT NULL
  ) STRICT;
  `,
]

const AnalysisJson = Schema.fromJsonString(Schema.toCodecJson(Tv.TvAnalysis))
const encodeAnalysis = Schema.encodeSync(AnalysisJson)
const decodeAnalysis = Schema.decodeUnknownOption(AnalysisJson)

const CacheRow = Schema.Struct({ analysis: Schema.String })
const decodeCacheRow = Schema.decodeUnknownOption(CacheRow)

const LoudnessRow = Schema.Struct({
  integrated_lufs: Schema.Number,
  true_peak_dbtp: Schema.NullOr(Schema.Number),
})
const decodeLoudnessRow = Schema.decodeUnknownOption(LoudnessRow)

const VersionRow = Schema.Struct({ user_version: Schema.Number })
const decodeVersionRow = Schema.decodeUnknownOption(VersionRow)

export interface AnalysisCache {
  /** The song's analysis, if one was made by the current analyzer. */
  readonly get: (videoId: string) => Option.Option<Tv.TvAnalysis>
  readonly put: (analysis: Tv.TvAnalysis, now: number) => void
  /** The song's loudness, if it was measured. */
  readonly getLoudness: (videoId: string) => Option.Option<Loudness>
  readonly putLoudness: (
    videoId: string,
    loudness: Loudness,
    now: number,
  ) => void
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
  const selectLoudness = db.query(
    'SELECT integrated_lufs, true_peak_dbtp FROM song_loudness WHERE video_id = ?',
  )
  const upsertLoudness = db.query(
    `INSERT INTO song_loudness (video_id, integrated_lufs, true_peak_dbtp, measured_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (video_id) DO UPDATE SET
       integrated_lufs = excluded.integrated_lufs,
       true_peak_dbtp = excluded.true_peak_dbtp,
       measured_at = excluded.measured_at`,
  )

  return {
    get: videoId =>
      Option.flatMap(decodeCacheRow(select.get(videoId, version)), row =>
        decodeAnalysis(row.analysis),
      ),
    put: (analysis, now) => {
      upsert.run(analysis.videoId, version, encodeAnalysis(analysis), now)
    },
    getLoudness: videoId =>
      Option.map(decodeLoudnessRow(selectLoudness.get(videoId)), row => ({
        integratedLufs: row.integrated_lufs,
        truePeakDbtp: row.true_peak_dbtp ?? Number.NEGATIVE_INFINITY,
      })),
    putLoudness: (videoId, loudness, now) => {
      upsertLoudness.run(
        videoId,
        loudness.integratedLufs,
        Number.isFinite(loudness.truePeakDbtp) ? loudness.truePeakDbtp : null,
        now,
      )
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
    /**
     * The song's loudness: from the cache, from its analysis when one is
     * under way, or measured now, once the song is downloaded.
     */
    readonly loudness: (
      videoId: string,
    ) => Effect.Effect<Loudness, AnalysisError>
    /** The song's loudness if it was measured, without waiting. */
    readonly knownLoudness: (
      videoId: string,
    ) => Effect.Effect<Option.Option<Loudness>>
    /**
     * Queues the song for analysis and measurement in the background,
     * unless it has both.
     */
    readonly warm: (videoId: string) => Effect.Effect<void>
  }
>()('music/SongAnalysis') {}

/** An analysis, and the loudness measured in the same pass when it could be. */
export interface Analyzed {
  readonly analysis: Tv.TvAnalysis
  readonly maybeLoudness: Option.Option<Loudness>
}

export type AnalyzeSong = (
  videoId: string,
) => Effect.Effect<Analyzed, AnalysisError>

export type MeasureSong = (
  videoId: string,
) => Effect.Effect<Loudness, AnalysisError>

/**
 * One run per song at a time, in `scope`, so a request that hangs up still
 * lets it finish and be kept: asks for a song being worked on share its
 * result. A failure is remembered and not tried again for a while.
 */
const makeOnePerSong = <A>(
  scope: Scope.Scope,
  now: () => number,
  work: (videoId: string) => Effect.Effect<A, AnalysisError>,
  keep: (videoId: string, result: A) => void,
) => {
  const pending = new Map<string, Deferred.Deferred<A, AnalysisError>>()
  const failures = new Map<string, { at: number; error: AnalysisError }>()

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
      const deferred = yield* Deferred.make<A, AnalysisError>()
      pending.set(videoId, deferred)
      // Unmarked before anyone waiting resumes, so a later ask looks again.
      const settle = (result: Exit.Exit<A, AnalysisError>) =>
        Effect.sync(() => pending.delete(videoId)).pipe(
          Effect.andThen(Deferred.done(deferred, result)),
        )
      yield* work(videoId).pipe(
        Effect.tap(result => Effect.sync(() => keep(videoId, result))),
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

  return {
    run: (videoId: string): Effect.Effect<A, AnalysisError> =>
      Effect.suspend(() =>
        Option.match(recentFailure(videoId), {
          onSome: Effect.fail,
          onNone: () => Effect.flatMap(start(videoId), Deferred.await),
        }),
      ),
    /** The run under way for the song, if any. */
    running: (videoId: string) => Option.fromNullishOr(pending.get(videoId)),
    hasFailed: (videoId: string) => Option.isSome(recentFailure(videoId)),
  }
}

/**
 * Builds the service on a cache, an analyzer, and a loudness meter. Each
 * runs once per song at a time; the loudness the analyzer measures on its
 * way is kept too, so the meter only runs for songs analyzed before it.
 */
export const makeSongAnalysis = Effect.fnUntraced(function* (
  cache: AnalysisCache,
  analyzeSong: AnalyzeSong,
  measureSong: MeasureSong,
  now: () => number,
) {
  const scope = yield* Scope.Scope
  const queued = new Set<string>()
  const background = yield* Queue.unbounded<string>()

  const analyses = makeOnePerSong(
    scope,
    now,
    analyzeSong,
    (videoId, analyzed) => {
      cache.put(analyzed.analysis, now())
      Option.map(analyzed.maybeLoudness, loudness =>
        cache.putLoudness(videoId, loudness, now()),
      )
    },
  )
  const measurements = makeOnePerSong(
    scope,
    now,
    measureSong,
    (videoId, loudness) => cache.putLoudness(videoId, loudness, now()),
  )

  const analysis = (
    videoId: string,
  ): Effect.Effect<Tv.TvAnalysis, AnalysisError> =>
    Effect.suspend(() =>
      Option.match(cache.get(videoId), {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.map(analyses.run(videoId), analyzed => analyzed.analysis),
      }),
    )

  const knownLoudness = (videoId: string) =>
    Effect.sync(() => cache.getLoudness(videoId))

  const loudness = (videoId: string): Effect.Effect<Loudness, AnalysisError> =>
    Effect.gen(function* () {
      const known = cache.getLoudness(videoId)
      if (Option.isSome(known)) return known.value
      // An analysis under way measures it too: wait for that instead.
      const maybeRunning = analyses.running(videoId)
      if (Option.isSome(maybeRunning)) {
        yield* Effect.ignore(Deferred.await(maybeRunning.value))
        const measured = cache.getLoudness(videoId)
        if (Option.isSome(measured)) return measured.value
      }
      return yield* measurements.run(videoId)
    })

  const logFailure =
    (what: string, videoId: string) => (error: AnalysisError) =>
      Effect.logWarning(
        `${what} a song in the background failed`,
        videoId,
        error.message,
      )

  /** Analyzes the song, then measures it if the analysis didn't. */
  const prepare = (videoId: string) =>
    Effect.gen(function* () {
      const mayMeasure = yield* analysis(videoId).pipe(
        Effect.as(true),
        Effect.catchTag('AnalysisError', error =>
          logFailure(
            'Analyzing',
            videoId,
          )(error).pipe(
            // A song that couldn't be had can't be measured either; one
            // whose analysis broke may still be.
            Effect.as(error.reason !== 'AudioUnavailable'),
          ),
        ),
      )
      if (!mayMeasure) return
      yield* loudness(videoId).pipe(
        Effect.asVoid,
        Effect.catchTag('AnalysisError', logFailure('Measuring', videoId)),
      )
    })

  // The background worker: one song at a time, failures only logged.
  yield* Queue.take(background).pipe(
    Effect.tap(videoId => Effect.sync(() => queued.delete(videoId))),
    Effect.flatMap(prepare),
    Effect.forever,
    Effect.forkIn(scope),
  )

  const warm = (videoId: string) =>
    Effect.suspend(() => {
      const needsAnalysis =
        Option.isNone(cache.get(videoId)) && !analyses.hasFailed(videoId)
      const needsLoudness =
        Option.isNone(cache.getLoudness(videoId)) &&
        !measurements.hasFailed(videoId)
      if (
        queued.has(videoId) ||
        Option.isSome(analyses.running(videoId)) ||
        Option.isSome(measurements.running(videoId)) ||
        !(needsAnalysis || needsLoudness)
      ) {
        return Effect.void
      }
      queued.add(videoId)
      return Effect.asVoid(Queue.offer(background, videoId))
    })

  return SongAnalysis.of({ analysis, loudness, knownLoudness, warm })
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

    const failed = (videoId: string) => (error: DecodeError) =>
      new AnalysisError({ videoId, reason: 'Failed', message: error.message })

    const withSpawner = <A, E>(
      effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
    ) =>
      Effect.provideService(
        effect,
        ChildProcessSpawner.ChildProcessSpawner,
        spawner,
      )

    const decodeAndAnalyze = (videoId: string, songPath: string) =>
      Effect.gen(function* () {
        const { samples, maybeLoudness } = yield* withSpawner(
          decodeAudio(ffmpeg, songPath),
        ).pipe(Effect.mapError(failed(videoId)))
        const analysis = yield* analyzeInWorker(videoId, samples)
        return { analysis, maybeLoudness } satisfies Analyzed
      })

    const analyzeSong: AnalyzeSong = videoId =>
      Effect.gen(function* () {
        const songPath = yield* storedFile(store, videoId)
        return yield* decodeAndAnalyze(videoId, songPath).pipe(
          working.withPermits(1),
        )
      }).pipe(
        Effect.withSpan('SongAnalysis.analyze', { attributes: { videoId } }),
      )

    const measureSong: MeasureSong = videoId =>
      Effect.gen(function* () {
        const songPath = yield* storedFile(store, videoId)
        return yield* withSpawner(measureLoudness(ffmpeg, songPath)).pipe(
          Effect.mapError(failed(videoId)),
          working.withPermits(1),
        )
      }).pipe(
        Effect.withSpan('SongAnalysis.measure', { attributes: { videoId } }),
      )

    return yield* makeSongAnalysis(
      makeAnalysisCache(db),
      analyzeSong,
      measureSong,
      () => Date.now(),
    )
  }),
)
