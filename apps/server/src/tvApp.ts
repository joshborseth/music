import { Config, Effect, Layer, Option } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

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

/**
 * `GET /tv.apk`: the TV app, so the TV's Downloader app can install it from
 * a short address. Serves `TV_APK_PATH` when it is set.
 */
const TvApkRoute = HttpRouter.use(router =>
  Effect.gen(function* () {
    const maybePath = yield* Config.option(Config.String('TV_APK_PATH'))
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

export const TvAppRoutes = Layer.mergeAll(TvLogRoute, TvApkRoute)
