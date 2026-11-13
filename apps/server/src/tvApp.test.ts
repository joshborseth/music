import { afterAll, describe, expect, test } from 'bun:test'
import {
  ConfigProvider,
  Effect,
  Fiber,
  Layer,
  Logger,
  SubscriptionRef,
} from 'effect'
import { HttpRouter } from 'effect/http'
import { TestClock } from 'effect/testing'
import { readdirSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunServices } from '@effect/platform-bun'

import { encodePng } from './testing/png.ts'
import {
  type AfterUpdate,
  TvCaptureRoute,
  TvVersionRoute,
  buildPathFor,
  logTvFrame,
  logTvReport,
  reopenAfterUpdate,
  tvLogLevel,
} from './tvApp.ts'

const directory = mkdtempSync(join(tmpdir(), 'music-tv-version-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const getVersion = async (config: Record<string, string>) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    TvVersionRoute.pipe(
      Layer.provide(BunServices.layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
    ),
    { disableLogger: true },
  )
  try {
    const response = await handler(new Request('http://tv.test/tv/version'))
    return { status: response.status, body: await response.json() }
  } finally {
    await dispose()
  }
}

describe('GET /tv/version', () => {
  test('answers the build written next to the APK, trimmed', async () => {
    const apk = join(directory, 'music-tv.apk')
    writeFileSync(buildPathFor(apk), '3f2a9c1b7d4e-202611120430\n')
    expect(await getVersion({ TV_APK_PATH: apk })).toEqual({
      status: 200,
      body: { build: '3f2a9c1b7d4e-202611120430' },
    })
  })

  test('answers null when nothing has been built', async () => {
    expect(
      await getVersion({ TV_APK_PATH: join(directory, 'missing.apk') }),
    ).toEqual({ status: 200, body: { build: null } })
  })

  test('answers null when the server serves no APK', async () => {
    expect(await getVersion({})).toEqual({ status: 200, body: { build: null } })
  })

  test('answers null for an empty build file', async () => {
    const apk = join(directory, 'empty.apk')
    writeFileSync(buildPathFor(apk), '  \n')
    expect(await getVersion({ TV_APK_PATH: apk })).toEqual({
      status: 200,
      body: { build: null },
    })
  })
})

describe('TV screenshots', () => {
  const frames = join(directory, 'frames')
  const withCapture = async (
    run: (
      call: (
        method: string,
        path: string,
        body?: Uint8Array<ArrayBuffer>,
      ) => Promise<number>,
    ) => Promise<void>,
  ) => {
    const { handler, dispose } = HttpRouter.toWebHandler(
      TvCaptureRoute.pipe(
        Layer.provide(BunServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ TV_FRAMES_DIR: frames }),
          ),
        ),
      ),
      { disableLogger: true },
    )
    try {
      await run(async (method, path, body) => {
        const response = await handler(
          new Request(`http://tv.test${path}`, {
            method,
            body: body ?? null,
            headers: body === undefined ? {} : { 'content-type': 'image/png' },
          }),
        )
        return response.status
      })
    } finally {
      await dispose()
    }
  }

  test('the TV sends as many as were asked for, and they are saved', async () => {
    await withCapture(async call => {
      expect(await call('GET', '/tv/capture')).toBe(204)
      expect(await call('POST', '/tv/frame', new Uint8Array([1]))).toBe(409)
      expect(await call('POST', '/tv/capture?count=2')).toBe(200)
      expect(await call('GET', '/tv/capture')).toBe(200)
      expect(await call('GET', '/tv/capture')).toBe(200)
      expect(await call('GET', '/tv/capture')).toBe(204)
      expect(
        await call('POST', '/tv/frame', new Uint8Array([60, 104, 116, 109])),
      ).toBe(415)
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
      expect(await call('POST', '/tv/frame', png)).toBe(204)
    })
    expect(
      readdirSync(frames).filter(name => name.endsWith('.png')),
    ).toHaveLength(1)
  })

  test('a black frame is saved too', async () => {
    const before = readdirSync(frames).length
    await withCapture(async call => {
      expect(await call('POST', '/tv/capture')).toBe(200)
      const black = encodePng(8, 6, 4, () => [0, 0, 0, 255])
      expect(await call('POST', '/tv/frame', black)).toBe(204)
    })
    expect(readdirSync(frames)).toHaveLength(before + 1)
  })
})

describe('logTvReport', () => {
  test('logs a line at the level the TV names, a crash as an error', async () => {
    const seen: Array<[string, unknown]> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* logTvReport('info', 'visuals: 60 fps')
        yield* logTvReport('warning', 'update: no room')
        yield* logTvReport(null, "panic in thread 'main'")
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, message }) => {
              seen.push([logLevel, message])
            }),
          ]),
        ),
      ),
    )
    expect(seen).toEqual([
      ['Info', ['TV app', 'visuals: 60 fps']],
      ['Warn', ['TV app', 'update: no room']],
      ['Error', ['TV app', "panic in thread 'main'"]],
    ])
  })
})

describe('logTvFrame', () => {
  test('logs a black or clear frame as an error, anything else as information', async () => {
    const seen: Array<[string, unknown]> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* logTvFrame(
          'black.png',
          encodePng(8, 6, 4, () => [0, 0, 0, 255]),
        )
        yield* logTvFrame(
          'clear.png',
          encodePng(8, 6, 4, () => [9, 9, 9, 0]),
        )
        yield* logTvFrame(
          'lit.png',
          encodePng(8, 6, 3, (x, y) => [x * 30, y * 40, 90]),
        )
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, message }) => {
              seen.push([logLevel, message])
            }),
          ]),
        ),
      ),
    )
    expect(seen).toEqual([
      [
        'Error',
        ['TV sent a black frame: the screen may be blank', 'black.png'],
      ],
      [
        'Error',
        ['TV sent a black frame: the screen may be blank', 'clear.png'],
      ],
      ['Info', ['A screenshot from the TV', 'lit.png']],
    ])
  })
})

describe('tvLogLevel', () => {
  test('follows the level the TV names', () => {
    expect(tvLogLevel('info', 'anything')).toBe('Info')
    expect(tvLogLevel('warning', 'anything')).toBe('Warning')
    expect(tvLogLevel('error', 'visuals: could not start')).toBe('Error')
  })

  test('keeps crashes at error', () => {
    expect(tvLogLevel(null, "panic in thread 'main': boom")).toBe('Error')
    expect(tvLogLevel('loud', "panic in thread 'main': boom")).toBe('Error')
  })

  test("reads older TVs' visuals reports as information", () => {
    expect(
      tvLogLevel(null, 'visuals: 1920×1080 screen, 58.2 fps, 3.0% late'),
    ).toBe('Info')
    expect(tvLogLevel(null, 'visuals: GPU Mali-G52 (OpenGL ES 3.2)')).toBe(
      'Info',
    )
    expect(tvLogLevel(null, 'visuals: could not start on Mali-G52')).toBe(
      'Error',
    )
    expect(tvLogLevel(null, 'visuals: GL error 0x0505 in the visuals')).toBe(
      'Error',
    )
  })
})

describe('buildPathFor', () => {
  test('swaps the .apk extension for .build', () => {
    expect(buildPathFor('/srv/dist/music-tv.apk')).toBe(
      '/srv/dist/music-tv.build',
    )
  })
})

/**
 * Runs `reopenAfterUpdate` against a TV that starts online, lets `script`
 * move it, and reports the outcome and how many times it was reopened.
 */
const afterUpdate = (
  script: (
    online: SubscriptionRef.SubscriptionRef<boolean>,
  ) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const online = yield* SubscriptionRef.make(true)
    let reopened = 0
    const fiber = yield* reopenAfterUpdate(
      SubscriptionRef.changes(online),
      Effect.sync(() => {
        reopened += 1
      }),
    ).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* script(online)
    const outcome: AfterUpdate = yield* Fiber.join(fiber)
    return { outcome, reopened }
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)

describe('reopenAfterUpdate', () => {
  test('reopens a TV that does not come back by itself', async () => {
    expect(
      await afterUpdate(online =>
        Effect.gen(function* () {
          yield* SubscriptionRef.set(online, false)
          yield* Effect.yieldNow
          yield* TestClock.adjust('21 seconds')
        }),
      ),
    ).toEqual({ outcome: 'Reopened', reopened: 1 })
  })

  test('leaves a TV alone that reconnects in time', async () => {
    expect(
      await afterUpdate(online =>
        Effect.gen(function* () {
          yield* SubscriptionRef.set(online, false)
          yield* Effect.yieldNow
          yield* TestClock.adjust('5 seconds')
          yield* SubscriptionRef.set(online, true)
          yield* Effect.yieldNow
          yield* TestClock.adjust('30 seconds')
        }),
      ),
    ).toEqual({ outcome: 'Reconnected', reopened: 0 })
  })

  test('gives up when the TV never drops off', async () => {
    expect(await afterUpdate(() => TestClock.adjust('11 minutes'))).toEqual({
      outcome: 'NeverLeft',
      reopened: 0,
    })
  })
})
