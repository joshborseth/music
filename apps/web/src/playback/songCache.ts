import { Array, Data, Effect, Option } from 'effect'

import { Session } from '@music/shared'

/*
 * Songs this phone has played or is about to play, kept in Cache Storage.
 * A cached song plays from a local Blob, so it starts and seeks instantly
 * with no network at all. Only this module touches the cache.
 */

const CACHE_NAME = 'music-songs-v1'
/** About 250 MB of AAC at YouTube Music's 128 kbps. */
const MAX_SONGS = 50

class SongCacheError extends Data.TaggedError('SongCacheError')<{
  readonly message: string
}> {}

const songUrl = (videoId: string): string =>
  new URL(Session.audioPath(videoId), globalThis.location.origin).toString()

/** Cache Storage only exists on secure origins (HTTPS or localhost). */
const openCache = Effect.tryPromise({
  try: () => {
    if (!('caches' in globalThis)) {
      throw new SongCacheError({ message: 'Cache Storage is unavailable' })
    }
    return globalThis.caches.open(CACHE_NAME)
  },
  catch: () => new SongCacheError({ message: 'Cache Storage is unavailable' }),
})

/** The cached song as a Blob, if this phone has it. */
export const cachedSong = (
  videoId: string,
): Effect.Effect<Option.Option<Blob>> =>
  openCache.pipe(
    Effect.flatMap(cache =>
      Effect.tryPromise({
        try: async () => {
          const response = await cache.match(songUrl(videoId))
          return response === undefined ? undefined : await response.blob()
        },
        catch: () =>
          new SongCacheError({ message: 'Could not read the cache' }),
      }),
    ),
    Effect.map(Option.fromNullishOr),
    Effect.orElseSucceed(() => Option.none()),
  )

/** Forget the oldest songs once the cache holds more than it should. */
const trim = (cache: Cache) =>
  Effect.tryPromise({
    try: async () => {
      const keys = await cache.keys()
      await Promise.all(
        Array.map(Array.take(keys, Math.max(0, keys.length - MAX_SONGS)), key =>
          cache.delete(key),
        ),
      )
    },
    catch: () => new SongCacheError({ message: 'Could not trim the cache' }),
  })

const downloading = new Set<string>()

/** Download a whole song into the cache, unless it is there or on its way. */
export const cacheSong = (videoId: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (downloading.has(videoId)) {
      return
    }
    const cache = yield* openCache
    const isCached = yield* Effect.tryPromise({
      try: async () => (await cache.match(songUrl(videoId))) !== undefined,
      catch: () => new SongCacheError({ message: 'Could not read the cache' }),
    })
    if (isCached) {
      return
    }
    downloading.add(videoId)
    yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(songUrl(videoId))
        if (response.status !== 200) {
          throw new SongCacheError({
            message: `The server answered ${response.status}`,
          })
        }
        await cache.put(songUrl(videoId), response)
      },
      catch: () =>
        new SongCacheError({ message: 'Could not download the song' }),
    }).pipe(Effect.ensuring(Effect.sync(() => downloading.delete(videoId))))
    yield* trim(cache)
  }).pipe(Effect.ignore)
