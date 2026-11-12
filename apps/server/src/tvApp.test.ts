import { afterAll, describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect, Fiber, Layer, SubscriptionRef } from 'effect'
import { HttpRouter } from 'effect/http'
import { TestClock } from 'effect/testing'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunServices } from '@effect/platform-bun'

import {
  type AfterUpdate,
  TvVersionRoute,
  buildPathFor,
  reopenAfterUpdate,
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
