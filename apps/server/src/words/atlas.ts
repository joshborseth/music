import type { Tv } from '@music/shared'

import { grayPng } from '../analysis/score.ts'
import { fieldBytes, signedDistance } from './sdf.ts'

/*
 * Every distinct word of a song in one texture for the TV: a signed
 * distance field of each word in capitals (`sdf.ts`), packed in rows.
 *
 * ffmpeg draws the words (its `drawtext` filter, with FreeType) in the
 * app's own type, Inter Display ExtraBold, twice the size they are kept,
 * each in a cell of a tall canvas with room to spare; here each word's ink
 * is found in its cell, turned into a distance field, halved, and packed.
 * The capitals are as tall as fits: 64 pixels for most songs, less for a
 * song of many words, so the atlas stays within 2048 pixels each way, a
 * size every GPU takes.
 */

export const ATLAS_SIDE = 2048
/** A capital's height in the atlas, at most and at least. */
const MAX_CAP = 64
const MIN_CAP = 24
/** The distance field reaches this many capitals' heights from the edge. */
const SPREAD_PER_CAP = 0.25
/** Words are drawn this many times larger than they are kept. */
const SCALE = 2
/** Inter's capitals are this many of its font size tall. */
const CAP_PER_EM = 0.727
/** The canvas ffmpeg draws on is this wide. */
const CANVAS_WIDTH = 4096
/** A row of the canvas holds a capital this many times over, above and below the baseline. */
const ABOVE_BASELINE = 1.12
const BELOW_BASELINE = 0.43
/** A pixel this bright is ink, when finding a word's bounds. */
const INK = 8

/** The letters, digits, and marks the font draws (Latin, Greek, Cyrillic). */
const DRAWABLE =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{M}'&-]+$/u

/** A word as the atlas draws it, or null when the font can't draw it. */
export const glyphText = (word: string): string | null => {
  const text = word.toUpperCase()
  return DRAWABLE.test(text) ? text : null
}

export interface Cell {
  readonly text: string
  /** The cell's top left corner on the canvas. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** The baseline, pixels down from the cell's top. */
  readonly baseline: number
}

export interface AtlasPlan {
  /** A capital's height in the atlas, and the field's spread there. */
  readonly cap: number
  readonly spread: number
  readonly fontSize: number
  readonly canvasWidth: number
  readonly canvasHeight: number
  /** A capital H to measure, then each word. */
  readonly cells: ReadonlyArray<Cell>
}

/** Room around a word in its cell on the canvas: its field's reach and a little. */
const cellPad = (spread: number) => spread * SCALE + 4

const spreadFor = (cap: number) => Math.max(4, Math.round(cap * SPREAD_PER_CAP))

/** How much of the atlas `texts` would take with capitals `cap` tall. */
const areaFor = (texts: ReadonlyArray<string>, cap: number): number => {
  const pad = 2 * spreadFor(cap)
  return texts.reduce(
    (sum, text) =>
      sum +
      (cap * (0.85 * [...text].length + 0.1) + pad + 1) *
        (cap * 1.05 + pad + 1),
    0,
  )
}

/** The tallest capitals that leave room to pack `texts`, down from `below`. */
export const capFor = (
  texts: ReadonlyArray<string>,
  below = MAX_CAP + 1,
): number => {
  for (let cap = Math.min(MAX_CAP, below - 1); cap > MIN_CAP; cap -= 2)
    if (areaFor(texts, cap) <= 0.85 * ATLAS_SIDE * ATLAS_SIDE) return cap
  return MIN_CAP
}

/** Where on ffmpeg's canvas each word is drawn, with capitals `cap` tall. */
export const planAtlas = (
  texts: ReadonlyArray<string>,
  cap: number,
): AtlasPlan => {
  const spread = spreadFor(cap)
  const fontSize = Math.round((cap * SCALE) / CAP_PER_EM)
  const pad = cellPad(spread)
  const height =
    Math.ceil(fontSize * (ABOVE_BASELINE + BELOW_BASELINE)) + 2 * pad
  const baseline = pad + Math.ceil(fontSize * ABOVE_BASELINE)
  const cells: Array<Cell> = []
  let x = 0
  let y = 0
  for (const text of ['H', ...texts]) {
    // No capital is wider than its font size, so the word fits.
    const width = Math.min(CANVAS_WIDTH, fontSize * [...text].length + 2 * pad)
    if (x + width > CANVAS_WIDTH) {
      x = 0
      y += height
    }
    cells.push({ text, x, y, width, height, baseline })
    x += width
  }
  return {
    cap,
    spread,
    fontSize,
    canvasWidth: CANVAS_WIDTH,
    canvasHeight: y + height,
    cells,
  }
}

/**
 * The ffmpeg filter that draws the plan's words, word `i` read from
 * `files[i]`: a file each, so no word needs the filter's escaping.
 */
export const drawFilter = (
  plan: AtlasPlan,
  fontPath: string,
  files: ReadonlyArray<string>,
): string =>
  plan.cells
    .map(
      (cell, i) =>
        `drawtext=fontfile='${fontPath}':textfile='${files[i] ?? ''}':expansion=none` +
        `:fontsize=${plan.fontSize}:fontcolor=white:y_align=baseline` +
        `:x=${cell.x + cellPad(plan.spread)}:y=${cell.y + cell.baseline}`,
    )
    .join(',\n')

interface Bounds {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** The ink in `cell` of the drawn canvas, or null when there is none. */
const inkBounds = (
  pixels: Uint8Array,
  canvasWidth: number,
  cell: Cell,
): Bounds | null => {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (let y = cell.y; y < cell.y + cell.height; y++) {
    for (let x = cell.x; x < cell.x + cell.width; x++) {
      if ((pixels[y * canvasWidth + x] ?? 0) > INK) {
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
  }
  return left > right
    ? null
    : { left, top, right: right + 1, bottom: bottom + 1 }
}

interface Field {
  readonly text: string
  readonly bytes: Uint8Array
  readonly width: number
  readonly height: number
  /** The baseline, atlas pixels down from the top. */
  readonly baseline: number
}

/** Shelves: the tallest first, left to right, a new row when one is full. */
export const pack = (
  sizes: ReadonlyArray<{ readonly width: number; readonly height: number }>,
  side: number,
): {
  readonly places: ReadonlyArray<{ x: number; y: number }>
  readonly height: number
} | null => {
  const order = sizes
    .map((size, index) => ({ ...size, index }))
    .sort((a, b) => b.height - a.height || b.width - a.width)
  const places = new Array<{ x: number; y: number }>(sizes.length)
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const size of order) {
    if (size.width > side) return null
    if (x + size.width > side) {
      x = 0
      y += rowHeight
      rowHeight = 0
    }
    places[size.index] = { x, y }
    x += size.width
    rowHeight = Math.max(rowHeight, size.height)
  }
  const height = y + rowHeight
  return height > side ? null : { places, height }
}

/**
 * The atlas from ffmpeg's drawing of `plan`: each word's field and where
 * it is packed. Null when the words do not fit, so the caller draws them
 * smaller. Words with no ink (none the font has) are left out.
 */
export const buildAtlas = (
  plan: AtlasPlan,
  pixels: Uint8Array,
): Tv.TvWordAtlas | null => {
  const [reference, ...cells] = plan.cells
  const measured =
    reference === undefined
      ? null
      : inkBounds(pixels, plan.canvasWidth, reference)
  const cap =
    measured === null ? plan.cap : (measured.bottom - measured.top) / SCALE
  const pad = plan.spread * SCALE
  const fields: Array<Field> = []
  for (const cell of cells) {
    const ink = inkBounds(pixels, plan.canvasWidth, cell)
    if (ink === null) continue
    const left = Math.max(cell.x, ink.left - pad)
    const top = Math.max(cell.y, ink.top - pad)
    const width = Math.min(cell.x + cell.width, ink.right + pad) - left
    const height = Math.min(cell.y + cell.height, ink.bottom + pad) - top
    const coverage = new Uint8Array(width * height)
    for (let y = 0; y < height; y++)
      coverage.set(
        pixels.subarray(
          (top + y) * plan.canvasWidth + left,
          (top + y) * plan.canvasWidth + left + width,
        ),
        y * width,
      )
    const field = fieldBytes(
      signedDistance(coverage, width, height),
      width,
      height,
      SCALE,
      plan.spread,
    )
    fields.push({
      text: cell.text,
      ...field,
      baseline: (cell.y + cell.baseline - top) / SCALE,
    })
  }
  if (fields.length === 0) return null
  // A pixel between rectangles, so filtering never reads a neighbor.
  const packed = pack(
    fields.map(field => ({ width: field.width + 1, height: field.height + 1 })),
    ATLAS_SIDE,
  )
  if (packed === null) return null
  const width = Math.min(
    ATLAS_SIDE,
    Math.max(
      ...fields.map((field, i) => (packed.places[i]?.x ?? 0) + field.width + 1),
    ),
  )
  const atlas = new Uint8Array(width * packed.height)
  const glyphs = fields.map((field, i) => {
    const { x, y } = packed.places[i] ?? { x: 0, y: 0 }
    for (let row = 0; row < field.height; row++)
      atlas.set(
        field.bytes.subarray(row * field.width, (row + 1) * field.width),
        (y + row) * width + x,
      )
    return {
      text: field.text,
      x,
      y,
      width: field.width,
      height: field.height,
      baseline: Math.round(field.baseline * 100) / 100,
    }
  })
  return {
    width,
    height: packed.height,
    capHeight: Math.round(cap * 100) / 100,
    spread: plan.spread,
    png: Buffer.from(grayPng(atlas, width, packed.height)).toString('base64'),
    glyphs,
  }
}
