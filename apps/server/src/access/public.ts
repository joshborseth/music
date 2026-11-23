import { Database } from 'bun:sqlite'
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
} from 'effect'
import { randomBytes } from 'node:crypto'

import { BunHttpServer } from '@effect/platform-bun'

import { type Accounts, makeAccounts } from './accounts.ts'

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

/** Where invite links point when no public address is set. */
const FALLBACK_ORIGIN = 'http://localhost'

export class AccountsService extends Context.Service<
  AccountsService,
  Accounts
>()('music/Accounts') {}

/**
 * The secret that signs session cookies: `BETTER_AUTH_SECRET`, or one made
 * on first start and kept beside the accounts, readable only by this user.
 */
const sessionSecret = (dataDir: string) =>
  Effect.gen(function* () {
    const fromEnv = yield* Config.option(Config.Redacted('BETTER_AUTH_SECRET'))
    if (Option.isSome(fromEnv)) return Redacted.value(fromEnv.value)
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(dataDir, 'auth-secret')
    const existing = yield* fs.readFileString(file).pipe(Effect.option)
    if (Option.isSome(existing) && existing.value.trim().length >= 32) {
      return existing.value.trim()
    }
    const secret = randomBytes(48).toString('base64url')
    yield* fs.writeFileString(file, `${secret}\n`, { mode: 0o600 })
    return secret
  }).pipe(Effect.orDie)

/** The accounts, in `AUTH_DB_PATH`, open for the life of the server. */
export const AccountsLive = Layer.effect(AccountsService)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
    const dataDir = path.join(home, '.local', 'share', 'music')
    const file = yield* Config.String('AUTH_DB_PATH').pipe(
      Config.withDefault(path.join(dataDir, 'auth.sqlite')),
    )
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.orDie)
    const secret = yield* sessionSecret(path.dirname(file))
    const origin = yield* Config.String('PUBLIC_ORIGIN').pipe(
      Config.withDefault(FALLBACK_ORIGIN),
    )
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const database = new Database(file, { create: true })
        database.run('PRAGMA journal_mode = WAL')
        return database
      }),
      database => Effect.sync(() => database.close()),
    )
    const accounts = yield* makeAccounts(db, { secret, origin }).pipe(
      Effect.orDie,
    )
    return AccountsService.of(accounts)
  }),
)

/**
 * The public listener, on loopback only: nothing reaches it but Funnel's
 * proxy on this machine, so it never bypasses the gate from the network.
 */
export const publicServer = (port: number) =>
  BunHttpServer.layer({ hostname: '127.0.0.1', port })
