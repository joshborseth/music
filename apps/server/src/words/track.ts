import { inflateSync } from 'node:zlib'

import type { Tv } from '@music/shared'

import { SCORE_COLUMNS, SPECTRUM_COLUMNS } from '../analysis/score.ts'
import { type SungTrack, VOICED } from './timing.ts'

/*
 * The singing, read back off the song's score (`analysis/score.ts`): its
 * lead column (how clearly a lead melody stands out) and its melody column
 * (the lead's height across the song's own range), twenty rows a second.
 * A note starts where the lead starts singing, where its pitch steps to a
 * new one and holds, where it sings again after a dip (a new syllable on
 * the same note), or, more weakly, where the voice's part of the spectrum
 * jumps while it sings.
 */

const LEAD = SPECTRUM_COLUMNS + 5
const MELODY = SPECTRUM_COLUMNS + 6
/** The voice's part of the spectrum, in the score's columns (about 300 Hz to 3 kHz). */
const VOICE_COLUMNS = [8, 18] as const
/** Two note starts are at least this many rows apart. */
const MIN_ROWS_APART = 2
/** A row's onset counts when it is at least this strong. */
const MIN_ONSET = 0.15

/** The pixels of an 8-bit grayscale PNG (any of PNG's row filters), or null. */
export const readGrayPng = (
  png: Uint8Array,
): {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
} | null => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  if (png.length < 33 || view.getUint32(0) !== 0x89504e47) return null
  let width = 0
  let height = 0
  const data: Array<Uint8Array> = []
  let at = 8
  while (at + 8 <= png.length) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8))
    const body = png.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      // 8-bit grayscale, not interlaced.
      if (body[8] !== 8 || body[9] !== 0 || body[12] !== 0) return null
    } else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
    at += 12 + length
  }
  if (width === 0 || height === 0) return null
  const joined = new Uint8Array(
    data.reduce((sum, part) => sum + part.length, 0),
  )
  let offset = 0
  for (const part of data) {
    joined.set(part, offset)
    offset += part.length
  }
  let raw: Uint8Array
  try {
    raw = new Uint8Array(inflateSync(joined))
  } catch {
    return null
  }
  if (raw.length < height * (width + 1)) return null
  const pixels = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)] ?? 0
    for (let x = 0; x < width; x++) {
      const value = raw[y * (width + 1) + 1 + x] ?? 0
      const left = x > 0 ? (pixels[y * width + x - 1] ?? 0) : 0
      const up = y > 0 ? (pixels[(y - 1) * width + x] ?? 0) : 0
      const corner = x > 0 && y > 0 ? (pixels[(y - 1) * width + x - 1] ?? 0) : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - corner
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - corner)
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner
      }
      pixels[y * width + x] = (value + predicted) & 0xff
    }
  }
  return { width, height, pixels }
}

/** The singing in `score`, or null when it can't be read. */
export const sungTrack = (score: Tv.TvScore): SungTrack | null => {
  const image = readGrayPng(new Uint8Array(Buffer.from(score.png, 'base64')))
  if (
    image === null ||
    image.width !== score.columns ||
    score.columns < SCORE_COLUMNS
  )
    return null
  const { pixels, height: rows, width: columns } = image
  const at = (row: number, column: number) =>
    (pixels[Math.min(rows - 1, Math.max(0, row)) * columns + column] ?? 0) / 255
  const voicing = new Float32Array(rows)
  for (let row = 0; row < rows; row++)
    voicing[row] = at(row, MELODY) > 0 ? at(row, LEAD) : 0
  const sings = (row: number) =>
    row >= 0 && row < rows && (voicing[row] ?? 0) > VOICED
  const raw = new Float32Array(rows)
  for (let row = 1; row < rows; row++) {
    if (!sings(row)) continue
    let strength = 0
    // The lead starts singing.
    if (!sings(row - 1)) strength = sings(row - 2) ? 0.8 : 1
    else {
      // A step to a new pitch that holds.
      const step = Math.abs(at(row, MELODY) - at(row - 1, MELODY)) * 255
      const holds =
        !sings(row + 1) ||
        Math.abs(at(row + 1, MELODY) - at(row, MELODY)) * 255 < step / 2
      if (step > 4 && holds)
        strength = Math.max(strength, 0.7 * Math.min(1, (step - 4) / 12))
      // Sung again after a dip.
      const rise =
        (voicing[row] ?? 0) -
        Math.min(voicing[row - 1] ?? 0, voicing[row - 2] ?? 0)
      if (rise > 0.12)
        strength = Math.max(strength, 0.5 * Math.min(1, rise / 0.3))
    }
    // The voice's part of the spectrum jumps.
    let flux = 0
    for (let column = VOICE_COLUMNS[0]; column <= VOICE_COLUMNS[1]; column++)
      flux += Math.max(0, at(row, column) - at(row - 1, column))
    flux /= VOICE_COLUMNS[1] - VOICE_COLUMNS[0] + 1
    strength = Math.max(strength, 0.4 * Math.min(1, flux * 6))
    raw[row] = strength
  }
  // Only the peaks, a little apart.
  const onsets = new Float32Array(rows)
  for (let row = 0; row < rows; row++) {
    const value = raw[row] ?? 0
    if (value < MIN_ONSET) continue
    let peak = true
    for (let k = row - MIN_ROWS_APART; k <= row + MIN_ROWS_APART && peak; k++)
      if (
        k !== row &&
        ((raw[k] ?? 0) > value || (k < row && (raw[k] ?? 0) === value))
      )
        peak = false
    if (peak) onsets[row] = value
  }
  return { rate: score.rate, voicing, onsets }
}
