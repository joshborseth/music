import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Deferred, Effect, Exit, Fiber, Option } from 'effect'
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BunServices } from '@effect/platform-bun'
import type { Tv } from '@music/shared'

import { decodeAudio, measureLoudness } from './decode.ts'
import { type Loudness } from './loudness.ts'
import {
  AnalysisError,
  type AnalyzeSong,
  type Analyzed,
  type MeasureSong,
  analyzeInWorker,
  makeAnalysisCache,
  makeSongAnalysis,
} from './service.ts'

const analysisOf = (videoId: string, tempo = 120): Tv.TvAnalysis => ({
  videoId,
  durationSeconds: 10,
  tempo,
  beats: [0.5, 1],
  downbeats: [0.5],
  sections: [
    { startSeconds: 0, endSeconds: 10, kind: 'Verse', group: 0, energy: 1 },
  ],
  drops: [],
  accents: [],
  energyStepSeconds: 0.1,
  energy: [1],
  drive: 0.5,
})

const loudnessOf = (integratedLufs: number): Loudness => ({
  integratedLufs,
  truePeakDbtp: -1.5,
})

/** What the analyzer makes of a song, measuring it on the way. */
const analyzedOf = (videoId: string, tempo = 120): Analyzed => ({
  analysis: analysisOf(videoId, tempo),
  maybeLoudness: Option.some(loudnessOf(-9)),
})

const noMeasuring: MeasureSong = videoId =>
  Effect.die(new Error(`measured ${videoId} on its own`))

describe('the analysis cache', () => {
  test('keeps an analysis per song, for the analyzer version that made it', () => {
    const db = new Database(':memory:', { strict: true })
    const cache = makeAnalysisCache(db, 1)
    expect(cache.get('a')).toEqual(Option.none())
    cache.put(analysisOf('a'), 1)
    expect(cache.get('a')).toEqual(Option.some(analysisOf('a')))
    // A newer analyzer does not trust the old result.
    expect(makeAnalysisCache(db, 2).get('a')).toEqual(Option.none())
  })

  test('keeps a loudness per song, whatever the analyzer version', () => {
    const db = new Database(':memory:', { strict: true })
    const cache = makeAnalysisCache(db, 1)
    expect(cache.getLoudness('a')).toEqual(Option.none())
    cache.putLoudness('a', loudnessOf(-9), 1)
    // A silent song has no peak.
    const silent = {
      integratedLufs: -70,
      truePeakDbtp: Number.NEGATIVE_INFINITY,
    }
    cache.putLoudness('silent', silent, 1)
    const newer = makeAnalysisCache(db, 2)
    expect(newer.getLoudness('a')).toEqual(Option.some(loudnessOf(-9)))
    expect(newer.getLoudness('silent')).toEqual(Option.some(silent))
  })

  test('a cache made before Sound Check gains the loudness table', () => {
    const db = new Database(':memory:', { strict: true })
    db.run(`CREATE TABLE song_analysis (
      video_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      analysis TEXT NOT NULL,
      analyzed_at INTEGER NOT NULL
    ) STRICT`)
    db.run('PRAGMA user_version = 1')
    const cache = makeAnalysisCache(db, 1)
    cache.putLoudness('a', loudnessOf(-9), 1)
    expect(cache.getLoudness('a')).toEqual(Option.some(loudnessOf(-9)))
  })
})

describe('the analysis service', () => {
  const withService = <A>(
    analyzeSong: AnalyzeSong,
    measureSong: MeasureSong,
    use: (
      service: Effect.Success<ReturnType<typeof makeSongAnalysis>>,
      cache: ReturnType<typeof makeAnalysisCache>,
    ) => Effect.Effect<A, AnalysisError>,
  ) => {
    const cache = makeAnalysisCache(new Database(':memory:', { strict: true }))
    return Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(
          makeSongAnalysis(cache, analyzeSong, measureSong, () => 0),
          service => use(service, cache),
        ),
      ),
    )
  }

  test('requests for one song share one analysis, which is kept', async () => {
    const calls: Array<string> = []
    const result = await withService(
      videoId =>
        Effect.sync(() => calls.push(videoId)).pipe(
          Effect.andThen(Effect.sleep('20 millis')),
          Effect.as(analyzedOf(videoId)),
        ),
      noMeasuring,
      (service, cache) =>
        Effect.gen(function* () {
          const both = yield* Effect.all(
            [service.analysis('a'), service.analysis('a')],
            { concurrency: 'unbounded' },
          )
          const again = yield* service.analysis('a')
          return { both, again, cached: cache.get('a') }
        }),
    )
    expect(calls).toEqual(['a'])
    expect(result.both).toEqual([analysisOf('a'), analysisOf('a')])
    expect(result.again).toEqual(analysisOf('a'))
    expect(Option.isSome(result.cached)).toBe(true)
  })

  test('a failure is reported and not retried right away', async () => {
    const calls: Array<string> = []
    const exits = await withService(
      videoId =>
        Effect.sync(() => calls.push(videoId)).pipe(
          Effect.andThen(
            Effect.fail(
              new AnalysisError({
                videoId,
                reason: 'AudioUnavailable',
                message: 'gone',
              }),
            ),
          ),
        ),
      noMeasuring,
      service =>
        Effect.all([
          Effect.exit(service.analysis('a')),
          Effect.exit(service.analysis('a')),
        ]),
    )
    expect(exits.map(Exit.isFailure)).toEqual([true, true])
    expect(calls).toEqual(['a'])
  })

  test('warming analyzes songs in the background, one at a time', async () => {
    const order: Array<string> = []
    let running = 0
    let mostAtOnce = 0
    const result = await withService(
      videoId =>
        Effect.gen(function* () {
          running += 1
          mostAtOnce = Math.max(mostAtOnce, running)
          order.push(videoId)
          yield* Effect.sleep('10 millis')
          running -= 1
          return analyzedOf(videoId)
        }),
      noMeasuring,
      (service, cache) =>
        Effect.gen(function* () {
          yield* service.warm('a')
          yield* service.warm('b')
          yield* service.warm('a')
          const done = yield* Deferred.make<void>()
          const watcher = yield* Effect.forkChild(
            Effect.gen(function* () {
              while (Option.isNone(cache.get('b'))) {
                yield* Effect.sleep('5 millis')
              }
              yield* Deferred.succeed(done, undefined)
            }),
          )
          yield* Deferred.await(done).pipe(Effect.timeout('2 seconds'))
          yield* Fiber.interrupt(watcher)
          // Already analyzed: warming again does nothing.
          yield* service.warm('a')
          yield* Effect.sleep('30 millis')
          return Option.isSome(cache.get('a'))
        }).pipe(Effect.orDie),
    )
    expect(result).toBe(true)
    expect(order).toEqual(['a', 'b'])
    expect(mostAtOnce).toBe(1)
  })

  test("the analysis's own measurement is kept, so nothing measures again", async () => {
    const result = await withService(
      videoId => Effect.succeed(analyzedOf(videoId)),
      noMeasuring,
      service =>
        Effect.gen(function* () {
          const before = yield* service.knownLoudness('a')
          yield* service.analysis('a')
          return { before, after: yield* service.loudness('a') }
        }),
    )
    expect(result.before).toEqual(Option.none())
    expect(result.after).toEqual(loudnessOf(-9))
  })

  test('a song analyzed before Sound Check is only measured', async () => {
    const measured: Array<string> = []
    const result = await withService(
      videoId => Effect.die(new Error(`analyzed ${videoId} again`)),
      videoId =>
        Effect.sync(() => measured.push(videoId)).pipe(
          Effect.as(loudnessOf(-17)),
        ),
      (service, cache) =>
        Effect.gen(function* () {
          cache.put(analysisOf('old'), 0)
          yield* service.warm('old')
          while (Option.isNone(cache.getLoudness('old'))) {
            yield* Effect.sleep('5 millis')
          }
          return yield* Effect.all(
            [service.loudness('old'), service.loudness('old')],
            { concurrency: 'unbounded' },
          )
        }).pipe(Effect.timeout('2 seconds'), Effect.orDie),
    )
    expect(result).toEqual([loudnessOf(-17), loudnessOf(-17)])
    expect(measured).toEqual(['old'])
  })

  test('asking for the loudness during an analysis waits for it', async () => {
    const result = await withService(
      videoId => Effect.sleep('20 millis').pipe(Effect.as(analyzedOf(videoId))),
      noMeasuring,
      service =>
        Effect.gen(function* () {
          const analyzing = yield* Effect.forkChild(service.analysis('a'))
          yield* Effect.sleep('1 millis')
          const loudness = yield* service.loudness('a')
          yield* Fiber.join(analyzing)
          return loudness
        }),
    )
    expect(result).toEqual(loudnessOf(-9))
  })

  test('an analysis that measured nothing leaves the song to the meter', async () => {
    const measured: Array<string> = []
    const result = await withService(
      videoId =>
        Effect.succeed({
          analysis: analysisOf(videoId),
          maybeLoudness: Option.none(),
        }),
      videoId =>
        Effect.sync(() => measured.push(videoId)).pipe(
          Effect.as(loudnessOf(-12)),
        ),
      service => Effect.andThen(service.analysis('a'), service.loudness('a')),
    )
    expect(result).toEqual(loudnessOf(-12))
    expect(measured).toEqual(['a'])
  })
})

describe('decoding and analyzing a real file', () => {
  const parent = join(homedir(), '.cache', 'music-server-tests')
  let directory = ''
  const file = () => join(directory, 'clicks.m4a')

  beforeAll(async () => {
    await mkdir(parent, { recursive: true })
    directory = await mkdtemp(join(parent, 'analysis-'))
    // 20 seconds of 10 ms clicks every half second (120 BPM), as AAC.
    const ffmpeg = Bun.spawn(
      [
        'ffmpeg',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        "aevalsrc='if(lt(mod(t,0.5),0.01),0.8*sin(2*PI*2000*t),0)':s=44100:d=20",
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        file(),
      ],
      { stdout: 'ignore', stderr: 'pipe' },
    )
    expect(await ffmpeg.exited).toBe(0)
  })

  afterAll(async () => {
    if (directory !== '') await rm(directory, { recursive: true, force: true })
    // Left only if another run is still using it.
    await rmdir(parent).catch(() => undefined)
  })

  test('ffmpeg decodes it and the worker finds its tempo', async () => {
    const analysis = await Effect.runPromise(
      decodeAudio('ffmpeg', file()).pipe(
        Effect.flatMap(({ samples }) => analyzeInWorker('clicks', samples)),
        Effect.provide(BunServices.layer),
      ),
    )
    expect(analysis.videoId).toBe('clicks')
    expect(Math.abs(analysis.durationSeconds - 20)).toBeLessThan(0.1)
    expect(Math.abs(analysis.tempo - 120)).toBeLessThan(2.4)
    expect(analysis.beats.length).toBeGreaterThan(30)
  })

  test('the same pass measures its loudness, as a pass of its own does', async () => {
    const [decoded, measured] = await Effect.runPromise(
      Effect.all([
        decodeAudio('ffmpeg', file()),
        measureLoudness('ffmpeg', file()),
      ]).pipe(Effect.provide(BunServices.layer)),
    )
    const loudness = Option.getOrThrow(decoded.maybeLoudness)
    expect(loudness).toEqual(measured)
    // Short clicks: quiet overall (K-weighting lifts their 2 kHz a little),
    // with peaks near the clicks' 0.8 (-2 dB).
    expect(loudness.integratedLufs).toBeLessThan(-14)
    expect(loudness.integratedLufs).toBeGreaterThan(-30)
    expect(loudness.truePeakDbtp).toBeGreaterThan(-4)
    expect(loudness.truePeakDbtp).toBeLessThan(1)
  })

  test('a file ffmpeg cannot read fails with its message', async () => {
    const exit = await Effect.runPromiseExit(
      decodeAudio('ffmpeg', join(directory, 'missing.m4a')).pipe(
        Effect.provide(BunServices.layer),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
