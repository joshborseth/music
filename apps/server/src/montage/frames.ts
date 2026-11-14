/*
 * Choosing a music video's key frames. ffmpeg hands over the video at two
 * frames a second, each `CELL_WIDTH` × `CELL_HEIGHT` RGB; `FrameSifter`
 * splits the stream into shots where the picture changes at once (a cut),
 * keeps the sharpest frame of each (a long shot gives one every few
 * seconds, if the camera moved), and drops what would look like nothing on
 * the TV: near black, near white, and flat cards of text. `selectFrames`
 * then drops shots that look alike (a set the video keeps coming back to)
 * and picks the most varied `MAX_FRAMES` of the rest, in the video's order.
 * A video with only a handful of different pictures is a still picture
 * ("visualizer", "official audio") and is not used.
 */

/** A video frame's size in the atlas. */
export const CELL_WIDTH = 320
export const CELL_HEIGHT = 180
export const FRAME_BYTES = CELL_WIDTH * CELL_HEIGHT * 3
/** Frames a second ffmpeg samples. */
export const FRAMES_PER_SECOND = 2
/** The most frames a montage holds: an 8 × 6 atlas. */
export const MAX_FRAMES = 48
/** Fewer different pictures than this is a still picture, not a video. */
export const MIN_DISTINCT = 8

/** The coarse picture shots are compared by: 16 × 9 cells, RGB. */
const SIGNATURE_COLUMNS = 16
const SIGNATURE_ROWS = 9
/** How far apart two frames' signatures are, on average, at a cut. */
const CUT = 0.1
/** Two shots closer than this look alike: only the better one is kept. */
const ALIKE = 0.055
/** A shot longer than this gives another frame, if the camera moved. */
const LONG_SHOT_SECONDS = 5
const MOVED = 0.05
/** Light below or above which a frame is near black or near white. */
const DARKEST = 0.07
const BRIGHTEST = 0.9
/** A frame this flat (its share of pixels near its usual light) is a card. */
const FLATTEST = 0.9
/** Pixels this close to the frame's usual light count as flat. */
const FLAT_RANGE = 0.08
/** The most candidates held at once, each a whole frame. */
const MAX_CANDIDATES = 320

export type Rgb = readonly [number, number, number]

/** What a frame looks like, worked out from its pixels. */
export interface FrameStats {
  /** Its average color, 0 to 1 each. */
  readonly color: Rgb
  /** Its average light, 0 to 1. */
  readonly brightness: number
  /** Detail and contrast, 0 (flat) to about 1 (a crowd, foliage). */
  readonly busyness: number
  /** Its share of pixels near its usual light, 0 to 1. */
  readonly flatness: number
  readonly signature: Float32Array
}

/** A frame kept as a candidate, with its pixels. */
export interface Candidate {
  readonly seconds: number
  readonly stats: FrameStats
  readonly pixels: Uint8Array
}

const luma = (r: number, g: number, b: number): number =>
  (0.299 * r + 0.587 * g + 0.114 * b) / 255

/** The stats of a `width` × `height` RGB frame. */
export const frameStats = (
  pixels: Uint8Array,
  width: number = CELL_WIDTH,
  height: number = CELL_HEIGHT,
): FrameStats => {
  const signature = new Float32Array(SIGNATURE_COLUMNS * SIGNATURE_ROWS * 3)
  const counts = new Float32Array(SIGNATURE_COLUMNS * SIGNATURE_ROWS)
  const histogram = new Uint32Array(64)
  let red = 0
  let green = 0
  let blue = 0
  let light = 0
  let lightSquared = 0
  let gradient = 0
  let samples = 0
  let gradients = 0
  // Every other pixel each way: plenty for averages, a quarter of the work.
  for (let y = 0; y < height; y += 2) {
    const cellY = Math.min(
      SIGNATURE_ROWS - 1,
      Math.floor((y * SIGNATURE_ROWS) / height),
    )
    for (let x = 0; x < width; x += 2) {
      const at = (y * width + x) * 3
      const r = pixels[at] ?? 0
      const g = pixels[at + 1] ?? 0
      const b = pixels[at + 2] ?? 0
      const l = luma(r, g, b)
      red += r
      green += g
      blue += b
      light += l
      lightSquared += l * l
      samples++
      const bucket = Math.min(63, Math.floor(l * 64))
      histogram[bucket] = (histogram[bucket] ?? 0) + 1
      const cell =
        cellY * SIGNATURE_COLUMNS +
        Math.min(
          SIGNATURE_COLUMNS - 1,
          Math.floor((x * SIGNATURE_COLUMNS) / width),
        )
      signature[cell * 3] = (signature[cell * 3] ?? 0) + r / 255
      signature[cell * 3 + 1] = (signature[cell * 3 + 1] ?? 0) + g / 255
      signature[cell * 3 + 2] = (signature[cell * 3 + 2] ?? 0) + b / 255
      counts[cell] = (counts[cell] ?? 0) + 1
      if (x + 2 < width && y + 2 < height) {
        const right = (y * width + x + 2) * 3
        const below = ((y + 2) * width + x) * 3
        gradient +=
          Math.abs(
            l -
              luma(
                pixels[right] ?? 0,
                pixels[right + 1] ?? 0,
                pixels[right + 2] ?? 0,
              ),
          ) +
          Math.abs(
            l -
              luma(
                pixels[below] ?? 0,
                pixels[below + 1] ?? 0,
                pixels[below + 2] ?? 0,
              ),
          )
        gradients++
      }
    }
  }
  for (let cell = 0; cell < counts.length; cell++) {
    const count = Math.max(1, counts[cell] ?? 1)
    for (let channel = 0; channel < 3; channel++) {
      signature[cell * 3 + channel] =
        (signature[cell * 3 + channel] ?? 0) / count
    }
  }
  const total = Math.max(1, samples)
  const brightness = light / total
  const spread = Math.sqrt(
    Math.max(0, lightSquared / total - brightness * brightness),
  )
  // The usual light: the histogram's fullest bucket, and its share within
  // `FLAT_RANGE` either side.
  let fullest = 0
  histogram.forEach((count, bucket) => {
    if (count > (histogram[fullest] ?? 0)) fullest = bucket
  })
  const reach = Math.round(FLAT_RANGE * 64)
  let flat = 0
  for (
    let bucket = Math.max(0, fullest - reach);
    bucket <= Math.min(63, fullest + reach);
    bucket++
  ) {
    flat += histogram[bucket] ?? 0
  }
  const edges = gradient / Math.max(1, gradients)
  return {
    color: [red / total / 255, green / total / 255, blue / total / 255],
    brightness,
    // Soft, so the busiest frames still rank among themselves.
    busyness: 1 - Math.exp(-(0.65 * (edges / 0.09) + 0.35 * (spread / 0.28))),
    flatness: flat / total,
    signature,
  }
}

/** How different two frames look, 0 (the same) to 1. */
export const distance = (a: Float32Array, b: Float32Array): number => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0))
  return sum / Math.max(1, a.length)
}

/** Why a frame would look like nothing on the TV, or none. */
export const unusable = (stats: FrameStats): string | undefined => {
  if (stats.brightness < DARKEST) return 'black'
  if (stats.brightness > BRIGHTEST) return 'white'
  if (stats.flatness > FLATTEST) return 'flat'
  return undefined
}

/** How good a frame of a shot is to keep: sharp, and not near black. */
const quality = (stats: FrameStats): number =>
  stats.busyness + 0.5 * Math.min(1, stats.brightness / 0.3)

/**
 * Splits a stream of frames into shots and keeps the best frame of each.
 * `push` each frame in order (the pixels are copied only when kept);
 * `candidates` are the frames kept, in order.
 */
export class FrameSifter {
  readonly candidates: Array<Candidate> = []
  /** Different pictures seen, usable or not: how much the video moves. */
  shots = 0
  private last: Float32Array | undefined
  private shotStart: { seconds: number; signature: Float32Array } | undefined
  private best: Candidate | undefined
  private bestQuality = -1
  private framesInShot = 0

  push(pixels: Uint8Array, seconds: number): void {
    const stats = frameStats(pixels)
    const isCut =
      this.last === undefined || distance(stats.signature, this.last) > CUT
    const isLong =
      this.shotStart !== undefined &&
      seconds - this.shotStart.seconds >= LONG_SHOT_SECONDS &&
      distance(stats.signature, this.shotStart.signature) > MOVED
    if (isCut || isLong) {
      this.endShot()
      this.shots++
      this.shotStart = { seconds, signature: stats.signature }
      this.framesInShot = 0
    }
    this.last = stats.signature
    this.framesInShot++
    if (unusable(stats) !== undefined) return
    // The first frame after a cut is often mid-transition: any later one wins.
    const score = quality(stats) + (this.framesInShot > 1 ? 1 : 0)
    if (score > this.bestQuality) {
      this.best = { seconds, stats, pixels: pixels.slice() }
      this.bestQuality = score
    }
  }

  /** The last shot is over: keep its frame. */
  finish(): ReadonlyArray<Candidate> {
    this.endShot()
    return this.candidates
  }

  private endShot(): void {
    if (this.best !== undefined) {
      this.candidates.push(this.best)
      if (this.candidates.length > MAX_CANDIDATES) this.dropMostAlike()
    }
    this.best = undefined
    this.bestQuality = -1
  }

  /** Too many held: drop the one most like the one before it. */
  private dropMostAlike(): void {
    let most = 1
    let closest = Number.POSITIVE_INFINITY
    this.candidates.forEach((candidate, index) => {
      const before = this.candidates[index - 1]
      if (before === undefined) return
      const apart = distance(candidate.stats.signature, before.stats.signature)
      if (apart < closest) {
        closest = apart
        most = index
      }
    })
    this.candidates.splice(most, 1)
  }
}

/** The frames chosen, and whether the video is only a still picture. */
export interface Selection<A> {
  readonly frames: ReadonlyArray<A>
  /** Different pictures it had, after dropping those alike. */
  readonly distinct: number
  readonly isStatic: boolean
}

/**
 * The most varied `limit` of `candidates`, in their order: those alike
 * dropped (the better kept), then, while there are too many, the one that
 * looks most unlike those chosen added each time, starting from the best.
 * Time counts a little, so the picks cover the whole video.
 */
export const selectFrames = <
  A extends { readonly seconds: number; readonly stats: FrameStats },
>(
  candidates: ReadonlyArray<A>,
  limit: number = MAX_FRAMES,
  minDistinct: number = MIN_DISTINCT,
): Selection<A> => {
  const usable = candidates.filter(
    candidate => unusable(candidate.stats) === undefined,
  )
  const byQuality = [...usable].sort(
    (a, b) => quality(b.stats) - quality(a.stats),
  )
  const distinct: Array<A> = []
  for (const candidate of byQuality) {
    if (
      distinct.every(
        kept =>
          distance(kept.stats.signature, candidate.stats.signature) > ALIKE,
      )
    ) {
      distinct.push(candidate)
    }
  }
  const span =
    Math.max(1, ...usable.map(candidate => candidate.seconds)) -
    Math.min(0, ...usable.map(candidate => candidate.seconds))
  const first = distinct[0]
  const chosen: Array<A> = first === undefined ? [] : [first]
  const nearest = distinct.map(candidate =>
    first === undefined ? 0 : gap(candidate, first, span),
  )
  while (chosen.length < Math.min(limit, distinct.length)) {
    let farthest = -1
    nearest.forEach((value, index) => {
      if (value > 0 && (farthest < 0 || value > (nearest[farthest] ?? 0)))
        farthest = index
    })
    const pick = distinct[farthest]
    if (pick === undefined) break
    chosen.push(pick)
    distinct.forEach((candidate, index) => {
      nearest[index] = Math.min(nearest[index] ?? 0, gap(candidate, pick, span))
    })
  }
  return {
    frames: chosen.sort((a, b) => a.seconds - b.seconds),
    distinct: distinct.length,
    isStatic: distinct.length < minDistinct,
  }
}

const gap = (
  a: { readonly seconds: number; readonly stats: FrameStats },
  b: { readonly seconds: number; readonly stats: FrameStats },
  span: number,
): number =>
  a === b
    ? 0
    : distance(a.stats.signature, b.stats.signature) +
      (0.08 * Math.abs(a.seconds - b.seconds)) / span
