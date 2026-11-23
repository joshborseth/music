import { Database } from 'bun:sqlite'
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Scope,
  Semaphore,
} from 'effect'

import { HOME_OWNER } from '../access/owner.ts'
import {
  PlaylistStore,
  type PlaylistStoreShape,
  makePlaylistStore,
} from './store.ts'

/*
 * One library per account: playlists, Liked songs, saved albums, followed
 * artists, and the play history. The owner's (`home`, the TV's too) is the
 * `PlaylistStore` the server always had, so the library from before
 * accounts stays theirs; everyone else's is a file of its own under
 * `LIBRARIES_DIR`, opened on first use and kept open.
 */

export class Libraries extends Context.Service<
  Libraries,
  {
    /** The library of `owner`: an account's id, or `home`. */
    readonly of: (owner: string) => Effect.Effect<PlaylistStoreShape>
    /** Close and delete an account's library, once the account is gone. */
    readonly remove: (owner: string) => Effect.Effect<void>
  }
>()('music/Libraries') {}

/** Account ids are Better Auth's: letters and digits. Anything else is refused. */
const isSafeId = (owner: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(owner)

export const LibrariesLive = Layer.effect(Libraries)(
  Effect.gen(function* () {
    const homeStore = yield* PlaylistStore
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const scope = yield* Scope.Scope
    const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
    const dir = yield* Config.String('LIBRARIES_DIR').pipe(
      Config.withDefault(
        path.join(home, '.local', 'share', 'music', 'libraries'),
      ),
    )
    const open = new Map<
      string,
      { readonly store: PlaylistStoreShape; readonly db: Database }
    >()
    const lock = yield* Semaphore.make(1)
    const fileOf = (owner: string) => path.join(dir, `${owner}.sqlite`)

    const of = (owner: string): Effect.Effect<PlaylistStoreShape> =>
      owner === HOME_OWNER
        ? Effect.succeed(homeStore)
        : lock.withPermits(1)(
            Effect.gen(function* () {
              const existing = open.get(owner)
              if (existing !== undefined) return existing.store
              if (!isSafeId(owner)) {
                return yield* Effect.die(new Error('Not an account id'))
              }
              yield* fs
                .makeDirectory(dir, { recursive: true })
                .pipe(Effect.orDie)
              const db = yield* Effect.acquireRelease(
                Effect.sync(
                  () =>
                    new Database(fileOf(owner), { create: true, strict: true }),
                ),
                database =>
                  Effect.sync(() => {
                    if (open.get(owner)?.db === database) open.delete(owner)
                    database.close()
                  }),
              ).pipe(Scope.provide(scope))
              const store = makePlaylistStore(db, {
                now: () => Date.now(),
                newId: () => crypto.randomUUID(),
              })
              open.set(owner, { store, db })
              return store
            }),
          )

    const remove = (owner: string): Effect.Effect<void> =>
      owner === HOME_OWNER || !isSafeId(owner)
        ? Effect.void
        : lock.withPermits(1)(
            Effect.gen(function* () {
              const existing = open.get(owner)
              if (existing !== undefined) {
                open.delete(owner)
                existing.db.close()
              }
              for (const suffix of ['', '-wal', '-shm']) {
                yield* fs
                  .remove(`${fileOf(owner)}${suffix}`)
                  .pipe(Effect.ignore)
              }
            }),
          )

    return Libraries.of({ of, remove })
  }),
)
