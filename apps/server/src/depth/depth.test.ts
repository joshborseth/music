import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
} from 'effect'
import { HttpRouter } from 'effect/http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

import { BunServices } from '@effect/platform-bun'

import { makeDepthCache } from './cache.ts'
import { ensureModel, fileSha256 } from './model.ts'
import {
  DEPTH_SIDE,
  INPUT_SIDE,
  quantile,
  shrink,
  toDepthMap,
  toInputTensor,
} from './process.ts'
import { DepthRoutes } from './routes.ts'
import {
  CoverDepth,
  CoverDepthLive,
  DepthError,
  depthKey,
  depthPngOf,
  makeCoverDepth,
} from './service.ts'

const COVER = 'https://lh3.googleusercontent.com/abc=w120-h120-l90-rj'
const COVER_KEY = 'https://lh3.googleusercontent.com/abc=w544-h544-l90-rj'

describe('preparing a cover for the model', () => {
  test('makes three normalized planes, red first', () => {
    const side = 2
    const rgb = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255, 0, 124, 116, 104])
    const tensor = toInputTensor(rgb, side)
    expect(tensor.length).toBe(12)
    // Red at full, in the red plane: (1 - 0.485) / 0.229.
    expect(tensor[0]).toBeCloseTo((1 - 0.485) / 0.229, 5)
    // No green in the first pixel: (0 - 0.456) / 0.224, in the green plane.
    expect(tensor[4]).toBeCloseTo(-0.456 / 0.224, 5)
    // The last pixel is about ImageNet's mean colour: near 0 everywhere.
    for (const plane of [0, 1, 2]) {
      expect(Math.abs(tensor[plane * 4 + 3] ?? 9)).toBeLessThan(0.02)
    }
  })

  test('refuses a picture of the wrong size', () => {
    expect(() => toInputTensor(new Uint8Array(10))).toThrow()
  })
})

describe("making the model's answer a depth map", () => {
  test('shrinking keeps a flat map flat and averages the rest', () => {
    expect(Array.from(shrink(new Float32Array(9).fill(3), 3, 2))).toEqual([
      3, 3, 3, 3,
    ])
    const halves = Float32Array.from({ length: 16 }, (_, i) =>
      i % 4 < 2 ? 0 : 4,
    )
    expect(Array.from(shrink(halves, 4, 2))).toEqual([0, 4, 0, 4])
  })

  test('the quantile ignores a speck', () => {
    const values = new Float32Array(1000).fill(1)
    values[0] = 1e6
    expect(quantile(values, 0.995)).toBe(1)
  })

  test('near is bright, far is dark, at the TV cover size', () => {
    // Larger is nearer: a ramp from the top (far) to the bottom (near).
    const side = INPUT_SIDE
    const raw = Float32Array.from(
      { length: side * side },
      (_, i) => Math.floor(i / side) / side,
    )
    const map = toDepthMap(raw)
    expect(map.length).toBe(DEPTH_SIDE * DEPTH_SIDE)
    const row = (y: number) => map[y * DEPTH_SIDE + 128] ?? -1
    expect(row(0)).toBeLessThan(5)
    expect(row(DEPTH_SIDE - 1)).toBeGreaterThan(250)
    for (let y = 1; y < DEPTH_SIDE; y++) {
      expect(row(y)).toBeGreaterThanOrEqual(row(y - 1))
    }
  })

  test('a stray hot pixel does not squash the rest', () => {
    const side = INPUT_SIDE
    const raw = Float32Array.from({ length: side * side }, (_, i) =>
      i % side < side / 2 ? 1 : 2,
    )
    raw[side * 10 + 10] = 500
    const map = toDepthMap(raw)
    // The two halves still span the range.
    expect(map[128 * DEPTH_SIDE + 10]).toBeLessThan(10)
    expect(map[128 * DEPTH_SIDE + 245]).toBeGreaterThan(245)
  })

  test('a map without depth is a flat grey', () => {
    const map = toDepthMap(new Float32Array(INPUT_SIDE * INPUT_SIDE).fill(2))
    expect(new Set(map)).toEqual(new Set([128]))
  })

  test('the PNG is a grayscale square the TV can read back', async () => {
    const depth = Uint8Array.from({ length: DEPTH_SIDE * DEPTH_SIDE }, (_, i) =>
      Math.floor(i / DEPTH_SIDE),
    )
    const png = await Effect.runPromise(depthPngOf('key', depth))
    const meta = await sharp(png).metadata()
    expect([meta.width, meta.height, meta.channels]).toEqual([256, 256, 1])
    const data = await sharp(png).extractChannel(0).raw().toBuffer()
    expect(data[200 * DEPTH_SIDE + 7]).toBe(200)
  })
})

describe('the depth cache', () => {
  const png = (bytes: number, fill = 1) => new Uint8Array(bytes).fill(fill)

  test('keeps a map by URL, only for its version', () => {
    const db = new Database(':memory:', { strict: true })
    const cache = makeDepthCache(db, 1000, 1)
    expect(Option.isNone(cache.get('a', 1))).toBe(true)
    cache.put('a', png(10, 7), 1)
    expect(Option.getOrThrow(cache.get('a', 2))).toEqual(png(10, 7))
    // A newer version works it out again.
    const newer = makeDepthCache(db, 1000, 2)
    expect(Option.isNone(newer.get('a', 3))).toBe(true)
  })

  test('drops the maps used longest ago past its cap', () => {
    const cache = makeDepthCache(
      new Database(':memory:', { strict: true }),
      250,
    )
    cache.put('a', png(100), 1)
    cache.put('b', png(100), 2)
    // Reading `a` makes it the most recently used...
    expect(Option.isSome(cache.get('a', 3))).toBe(true)
    // ...so a third map pushes out `b`.
    cache.put('c', png(100), 4)
    expect(Option.isSome(cache.get('a', 5))).toBe(true)
    expect(Option.isNone(cache.get('b', 5))).toBe(true)
    expect(Option.isSome(cache.get('c', 5))).toBe(true)
    expect(cache.totalBytes()).toBe(200)
  })
})

describe('which covers have a depth', () => {
  test('artwork at any size shares one entry, fetched just over the model size', () => {
    expect(depthKey(COVER)).toEqual(Option.some(COVER_KEY))
    expect(
      depthKey('https://lh3.googleusercontent.com/abc=w60-h60-l90-rj'),
    ).toEqual(Option.some(COVER_KEY))
  })

  test('only the artwork hosts the server relays', () => {
    expect(Option.isNone(depthKey('https://example.com/a.jpg'))).toBe(true)
    expect(Option.isNone(depthKey('http://lh3.googleusercontent.com/a'))).toBe(
      true,
    )
    expect(Option.isNone(depthKey('not a url'))).toBe(true)
  })
})

describe('the depth service', () => {
  const service = (
    makeDepth: (key: string) => Effect.Effect<Uint8Array, DepthError>,
  ) => {
    const cache = makeDepthCache(new Database(':memory:', { strict: true }))
    return makeCoverDepth(cache, makeDepth, () => Date.now())
  }

  test('works a cover out once for everyone asking, then keeps it', async () => {
    const asked: Array<string> = []
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const depth = yield* service(key =>
            Effect.sync(() => asked.push(key)).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as(new Uint8Array([1, 2, 3])),
            ),
          )
          const both = yield* Effect.forkChild(
            Effect.all([depth.depthPng(COVER), depth.depthPng(COVER)], {
              concurrency: 'unbounded',
            }),
          )
          yield* Effect.yieldNow
          yield* Deferred.succeed(gate, undefined)
          const [first, second] = yield* Fiber.join(both)
          const again = yield* depth.depthPng(COVER)
          return [first, second, again]
        }),
      ),
    )
    expect(asked).toEqual([COVER_KEY])
    expect(result.map(png => Array.from(png))).toEqual([
      [1, 2, 3],
      [1, 2, 3],
      [1, 2, 3],
    ])
  })

  test('remembers a failure for a while', async () => {
    let tries = 0
    const exits = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const depth = yield* service(key =>
            Effect.sync(() => {
              tries += 1
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new DepthError({
                    url: key,
                    reason: 'NoModel',
                    message: 'no model',
                  }),
                ),
              ),
            ),
          )
          const first = yield* Effect.exit(depth.depthPng(COVER))
          const second = yield* Effect.exit(depth.depthPng(COVER))
          return [first, second]
        }),
      ),
    )
    expect(tries).toBe(1)
    expect(exits.every(Exit.isFailure)).toBe(true)
  })

  test('refuses what is not artwork without working', async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const depth = yield* service(() => Effect.die('should not run'))
          return yield* Effect.exit(depth.depthPng('https://example.com/a'))
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test('warming works the cover out in the background', async () => {
    const asked: Array<string> = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>()
          const depth = yield* service(key =>
            Effect.sync(() => asked.push(key)).pipe(
              Effect.andThen(Deferred.succeed(done, undefined)),
              Effect.as(new Uint8Array([9])),
            ),
          )
          yield* depth.warm(COVER)
          yield* depth.warm(COVER)
          yield* depth.warm('https://example.com/nope.jpg')
          yield* Deferred.await(done)
          // Known now: warming again does nothing.
          yield* depth.warm(COVER)
          yield* Effect.sleep('20 millis')
        }),
      ),
    )
    expect(asked).toEqual([COVER_KEY])
  })
})

describe('the depth model file', () => {
  const dir = mkdtemp(join(tmpdir(), 'depth-model-'))
  afterAll(async () => rm(await dir, { recursive: true, force: true }))

  test('is used only when its hash matches', async () => {
    const file = join(await dir, 'model.onnx')
    await writeFile(file, 'weights')
    const sha256 = await Effect.runPromise(fileSha256(file))
    expect(sha256).toBe(
      new Bun.CryptoHasher('sha256').update('weights').digest('hex'),
    )
    const good = await Effect.runPromise(
      Effect.exit(ensureModel(file, false, { url: 'unused', sha256 })),
    )
    expect(good).toEqual(Exit.succeed(file))
    const bad = await Effect.runPromise(
      Effect.exit(ensureModel(file, false, { url: 'unused', sha256: '00' })),
    )
    expect(Exit.isFailure(bad)).toBe(true)
  })

  test('is not downloaded when that is off', async () => {
    const missing = join(await dir, 'missing.onnx')
    const exit = await Effect.runPromise(
      Effect.exit(ensureModel(missing, false)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test('a download that fails is an error, and leaves nothing behind', async () => {
    const missing = join(await dir, 'unreachable.onnx')
    const exit = await Effect.runPromise(
      Effect.exit(
        ensureModel(missing, true, {
          url: 'http://127.0.0.1:9/model.onnx',
          sha256: '00',
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Bun.file(missing).exists()).toBe(false)
  })

  test('the server starts without it, and only Diorama goes without', async () => {
    const home = await dir
    const config = ConfigProvider.fromUnknown({
      HOME: home,
      DEPTH_DB_PATH: join(home, 'data', 'depth.sqlite'),
      DEPTH_MODEL_PATH: join(home, 'models', 'none.onnx'),
      DEPTH_MODEL_DOWNLOAD: 'false',
    })
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const depth = yield* CoverDepth
        yield* depth.warm(COVER)
        return yield* Effect.flip(depth.depthPng(COVER))
      }).pipe(
        Effect.provide(
          CoverDepthLive.pipe(
            Layer.provide(BunServices.layer),
            Layer.provide(ConfigProvider.layer(config)),
          ),
        ),
        Effect.scoped,
      ),
    )
    expect(error.reason).toBe('NoModel')
  })
})

describe('GET /tv/depth', () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const { handler, dispose } = HttpRouter.toWebHandler(
    DepthRoutes.pipe(
      Layer.provide(
        Layer.succeed(CoverDepth)(
          CoverDepth.of({
            depthPng: url =>
              url.includes('nomodel')
                ? Effect.fail(
                    new DepthError({ url, reason: 'NoModel', message: 'none' }),
                  )
                : url.startsWith('https://example.com')
                  ? Effect.fail(
                      new DepthError({
                        url,
                        reason: 'NotArtwork',
                        message: 'Not an artwork URL',
                      }),
                    )
                  : Effect.succeed(png),
            warm: () => Effect.void,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  )
  afterAll(() => dispose())
  const get = (query: string) =>
    handler(new Request(`http://tv/tv/depth${query}`))

  test('answers the cover depth as a PNG', async () => {
    const response = await get(`?url=${encodeURIComponent(COVER)}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png)
  })

  test('needs a url', async () => {
    expect((await get('')).status).toBe(400)
    expect((await get('?url=')).status).toBe(400)
  })

  test('says what went wrong', async () => {
    const notArtwork = await get(
      `?url=${encodeURIComponent('https://example.com/a.jpg')}`,
    )
    expect(notArtwork.status).toBe(400)
    const noModel = await get(
      `?url=${encodeURIComponent('https://lh3.googleusercontent.com/nomodel')}`,
    )
    expect(noModel.status).toBe(404)
  })
})
