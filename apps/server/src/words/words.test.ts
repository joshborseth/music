import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { Effect, Option } from 'effect'

import type { LyricLine, Tv } from '@music/shared'

import { grayPng } from '../analysis/score.ts'
import { buildAtlas, capFor, glyphText, pack, planAtlas } from './atlas.ts'
import { fieldBytes, signedDistance } from './sdf.ts'
import { makeSongWords, makeWords, makeWordsCache } from './service.ts'
import { syllables } from './syllables.ts'
import {
  type SungTrack,
  findPhrase,
  hookLines,
  placeLine,
  timeWords,
  wordText,
  wordsOf,
} from './timing.ts'
import { readGrayPng, sungTrack } from './track.ts'

const line = (startSeconds: number, text: string): LyricLine => ({
  startSeconds,
  text,
  words: [],
})

/** A track 20 rows a second, singing throughout, with notes at `onsets`. */
const trackWith = (
  seconds: number,
  onsets: ReadonlyArray<number>,
): SungTrack => {
  const rows = Math.ceil(seconds * 20)
  const notes = new Float32Array(rows)
  for (const time of onsets) notes[Math.round(time * 20)] = 1
  return { rate: 20, voicing: new Float32Array(rows).fill(1), onsets: notes }
}

describe('syllables', () => {
  test('counts the syllables of common sung words', () => {
    const expected: ReadonlyArray<[string, number]> = [
      ['love', 1],
      ['the', 1],
      ['fire', 1],
      ['night', 1],
      ['walked', 1],
      ['makes', 1],
      ['baby', 2],
      ['people', 2],
      ['little', 2],
      ['wanted', 2],
      ['going', 2],
      ['flying', 2],
      ['tonight', 2],
      ['boxes', 2],
      ['nation', 2],
      ['special', 2],
      ['lion', 2],
      ['beautiful', 3],
      ['together', 3],
      ['radio', 3],
      ["don't", 1],
      ['99', 2],
      ['Éclair', 2],
    ]
    for (const [word, count] of expected)
      expect([word, syllables(word)]).toEqual([word, count])
  })
})

describe('words of a line', () => {
  test('drop the punctuation around them, keep apostrophes and hyphens', () => {
    expect(wordsOf('"Hey," you — don’t stop, ooh-ooh!')).toEqual([
      'Hey',
      'you',
      "don't",
      'stop',
      'ooh-ooh',
    ])
    expect(wordText("'bout")).toBe("'bout")
  })

  test('the atlas draws capitals, and only scripts the font has', () => {
    expect(glyphText("don't")).toBe("DON'T")
    expect(glyphText('café')).toBe('CAFÉ')
    expect(glyphText('любовь')).toBe('ЛЮБОВЬ')
    expect(glyphText('愛')).toBeNull()
  })
})

describe('placing words in a line', () => {
  const plan = { start: 10, next: 14, syllables: [1, 1, 2, 1] }

  test('each word moves to the note start near its place', () => {
    // Places by syllable: 10, ~10.6, ~11.2, ~12.4. Notes a little off each.
    const track = trackWith(20, [10.05, 10.7, 11.1, 12.5])
    const { starts } = placeLine(plan, track, [])
    expect(starts).toEqual([10.05, 10.7, 11.1, 12.5])
  })

  test('a note too far from any word is left alone, and order is kept', () => {
    const track = trackWith(20, [10, 10.25, 10.3, 13.9])
    const { starts } = placeLine(plan, track, [])
    for (let i = 1; i < starts.length; i++)
      expect(starts[i] ?? 0).toBeGreaterThan(starts[i - 1] ?? 0)
    expect(starts).not.toContain(13.9)
  })

  test('without a melody, words spread by syllable, onto eighth notes', () => {
    const plain = placeLine(plan, null, [])
    expect(plain.starts[0]).toBe(10)
    // One, one, two syllables before the last word, which is held.
    const gap = (plain.starts[1] ?? 0) - (plain.starts[0] ?? 0)
    expect((plain.starts[3] ?? 0) - (plain.starts[2] ?? 0)).toBeCloseTo(
      2 * gap,
      2,
    )
    const beats = Array.from({ length: 20 }, (_, i) => 9 + i * 0.5)
    const onBeat = placeLine(plan, null, beats)
    for (const start of onBeat.starts) expect((start * 4) % 1).toBeCloseTo(0, 5)
  })

  test("the line's singing ends where the lead stops, before the next line", () => {
    const track = trackWith(20, [10, 10.5, 11, 11.5])
    track.voicing.fill(0, Math.round(12 * 20))
    const { end } = placeLine(plan, track, [])
    expect(end).toBeGreaterThan(11.5)
    expect(end).toBeLessThanOrEqual(12.1)
  })
})

describe('hooks', () => {
  const lines = [
    line(1, 'Never gonna give you up'),
    line(4, 'Never gonna let you down'),
    line(7, 'We know the game'),
    line(10, 'Never gonna give you up'),
    line(13, 'Never gonna let you down'),
    line(16, 'Never gonna run around'),
  ]

  test('the most repeated short phrase, longer ones first', () => {
    const phrase = findPhrase(lines.map(({ text }) => wordsOf(text)))
    expect(phrase?.keys).toEqual(['never', 'gonna'])
    expect(phrase?.count).toBe(5)
    // Stopwords alone never make one.
    expect(
      findPhrase([
        ['you', 'and', 'me'],
        ['you', 'and', 'me'],
        ['you', 'and', 'me'],
      ]),
    ).toBeNull()
  })

  test('lines that come again are hooks; their phrase is marked word by word', () => {
    const timed = timeWords(lines, null, [], 20)
    expect(timed.lines.map(({ hook }) => hook)).toEqual([
      true,
      true,
      false,
      true,
      true,
      false,
    ])
    expect(timed.phrase).toBe('Never gonna')
    const first = timed.words.filter(word => word.line === 0)
    expect(first.map(word => word.phrase)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ])
    expect(first.every(word => word.hook)).toBe(true)
    // Each word ends where the next starts.
    expect(first[0]?.endSeconds).toBe(first[1]?.startSeconds ?? -1)
  })

  test('only the lines sung most often are hooks, about a third at most', () => {
    // A chorus line sung four times, two sung twice, and a verse.
    const words = [
      'here comes the chorus',
      'the verse goes on',
      'and on and on',
      'here comes the chorus',
      'a line sung twice',
      'another sung twice',
      'here comes the chorus',
      'a line sung twice',
      'another sung twice',
      'still more verse',
      'here comes the chorus',
      'the end of it',
    ].map(text => text.split(' '))
    const hooks = hookLines(words, findPhrase(words))
    expect([...hooks]).toEqual(['here comes the chorus'])
    // A song that sings every line twice: only the lines with its phrase.
    const doubled = ['oh my love', 'oh my love', 'walk on by', 'walk on by']
      .map(text => text.split(' '))
      .concat([['oh', 'my', 'love', 'again']])
    expect([...hookLines(doubled, findPhrase(doubled))]).toEqual(['oh my love'])
  })

  test('word-timed lines keep their own times', () => {
    const timed = timeWords(
      [
        {
          startSeconds: 2,
          text: 'We are',
          words: [
            { startSeconds: 2, text: 'We ' },
            { startSeconds: 2.6, text: 'are' },
          ],
        },
      ],
      null,
      [],
      10,
    )
    expect(timed.words.map(word => word.startSeconds)).toEqual([2, 2.6])
  })
})

describe('the score as a track', () => {
  test('reads back a PNG the score writer made', () => {
    const pixels = Uint8Array.from({ length: 6 * 4 }, (_, i) => (i * 37) % 256)
    const image = readGrayPng(grayPng(pixels, 6, 4))
    expect(image?.width).toBe(6)
    expect(Array.from(image?.pixels ?? [])).toEqual(Array.from(pixels))
  })

  test('finds where the lead starts singing and steps to a new note', () => {
    const rows = 40
    const columns = 32
    const pixels = new Uint8Array(rows * columns)
    for (let row = 0; row < rows; row++) {
      const singing = row >= 10
      pixels[row * columns + 29] = singing ? 255 : 0
      pixels[row * columns + 30] = singing ? (row < 25 ? 60 : 120) : 0
    }
    const score: Tv.TvScore = {
      rate: 20,
      columns,
      png: Buffer.from(grayPng(pixels, columns, rows)).toString('base64'),
    }
    const track = sungTrack(score)
    expect(track).not.toBeNull()
    const onsets = Array.from(track?.onsets ?? []).flatMap((value, row) =>
      value > 0 ? [row] : [],
    )
    expect(onsets).toEqual([10, 25])
  })
})

describe('the atlas', () => {
  test('a distance field is signed: inside positive, outside negative', () => {
    const width = 20
    const coverage = new Uint8Array(width * width)
    for (let y = 5; y < 15; y++)
      for (let x = 5; x < 15; x++) coverage[y * width + x] = 255
    const field = signedDistance(coverage, width, width)
    expect(field[10 * width + 10]).toBeCloseTo(4.5, 5)
    expect(field[10 * width + 2]).toBeCloseTo(-2.5, 5)
    expect(field[0]).toBeCloseTo(-(Math.hypot(5, 5) - 0.5), 5)
    const { bytes, width: small } = fieldBytes(field, width, width, 2, 4)
    expect(small).toBe(10)
    // The middle is well inside; the corners well outside.
    expect(bytes[5 * 10 + 5]).toBeGreaterThan(180)
    expect(bytes[0]).toBeLessThan(50)
  })

  test('packs rows, tallest first, and says when they do not fit', () => {
    const packed = pack(
      [
        { width: 60, height: 10 },
        { width: 50, height: 20 },
        { width: 50, height: 10 },
      ],
      100,
    )
    // 50 × 20 opens the first row, 60 × 10 and 50 × 10 a row each.
    expect(packed?.places).toEqual([
      { x: 0, y: 20 },
      { x: 0, y: 0 },
      { x: 0, y: 30 },
    ])
    expect(packed?.height).toBe(40)
    expect(pack([{ width: 101, height: 1 }], 100)).toBeNull()
  })

  test('capitals shrink for a song of many words', () => {
    expect(capFor(['LOVE', 'ME', 'DO'])).toBe(64)
    const many = Array.from({ length: 600 }, (_, i) => `WORD${i}`)
    expect(capFor(many)).toBeLessThan(40)
  })

  test("builds glyphs from a drawing's ink, leaving out words with none", () => {
    const plan = planAtlas(['AB', 'C', '?'], 32)
    const pixels = new Uint8Array(plan.canvasWidth * plan.canvasHeight)
    // "Draw" a block of ink as each word, two capitals tall, on its baseline,
    // and none for the third.
    plan.cells.slice(0, 3).forEach(cell => {
      const capital = 2 * 32
      for (
        let y = cell.y + cell.baseline - capital;
        y < cell.y + cell.baseline;
        y++
      )
        for (let x = cell.x + 40; x < cell.x + 40 + 50; x++)
          pixels[y * plan.canvasWidth + x] = 255
    })
    const atlas = buildAtlas(plan, pixels)
    expect(atlas?.glyphs.map(glyph => glyph.text)).toEqual(['AB', 'C'])
    expect(atlas?.capHeight).toBe(32)
    const glyph = atlas?.glyphs[0]
    // The ink, 25 × 32, and the field's reach around it.
    expect(glyph?.width).toBe(25 + 2 * plan.spread)
    expect(glyph?.height).toBe(32 + 2 * plan.spread)
    expect(glyph?.baseline).toBe(32 + plan.spread)
    const image = readGrayPng(
      new Uint8Array(Buffer.from(atlas?.png ?? '', 'base64')),
    )
    expect(image?.width).toBe(atlas?.width)
    // The glyph's middle is ink; its corner is outside.
    const at = (x: number, y: number) =>
      image?.pixels[y * (image?.width ?? 0) + x] ?? 0
    expect(
      at(
        (glyph?.x ?? 0) + Math.floor((glyph?.width ?? 0) / 2),
        (glyph?.y ?? 0) + Math.floor((glyph?.height ?? 0) / 2),
      ),
    ).toBeGreaterThan(160)
    expect(at(glyph?.x ?? 0, glyph?.y ?? 0)).toBeLessThan(40)
  })
})

describe('a song’s words', () => {
  const atlasOf = (texts: ReadonlyArray<string>): Tv.TvWordAtlas => ({
    width: 8,
    height: 8,
    capHeight: 4,
    spread: 1,
    png: '',
    glyphs: texts.map((text, i) => ({
      text,
      x: i,
      y: 0,
      width: 1,
      height: 1,
      baseline: 1,
    })),
  })

  test('each distinct word is drawn once, and each word points at its glyph', async () => {
    const drawn: Array<ReadonlyArray<string>> = []
    const words = await Effect.runPromise(
      makeWords('abc', [line(1, 'Go go, gone 愛')], Option.none(), texts =>
        Effect.sync(() => {
          drawn.push(texts)
          return Option.some(atlasOf(texts))
        }),
      ),
    )
    expect(drawn).toEqual([['GO', 'GONE']])
    expect(words.words.map(word => word.glyph)).toEqual([0, 0, 1, null])
  })

  test('kept once made from an analysis; made again when the lyrics change', async () => {
    let draws = 0
    const service = await Effect.runPromise(
      makeSongWords(
        makeWordsCache(new Database(':memory:', { strict: true }), 2),
        () => texts =>
          Effect.sync(() => {
            draws++
            return Option.some(atlasOf(texts))
          }),
        () => draws,
      ),
    )
    const made: Tv.TvAnalysis = {
      videoId: 'abc',
      durationSeconds: 10,
      tempo: 120,
      beats: [],
      downbeats: [],
      sections: [],
      drops: [],
      accents: [],
      energyStepSeconds: 0.1,
      energy: [],
      drive: 0.5,
      kicks: [],
      snares: [],
      hats: [],
      chords: [],
      keys: [],
      stops: [],
      risers: [],
      fills: [],
      score: { rate: 20, columns: 32, png: '' },
      choreography: {
        climax: null,
        builds: [],
        breaths: [],
        strobes: [],
        transitions: [],
      },
    }
    const analysis = Option.some(made)
    const ask = (text: string, maybe = analysis) =>
      Effect.runPromise(service.words('abc', [line(1, text)], maybe))
    await ask('la la')
    await ask('la la')
    expect(draws).toBe(1)
    await ask('la di da')
    expect(draws).toBe(2)
    // Without an analysis they are a guess, never kept.
    await ask('oh', Option.none())
    await ask('oh', Option.none())
    expect(draws).toBe(4)
  })
})
