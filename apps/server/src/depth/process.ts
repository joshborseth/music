/*
 * The pure halves of a cover's depth: the picture made into what Depth
 * Anything V2 reads, and what it answers made into the map the TV draws
 * with. Both run in the depth runner (`runner.ts`), off the server's
 * process, and are tested on their own.
 *
 * The model reads a 518 × 518 picture, scaled 0 to 1 and normalized with
 * ImageNet's mean and spread, channel by channel (NCHW). It answers a
 * relative inverse depth the same size: larger is nearer, in no fixed unit.
 * The TV wants a `DEPTH_SIDE` square of bytes, near bright, the cover's own
 * size there (`COVER_SIDE` in `apps/tv/src/visuals/look.rs`).
 */

/** The side of the square the model reads (its card's `size`). */
export const INPUT_SIDE = 518
/** The side of the depth map the TV gets, the size it draws the cover at. */
export const DEPTH_SIDE = 256

const MEAN = [0.485, 0.456, 0.406] as const
const STD = [0.229, 0.224, 0.225] as const

/**
 * Packed RGB bytes, `side` × `side`, as the model's input: three planes of
 * floats, each channel scaled 0 to 1, less its mean, over its spread.
 */
export const toInputTensor = (
  rgb: Uint8Array,
  side: number = INPUT_SIDE,
): Float32Array => {
  const pixels = side * side
  if (rgb.length !== pixels * 3) {
    throw new Error(`Expected ${pixels * 3} bytes of RGB, got ${rgb.length}`)
  }
  const tensor = new Float32Array(pixels * 3)
  for (let channel = 0; channel < 3; channel++) {
    const mean = MEAN[channel] ?? 0
    const scale = 1 / (255 * (STD[channel] ?? 1))
    const shift = mean / (STD[channel] ?? 1)
    const plane = channel * pixels
    for (let i = 0; i < pixels; i++) {
      tensor[plane + i] = (rgb[i * 3 + channel] ?? 0) * scale - shift
    }
  }
  return tensor
}

/** Where the darkest and brightest of the map are pinned: a speck is not the range. */
const LOW_SHARE = 0.01
const HIGH_SHARE = 0.995

/**
 * The value below which `share` of `values` lie. Sorts a copy, which for
 * the model's quarter million values takes a few tens of milliseconds.
 */
export const quantile = (values: Float32Array, share: number): number => {
  const sorted = Float32Array.from(values).sort()
  const at = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(share * (sorted.length - 1))),
  )
  return sorted[at] ?? 0
}

/**
 * `source` (`from` × `from`) shrunk to `to` × `to`: each output pixel the
 * average of the source area it covers, partial pixels weighed by how much
 * of them it covers. No aliasing, and a flat map stays flat.
 */
export const shrink = (
  source: Float32Array,
  from: number,
  to: number,
): Float32Array => {
  const out = new Float32Array(to * to)
  const step = from / to
  // Each output column's source span, worked out once: [first, last, weights].
  const spans = Array.from({ length: to }, (_, o) => {
    const start = o * step
    const end = start + step
    const first = Math.floor(start)
    const last = Math.min(from - 1, Math.ceil(end) - 1)
    const weights: Array<number> = []
    for (let i = first; i <= last; i++) {
      weights.push(Math.min(end, i + 1) - Math.max(start, i))
    }
    return { first, weights }
  })
  const area = step * step
  for (let oy = 0; oy < to; oy++) {
    const rows = spans[oy]
    if (rows === undefined) continue
    for (let ox = 0; ox < to; ox++) {
      const columns = spans[ox]
      if (columns === undefined) continue
      let sum = 0
      rows.weights.forEach((wy, dy) => {
        const row = (rows.first + dy) * from + columns.first
        columns.weights.forEach((wx, dx) => {
          sum += (source[row + dx] ?? 0) * wx * wy
        })
      })
      out[oy * to + ox] = sum / area
    }
  }
  return out
}

/**
 * A light blur, [1 2 1] each way, the edges held: the mesh the TV raises
 * from the map then has no one-pixel steps, while a figure keeps its
 * outline.
 */
export const soften = (map: Float32Array, side: number): Float32Array => {
  const across = new Float32Array(map.length)
  const at = (x: number, y: number, from: Float32Array) =>
    from[
      Math.min(side - 1, Math.max(0, y)) * side +
        Math.min(side - 1, Math.max(0, x))
    ] ?? 0
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      across[y * side + x] =
        (at(x - 1, y, map) + 2 * at(x, y, map) + at(x + 1, y, map)) / 4
    }
  }
  const out = new Float32Array(map.length)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      out[y * side + x] =
        (at(x, y - 1, across) + 2 * at(x, y, across) + at(x, y + 1, across)) / 4
    }
  }
  return out
}

/**
 * The model's answer (`side` × `side` relative inverse depth) as the TV's
 * depth map: `DEPTH_SIDE` square bytes, row by row from the top, the
 * nearest bright (255) and the farthest dark (0), pinned at the 1% and
 * 99.5% marks so a stray pixel doesn't squash the rest, lightly smoothed.
 * A map with no depth at all comes out a flat middle grey.
 */
export const toDepthMap = (
  raw: Float32Array,
  side: number = INPUT_SIDE,
  to: number = DEPTH_SIDE,
): Uint8Array => {
  if (raw.length !== side * side) {
    throw new Error(`Expected ${side * side} depths, got ${raw.length}`)
  }
  const small = soften(shrink(raw, side, to), to)
  const low = quantile(small, LOW_SHARE)
  const high = quantile(small, HIGH_SHARE)
  const range = high - low
  const out = new Uint8Array(to * to)
  if (!(range > 1e-6)) return out.fill(128)
  for (let i = 0; i < out.length; i++) {
    const value = ((small[i] ?? low) - low) / range
    out[i] = Math.round(Math.min(1, Math.max(0, value)) * 255)
  }
  return out
}
