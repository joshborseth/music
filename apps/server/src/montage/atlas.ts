import type { Tv } from '@music/shared'

import type { FrameStats } from './frames.ts'

/*
 * Packing a montage's pictures into one atlas: `columns` across, row by
 * row from the top left, each picture filling its cell. Video frames often
 * carry black bars (a widescreen film in a 16:9 frame, a 4:3 video pillar-
 * boxed); the bars every frame shares are cut off and the picture inside
 * scaled up to fill the cell, so the TV never shows them.
 */

/** Cells across an atlas. */
export const ATLAS_COLUMNS = 8

/** A picture ready for the atlas: RGB, `width` × `height`. */
export interface Picture {
  readonly pixels: Uint8Array
  readonly width: number
  readonly height: number
}

/** A picture and what is known about it. */
export interface MontageFrame {
  readonly picture: Picture
  readonly stats: FrameStats
  /** Seconds into the video; null for a photo or a cover. */
  readonly seconds: number | null
}

/** The part of a picture that holds it, without bars, in pixels. */
export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** A row or column darker than this in every frame is a bar. */
const BAR_LIGHT = 0.07
/** Bars cover at most this share of a side. */
const MOST_BAR = 0.3
/** Bars thinner than this share are left: not worth the scaling. */
const LEAST_BAR = 0.02

const lightAt = (picture: Picture, x: number, y: number): number => {
  const at = (y * picture.width + x) * 3
  return (
    (0.299 * (picture.pixels[at] ?? 0) +
      0.587 * (picture.pixels[at + 1] ?? 0) +
      0.114 * (picture.pixels[at + 2] ?? 0)) /
    255
  )
}

/**
 * The box inside the bars all `pictures` share (same-sized pictures). A row
 * or column is a bar when it is dark in every picture.
 */
export const contentBox = (pictures: ReadonlyArray<Picture>): Box => {
  const first = pictures[0]
  if (first === undefined) return { left: 0, top: 0, width: 0, height: 0 }
  const { width, height } = first
  const rowLight = new Float32Array(height)
  const columnLight = new Float32Array(width)
  for (const picture of pictures) {
    for (let y = 0; y < height; y++) {
      let row = 0
      for (let x = 0; x < width; x += 4)
        row = Math.max(row, lightAt(picture, x, y))
      rowLight[y] = Math.max(rowLight[y] ?? 0, row)
    }
    for (let x = 0; x < width; x++) {
      let column = 0
      for (let y = 0; y < height; y += 4)
        column = Math.max(column, lightAt(picture, x, y))
      columnLight[x] = Math.max(columnLight[x] ?? 0, column)
    }
  }
  const bar = (light: Float32Array, size: number, fromEnd: boolean): number => {
    let count = 0
    while (count < size * MOST_BAR) {
      const index = fromEnd ? size - 1 - count : count
      if ((light[index] ?? 0) > BAR_LIGHT) break
      count++
    }
    return count < size * LEAST_BAR ? 0 : count
  }
  const top = bar(rowLight, height, false)
  const bottom = bar(rowLight, height, true)
  const left = bar(columnLight, width, false)
  const right = bar(columnLight, width, true)
  return {
    left,
    top,
    width: width - left - right,
    height: height - top - bottom,
  }
}

/**
 * `box` of `picture`, scaled to cover `width` × `height` (cropping its
 * longer side, keeping the middle), with bilinear filtering.
 */
export const coverInto = (
  picture: Picture,
  box: Box,
  width: number,
  height: number,
): Picture => {
  const scale = Math.max(width / box.width, height / box.height)
  const offsetX = box.left + (box.width - width / scale) / 2
  const offsetY = box.top + (box.height - height / scale) / 2
  const out = new Uint8Array(width * height * 3)
  const maxX = picture.width - 1
  const maxY = picture.height - 1
  for (let y = 0; y < height; y++) {
    const sy = Math.min(maxY, Math.max(0, offsetY + (y + 0.5) / scale - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(maxY, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < width; x++) {
      const sx = Math.min(maxX, Math.max(0, offsetX + (x + 0.5) / scale - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(maxX, x0 + 1)
      const fx = sx - x0
      for (let channel = 0; channel < 3; channel++) {
        const read = (px: number, py: number) =>
          picture.pixels[(py * picture.width + px) * 3 + channel] ?? 0
        const top = read(x0, y0) * (1 - fx) + read(x1, y0) * fx
        const bottom = read(x0, y1) * (1 - fx) + read(x1, y1) * fx
        out[(y * width + x) * 3 + channel] = Math.round(
          top * (1 - fy) + bottom * fy,
        )
      }
    }
  }
  return { pixels: out, width, height }
}

/** The atlas's pixels and layout. */
export interface Atlas {
  readonly pixels: Uint8Array
  readonly width: number
  readonly height: number
  readonly columns: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
}

/** `pictures`, each already the cell's size, packed row by row. */
export const pack = (
  pictures: ReadonlyArray<Picture>,
  cellWidth: number,
  cellHeight: number,
  columns: number = ATLAS_COLUMNS,
): Atlas => {
  const across = Math.max(1, Math.min(columns, pictures.length))
  const rows = Math.max(1, Math.ceil(pictures.length / across))
  const width = across * cellWidth
  const height = rows * cellHeight
  const pixels = new Uint8Array(width * height * 3)
  pictures.forEach((picture, index) => {
    const left = (index % across) * cellWidth
    const top = Math.floor(index / across) * cellHeight
    for (let y = 0; y < cellHeight; y++) {
      const from = y * picture.width * 3
      pixels.set(
        picture.pixels.subarray(from, from + cellWidth * 3),
        ((top + y) * width + left) * 3,
      )
    }
  })
  return { pixels, width, height, columns: across, rows, cellWidth, cellHeight }
}

const rounded = (value: number, places: number): number => {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

/** What the TV is told about each picture. */
export const frameInfo = (frame: MontageFrame): Tv.TvMontageFrame => ({
  seconds: frame.seconds === null ? null : rounded(frame.seconds, 1),
  color: [
    rounded(frame.stats.color[0], 3),
    rounded(frame.stats.color[1], 3),
    rounded(frame.stats.color[2], 3),
  ],
  brightness: rounded(frame.stats.brightness, 3),
  busyness: rounded(frame.stats.busyness, 3),
})
