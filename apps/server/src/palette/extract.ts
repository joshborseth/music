import type { NowPlaying } from '@music/shared'

/*
 * Finds the colors that define a piece of album art, for lights and tints.
 *
 * The pixels are clustered with k-means in OKLab, where distance follows how
 * different two colors look. Clusters that look alike are merged, and grey,
 * near-black, and specks are dropped, because a bulb cannot show them and a
 * tint made from them looks muddy. What is left is ranked by how much of the
 * cover a color fills and how colorful it is, so a cover that is mostly deep
 * blue with a small yellow title leads with the blue.
 */

const CLUSTERS = 8
const ITERATIONS = 12
/** Clusters closer than this in OKLab read as one color. */
const MERGE_DISTANCE = 0.08
/** Below this OKLCh chroma a color reads as grey. */
const MIN_CHROMA = 0.045
/** Below this OKLab lightness the hue is mostly noise. */
const MIN_LIGHTNESS = 0.22
/** A color must fill at least this share of the cover. */
const MIN_SHARE = 0.02
const MAX_SWATCHES = 4

interface Lab {
  readonly l: number
  readonly a: number
  readonly b: number
}

const toLinear = (channel: number): number => {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

const toGamma = (value: number): number => {
  const clamped = Math.min(1, Math.max(0, value))
  const encoded =
    clamped <= 0.0031308
      ? clamped * 12.92
      : 1.055 * clamped ** (1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

/** sRGB (0-255) to OKLab, from Björn Ottosson's reference implementation. */
export const rgbToOklab = (red: number, green: number, blue: number): Lab => {
  const r = toLinear(red)
  const g = toLinear(green)
  const b = toLinear(blue)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

export const oklabToRgb = ({
  l,
  a,
  b,
}: Lab): readonly [number, number, number] => {
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    toGamma(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp),
    toGamma(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp),
    toGamma(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp),
  ]
}

const distanceSquared = (x: Lab, y: Lab): number =>
  (x.l - y.l) ** 2 + (x.a - y.a) ** 2 + (x.b - y.b) ** 2

const chroma = ({ a, b }: Lab): number => Math.hypot(a, b)

const hex = ([red, green, blue]: readonly [number, number, number]): string =>
  `#${[red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('')}`

interface Cluster {
  readonly center: Lab
  readonly count: number
}

/**
 * Deterministic seeding: start from the pixel nearest the average color,
 * then repeatedly take the pixel farthest from every seed so far.
 */
const seed = (pixels: ReadonlyArray<Lab>, count: number): Array<Lab> => {
  let sum = { l: 0, a: 0, b: 0 }
  for (const pixel of pixels) {
    sum = { l: sum.l + pixel.l, a: sum.a + pixel.a, b: sum.b + pixel.b }
  }
  const mean = {
    l: sum.l / pixels.length,
    a: sum.a / pixels.length,
    b: sum.b / pixels.length,
  }
  const nearest = new Float64Array(pixels.length).fill(Infinity)
  let next = pixels.reduce(
    (best, pixel) =>
      distanceSquared(pixel, mean) < distanceSquared(best, mean) ? pixel : best,
    pixels[0] ?? mean,
  )
  const seeds: Array<Lab> = []
  while (seeds.length < count) {
    const current = next
    seeds.push(current)
    let farthest = 0
    pixels.forEach((pixel, index) => {
      const distance = Math.min(
        nearest[index] ?? Infinity,
        distanceSquared(pixel, current),
      )
      nearest[index] = distance
      if (distance > farthest) {
        farthest = distance
        next = pixel
      }
    })
    if (farthest === 0) break
  }
  return seeds
}

const kMeans = (pixels: ReadonlyArray<Lab>): Array<Cluster> => {
  let centers = seed(pixels, CLUSTERS)
  let counts: Array<number> = []
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const sums = centers.map(() => ({ l: 0, a: 0, b: 0 }))
    counts = centers.map(() => 0)
    for (const pixel of pixels) {
      let bestIndex = 0
      let bestDistance = Infinity
      centers.forEach((center, index) => {
        const distance = distanceSquared(pixel, center)
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = index
        }
      })
      const sum = sums[bestIndex]
      if (sum !== undefined) {
        sum.l += pixel.l
        sum.a += pixel.a
        sum.b += pixel.b
        counts[bestIndex] = (counts[bestIndex] ?? 0) + 1
      }
    }
    centers = centers.map((center, index) => {
      const count = counts[index] ?? 0
      const sum = sums[index]
      return count === 0 || sum === undefined
        ? center
        : { l: sum.l / count, a: sum.a / count, b: sum.b / count }
    })
  }
  return centers
    .map((center, index) => ({ center, count: counts[index] ?? 0 }))
    .filter(({ count }) => count > 0)
}

/** Folds each cluster into a larger one that looks the same. */
const mergeAlike = (clusters: ReadonlyArray<Cluster>): Array<Cluster> => {
  const merged: Array<Cluster> = []
  const bySize = [...clusters].sort((x, y) => y.count - x.count)
  for (const cluster of bySize) {
    const index = merged.findIndex(
      other =>
        distanceSquared(other.center, cluster.center) < MERGE_DISTANCE ** 2,
    )
    const other = merged[index]
    if (other === undefined) {
      merged.push(cluster)
      continue
    }
    const count = other.count + cluster.count
    const weigh = (pick: (lab: Lab) => number) =>
      (pick(other.center) * other.count +
        pick(cluster.center) * cluster.count) /
      count
    merged[index] = {
      center: {
        l: weigh(({ l }) => l),
        a: weigh(({ a }) => a),
        b: weigh(({ b }) => b),
      },
      count,
    }
  }
  return merged
}

/**
 * The cover's colors, best first: at most four, each colorful enough for a
 * bulb to show. Empty for a cover that is black, white, or grey.
 *
 * `rgb` holds packed 8-bit RGB pixels, three bytes each.
 */
export const paletteFromPixels = (
  rgb: Uint8Array,
): ReadonlyArray<NowPlaying.Swatch> => {
  const pixels: Array<Lab> = []
  for (let offset = 0; offset + 2 < rgb.length; offset += 3) {
    pixels.push(
      rgbToOklab(rgb[offset] ?? 0, rgb[offset + 1] ?? 0, rgb[offset + 2] ?? 0),
    )
  }
  if (pixels.length === 0) return []
  return mergeAlike(kMeans(pixels))
    .map(({ center, count }) => ({
      center,
      share: count / pixels.length,
      chroma: chroma(center),
    }))
    .filter(
      ({ center, share, chroma }) =>
        share >= MIN_SHARE && chroma >= MIN_CHROMA && center.l >= MIN_LIGHTNESS,
    )
    .sort(
      (x, y) => Math.sqrt(y.share) * y.chroma - Math.sqrt(x.share) * x.chroma,
    )
    .slice(0, MAX_SWATCHES)
    .map(({ center, share }) => ({
      hex: hex(oklabToRgb(center)),
      share: Math.round(share * 1000) / 1000,
    }))
}
