import {
  Array,
  Config,
  Effect,
  FiberHandle,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Ref,
  Stream,
} from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { Tv } from '@music/shared'

import { SessionHub } from './session/hub.ts'
import { TvWaker } from './session/wake.ts'

/** The most of a crash report worth keeping. */
const MAX_REPORT_LENGTH = 16_384

/**
 * `POST /tv-log`: the TV app sends its crash reports here, since there is no
 * debugger attached to the TV. They land in this server's log.
 */
const TvLogRoute = HttpRouter.add(
  'POST',
  '/tv-log',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const report = yield* request.text.pipe(Effect.orElseSucceed(() => ''))
    yield* Effect.logError('TV app', report.slice(0, MAX_REPORT_LENGTH))
    return HttpServerResponse.empty({ status: 204 })
  }),
)

const TvApkPath = Config.option(Config.String('TV_APK_PATH'))

/**
 * `GET /tv.apk`: the TV app, so the TV's Downloader app can install it from
 * a short address. Serves `TV_APK_PATH` when it is set.
 */
const TvApkRoute = HttpRouter.use(router =>
  Effect.gen(function* () {
    const maybePath = yield* TvApkPath
    if (Option.isNone(maybePath)) {
      return
    }
    const path = maybePath.value
    yield* router.add(
      'GET',
      '/tv.apk',
      HttpServerResponse.file(path, {
        contentType: 'application/vnd.android.package-archive',
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text('The TV app has not been built', {
              status: 404,
            }),
          ),
        ),
      ),
    )
  }),
)

/**
 * Where `scripts/build-tv-apk.sh` writes the build id of the APK at
 * `apkPath`: `dist/music-tv.apk` → `dist/music-tv.build`.
 */
export const buildPathFor = (apkPath: string): string =>
  `${apkPath.replace(/\.apk$/u, '')}.build`

const encodeVersion = HttpServerResponse.schemaJson(Tv.TvVersion)

/**
 * `GET /tv/version`: the build of the TV app this server serves, so the TV
 * can update itself when it runs another one. Read on every request, because
 * a deploy rebuilds the APK without restarting anything that would notice.
 */
export const TvVersionRoute = HttpRouter.use(router =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const maybeApkPath = yield* TvApkPath
    const readBuild = Option.match(maybeApkPath, {
      onNone: () => Effect.succeed<string | null>(null),
      onSome: apkPath =>
        fs.readFileString(buildPathFor(apkPath)).pipe(
          Effect.map(text => text.trim() || null),
          Effect.orElseSucceed(() => null),
        ),
    })
    yield* router.add(
      'GET',
      '/tv/version',
      readBuild.pipe(
        Effect.flatMap(build => encodeVersion({ build })),
        Effect.orDie,
      ),
    )
  }),
)

/** How long an installing TV may take to close its session connection. */
const UPDATE_DROP_TIMEOUT = '2 minutes'
/** How long a freshly installed TV app gets to reconnect before it is reopened. */
const REOPEN_AFTER = '20 seconds'

export type AfterUpdate = 'NeverLeft' | 'Reconnected' | 'Reopened'

/**
 * Wait for an updating TV to drop off, then give it `REOPEN_AFTER` to come
 * back by itself (Android sometimes relaunches a replaced app). If it does
 * not, `reopen` it. `online` says whether the TV is connected, current value
 * first.
 */
export const reopenAfterUpdate = <E>(
  online: Stream.Stream<boolean>,
  reopen: Effect.Effect<void, E>,
): Effect.Effect<AfterUpdate, E> =>
  Effect.gen(function* () {
    const dropped = yield* online.pipe(
      Stream.filter(isOnline => !isOnline),
      Stream.runHead,
      Effect.timeoutOption(UPDATE_DROP_TIMEOUT),
    )
    if (Option.isNone(dropped)) {
      return 'NeverLeft' as const
    }
    const back = yield* online.pipe(
      Stream.filter(isOnline => isOnline),
      Stream.runHead,
      Effect.timeoutOption(REOPEN_AFTER),
    )
    if (Option.isSome(back)) {
      return 'Reconnected' as const
    }
    yield* reopen
    return 'Reopened' as const
  })

/**
 * `POST /tv/updating`: the TV is about to install an update, which closes
 * the app. Once it has reinstalled, open it again through the same Home
 * Assistant call that wakes the TV. That only opens the app: the session is
 * left alone, and a TV that joins as an idle player starts nothing.
 */
export const TvUpdatingRoute = HttpRouter.use(router =>
  Effect.gen(function* () {
    const hub = yield* SessionHub
    const waker = yield* TvWaker
    // NOTE: one watch at a time; a second POST starts it over.
    const watch = yield* FiberHandle.make<void>()
    yield* router.add(
      'POST',
      '/tv/updating',
      Effect.gen(function* () {
        const maybeTv = Option.fromNullishOr(waker.devices[0])
        if (Option.isNone(maybeTv)) {
          yield* Effect.logWarning(
            'The TV is updating, but waking it is not set up, so it will stay closed',
          )
          return HttpServerResponse.empty({ status: 204 })
        }
        const tv = maybeTv.value
        const online = hub.states.pipe(
          Stream.map(state =>
            state.devices.some(device => device.id === tv.id && device.online),
          ),
          Stream.changes,
        )
        yield* Effect.logInfo('The TV is installing an update')
        yield* FiberHandle.run(
          watch,
          reopenAfterUpdate(online, waker.wake(tv.id)).pipe(
            Effect.flatMap(outcome =>
              Effect.logInfo('After the TV update', outcome),
            ),
            Effect.catch(error =>
              Effect.logWarning(
                'Reopening the TV after its update failed',
                error.message,
              ),
            ),
          ),
        )
        return HttpServerResponse.empty({ status: 204 })
      }),
    )
    // `DELETE /tv/updating`: the install failed and the app is still open,
    // so stop watching; reopening later could turn a TV back on.
    yield* router.add(
      'DELETE',
      '/tv/updating',
      Effect.gen(function* () {
        yield* FiberHandle.clear(watch)
        yield* Effect.logInfo('The TV update did not install; not reopening it')
        return HttpServerResponse.empty({ status: 204 })
      }),
    )
  }),
)

/** The largest screenshot the TV may send (it sends half size PNGs). */
const MAX_FRAME_BYTES = 6 * 1024 * 1024
/** Every PNG file starts with these bytes. */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
/** Screenshots kept; older ones are deleted. */
const FRAMES_KEPT = 30
/** A request for a screenshot lapses after this long. */
const CAPTURE_WINDOW_MS = 60_000

/**
 * Pictures of the TV's screen, to check its visuals: nobody can see the TV
 * from this box. `POST /tv/capture?count=N` asks for N; the TV asks
 * `GET /tv/capture` every few seconds while its visuals show (200 when one
 * is wanted, 204 when not) and sends each to `POST /tv/frame` as a PNG,
 * saved in `TV_FRAMES_DIR` (default `~/.cache/music/tv-frames`).
 */
export const TvCaptureRoute = HttpRouter.use(router =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
    const dir = yield* Config.String('TV_FRAMES_DIR').pipe(
      Config.withDefault(path.join(home, '.cache', 'music', 'tv-frames')),
    )
    const wanted = yield* Ref.make({ count: 0, until: 0 })
    const now = Effect.clockWith(clock => clock.currentTimeMillis)

    yield* router.add(
      'POST',
      '/tv/capture',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, 'http://tv')
        const asked = Number(url.searchParams.get('count') ?? '1')
        const count = Number.isFinite(asked)
          ? Math.min(Math.max(Math.round(asked), 1), 10)
          : 1
        const at = yield* now
        yield* Ref.set(wanted, { count, until: at + CAPTURE_WINDOW_MS })
        yield* Effect.logInfo('Asked the TV for screenshots', count)
        return HttpServerResponse.text(
          `Asked for ${count}; they land in ${dir}\n`,
        )
      }),
    )

    yield* router.add(
      'GET',
      '/tv/capture',
      Effect.gen(function* () {
        const at = yield* now
        const take = yield* Ref.modify(wanted, state =>
          state.count > 0 && at < state.until
            ? [true, { ...state, count: state.count - 1 }]
            : // Keep the window open for the frames already on their way.
              [false, { ...state, count: 0 }],
        )
        return HttpServerResponse.empty({ status: take ? 200 : 204 })
      }),
    )

    yield* router.add(
      'POST',
      '/tv/frame',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const at = yield* now
        const { until } = yield* Ref.get(wanted)
        // Only frames that were asked for, within a minute or so.
        if (at > until + CAPTURE_WINDOW_MS) {
          return HttpServerResponse.text('No screenshot was asked for', {
            status: 409,
          })
        }
        // Check the size before reading, and that it really is a PNG after:
        // agents open these files to see the TV.
        const length = Number(request.headers['content-length'] ?? '0')
        if (
          request.headers['content-type'] !== 'image/png' ||
          !(length <= MAX_FRAME_BYTES)
        ) {
          return HttpServerResponse.text('Send a PNG of at most 6 MB', {
            status: 413,
          })
        }
        const body = yield* request.arrayBuffer
        const bytes = new Uint8Array(body)
        if (
          bytes.byteLength > MAX_FRAME_BYTES ||
          !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
        ) {
          return HttpServerResponse.text('Not a PNG', { status: 415 })
        }
        yield* fs.makeDirectory(dir, { recursive: true })
        const file = path.join(
          dir,
          `${new Date(at).toISOString().replaceAll(':', '-')}.png`,
        )
        yield* fs.writeFile(file, bytes)
        const names = yield* fs.readDirectory(dir)
        const old = Array.dropRight(
          Array.sort(
            Array.filter(names, name => name.endsWith('.png')),
            Order.String,
          ),
          FRAMES_KEPT,
        )
        yield* Effect.forEach(old, name => fs.remove(path.join(dir, name)), {
          discard: true,
        })
        yield* Effect.logInfo('A screenshot from the TV', file)
        return HttpServerResponse.empty({ status: 204 })
      }).pipe(
        Effect.catch(error =>
          Effect.succeed(
            HttpServerResponse.text(`Could not save it: ${String(error)}`, {
              status: 500,
            }),
          ),
        ),
      ),
    )
  }),
)

/** Routes that need nothing from the session. */
export const TvAppRoutes = Layer.mergeAll(
  TvLogRoute,
  TvApkRoute,
  TvVersionRoute,
  TvCaptureRoute,
)
