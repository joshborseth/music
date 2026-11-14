import { Array, Effect, Option, Schema, pipe } from 'effect'
import sharp from 'sharp'

import type { ArtistDetails, Artwork } from '@music/shared'

import { allowedArtworkUrl } from '../artwork.ts'
import type { MontageFrame } from './atlas.ts'
import { distance, frameStats } from './frames.ts'

/*
 * A montage for a song without a music video: the artist's own pictures,
 * the photos on their page and the covers of their albums, singles, and
 * EPs, each cut to a square cell. Covers that look alike (a deluxe edition
 * and the album) count once.
 */

/** Photos and covers fill square cells this many pixels a side. */
export const ARTIST_CELL = 320
/** The most pictures an artist's montage holds: an 8 × 4 atlas. */
export const MAX_ARTIST_PICTURES = 32
/** Pictures fetched at once. */
const FETCHES_AT_ONCE = 4
const FETCH_TIMEOUT = '10 seconds'
const RESIZABLE_GOOGLE_IMAGE = /=w\d+-h\d+/
/** Two pictures closer than this are the same picture. */
const SAME_PICTURE = 0.03

export class PictureError extends Schema.TaggedError<PictureError>()(
  'PictureError',
  {
    url: Schema.String,
    message: Schema.String,
  },
) {}

/** The artwork's largest size, asked for at about the cell's size. */
export const pictureUrl = (artwork: Artwork): Option.Option<URL> =>
  pipe(
    Array.last(artwork),
    Option.flatMap(thumbnail =>
      Option.fromNullishOr(allowedArtworkUrl(thumbnail.url)),
    ),
    Option.map(url => {
      const sized = new URL(url)
      sized.pathname = sized.pathname.replace(
        RESIZABLE_GOOGLE_IMAGE,
        `=w${ARTIST_CELL * 2}-h${ARTIST_CELL * 2}`,
      )
      return sized
    }),
  )

/** Every picture of the artist, their photos first, then the newest releases. */
export const artistPictureUrls = (artist: ArtistDetails): ReadonlyArray<URL> =>
  Array.dedupeWith(
    Array.getSomes(
      Array.map(
        [
          artist.artist.artwork,
          ...Array.map(
            [...artist.albums, ...artist.singles],
            album => album.artwork,
          ),
        ],
        pictureUrl,
      ),
    ),
    (left, right) => left.href === right.href,
  )

/** One picture, fetched and cut to the cell's square. */
const fetchPicture = (url: URL): Effect.Effect<MontageFrame, PictureError> =>
  Effect.tryPromise({
    try: async signal => {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const raw = await sharp(bytes)
        .resize(ARTIST_CELL, ARTIST_CELL, {
          fit: 'cover',
          position: 'attention',
        })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer()
      const pixels = new Uint8Array(raw.buffer, raw.byteOffset, raw.length)
      return {
        picture: { pixels, width: ARTIST_CELL, height: ARTIST_CELL },
        stats: frameStats(pixels, ARTIST_CELL, ARTIST_CELL),
        seconds: null,
      }
    },
    catch: error => new PictureError({ url: url.href, message: String(error) }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: FETCH_TIMEOUT,
      orElse: () =>
        Effect.fail(new PictureError({ url: url.href, message: 'timeout' })),
    }),
  )

/** The artist's pictures, those that could be had, at most `MAX_ARTIST_PICTURES`. */
export const artistPictures = (
  artist: ArtistDetails,
): Effect.Effect<ReadonlyArray<MontageFrame>> =>
  Effect.forEach(
    Array.take(artistPictureUrls(artist), MAX_ARTIST_PICTURES + 8),
    url => Effect.option(fetchPicture(url)),
    { concurrency: FETCHES_AT_ONCE },
  ).pipe(
    Effect.map(found =>
      Array.take(
        Array.reduce(
          Array.getSomes(found),
          Array.empty<MontageFrame>(),
          (kept, frame) =>
            Array.some(
              kept,
              other =>
                distance(other.stats.signature, frame.stats.signature) <
                SAME_PICTURE,
            )
              ? kept
              : [...kept, frame],
        ),
        MAX_ARTIST_PICTURES,
      ),
    ),
  )
