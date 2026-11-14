import { Effect, Layer } from 'effect'

import { BunServices } from '@effect/platform-bun'

import { CoverDepth, CoverDepthLive } from '../src/depth/service.ts'

/*
 * Works out covers' depth the way the server does, and writes each as a
 * PNG, to look at them or to load them in the visuals lab:
 *
 *   bun scripts/cover-depth.ts <out dir> <artwork url>...
 *
 * It uses the server's depth cache and model (`DEPTH_DB_PATH`,
 * `DEPTH_MODEL_PATH`), downloading the model when it is missing.
 */

const [outDir, ...urls] = process.argv.slice(2)
if (outDir === undefined || urls.length === 0) {
  console.error('Usage: bun scripts/cover-depth.ts <out dir> <artwork url>...')
  process.exit(2)
}

const program = Effect.gen(function* () {
  const depth = yield* CoverDepth
  yield* Effect.forEach(
    urls,
    (url, index) =>
      Effect.gen(function* () {
        const started = Date.now()
        const png = yield* depth.depthPng(url)
        const file = `${outDir}/depth-${index}.png`
        yield* Effect.promise(() => Bun.write(file, png))
        console.log(`${file}  ${Date.now() - started} ms  ${url}`)
      }).pipe(
        Effect.catchTag('DepthError', error =>
          Effect.sync(() => console.error(`${url}: ${error.message}`)),
        ),
      ),
    { discard: true },
  )
})

await Effect.runPromise(
  program.pipe(
    Effect.provide(CoverDepthLive.pipe(Layer.provide(BunServices.layer))),
    Effect.scoped,
  ),
)
