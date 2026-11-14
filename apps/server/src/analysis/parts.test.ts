import { describe, expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'

import { SAMPLE_RATE, analyzeSamples } from './analyze.ts'
import { findChords, findKeys, listenForTune } from './harmony.ts'
import { findStops } from './moments.ts'
import { grayPng } from './score.ts'

/** A repeatable noise source, so the tests never flake. */
const noise = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 31 - 1
  }
}

/** Tones (Hz) held over `[from, to)` seconds, added into `samples`. */
const hold = (
  samples: Float32Array,
  hz: ReadonlyArray<number>,
  from: number,
  to: number,
  gain = 0.1,
) => {
  for (
    let i = Math.round(from * SAMPLE_RATE);
    i < Math.round(to * SAMPLE_RATE);
    i++
  ) {
    const t = i / SAMPLE_RATE
    for (const f of hz)
      samples[i] = (samples[i] ?? 0) + gain * Math.sin(2 * Math.PI * f * t)
  }
}

const midiHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
/** A triad with three harmonics a note, as an instrument would have. */
const triad = (root: number, minor: boolean) =>
  [root, root + (minor ? 3 : 4), root + 7].flatMap(note =>
    [1, 2, 3].map(h => midiHz(note) * h),
  )

describe('drums', () => {
  test('a low thump on every beat is a kick, a high tick between is a hi-hat', () => {
    const seconds = 12
    const samples = new Float32Array(seconds * SAMPLE_RATE)
    const random = noise(3)
    for (let beat = 0; beat < seconds * 2; beat++) {
      const start = Math.round(beat * 0.5 * SAMPLE_RATE)
      for (let i = 0; i < 0.15 * SAMPLE_RATE; i++) {
        const t = i / SAMPLE_RATE
        samples[start + i] =
          (samples[start + i] ?? 0) +
          0.8 * Math.exp(-t * 30) * Math.sin(2 * Math.PI * 60 * t)
      }
      const tick = start + Math.round(0.25 * SAMPLE_RATE)
      let previous = 0
      for (let i = 0; i < 0.03 * SAMPLE_RATE; i++) {
        // White noise, differenced: only the top of the spectrum.
        const value = random()
        samples[tick + i] =
          (samples[tick + i] ?? 0) +
          0.3 * Math.exp((-i / SAMPLE_RATE) * 150) * (value - previous)
        previous = value
      }
    }
    const analysis = analyzeSamples('drums', samples)
    const middle = (times: ReadonlyArray<number>) =>
      times.filter(time => time > 2 && time < 10)
    const kicks = middle(analysis.kicks)
    expect(kicks.length).toBeGreaterThanOrEqual(14)
    for (const kick of kicks)
      expect(Math.abs(kick * 2 - Math.round(kick * 2))).toBeLessThan(0.06)
    const hats = middle(analysis.hats)
    expect(hats.length).toBeGreaterThanOrEqual(12)
    for (const hat of hats)
      expect(Math.abs(hat * 2 - Math.round(hat * 2))).toBeGreaterThan(0.4)
    // The thump starting at full strength clicks; a few may pass for snares.
    expect(middle(analysis.snares).length).toBeLessThan(hats.length / 3)
  })
})

describe('harmony', () => {
  test('two chords a bar apart are named, and the key holds', () => {
    const samples = new Float32Array(8 * SAMPLE_RATE)
    hold(samples, triad(60, false), 0, 4, 0.03)
    hold(samples, triad(57, true), 4, 8, 0.03)
    const tune = listenForTune(samples, SAMPLE_RATE)
    const beats = Array.from({ length: 16 }, (_, i) => i * 0.5)
    const chords = findChords(tune, beats, 8)
    expect(chords.map(chord => [chord.root, chord.minor])).toEqual([
      [0, false],
      [9, true],
    ])
    expect(chords[1]?.startSeconds).toBe(4)
    const keys = findKeys(tune, [{ startSeconds: 0, endSeconds: 8 }])
    expect(keys).toHaveLength(1)
  })

  test('a held tune is followed note by note', () => {
    const samples = new Float32Array(4 * SAMPLE_RATE)
    const notes = [64, 67, 72, 67]
    notes.forEach((note, i) =>
      hold(
        samples,
        [1, 2, 3, 4].map(h => midiHz(note) * h),
        i,
        i + 1,
        0.05,
      ),
    )
    const tune = listenForTune(samples, SAMPLE_RATE)
    notes.forEach((note, i) => {
      const frame = Math.round((i + 0.5) * tune.frameRate)
      expect(Math.abs((tune.melody[frame] ?? 0) - note)).toBeLessThan(0.6)
      expect(tune.lead[frame] ?? 0).toBeGreaterThan(0.3)
    })
  })
})

describe('moments', () => {
  test('the music cutting out mid-song is a stop', () => {
    const frameRate = 50
    const power = Float32Array.from({ length: 10 * frameRate }, (_, t) =>
      t >= 250 && t < 280 ? 1e-9 : 0.1,
    )
    expect(findStops(power, frameRate, 0.5, 9.5)).toEqual([
      { startSeconds: 5, endSeconds: 5.6 },
    ])
  })
})

describe('score', () => {
  test('the PNG holds the pixels, row by row', () => {
    const pixels = Uint8Array.from({ length: 3 * 4 }, (_, i) => (i * 37) % 256)
    const png = grayPng(pixels, 3, 4)
    expect(
      [...png.subarray(1, 4)].map(byte => String.fromCharCode(byte)).join(''),
    ).toBe('PNG')
    // The IDAT chunk follows the 8-byte signature and the 25-byte IHDR chunk.
    const view = new DataView(png.buffer, png.byteOffset)
    const length = view.getUint32(33)
    const raw = inflateSync(png.subarray(41, 41 + length))
    const rows = Array.from({ length: 4 }, (_, row) => {
      const filtered = raw.subarray(row * 4 + 1, row * 4 + 4)
      return [...filtered]
    })
    const decoded: Array<number> = []
    rows.forEach((row, r) =>
      row.forEach((value, x) =>
        decoded.push(
          (value + (r > 0 ? (decoded[(r - 1) * 3 + x] ?? 0) : 0)) & 0xff,
        ),
      ),
    )
    expect(decoded).toEqual([...pixels])
  })
})
