/*
 * Signed distance fields of drawn letters, for the TV to draw words from at
 * any size: each pixel holds how far it is from the letters' edge, so a
 * shader cuts a crisp edge at any scale, and outlines, glows, and shock
 * waves come from reading the same field at other distances.
 *
 * Exact Euclidean distances (Felzenszwalb and Huttenlocher's transform, a
 * pass down each column then along each row), from a picture of the
 * letters drawn a few times larger than they are kept, then averaged down.
 * Pixels the letters' edge crosses take their distance from how much of
 * them is covered, so the edge sits between pixels as drawn, not on them.
 * Pure TypeScript, so the visuals lab uses the same code.
 */

const FAR = 1e20

/** One line of the transform: squared distances `f` in, `d` out. */
const transformLine = (
  f: Float64Array,
  n: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void => {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    const fq = (f[q] ?? FAR) + q * q
    const meet = (p: number) => (fq - ((f[p] ?? FAR) + p * p)) / (2 * q - 2 * p)
    // Drop the parabolas the new one lies below everywhere they ruled;
    // the first rules from minus infinity, so it always stays.
    let s = meet(v[k] ?? 0)
    while (s <= (z[k] ?? -Infinity)) {
      k--
      s = meet(v[k] ?? 0)
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] ?? Infinity) < q) k++
    const p = v[k] ?? 0
    d[q] = (q - p) * (q - p) + (f[p] ?? FAR)
  }
}

/** Squared distance from each pixel to the nearest pixel where `isSource`. */
const squaredDistances = (
  width: number,
  height: number,
  isSource: (index: number) => boolean,
): Float64Array => {
  const grid = new Float64Array(width * height)
  for (let i = 0; i < grid.length; i++) grid[i] = isSource(i) ? 0 : FAR
  const longest = Math.max(width, height)
  const f = new Float64Array(longest)
  const d = new Float64Array(longest)
  const v = new Int32Array(longest)
  const z = new Float64Array(longest + 1)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x] ?? FAR
    transformLine(f, height, d, v, z)
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y] ?? FAR
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x] ?? FAR
    transformLine(f, width, d, v, z)
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x] ?? FAR
  }
  return grid
}

/**
 * The signed distance, in pixels, from each pixel of `coverage` (0 to 255,
 * how much of each pixel the letters cover) to the letters' edge: positive
 * inside, negative outside.
 */
export const signedDistance = (
  coverage: ArrayLike<number>,
  width: number,
  height: number,
): Float32Array => {
  const inside = (i: number) => (coverage[i] ?? 0) >= 128
  const toInside = squaredDistances(width, height, inside)
  const toOutside = squaredDistances(width, height, i => !inside(i))
  const out = new Float32Array(width * height)
  for (let i = 0; i < out.length; i++) {
    const covered = (coverage[i] ?? 0) / 255
    if (covered > 0 && covered < 1) {
      // The edge crosses this pixel: as far in as it is covered.
      out[i] = covered - 0.5
    } else if (inside(i)) {
      out[i] = Math.sqrt(toOutside[i] ?? FAR) - 0.5
    } else {
      out[i] = 0.5 - Math.sqrt(toInside[i] ?? FAR)
    }
  }
  return out
}

/**
 * `field` (a signed distance in pixels, `width` × `height`) averaged down
 * `scale` times each way, as bytes: 128 on the edge, a step of 128 for
 * every `spread` pixels of the smaller picture. The smaller picture is
 * `ceil(width / scale)` × `ceil(height / scale)`.
 */
export const fieldBytes = (
  field: Float32Array,
  width: number,
  height: number,
  scale: number,
  spread: number,
): {
  readonly bytes: Uint8Array
  readonly width: number
  readonly height: number
} => {
  const small = {
    width: Math.ceil(width / scale),
    height: Math.ceil(height / scale),
  }
  const bytes = new Uint8Array(small.width * small.height)
  for (let y = 0; y < small.height; y++) {
    for (let x = 0; x < small.width; x++) {
      let sum = 0
      let n = 0
      for (let dy = 0; dy < scale; dy++) {
        const row = y * scale + dy
        if (row >= height) break
        for (let dx = 0; dx < scale; dx++) {
          const column = x * scale + dx
          if (column >= width) break
          sum += field[row * width + column] ?? 0
          n++
        }
      }
      const distance = n > 0 ? sum / n / scale : -spread
      const value = 128 + (distance / spread) * 128
      bytes[y * small.width + x] = Math.round(Math.min(255, Math.max(0, value)))
    }
  }
  return { bytes, ...small }
}
