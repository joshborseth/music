import { Array, Data, Effect, Option, Schema } from 'effect'

import {
  DOWNLOAD_ARTWORK_CACHE,
  type DownloadKind,
  type OfflineCopy,
  OfflineCopyJson,
  artworkKey,
  copyKey,
  copyOf,
  offlineArtworkUrls,
} from './domain'

/*
 * Each download's copy of its page, and its covers, in Cache Storage beside
 * its songs, so the page shows and plays with no server. The copies are
 * JSON under a made-up URL per download; the covers are kept under
 * `artworkKey`, which the service worker looks up when an image can't be
 * fetched. Only this module touches these caches.
 */

const COPIES_CACHE = 'music-download-copies-v1'
const COPY_PATH = '/offline-copy/'

class OfflineCopyError extends Data.TaggedError('OfflineCopyError')<{
  readonly message: string
}> {}

const decodeCopy = Schema.decodeUnknownOption(OfflineCopyJson)
const encodeCopy = Schema.encodeUnknownOption(OfflineCopyJson)

const copyUrl = (kind: DownloadKind, id: string): string =>
  new URL(
    `${COPY_PATH}${encodeURIComponent(copyKey(kind, id))}`,
    globalThis.location.origin,
  ).toString()

const attempt = <A>(work: () => Promise<A>, message: string) =>
  Effect.tryPromise({
    try: work,
    catch: () => new OfflineCopyError({ message }),
  })

const openCache = (name: string) =>
  Effect.tryPromise({
    try: () => globalThis.caches.open(name),
    catch: () =>
      new OfflineCopyError({ message: 'Cache Storage is unavailable' }),
  })

/**
 * Fetch a cover to keep. Google's image hosts allow CORS, which keeps the
 * browser from padding the cached copy's size; any other host is kept
 * opaque, as an image tag would load it.
 */
const fetchImage = async (url: string): Promise<Response | undefined> => {
  try {
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (response.ok) return response
  } catch {
    // NOTE: no CORS from this host; take it as an image tag would.
  }
  try {
    const response = await fetch(url, {
      mode: 'no-cors',
      referrerPolicy: 'no-referrer',
    })
    return response.ok || response.type === 'opaque' ? response : undefined
  } catch {
    return undefined
  }
}

/** Keep each cover not kept yet. A cover that fails is left out. */
const saveArtwork = (urls: ReadonlyArray<string>) =>
  openCache(DOWNLOAD_ARTWORK_CACHE).pipe(
    Effect.flatMap(cache =>
      Effect.forEach(
        urls,
        url =>
          attempt(async () => {
            const key = artworkKey(url)
            if ((await cache.match(key)) !== undefined) return
            const response = await fetchImage(url)
            if (response !== undefined) await cache.put(key, response)
          }, 'Could not keep a cover').pipe(Effect.ignore),
        { concurrency: 2, discard: true },
      ),
    ),
  )

/** Keep a download's page and its covers. */
export const saveOfflineCopy = (copy: OfflineCopy): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { kind, id } = copyOf(copy)
    const json = yield* Option.match(encodeCopy(copy), {
      onNone: () =>
        Effect.fail(new OfflineCopyError({ message: 'Could not encode' })),
      onSome: Effect.succeed,
    })
    const cache = yield* openCache(COPIES_CACHE)
    yield* attempt(
      () =>
        cache.put(
          copyUrl(kind, id),
          new Response(json, {
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      'Could not save the copy',
    )
    yield* saveArtwork(offlineArtworkUrls(copy))
  }).pipe(Effect.ignore)

/** Every saved copy, by `copyKey`. None without Cache Storage. */
export const loadOfflineCopies: Effect.Effect<
  Readonly<Record<string, OfflineCopy>>
> = openCache(COPIES_CACHE).pipe(
  Effect.flatMap(cache =>
    attempt(async () => {
      const copies: Record<string, OfflineCopy> = {}
      for (const key of await cache.keys()) {
        const response = await cache.match(key)
        if (response === undefined) continue
        const maybeCopy = decodeCopy(await response.text())
        if (Option.isSome(maybeCopy)) {
          const { kind, id } = copyOf(maybeCopy.value)
          copies[copyKey(kind, id)] = maybeCopy.value
        }
      }
      return copies
    }, 'Could not read the copies'),
  ),
  Effect.orElseSucceed(() => ({})),
)

/**
 * Forget a removed download's page, and the covers no other download
 * shows (`keptArtworkUrls`).
 */
export const removeOfflineCopy = (
  kind: DownloadKind,
  id: string,
  removed: Option.Option<OfflineCopy>,
  keptArtworkUrls: ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const copies = yield* openCache(COPIES_CACHE)
    yield* attempt(
      () => copies.delete(copyUrl(kind, id)),
      'Could not delete the copy',
    )
    const kept = new Set(Array.map(keptArtworkUrls, artworkKey))
    const doomed = Array.filter(
      Array.map(
        Option.match(removed, {
          onNone: () => [],
          onSome: offlineArtworkUrls,
        }),
        artworkKey,
      ),
      key => !kept.has(key),
    )
    const artwork = yield* openCache(DOWNLOAD_ARTWORK_CACHE)
    yield* attempt(
      () => Promise.all(Array.map(doomed, key => artwork.delete(key))),
      'Could not delete the covers',
    )
  }).pipe(Effect.ignore)
