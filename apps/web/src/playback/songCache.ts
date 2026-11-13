import { Array, Data, Effect, Option, Order, Schema } from 'effect'

import { Session } from '@music/shared'

import {
  DOWNLOADS_KEY,
  type DownloadedCollection,
  DownloadsJson,
  type StorageEstimate,
  pinnedVideoIds,
} from '../downloads/domain'

/*
 * Songs this phone has played or is about to play, kept in Cache Storage.
 * A cached song plays from a local Blob, so it starts and seeks instantly
 * with no network at all. Only this module touches the cache.
 *
 * A small index in localStorage remembers each song's size, play count,
 * and last use. When the cache passes its size limit, songs played once or
 * twice go before favorites, least recently used first. The song playing
 * and the ones queued next are never dropped.
 *
 * Downloaded albums and playlists pin their songs: those are never trimmed
 * and do not count toward the limit, which is for the songs kept on their
 * own. The list of downloads lives here too, beside the index.
 */

const CACHE_NAME = 'music-songs-v1'
const INDEX_KEY = 'music:song-cache-index'
/** About 125 songs of AAC at YouTube Music's 128 kbps. */
const MAX_BYTES = 500 * 1024 * 1024
/** Trimming stops once the cache is this far under its limit. */
const TRIM_TO_FRACTION = 0.9
/** For songs cached before the index existed. */
const ASSUMED_SONG_BYTES = 5 * 1024 * 1024
/** A song played this many times on this phone is a favorite. */
export const FAVORITE_PLAYS = 3

class SongCacheError extends Data.TaggedError('SongCacheError')<{
  readonly message: string
}> {}

// INDEX

const SongUse = Schema.Struct({
  bytes: Schema.Number,
  plays: Schema.Number,
  lastUsedAt: Schema.Number,
})
type SongUse = typeof SongUse.Type
const SongIndex = Schema.Record(Schema.String, SongUse)
type SongIndex = typeof SongIndex.Type
const decodeSongIndex = Schema.decodeUnknownOption(
  Schema.fromJsonString(SongIndex),
)

const readIndex = (): SongIndex => {
  try {
    return Option.getOrElse(
      decodeSongIndex(globalThis.localStorage.getItem(INDEX_KEY) ?? '{}'),
      () => ({}),
    )
  } catch {
    return {}
  }
}

const writeIndex = (index: SongIndex): void => {
  try {
    globalThis.localStorage.setItem(INDEX_KEY, JSON.stringify(index))
  } catch {
    // Without storage the cache still works; it just trims by age alone.
  }
}

const updateUse = (
  videoId: string,
  change: (use: SongUse) => SongUse,
): void => {
  const index = readIndex()
  const use = index[videoId] ?? {
    bytes: ASSUMED_SONG_BYTES,
    plays: 0,
    lastUsedAt: 0,
  }
  writeIndex({ ...index, [videoId]: change(use) })
}

/** Count a play on this phone, so favorites stay cached longest. */
export const recordPlay = (videoId: string): Effect.Effect<void> =>
  Effect.sync(() =>
    updateUse(videoId, use => ({
      ...use,
      plays: use.plays + 1,
      lastUsedAt: Date.now(),
    })),
  )

/**
 * Which cached songs to delete so the cache fits: nothing protected or
 * pinned, songs that are not favorites first, then the least recently used.
 * Pinned songs (downloads) do not count toward `maxBytes` either.
 */
export const songsToTrim = (
  videoIds: ReadonlyArray<string>,
  index: SongIndex,
  protectedIds: ReadonlySet<string>,
  maxBytes: number,
  pinnedIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> => {
  const bytes = (videoId: string) => index[videoId]?.bytes ?? ASSUMED_SONG_BYTES
  const unpinned = Array.filter(videoIds, id => !pinnedIds.has(id))
  const total = Array.reduce(unpinned, 0, (sum, id) => sum + bytes(id))
  if (total <= maxBytes) return []
  const candidates = Array.sort(
    Array.filter(unpinned, id => !protectedIds.has(id)),
    Order.combine(
      Order.mapInput(
        Order.Boolean,
        (id: string) => (index[id]?.plays ?? 0) >= FAVORITE_PLAYS,
      ),
      Order.mapInput(Order.Number, (id: string) => index[id]?.lastUsedAt ?? 0),
    ),
  )
  const target = maxBytes * TRIM_TO_FRACTION
  let remaining = total
  return Array.takeWhile(candidates, id => {
    if (remaining <= target) return false
    remaining -= bytes(id)
    return true
  })
}

// DOWNLOADS

const decodeDownloads = Schema.decodeUnknownOption(DownloadsJson)
const encodeDownloads = Schema.encodeUnknownOption(DownloadsJson)

const readDownloadList = (): ReadonlyArray<DownloadedCollection> => {
  try {
    return Option.getOrElse(
      decodeDownloads(globalThis.localStorage.getItem(DOWNLOADS_KEY) ?? '[]'),
      () => [],
    )
  } catch {
    return []
  }
}

/** Remember which albums and playlists are downloaded. */
export const saveDownloads = (
  collections: ReadonlyArray<DownloadedCollection>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      Option.match(encodeDownloads(collections), {
        onNone: () => undefined,
        onSome: json => globalThis.localStorage.setItem(DOWNLOADS_KEY, json),
      })
    } catch {
      // Without storage the downloads last until the app closes.
    }
  })

/** How much the browser lets the app keep, when it says. */
export const storageEstimate: Effect.Effect<Option.Option<StorageEstimate>> =
  Effect.tryPromise({
    try: async () => {
      const storage: StorageManager | undefined = globalThis.navigator.storage
      if (storage === undefined || !('estimate' in storage)) {
        return undefined
      }
      const { usage, quota } = await storage.estimate()
      return usage === undefined || quota === undefined
        ? undefined
        : { usageBytes: usage, quotaBytes: quota }
    },
    catch: () => new SongCacheError({ message: 'Could not read storage' }),
  }).pipe(
    Effect.map(Option.fromNullishOr),
    Effect.orElseSucceed(() => Option.none()),
  )

// CACHE STORAGE

const songUrl = (videoId: string): string =>
  new URL(Session.audioPath(videoId), globalThis.location.origin).toString()

const videoIdFromUrl = (url: string): string =>
  decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '')

/**
 * Cache Storage only exists on secure origins (HTTPS or localhost). A guest
 * who opens the app over plain HTTP on the LAN has none, so their phone
 * streams every song instead.
 */
const hasCacheStorage = (): boolean => 'caches' in globalThis

/**
 * Ask the browser not to clear the cache when the phone runs low on space.
 * `navigator.storage` is missing on insecure origins too.
 */
const requestPersistence = Effect.tryPromise({
  try: async () => {
    const storage: StorageManager | undefined = globalThis.navigator.storage
    if (storage === undefined || !('persist' in storage)) {
      return
    }
    if (!(await storage.persisted())) {
      await storage.persist()
    }
  },
  catch: () => new SongCacheError({ message: 'Could not keep the cache' }),
}).pipe(Effect.ignore)

const openCache = Effect.tryPromise({
  try: () => {
    if (!hasCacheStorage()) {
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
    Effect.tap(maybeBlob =>
      Effect.sync(() => {
        if (Option.isSome(maybeBlob)) {
          updateUse(videoId, use => ({ ...use, lastUsedAt: Date.now() }))
        }
      }),
    ),
    Effect.orElseSucceed(() => Option.none()),
  )

/**
 * Forget songs until the cache fits its size limit, keeping `protectedIds`:
 * the one playing and the ones queued next.
 */
const trim = (cache: Cache, protectedIds: ReadonlySet<string>) =>
  Effect.tryPromise({
    try: async () => {
      const keys = await cache.keys()
      const index = readIndex()
      const urlById = new Map(
        Array.map(keys, key => [videoIdFromUrl(key.url), key] as const),
      )
      const pinned = pinnedVideoIds(readDownloadList())
      const doomed = songsToTrim(
        [...urlById.keys()],
        index,
        protectedIds,
        MAX_BYTES,
        pinned,
      )
      await Promise.all(
        Array.map(doomed, id => {
          const key = urlById.get(id)
          return key === undefined ? Promise.resolve(false) : cache.delete(key)
        }),
      )
      // Keep play counts for favorites and the songs on their way in; drop
      // the rest of what left the cache.
      const kept: Record<string, SongUse> = {}
      for (const [id, use] of Object.entries(index)) {
        if (urlById.has(id) && !doomed.includes(id)) kept[id] = use
        else if (
          use.plays >= FAVORITE_PLAYS ||
          protectedIds.has(id) ||
          pinned.has(id)
        ) {
          kept[id] = use
        }
      }
      writeIndex(kept)
    },
    catch: () => new SongCacheError({ message: 'Could not trim the cache' }),
  })

const downloading = new Set<string>()

const isCachedIn = (cache: Cache, videoId: string) =>
  Effect.tryPromise({
    try: async () => (await cache.match(songUrl(videoId))) !== undefined,
    catch: () => new SongCacheError({ message: 'Could not read the cache' }),
  })

/** Fetch a whole song into the cache, and note its size. */
const fetchIntoCache = (cache: Cache, videoId: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(songUrl(videoId))
      if (response.status !== 200) {
        throw new SongCacheError({
          message: `The server answered ${response.status}`,
        })
      }
      const blob = await response.blob()
      await cache.put(
        songUrl(videoId),
        new Response(blob, { headers: response.headers }),
      )
      updateUse(videoId, use => ({
        ...use,
        bytes: blob.size,
        lastUsedAt: Math.max(use.lastUsedAt, Date.now()),
      }))
      return blob.size
    },
    catch: () => new SongCacheError({ message: 'Could not download the song' }),
  })

/** Download a whole song into the cache, unless it is there or on its way. */
const cacheSong = (
  videoId: string,
  protectedIds: ReadonlySet<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (downloading.has(videoId)) {
      return
    }
    const cache = yield* openCache
    if (yield* isCachedIn(cache, videoId)) {
      return
    }
    downloading.add(videoId)
    yield* fetchIntoCache(cache, videoId).pipe(
      Effect.ensuring(Effect.sync(() => downloading.delete(videoId))),
    )
    yield* trim(cache, protectedIds)
  }).pipe(Effect.ignore)

/** The size a cached song was saved at, as the index remembers it. */
const knownBytes = (videoId: string): number =>
  readIndex()[videoId]?.bytes ?? ASSUMED_SONG_BYTES

/**
 * Download a song for an album or playlist downloaded on this phone, and
 * say how much room it takes. A song already cached is only counted.
 */
export const downloadSong = (
  videoId: string,
): Effect.Effect<number, SongCacheError> =>
  Effect.gen(function* () {
    const cache = yield* openCache
    if (yield* isCachedIn(cache, videoId)) {
      return knownBytes(videoId)
    }
    yield* requestPersistence
    return yield* fetchIntoCache(cache, videoId)
  })

/**
 * The downloads, and which of their songs are already on this phone, with
 * their size. None when the phone has no Cache Storage, so nothing can be
 * downloaded.
 */
export const loadDownloads: Effect.Effect<
  Option.Option<{
    readonly collections: ReadonlyArray<DownloadedCollection>
    readonly savedBytes: Readonly<Record<string, number>>
  }>
> = Effect.gen(function* () {
  const cache = yield* openCache
  const collections = readDownloadList()
  const cachedIds = yield* Effect.tryPromise({
    try: async () =>
      new Set(Array.map(await cache.keys(), key => videoIdFromUrl(key.url))),
    catch: () => new SongCacheError({ message: 'Could not read the cache' }),
  })
  const savedBytes: Record<string, number> = Object.fromEntries(
    Array.map(
      Array.filter([...pinnedVideoIds(collections)], videoId =>
        cachedIds.has(videoId),
      ),
      videoId => [videoId, knownBytes(videoId)] as const,
    ),
  )
  return Option.some({ collections, savedBytes })
}).pipe(Effect.orElseSucceed(() => Option.none()))

/**
 * Delete the songs a removed download held, to give the room back. The song
 * playing keeps playing: the audio element already holds it.
 */
export const removeSongs = (
  videoIds: ReadonlyArray<string>,
): Effect.Effect<void> =>
  openCache.pipe(
    Effect.flatMap(cache =>
      Effect.tryPromise({
        try: () =>
          Promise.all(Array.map(videoIds, id => cache.delete(songUrl(id)))),
        catch: () =>
          new SongCacheError({ message: 'Could not delete the songs' }),
      }),
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        const removed = new Set(videoIds)
        writeIndex(
          Object.fromEntries(
            Object.entries(readIndex()).filter(
              ([id, use]) => !removed.has(id) || use.plays >= FAVORITE_PLAYS,
            ),
          ),
        )
      }),
    ),
    Effect.ignore,
  )

/**
 * Keep the playing song and the next ones cached, in play order. They are
 * safe from trimming while they are in this list. Without Cache Storage
 * there is nothing to keep, and the songs stream when they play.
 */
export const prefetchSongs = (
  videoIds: ReadonlyArray<string>,
): Effect.Effect<void> => {
  if (!hasCacheStorage()) {
    return Effect.void
  }
  const protectedIds = new Set(videoIds)
  return Effect.andThen(
    requestPersistence,
    Effect.forEach(videoIds, videoId => cacheSong(videoId, protectedIds), {
      discard: true,
    }),
  )
}
