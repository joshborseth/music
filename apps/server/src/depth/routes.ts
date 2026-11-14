import { Duration, Effect, Fiber, Schema } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { CoverDepth, type DepthError } from './service.ts'

/*
 * `GET /tv/depth?url=<artwork url>`: the cover's depth map for the TV's
 * Diorama scene, a 256 × 256 grayscale PNG, near bright. The same artwork
 * hosts as `/artwork`. A cover not worked out yet is worked out now, which
 * takes a couple of seconds; one that takes longer than `WAIT` answers 503
 * and goes on, so the TV's next ask finds it. 404 means there is no depth
 * model on this server: the TV goes without the scene.
 */

/** How long the route waits for a cover's depth to be worked out. */
const WAIT = Duration.seconds(12)
const CACHE_CONTROL = 'public, max-age=604800'

export const DepthParams = Schema.Struct({ url: Schema.NonEmptyString })

/** The status and reason the TV gets for each way a depth can fail. */
export const depthFailureStatus = (error: DepthError): number => {
  switch (error.reason) {
    case 'NotArtwork':
      return 400
    case 'NoModel':
      return 404
    case 'ArtworkUnavailable':
      return 502
    case 'Failed':
      return 500
  }
}

export const DepthRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const coverDepth = yield* CoverDepth
    yield* router.add(
      'GET',
      '/tv/depth',
      Effect.gen(function* () {
        const params = yield* HttpServerRequest.schemaSearchParams(
          DepthParams,
        ).pipe(Effect.option)
        if (params._tag === 'None') {
          return HttpServerResponse.text('Needs url', { status: 400 })
        }
        const fiber = yield* Effect.forkDetach(
          coverDepth.depthPng(params.value.url),
        )
        const answer = yield* Fiber.join(fiber).pipe(
          Effect.timeoutOption(WAIT),
          Effect.result,
        )
        if (answer._tag === 'Failure') {
          const error = answer.failure
          return HttpServerResponse.text(error.message, {
            status: depthFailureStatus(error),
          })
        }
        if (answer.success._tag === 'None') {
          return HttpServerResponse.text('Not ready yet', {
            status: 503,
            headers: { 'retry-after': '5' },
          })
        }
        return HttpServerResponse.uint8Array(answer.success.value, {
          contentType: 'image/png',
          headers: { 'cache-control': CACHE_CONTROL },
        })
      }),
    )
  }),
)
