import { Cache, Context, Data, Duration, Effect, Exit, Layer } from 'effect'
import sharp from 'sharp'

import type { NowPlaying } from '@music/shared'

import { allowedArtworkUrl } from '../artwork.ts'
import { paletteFromPixels } from './extract.ts'

/*
 * The colors of a song's artwork, cached by URL. Google's square artwork is
 * fetched at a small size; anything else is shrunk after download. Video
 * thumbnails (i.ytimg.com) are letterboxed, so their black bars are trimmed
 * first.
 */

/** Pixels per side once shrunk: plenty to find a cover's main colors. */
const SAMPLE_SIZE = 48
const FETCH_SIZE = 96
const RESIZABLE_GOOGLE_IMAGE = /=w\d+-h\d+/
const LETTERBOXED_HOST = /(^|\.)ytimg\.com$/
const FETCH_TIMEOUT = '10 seconds'
const CAPACITY = 512
const FAILURE_TTL = Duration.minutes(5)

export class ArtworkFetchError extends Data.TaggedError('ArtworkFetchError')<{
  readonly url: string
  readonly reason: string
}> {}

export class ArtworkPalette extends Context.Service<
  ArtworkPalette,
  {
    /** Never fails: artwork that cannot be read has no colors. */
    readonly forUrl: (
      url: string,
    ) => Effect.Effect<ReadonlyArray<NowPlaying.Swatch>>
  }
>()('music/ArtworkPalette') {}

const smallUrl = (url: URL): URL => {
  const small = new URL(url)
  small.pathname = small.pathname.replace(
    RESIZABLE_GOOGLE_IMAGE,
    `=w${FETCH_SIZE}-h${FETCH_SIZE}`,
  )
  return small
}

const fetchImage = (url: URL) =>
  Effect.tryPromise({
    try: async signal => {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    },
    catch: error =>
      new ArtworkFetchError({ url: url.href, reason: String(error) }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: FETCH_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ArtworkFetchError({ url: url.href, reason: 'timeout' }),
        ),
    }),
  )

/** Packed RGB pixels of the image, shrunk to a square sample. */
export const samplePixels = (image: Uint8Array, letterboxed: boolean) =>
  Effect.tryPromise({
    try: async () => {
      const trimmed = letterboxed
        ? await sharp(image)
            .trim({ background: '#000000', threshold: 24 })
            .toBuffer()
            .catch(() => image)
        : image
      const pixels = await sharp(trimmed)
        .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'cover' })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer()
      return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length)
    },
    catch: error =>
      new ArtworkFetchError({ url: 'decode', reason: String(error) }),
  })

const lookup = (raw: string) =>
  Effect.gen(function* () {
    const url = allowedArtworkUrl(raw)
    if (url === undefined) {
      return yield* new ArtworkFetchError({ url: raw, reason: 'not artwork' })
    }
    const image = yield* fetchImage(smallUrl(url))
    const pixels = yield* samplePixels(
      image,
      LETTERBOXED_HOST.test(url.hostname),
    )
    return paletteFromPixels(pixels)
  })

export const ArtworkPaletteLive = Layer.effect(ArtworkPalette)(
  Effect.gen(function* () {
    const cache = yield* Cache.makeWith(lookup, {
      capacity: CAPACITY,
      timeToLive: exit =>
        Exit.isSuccess(exit) ? Duration.infinity : FAILURE_TTL,
    })
    return ArtworkPalette.of({
      forUrl: url =>
        Cache.get(cache, url).pipe(
          Effect.tapError(error =>
            Effect.logWarning('Artwork colors unavailable', error.reason),
          ),
          Effect.orElseSucceed(() => []),
        ),
    })
  }),
)
