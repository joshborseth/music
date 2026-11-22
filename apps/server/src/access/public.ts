import { Config, Effect, FileSystem, Path } from 'effect'

import { BunHttpServer } from '@effect/platform-bun'

import { makeAccessStore, openAccessDatabase } from './store.ts'

/**
 * `PUBLIC_PORT` and `PUBLIC_ORIGIN`, when both are set: the listener that
 * Tailscale Funnel forwards the internet to, and the address people use.
 */
export const PublicAccessConfig = Config.option(
  Config.all({
    port: Config.Port('PUBLIC_PORT'),
    origin: Config.String('PUBLIC_ORIGIN'),
  }),
)

/** The invites and signed-in devices, in `ACCESS_DB_PATH`. */
export const openAccessStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
  const file = yield* Config.String('ACCESS_DB_PATH').pipe(
    Config.withDefault(
      path.join(home, '.local', 'share', 'music', 'access.sqlite'),
    ),
  )
  yield* fs
    .makeDirectory(path.dirname(file), { recursive: true })
    .pipe(Effect.orDie)
  const db = yield* Effect.acquireRelease(
    Effect.sync(() => openAccessDatabase(file)),
    database => Effect.sync(() => database.close()),
  )
  return makeAccessStore(db, Date.now)
})

/**
 * The public listener, on loopback only: nothing reaches it but Funnel's
 * proxy on this machine, so it never bypasses the gate from the network.
 */
export const publicServer = (port: number) =>
  BunHttpServer.layer({ hostname: '127.0.0.1', port })
