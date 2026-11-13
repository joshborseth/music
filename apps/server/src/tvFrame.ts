import { inflateSync } from 'node:zlib'

/*
 * Whether a screenshot from the TV shows nothing: every pixel black, or
 * every pixel fully transparent. The TV once drew a black screen for
 * every song (#80), and its screenshots, 11 KB each, were the only sign.
 * The TV sends 8-bit RGBA PNGs (`encode_png` in apps/tv/src/ui.rs); this
 * reads those and 8-bit RGB, and calls anything else not blank.
 */

/** A pixel this dark in every channel counts as black. */
const BLACK_LEVEL = 4

const IHDR = 'IHDR'
const IDAT = 'IDAT'
const IEND = 'IEND'

/** Bytes per pixel for each colour type read: RGB and RGBA. */
const CHANNELS: Readonly<Record<number, number>> = { 2: 3, 6: 4 }

interface Chunk {
  readonly type: string
  readonly data: Uint8Array
}

const chunksOf = (png: Uint8Array): ReadonlyArray<Chunk> | undefined => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunks: Array<Chunk> = []
  // NOTE: the signature was checked before; chunks start after it.
  let offset = 8
  while (offset + 8 <= png.byteLength) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    const end = offset + 8 + length
    if (end + 4 > png.byteLength) {
      return undefined
    }
    chunks.push({ type, data: png.subarray(offset + 8, end) })
    if (type === IEND) {
      return chunks
    }
    offset = end + 4
  }
  return undefined
}

const inflated = (data: Uint8Array): Uint8Array | undefined => {
  try {
    return inflateSync(data)
  } catch {
    return undefined
  }
}

const paeth = (left: number, up: number, upLeft: number): number => {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left
  }
  return toUp <= toUpLeft ? up : upLeft
}

/** Undoes each scanline's filter in place, returning the rows' bytes. */
const unfilter = (
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array | undefined => {
  const stride = width * channels
  if (raw.byteLength < height * (stride + 1)) {
    return undefined
  }
  const pixels = new Uint8Array(height * stride)
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1))
    const out = row * stride
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? (pixels[out + index - channels] ?? 0) : 0
      const up = row > 0 ? (pixels[out - stride + index] ?? 0) : 0
      const upLeft =
        row > 0 && index >= channels
          ? (pixels[out - stride + index - channels] ?? 0)
          : 0
      const predicted =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? paeth(left, up, upLeft)
                  : undefined
      if (predicted === undefined) {
        return undefined
      }
      pixels[out + index] = ((line[index] ?? 0) + predicted) & 0xff
    }
  }
  return pixels
}

/**
 * Whether a PNG shows nothing: every pixel black, or, with an alpha
 * channel, every pixel fully transparent. False for a PNG it cannot read.
 */
export const isBlankFrame = (png: Uint8Array): boolean => {
  const chunks = chunksOf(png)
  const header = chunks?.find(chunk => chunk.type === IHDR)?.data
  if (chunks === undefined || header === undefined || header.byteLength < 13) {
    return false
  }
  const view = new DataView(header.buffer, header.byteOffset, 13)
  const width = view.getUint32(0)
  const height = view.getUint32(4)
  const [bitDepth, colorType, , , interlace] = header.subarray(8, 13)
  const channels = CHANNELS[colorType ?? -1]
  if (
    channels === undefined ||
    bitDepth !== 8 ||
    interlace !== 0 ||
    width === 0 ||
    height === 0
  ) {
    return false
  }
  const compressed = Buffer.concat(
    chunks.filter(chunk => chunk.type === IDAT).map(chunk => chunk.data),
  )
  const raw = inflated(compressed)
  const pixels =
    raw === undefined ? undefined : unfilter(raw, width, height, channels)
  if (pixels === undefined) {
    return false
  }
  let isBlack = true
  let isClear = channels === 4
  for (let at = 0; at < pixels.byteLength; at += channels) {
    if (
      isBlack &&
      ((pixels[at] ?? 0) > BLACK_LEVEL ||
        (pixels[at + 1] ?? 0) > BLACK_LEVEL ||
        (pixels[at + 2] ?? 0) > BLACK_LEVEL)
    ) {
      isBlack = false
    }
    if (isClear && pixels[at + 3] !== 0) {
      isClear = false
    }
    if (!isBlack && !isClear) {
      return false
    }
  }
  return true
}
