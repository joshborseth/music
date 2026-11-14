import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'

import {
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
  Schema,
  Scope,
  Semaphore,
  Stream,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import sharp from 'sharp'

import { allowedArtworkUrl } from '../artwork.ts'
import { type DepthCache, makeDepthCache } from './cache.ts'
import { MODEL, ensureModel } from './model.ts'
import { DEPTH_SIDE, INPUT_SIDE } from './process.ts'

/*
 * Each cover's depth, for the TV's Diorama scene: Depth Anything V2 Small
 * guesses how near each part of the picture is, and the TV raises the cover
 * into a relief by it. Worked out once per artwork URL and kept
 * (`cache.ts`); the queue's next songs are worked out ahead, in the
 * background, so the depth is ready before Play.
 *
 * The model runs in a process of its own (`runner.ts`), at the lowest
 * priority, one cover at a time: about two seconds and 370 MB at its peak,
 * all given back when it ends. Without the model (it could not be
 * downloaded, or its hash is wrong) there is no depth, and the TV leaves
 * the Diorama out; everything else works as before.
 */

/** Covers worked out at once: one, so the box never runs two models. */
const AT_ONCE = 1
/** A cover that failed is not tried again for this long. */
const FAILURE_RETRY_MS = 10 * 60 * 1000
/** Without the model, it is looked for (or downloaded) again after this long. */
const MODEL_RETRY_MS = 30 * 60 * 1000
const FETCH_TIMEOUT = Duration.seconds(10)
const RUN_TIMEOUT = Duration.seconds(60)
/** Google's artwork is fetched at this size, just over the model's input. */
const FETCH_SIZE = 544
const RESIZABLE_GOOGLE_IMAGE = /=w\d+-h\d+/

export class DepthError extends Schema.TaggedError<DepthError>()(
  'DepthError',
  {
    url: Schema.String,
    /**
     * `NotArtwork`: not an artwork URL this server relays; `NoModel`: the
     * depth model is not here; `ArtworkUnavailable`: the cover could not be
     * fetched or read; `Failed`: the model broke.
     */
    reason: Schema.Literals([
      'NotArtwork',
      'NoModel',
      'ArtworkUnavailable',
      'Failed',
    ]),
    message: Schema.String,
  },
) {}

export class CoverDepth extends Context.Service<
  CoverDepth,
  {
    /** The cover's depth map as a PNG: from the cache, or worked out now. */
    readonly depthPng: (url: string) => Effect.Effect<Uint8Array, DepthError>
    /** Queue the cover to be worked out in the background, unless it is known. */
    readonly warm: (url: string) => Effect.Effect<void>
  }
>()('music/CoverDepth') {}

/**
 * The URL a cover's depth is kept under and fetched from: an artwork URL
 * this server relays, at `FETCH_SIZE` when Google can resize it, so the
 * same cover asked for at any size is one entry. None for anything else.
 */
export const depthKey = (raw: string): Option.Option<string> => {
  const url = allowedArtworkUrl(raw)
  if (url === undefined) return Option.none()
  url.pathname = url.pathname.replace(
    RESIZABLE_GOOGLE_IMAGE,
    `=w${FETCH_SIZE}-h${FETCH_SIZE}`,
  )
  return Option.some(url.href)
}

/** Works out one cover's depth map, as a PNG, from its key. */
export type MakeDepth = (key: string) => Effect.Effect<Uint8Array, DepthError>

/**
 * The service on a cache and a way to make depth maps. Each cover is
 * worked out once at a time, however many ask; a failure is remembered for
 * a while. Background work goes one cover at a time.
 */
export const makeCoverDepth = Effect.fnUntraced(function* (
  cache: DepthCache,
  makeDepth: MakeDepth,
  now: () => number,
) {
  const scope = yield* Scope.Scope
  const pending = new Map<string, Deferred.Deferred<Uint8Array, DepthError>>()
  const failures = new Map<string, { at: number; error: DepthError }>()
  const queued = new Set<string>()
  const background = yield* Queue.unbounded<string>()

  const recentFailure = (key: string): Option.Option<DepthError> => {
    const failure = failures.get(key)
    if (failure === undefined) return Option.none()
    if (now() - failure.at < FAILURE_RETRY_MS) return Option.some(failure.error)
    failures.delete(key)
    return Option.none()
  }

  const start = (key: string) =>
    Effect.gen(function* () {
      const existing = pending.get(key)
      if (existing !== undefined) return existing
      const deferred = yield* Deferred.make<Uint8Array, DepthError>()
      pending.set(key, deferred)
      const settle = (result: Exit.Exit<Uint8Array, DepthError>) =>
        Effect.sync(() => pending.delete(key)).pipe(
          Effect.andThen(Deferred.done(deferred, result)),
        )
      // In the service's scope: a TV that hangs up still lets it finish.
      yield* makeDepth(key).pipe(
        Effect.tap(png => Effect.sync(() => cache.put(key, png, now()))),
        Effect.tapError(error =>
          Effect.sync(() => failures.set(key, { at: now(), error })),
        ),
        Effect.exit,
        Effect.flatMap(settle),
        Effect.onInterrupt(() =>
          settle(
            Exit.fail(
              new DepthError({
                url: key,
                reason: 'Failed',
                message: 'Working out the depth was interrupted',
              }),
            ),
          ),
        ),
        Effect.forkIn(scope),
      )
      return deferred
    })

  const depthOf = (key: string): Effect.Effect<Uint8Array, DepthError> =>
    Effect.suspend(() => {
      const known = cache.get(key, now())
      if (Option.isSome(known)) return Effect.succeed(known.value)
      return Option.match(recentFailure(key), {
        onSome: Effect.fail,
        onNone: () => Effect.flatMap(start(key), Deferred.await),
      })
    })

  const depthPng = (url: string) =>
    Option.match(depthKey(url), {
      onNone: () =>
        Effect.fail(
          new DepthError({
            url,
            reason: 'NotArtwork',
            message: 'Not an artwork URL',
          }),
        ),
      onSome: depthOf,
    })

  // The background worker: one cover at a time, failures only logged.
  yield* Queue.take(background).pipe(
    Effect.tap(key => Effect.sync(() => queued.delete(key))),
    Effect.flatMap(key =>
      depthOf(key).pipe(
        Effect.asVoid,
        Effect.catchTag('DepthError', error =>
          error.reason === 'NoModel'
            ? Effect.void
            : Effect.logWarning(
                'Working out a cover depth failed',
                key,
                error.message,
              ),
        ),
      ),
    ),
    Effect.forever,
    Effect.forkIn(scope),
  )

  const warm = (url: string) =>
    Effect.suspend(() => {
      const maybeKey = depthKey(url)
      if (Option.isNone(maybeKey)) return Effect.void
      const key = maybeKey.value
      if (
        queued.has(key) ||
        pending.has(key) ||
        Option.isSome(recentFailure(key)) ||
        Option.isSome(cache.get(key, now()))
      ) {
        return Effect.void
      }
      queued.add(key)
      return Effect.asVoid(Queue.offer(background, key))
    })

  return CoverDepth.of({ depthPng, warm })
})

// MAKING ONE

const failure =
  (url: string, reason: DepthError['reason']) => (error: unknown) =>
    new DepthError({ url, reason, message: String(error) })

/** The cover at `key`, as the model reads it: RGB bytes, `INPUT_SIDE` square. */
export const coverPixels = (key: string) =>
  Effect.tryPromise({
    try: async signal => {
      const response = await fetch(key, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const image = new Uint8Array(await response.arrayBuffer())
      // Its middle square, as the TV crops it, at the model's size.
      const pixels = await sharp(image)
        .resize(INPUT_SIDE, INPUT_SIDE, { fit: 'cover', kernel: 'cubic' })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer()
      return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length)
    },
    catch: failure(key, 'ArtworkUnavailable'),
  }).pipe(
    Effect.timeoutOrElse({
      duration: FETCH_TIMEOUT,
      orElse: () =>
        Effect.fail(failure(key, 'ArtworkUnavailable')('timed out')),
    }),
  )

/** A depth map's bytes as a grayscale PNG. */
export const depthPngOf = (key: string, depth: Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      const png = await sharp(depth, {
        raw: { width: DEPTH_SIDE, height: DEPTH_SIDE, channels: 1 },
      })
        .toColourspace('b-w')
        .png({ compressionLevel: 9 })
        .toBuffer()
      return new Uint8Array(png.buffer, png.byteOffset, png.length)
    },
    catch: failure(key, 'Failed'),
  })

/** Runs the model on `rgb` in its own process, at the lowest priority. */
const runModel = (
  key: string,
  modelPath: string,
  rgb: Uint8Array,
): Effect.Effect<
  Uint8Array,
  DepthError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const runner = fileURLToPath(new URL('./runner.ts', import.meta.url))
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        'nice',
        ['-n', '19', process.execPath, runner, modelPath],
        { stdin: Stream.make(rgb) },
      ),
    )
    const [chunks, log, exitCode] = yield* Effect.all(
      [
        Stream.runCollect(handle.stdout),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: 'unbounded' },
    )
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    if (exitCode !== 0 || total !== DEPTH_SIDE * DEPTH_SIDE) {
      return yield* failure(
        key,
        'Failed',
      )(`the depth runner exited ${exitCode}: ${log.trim().slice(-300)}`)
    }
    const depth = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
      depth.set(chunk, at)
      at += chunk.byteLength
    }
    return depth
  }).pipe(
    Effect.scoped,
    Effect.catchTag('PlatformError', error =>
      Effect.fail(failure(key, 'Failed')(error.message)),
    ),
    Effect.timeoutOrElse({
      duration: RUN_TIMEOUT,
      orElse: () => Effect.fail(failure(key, 'Failed')('the model timed out')),
    }),
  )

export const CoverDepthLive = Layer.effect(CoverDepth)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
    const dataDir = path.join(home, '.local', 'share', 'music')
    const file = yield* Config.String('DEPTH_DB_PATH').pipe(
      Config.withDefault(path.join(dataDir, 'depth.sqlite')),
    )
    const modelPath = yield* Config.String('DEPTH_MODEL_PATH').pipe(
      Config.withDefault(path.join(dataDir, 'models', MODEL.fileName)),
    )
    // Off, the model must already be at DEPTH_MODEL_PATH (tests, offline).
    const mayDownload = yield* Config.Boolean('DEPTH_MODEL_DOWNLOAD').pipe(
      Config.withDefault(true),
    )
    yield* Effect.forEach(
      [path.dirname(file), path.dirname(modelPath)],
      dir => fs.makeDirectory(dir, { recursive: true }),
      { discard: true },
    ).pipe(Effect.orDie)
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(file, { create: true, strict: true })),
      database => Effect.sync(() => database.close()),
    )

    const working = yield* Semaphore.make(AT_ONCE)
    // The model, once checked; or when it was last found missing.
    let model: { readonly ready: true } | { readonly missingAt: number } = {
      missingAt: Number.NEGATIVE_INFINITY,
    }
    const checkedModel = (key: string) =>
      Effect.gen(function* () {
        if ('ready' in model) return modelPath
        if (Date.now() - model.missingAt < MODEL_RETRY_MS) {
          return yield* failure(key, 'NoModel')('the depth model is missing')
        }
        return yield* ensureModel(modelPath, mayDownload).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              model = { ready: true }
            }),
          ),
          Effect.tapError(error =>
            Effect.logWarning(
              'No depth model, so no Diorama on the TV',
              error.message,
            ).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  model = { missingAt: Date.now() }
                }),
              ),
            ),
          ),
          Effect.mapError(error => failure(key, 'NoModel')(error.message)),
        )
      })

    const makeDepth: MakeDepth = key =>
      Effect.gen(function* () {
        const started = Date.now()
        const ready = yield* checkedModel(key)
        const rgb = yield* coverPixels(key)
        const depth = yield* runModel(key, ready, rgb).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        )
        const png = yield* depthPngOf(key, depth)
        yield* Effect.logInfo(
          `Worked out a cover's depth in ${Date.now() - started} ms`,
          key,
        )
        return png
      }).pipe(
        working.withPermits(1),
        Effect.withSpan('CoverDepth.make', { attributes: { url: key } }),
      )

    return yield* makeCoverDepth(makeDepthCache(db), makeDepth, () =>
      Date.now(),
    )
  }),
)
