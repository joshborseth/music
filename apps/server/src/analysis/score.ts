import { deflateSync } from 'node:zlib'

import type { Tv } from '@music/shared'

import { type Hit, quantile } from './drums.ts'
import type { Tune } from './harmony.ts'
import { MEL_BANDS, type Spectrogram } from './spectrogram.ts'

/*
 * The whole song as a picture for the TV's GPU (`Tv.TvScore`): a row every
 * `SCORE_RATE`th of a second, a column for each thing the visuals read
 * ahead of the music, as a grayscale PNG.
 */

export const SCORE_RATE = 20
export const SPECTRUM_COLUMNS = 24
export const SCORE_COLUMNS = SPECTRUM_COLUMNS + 8
/** The spectrum shows this many dB under its loudest. */
const SPECTRUM_RANGE_DB = 50
/** Seconds a drum hit takes to fade to a third. */
const HIT_DECAY = 0.12

export interface ScoreInput {
  readonly durationSeconds: number
  readonly spec: Spectrogram
  /** Percussive and low harmonic power per frame, in dB. */
  readonly drumsDb: Float32Array
  readonly bassDb: Float32Array
  readonly kicks: ReadonlyArray<Hit>
  readonly snares: ReadonlyArray<Hit>
  readonly hats: ReadonlyArray<Hit>
  readonly tune: Tune
  /** The spectrum's centroid per frame, in octaves. */
  readonly brightness: Float32Array
}

const toByte = (value: number): number =>
  Math.round(Math.min(1, Math.max(0, value)) * 255)

/** Scales `values` so the song's quiet end is 0 and its loud end 1. */
const spread = (
  values: Float32Array,
  low = 0.05,
  high = 0.98,
): ((value: number) => number) => {
  const from = quantile(values, low)
  const to = quantile(values, high)
  return value => (to > from ? (value - from) / (to - from) : 0)
}

/** Each row's strength of `hits`, fading after each one. */
const hitEnvelope = (
  hits: ReadonlyArray<Hit>,
  frameRate: number,
  rows: number,
): Float32Array => {
  const out = new Float32Array(rows)
  for (const hit of hits) {
    const time = hit.frame / frameRate
    const first = Math.ceil(time * SCORE_RATE)
    for (let row = first; row < rows; row++) {
      const value =
        hit.strength * Math.exp(-(row / SCORE_RATE - time) / HIT_DECAY)
      if (value < 0.02) break
      out[row] = Math.max(out[row] ?? 0, value)
    }
  }
  return out
}

export const buildScore = (input: ScoreInput): Tv.TvScore => {
  const { spec, tune } = input
  const rows = Math.max(1, Math.ceil(input.durationSeconds * SCORE_RATE))
  const pixels = new Uint8Array(rows * SCORE_COLUMNS)
  const frameAt = (row: number) =>
    Math.min(spec.frames - 1, Math.round((row / SCORE_RATE) * spec.frameRate))
  const tuneAt = (row: number) =>
    Math.min(tune.frames - 1, Math.round((row / SCORE_RATE) * tune.frameRate))

  // The spectrum in coarse bands, averaged over each row's frames.
  const perBand = MEL_BANDS / SPECTRUM_COLUMNS
  const bandValues = new Float32Array(spec.frames * SPECTRUM_COLUMNS)
  for (let t = 0; t < spec.frames; t++) {
    for (let column = 0; column < SPECTRUM_COLUMNS; column++) {
      let sum = 0
      for (let k = 0; k < perBand; k++)
        sum += spec.melDb[t * MEL_BANDS + column * perBand + k] ?? 0
      bandValues[t * SPECTRUM_COLUMNS + column] = sum / perBand
    }
  }
  const top = quantile(bandValues, 0.995)
  const drums = spread(input.drumsDb, 0.2)
  const bass = spread(input.bassDb, 0.2)
  const bright = spread(input.brightness)
  const kick = hitEnvelope(input.kicks, spec.frameRate, rows)
  const snare = hitEnvelope(input.snares, spec.frameRate, rows)
  const hat = hitEnvelope(input.hats, spec.frameRate, rows)
  const voiced = tune.melody.filter(Number.isFinite)
  const lowNote = quantile(voiced, 0.05)
  const highNote = Math.max(lowNote + 7, quantile(voiced, 0.95))

  const halfRow = Math.max(1, Math.round(spec.frameRate / SCORE_RATE / 2))
  for (let row = 0; row < rows; row++) {
    const at = row * SCORE_COLUMNS
    const frame = frameAt(row)
    for (let column = 0; column < SPECTRUM_COLUMNS; column++) {
      let sum = 0
      let n = 0
      for (
        let t = Math.max(0, frame - halfRow);
        t <= Math.min(spec.frames - 1, frame + halfRow);
        t++
      ) {
        sum += bandValues[t * SPECTRUM_COLUMNS + column] ?? 0
        n++
      }
      pixels[at + column] = toByte(
        (sum / Math.max(1, n) - (top - SPECTRUM_RANGE_DB)) / SPECTRUM_RANGE_DB,
      )
    }
    const t = tuneAt(row)
    const note = tune.melody[t] ?? Number.NaN
    const columns = [
      drums(input.drumsDb[frame] ?? 0),
      kick[row] ?? 0,
      snare[row] ?? 0,
      hat[row] ?? 0,
      bass(input.bassDb[frame] ?? 0),
      tune.lead[t] ?? 0,
      // 0 is silence, so a sung note is at least 1.
      Number.isFinite(note)
        ? (1 +
            254 *
              Math.min(
                1,
                Math.max(0, (note - lowNote) / (highNote - lowNote)),
              )) /
          255
        : 0,
      bright(input.brightness[frame] ?? 0),
    ]
    columns.forEach((value, i) => {
      pixels[at + SPECTRUM_COLUMNS + i] = toByte(value)
    })
  }
  return {
    rate: SCORE_RATE,
    columns: SCORE_COLUMNS,
    png: Buffer.from(grayPng(pixels, SCORE_COLUMNS, rows)).toString('base64'),
  }
}

// PNG

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/**
 * An 8-bit grayscale PNG of `pixels`, `width` a row. Each row is stored as
 * its difference from the row above (PNG's "Up" filter): the song changes
 * little from one twentieth of a second to the next, so it packs small.
 */
export const grayPng = (
  pixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array => {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8
  header[9] = 0
  const raw = new Uint8Array(height * (width + 1))
  for (let row = 0; row < height; row++) {
    const at = row * (width + 1)
    raw[at] = 2
    for (let x = 0; x < width; x++) {
      const value = pixels[row * width + x] ?? 0
      const above = row > 0 ? (pixels[(row - 1) * width + x] ?? 0) : 0
      raw[at + 1 + x] = (value - above) & 0xff
    }
  }
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
