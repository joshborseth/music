import { Config, Effect, Option } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'

/**
 * `GET /tv.apk`: the TV app, so the TV's Downloader app can install it from
 * a short address. Serves `TV_APK_PATH` when it is set.
 */
export const TvApkRoutes = HttpRouter.use(router =>
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
