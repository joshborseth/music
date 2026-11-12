import {
  Config,
  Effect,
  FiberHandle,
  FileSystem,
  Layer,
  Option,
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

/** Routes that need nothing from the session. */
export const TvAppRoutes = Layer.mergeAll(
  TvLogRoute,
  TvApkRoute,
  TvVersionRoute,
)
