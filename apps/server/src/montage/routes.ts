import { Duration, Effect, Fiber, Option, Schema } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { Tv } from '@music/shared'

import { VIDEO_ID } from '../audio.ts'
import { type MontageError, SongMontage } from './service.ts'

/*
 * The montage's routes for the TV (`packages/shared/src/tv.ts`):
 * `GET /tv/montage?videoId=…` answers the song's `TvMontage`, waiting a
 * while for one not made yet, and `GET /tv/montage.jpg?videoId=…` its
 * atlas. A montage still being made when the wait runs out answers 503 and
 * goes on being made, so the TV's next ask finds it.
 */

/**
 * How long the TV's ask waits for a montage being made: less than the TV's
 * own 20-second timeout.
 */
const MONTAGE_WAIT = Duration.seconds(15)

const SongParams = Schema.Struct({
  videoId: Schema.String.check(Schema.isPattern(VIDEO_ID)),
  v: Schema.optionalKey(Schema.String),
})

const statusOf = (error: MontageError): number => {
  switch (error.reason) {
    case 'Nothing':
      return 404
    case 'Unavailable':
      return 502
    case 'Failed':
      return 500
  }
}

const encodeMontage = HttpServerResponse.schemaJson(Tv.TvMontage)

export const MontageRoutes = HttpRouter.use(router =>
  Effect.gen(function* () {
    const songMontage = yield* SongMontage
    const params = HttpServerRequest.schemaSearchParams(SongParams).pipe(
      Effect.option,
    )

    yield* router.add(
      'GET',
      '/tv/montage',
      Effect.gen(function* () {
        const maybeParams = yield* params
        if (Option.isNone(maybeParams)) {
          return HttpServerResponse.text('Needs a valid videoId', {
            status: 400,
          })
        }
        const { videoId } = maybeParams.value
        // Made in a fiber of its own, so a request that gives up leaves it going.
        const fiber = yield* Effect.forkDetach(songMontage.montage(videoId))
        return yield* Fiber.join(fiber).pipe(
          Effect.timeoutOption(MONTAGE_WAIT),
          Effect.matchEffect({
            onFailure: error =>
              Effect.succeed(
                HttpServerResponse.text(error.message, {
                  status: statusOf(error),
                }),
              ),
            onSuccess: Option.match({
              onNone: () =>
                Effect.succeed(
                  HttpServerResponse.text('The montage is still being made', {
                    status: 503,
                  }),
                ),
              onSome: montage =>
                encodeMontage(montage).pipe(
                  Effect.orElseSucceed(() =>
                    HttpServerResponse.text('Could not encode the montage', {
                      status: 500,
                    }),
                  ),
                ),
            }),
          }),
        )
      }),
    )

    yield* router.add(
      'GET',
      '/tv/montage.jpg',
      Effect.gen(function* () {
        const maybeParams = yield* params
        if (Option.isNone(maybeParams)) {
          return HttpServerResponse.text('Needs a valid videoId', {
            status: 400,
          })
        }
        const maybeFile = yield* songMontage.atlasFile(
          maybeParams.value.videoId,
        )
        if (Option.isNone(maybeFile)) {
          return HttpServerResponse.text('No montage for this song', {
            status: 404,
          })
        }
        return yield* HttpServerResponse.file(maybeFile.value, {
          contentType: 'image/jpeg',
          headers: { 'cache-control': 'public, max-age=86400' },
        }).pipe(
          Effect.orElseSucceed(() =>
            HttpServerResponse.text('No montage for this song', {
              status: 404,
            }),
          ),
        )
      }),
    )
  }),
)
