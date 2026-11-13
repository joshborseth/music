import { Array, Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { type Artwork, type PlaylistDetails, type Song } from '@music/shared'

import { borrowedCoverMosaic } from './playlist'

const cover = (name: string, size: number): Artwork => [
  {
    url: `https://yt3.googleusercontent.com/${name}=w${size}-h${size}-l90-rj`,
    width: size,
    height: size,
  },
]

const song = (videoId: string, coverName: string): Song => ({
  videoId,
  title: videoId,
  artists: [],
  maybeAlbum: Option.none(),
  maybeDurationSeconds: Option.none(),
  artwork: cover(coverName, 120),
})

const playlist = (
  coverName: string,
  tracks: ReadonlyArray<Song>,
): PlaylistDetails => ({
  playlist: {
    id: 'VLtop',
    title: 'Top songs',
    maybeSubtitle: Option.none(),
    artwork: cover(coverName, 544),
  },
  maybeOwner: Option.none(),
  maybeDescription: Option.none(),
  maybeLengthSummary: Option.none(),
  tracks,
})

const fromFourAlbums = [
  song('a1', 'ram'),
  song('a2', 'ram'),
  song('b1', 'discovery'),
  song('c1', 'homework'),
  song('d1', 'human'),
  song('e1', 'tron'),
]

describe('borrowedCoverMosaic', () => {
  test("shows four of the songs' covers when the playlist borrows one of them", () => {
    const mosaic = borrowedCoverMosaic(playlist('ram', fromFourAlbums))
    expect(
      Option.map(mosaic, covers =>
        Array.map(covers, artwork => artwork[0]?.url),
      ),
    ).toEqual(
      Option.some([
        cover('ram', 120)[0]?.url,
        cover('discovery', 120)[0]?.url,
        cover('homework', 120)[0]?.url,
        cover('human', 120)[0]?.url,
      ]),
    )
  })

  test('keeps a cover of its own', () => {
    expect(borrowedCoverMosaic(playlist('essentials', fromFourAlbums))).toEqual(
      Option.none(),
    )
  })

  test('keeps the one cover when its songs come from fewer than four albums', () => {
    expect(
      borrowedCoverMosaic(
        playlist('ram', [
          song('a1', 'ram'),
          song('b1', 'discovery'),
          song('c1', 'homework'),
          song('a2', 'ram'),
        ]),
      ),
    ).toEqual(Option.none())
  })
})
