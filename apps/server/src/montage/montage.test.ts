import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'

import type { ArtistLink } from '@music/shared'

import { contentBox, coverInto, pack } from './atlas.ts'
import { frameReader } from './extract.ts'
import {
  CELL_HEIGHT,
  CELL_WIDTH,
  FRAME_BYTES,
  FrameSifter,
  frameStats,
  selectFrames,
  unusable,
} from './frames.ts'
import {
  type SongToMatch,
  type VideoCandidate,
  coreTitle,
  rankMusicVideos,
  rejection,
  videoQuery,
} from './match.ts'
import { montagesToEvict } from './service.ts'

// MATCHING

const daftPunk: ArtistLink = {
  maybeId: Option.some('UCdaft'),
  name: 'Daft Punk',
}

const song: SongToMatch = {
  videoId: 'song1',
  title: 'Harder, Better, Faster, Stronger',
  artists: [daftPunk],
  maybeDurationSeconds: Option.some(224),
}

const video = (
  videoId: string,
  title: string,
  seconds: number,
  artists: ReadonlyArray<ArtistLink> = [daftPunk],
): VideoCandidate => ({
  videoId,
  title,
  artists,
  maybeDurationSeconds: Option.some(seconds),
})

describe('finding the music video', () => {
  const found = [
    video(
      'lyric',
      'Daft Punk - Harder, Better, Faster, Stronger (Lyrics)',
      224,
    ),
    video(
      'live',
      'Daft Punk - Harder Better Faster Stronger (Live at Alive 2007)',
      300,
    ),
    video('cover', 'Harder, Better, Faster, Stronger - Piano Cover', 220, [
      { maybeId: Option.none(), name: 'Piano Guy' },
    ]),
    video('tuned', 'Daft Punk - Harder, Better, Faster, Stronger (432Hz)', 224),
    video(
      'korean',
      'Daft Punk - Harder, Better, Faster, Stronger [가사/해석]',
      224,
    ),
    video(
      'visualizer',
      'Daft Punk - Harder, Better, Faster, Stronger (Visualizer)',
      224,
    ),
    video('short', 'Daft Punk - Harder, Better, Faster, Stronger', 120),
    video('song1', 'Harder, Better, Faster, Stronger', 224),
    video('plain', 'Harder, Better, Faster, Stronger', 226),
    video(
      'official',
      'Daft Punk - Harder, Better, Faster, Stronger (Official Video)',
      226,
    ),
    video('other', 'Stronger', 312, [
      { maybeId: Option.some('UCkanye'), name: 'Kanye West' },
    ]),
  ]

  test('the official video comes first; other takes on the song are left out', () => {
    expect(
      rankMusicVideos(song, found).map(candidate => candidate.videoId),
    ).toEqual(['official', 'plain'])
  })

  test('says why each other video is not the one', () => {
    const why = (id: string) =>
      Option.getOrUndefined(
        Option.flatMap(
          Option.fromNullishOr(
            found.find(candidate => candidate.videoId === id),
          ),
          candidate => rejection(song, candidate),
        ),
      )
    expect(why('lyric')).toBe('a lyrics video')
    expect(why('live')).toBe('a live video')
    expect(why('cover')).toBe('another artist')
    expect(why('tuned')).toBe('a retuned copy')
    expect(why('korean')).toBe('a translation')
    expect(why('visualizer')).toBe('a visualizer video')
    expect(why('short')).toBe('too short')
    expect(why('song1')).toBe('the song itself')
    expect(why('other')).toBe('another title')
  })

  test('a video may run longer than the song, with an intro, but not far longer', () => {
    expect(
      Option.isNone(
        rejection(
          song,
          video('intro', 'Daft Punk - Harder, Better, Faster, Stronger', 320),
        ),
      ),
    ).toBe(true)
    expect(
      rejection(
        song,
        video('film', 'Daft Punk - Harder, Better, Faster, Stronger', 600),
      ),
    ).toEqual(Option.some('too long'))
  })

  test("a word the song's own title has is no reason to leave a video out", () => {
    const live: SongToMatch = {
      ...song,
      title: 'Live Forever',
      artists: [{ maybeId: Option.none(), name: 'Oasis' }],
    }
    const official = video(
      'oasis',
      'Oasis - Live Forever (Official HD Remastered Video)',
      230,
      live.artists,
    )
    expect(rankMusicVideos(live, [official]).length).toBe(1)
  })

  test("an artist's VEVO channel counts as the artist", () => {
    const channel = video(
      'vevo',
      'Harder, Better, Faster, Stronger (Official Video)',
      224,
      [{ maybeId: Option.some('UCvevo'), name: 'DaftPunkVEVO' }],
    )
    expect(rankMusicVideos(song, [channel]).length).toBe(1)
  })

  test("searches for the artist and the song's core title", () => {
    expect(coreTitle('tv off (feat. Lefty Gunplay)')).toBe('tv off')
    expect(coreTitle('Hold On - Remastered 2011')).toBe('hold on')
    expect(
      videoQuery({ ...song, title: 'Get Lucky (feat. Pharrell Williams)' }),
    ).toBe('Daft Punk get lucky')
  })
})

// FRAMES

/** A synthetic frame: `paint(x, y)` gives each pixel's RGB. */
const frame = (
  paint: (x: number, y: number) => readonly [number, number, number],
): Uint8Array => {
  const pixels = new Uint8Array(FRAME_BYTES)
  for (let y = 0; y < CELL_HEIGHT; y++) {
    for (let x = 0; x < CELL_WIDTH; x++) {
      const [r, g, b] = paint(x, y)
      const at = (y * CELL_WIDTH + x) * 3
      pixels[at] = r
      pixels[at + 1] = g
      pixels[at + 2] = b
    }
  }
  return pixels
}

/** A picture with detail: stripes and blocks in a color of its own. */
const scene = (seed: number) =>
  frame((x, y) => {
    const stripe = Math.floor((x + seed * 37) / (6 + (seed % 5))) % 2
    const block = (Math.floor(y / (12 + (seed % 7))) + seed) % 3
    return [
      (seed * 53 + stripe * 120 + block * 30) % 256,
      (seed * 97 + block * 70) % 256,
      (seed * 31 + stripe * 60 + 40) % 256,
    ]
  })

describe('reading frames', () => {
  test('tells near black, near white, and flat cards of text from pictures', () => {
    expect(unusable(frameStats(frame(() => [4, 4, 6])))).toBe('black')
    expect(unusable(frameStats(frame(() => [250, 250, 250])))).toBe('white')
    // White words on a dark grey card.
    const card = frame((x, y) =>
      y > 80 && y < 96 && x % 9 < 5 ? [240, 240, 240] : [40, 40, 40],
    )
    expect(unusable(frameStats(card))).toBe('flat')
    const picture = frameStats(scene(3))
    expect(unusable(picture)).toBeUndefined()
    expect(picture.busyness).toBeGreaterThan(0.3)
    expect(frameStats(frame(() => [90, 60, 50])).busyness).toBeLessThan(0.05)
  })

  test('splits the frames from ffmpeg however its output is chunked', () => {
    const seen: Array<number> = []
    const reader = frameReader((pixels, index) =>
      seen.push(index * 1000 + (pixels[0] ?? 0)),
    )
    const bytes = new Uint8Array(FRAME_BYTES * 2 + 10)
    bytes[0] = 7
    bytes[FRAME_BYTES] = 9
    for (let at = 0; at < bytes.length; at += 4099)
      reader.push(bytes.subarray(at, at + 4099))
    expect(seen).toEqual([7, 1009])
    expect(reader.frames()).toBe(2)
  })

  test('keeps a frame a shot, past the first, and a long shot that moves gives more', () => {
    const sifter = new FrameSifter()
    // Shot A for 3 seconds, a black frame, shot B for 2, then a slow pan of
    // 12 seconds (C, its colors drifting).
    for (let i = 0; i < 6; i++) sifter.push(scene(1), i / 2)
    sifter.push(
      frame(() => [0, 0, 0]),
      3,
    )
    for (let i = 0; i < 4; i++) sifter.push(scene(2), 3.5 + i / 2)
    for (let i = 0; i < 24; i++) {
      const drift = i * 3
      sifter.push(
        frame((x, y) => [(x + drift) % 256, (y * 2 + drift) % 256, 120]),
        5.5 + i / 2,
      )
    }
    const kept = sifter.finish()
    expect(kept.length).toBeGreaterThanOrEqual(4)
    expect(kept[0]?.seconds).toBe(0.5)
    expect(
      kept.every(candidate => unusable(candidate.stats) === undefined),
    ).toBe(true)
  })
})

describe('choosing frames', () => {
  const candidate = (seed: number, seconds: number) => ({
    seconds,
    stats: frameStats(scene(seed)),
  })

  test('drops shots that look alike and keeps the most varied, in order', () => {
    const repeated = [1, 2, 1, 3, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11].map(
      (seed, index) => candidate(seed, index),
    )
    const selection = selectFrames(repeated, 6, 3)
    expect(selection.distinct).toBe(11)
    expect(selection.frames.length).toBe(6)
    const times = selection.frames.map(frame => frame.seconds)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(selection.isStatic).toBe(false)
  })

  test('a still picture with the song under it is not a video', () => {
    const still = Array.from({ length: 40 }, (_, index) => candidate(4, index))
    const selection = selectFrames(still)
    expect(selection.distinct).toBe(1)
    expect(selection.isStatic).toBe(true)
  })
})

// ATLAS

describe('the atlas', () => {
  test('finds the black bars every frame shares and fills the cell without them', () => {
    // A widescreen film: 30 black rows top and bottom.
    const film = (seed: number) => {
      const picture = scene(seed)
      for (let y = 0; y < CELL_HEIGHT; y++) {
        if (y >= 30 && y < CELL_HEIGHT - 30) continue
        picture.fill(0, y * CELL_WIDTH * 3, (y + 1) * CELL_WIDTH * 3)
      }
      return { pixels: picture, width: CELL_WIDTH, height: CELL_HEIGHT }
    }
    const box = contentBox([film(1), film(2)])
    expect(box).toEqual({
      left: 0,
      top: 30,
      width: CELL_WIDTH,
      height: CELL_HEIGHT - 60,
    })
    const filled = coverInto(film(1), box, CELL_WIDTH, CELL_HEIGHT)
    expect(frameStats(filled.pixels).brightness).toBeGreaterThan(
      frameStats(film(1).pixels).brightness,
    )
    // A picture without bars keeps its whole frame.
    expect(
      contentBox([
        { pixels: scene(5), width: CELL_WIDTH, height: CELL_HEIGHT },
      ]),
    ).toEqual({
      left: 0,
      top: 0,
      width: CELL_WIDTH,
      height: CELL_HEIGHT,
    })
  })

  test('packs pictures row by row from the top left', () => {
    const solid = (value: number) => ({
      pixels: new Uint8Array(4 * 2 * 3).fill(value),
      width: 4,
      height: 2,
    })
    const atlas = pack([solid(1), solid(2), solid(3)], 4, 2, 2)
    expect([atlas.width, atlas.height, atlas.columns, atlas.rows]).toEqual([
      8, 4, 2, 2,
    ])
    const at = (x: number, y: number) => atlas.pixels[(y * atlas.width + x) * 3]
    expect([at(0, 0), at(4, 0), at(0, 2), at(4, 2)]).toEqual([1, 2, 3, 0])
  })
})

describe('the cache', () => {
  test('drops the least recently used montages until well under the cap', () => {
    const cached = [
      { videoId: 'a', size: 300, usedAt: 3 },
      { videoId: 'b', size: 300, usedAt: 1 },
      { videoId: 'c', size: 300, usedAt: 2 },
    ]
    expect(montagesToEvict(cached, 1000)).toEqual([])
    expect(
      montagesToEvict(cached, 800).map(montage => montage.videoId),
    ).toEqual(['b'])
    expect(
      montagesToEvict(cached, 500).map(montage => montage.videoId),
    ).toEqual(['b', 'c'])
  })
})
