import { refinePeak } from './beats.ts'
import { MEL_BANDS, type Spectrogram, bandsBetween } from './spectrogram.ts'

/*
 * The drums, told apart from the rest of the music. Harmonic-percussive
 * separation (Fitzgerald's median filtering) splits each frame's mel power
 * into what holds steady over time (voices, chords, the bass line: a
 * median across a few tenths of a second) and what is broad across
 * frequency but short (hits: a median across neighboring bands); each
 * frame's power is shared out between the two by a soft mask. The hits'
 * part is then read in three places: the lowest bands for the kick, the
 * upper mids for the snare (and claps), the top for the hi-hat.
 */

/** Frames each side of the median over time (about 0.2 s). */
const HARMONIC_REACH = 8
/** Bands each side of the median over frequency. */
const PERCUSSIVE_REACH = 4

export interface Separated {
  /** `frames × MEL_BANDS` power, the two parts together. */
  readonly power: Float32Array
  /** `frames × MEL_BANDS` power that holds steady over time. */
  readonly harmonic: Float32Array
  /** `frames × MEL_BANDS` power of hits. */
  readonly percussive: Float32Array
}

/** The median of the first `count` values of `scratch`, reordering them. */
const medianOf = (scratch: Float64Array, count: number): number => {
  for (let i = 1; i < count; i++) {
    const value = scratch[i] ?? 0
    let j = i - 1
    while (j >= 0 && (scratch[j] ?? 0) > value) {
      scratch[j + 1] = scratch[j] ?? 0
      j--
    }
    scratch[j + 1] = value
  }
  return scratch[count >> 1] ?? 0
}

export const separate = (spec: Spectrogram): Separated => {
  const { frames } = spec
  const power = new Float32Array(frames * MEL_BANDS)
  for (let i = 0; i < power.length; i++) {
    power[i] = 10 ** ((spec.melDb[i] ?? 0) / 10)
  }
  const across = new Float32Array(frames * MEL_BANDS)
  const along = new Float32Array(frames * MEL_BANDS)
  const scratch = new Float64Array(
    2 * Math.max(HARMONIC_REACH, PERCUSSIVE_REACH) + 1,
  )
  for (let band = 0; band < MEL_BANDS; band++) {
    for (let t = 0; t < frames; t++) {
      let count = 0
      for (let k = t - HARMONIC_REACH; k <= t + HARMONIC_REACH; k++) {
        if (k >= 0 && k < frames)
          scratch[count++] = power[k * MEL_BANDS + band] ?? 0
      }
      along[t * MEL_BANDS + band] = medianOf(scratch, count)
    }
  }
  for (let t = 0; t < frames; t++) {
    for (let band = 0; band < MEL_BANDS; band++) {
      let count = 0
      for (let k = band - PERCUSSIVE_REACH; k <= band + PERCUSSIVE_REACH; k++) {
        if (k >= 0 && k < MEL_BANDS)
          scratch[count++] = power[t * MEL_BANDS + k] ?? 0
      }
      across[t * MEL_BANDS + band] = medianOf(scratch, count)
    }
  }
  const harmonic = new Float32Array(frames * MEL_BANDS)
  const percussive = new Float32Array(frames * MEL_BANDS)
  for (let i = 0; i < power.length; i++) {
    const h = (along[i] ?? 0) ** 2
    const p = (across[i] ?? 0) ** 2
    const share = h + p > 0 ? p / (h + p) : 0
    percussive[i] = (power[i] ?? 0) * share
    harmonic[i] = (power[i] ?? 0) * (1 - share)
  }
  return { power, harmonic, percussive }
}

/** Each frame's power in mel bands `[from, to)`, in dB. */
export const bandDb = (
  power: Float32Array,
  frames: number,
  from: number,
  to: number,
): Float32Array =>
  Float32Array.from({ length: frames }, (_, t) => {
    let sum = 0
    for (let band = from; band < to; band++)
      sum += power[t * MEL_BANDS + band] ?? 0
    return 10 * Math.log10(sum + 1e-10)
  })

/** The value under which `share` of `values` fall. */
export const quantile = (values: ArrayLike<number>, share: number): number => {
  if (values.length === 0) return 0
  const sorted = Float64Array.from(values).sort()
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0
  )
}

export interface DrumKind {
  readonly lowHz: number
  readonly highHz: number
  /** Hits at least this far apart, in seconds. */
  readonly gap: number
  /** How far (dB) a hit must rise above the frame before. */
  readonly minRise: number
}

export const KICK: DrumKind = { lowHz: 30, highHz: 120, gap: 0.11, minRise: 4 }
/** Every hit above the kick: snares, claps, hi-hats, toms, stabs. */
export const HIGHS: DrumKind = {
  lowHz: 500,
  highHz: 11000,
  gap: 0.06,
  minRise: 3,
}
/** Toms and the snare's body, for counting fills. */
export const MIDS: DrumKind = {
  lowHz: 150,
  highHz: 1500,
  gap: 0.06,
  minRise: 4,
}

/** Where a snare's body, a clap's crack, and a hi-hat sit. */
const BODY_HZ = [150, 400] as const
const CRACK_HZ = [500, 1500] as const
const SIZZLE_HZ = [6000, 11000] as const

/** A hit: its frame (fractional) and strength, 0 to 1 within its kind. */
export interface Hit {
  readonly frame: number
  readonly strength: number
}

/** The window, each side, a hit must stand out from. */
const CONTEXT_SECONDS = 1
const DEVIATIONS = 1.5
/** A hit this far under its kind's loudest is too faint to count. */
const FAINT_DB = 24
/** A hit is loudest in the flux about one frame before its own frame. */
const ONSET_DELAY = 1

/** The rise in dB of the hits' level in `[lowHz, highHz)`, each frame. */
const riseIn = (
  spec: Spectrogram,
  percussive: Float32Array,
  lowHz: number,
  highHz: number,
): { readonly rise: Float32Array; readonly level: Float32Array } => {
  const { from, to } = bandsBetween(spec, lowHz, highHz)
  const level = bandDb(percussive, spec.frames, from, to)
  const rise = new Float32Array(spec.frames)
  for (let t = 1; t + ONSET_DELAY < spec.frames; t++) {
    rise[t + ONSET_DELAY] = Math.max(0, (level[t] ?? 0) - (level[t - 1] ?? 0))
  }
  return { rise, level }
}

/**
 * The hits in one stretch of the percussive part: peaks of the rise in its
 * bands' level that stand out from the second around them, loud enough
 * within the song, at least the kind's gap apart.
 */
export const drumHits = (
  spec: Spectrogram,
  percussive: Float32Array,
  kind: DrumKind,
): ReadonlyArray<Hit> => {
  const { frames, frameRate } = spec
  const { rise, level } = riseIn(spec, percussive, kind.lowHz, kind.highHz)
  const loud = quantile(level, 0.98)
  const sums = new Float64Array(frames + 1)
  const squares = new Float64Array(frames + 1)
  rise.forEach((value, t) => {
    sums[t + 1] = (sums[t] ?? 0) + value
    squares[t + 1] = (squares[t] ?? 0) + value * value
  })
  const reach = Math.round(CONTEXT_SECONDS * frameRate)
  const gap = Math.max(1, Math.round(kind.gap * frameRate))
  const candidates: Array<{ frame: number; value: number }> = []
  for (let t = 2; t < frames - 2; t++) {
    const value = rise[t] ?? 0
    if (value < kind.minRise) continue
    const heard = Math.max(level[t] ?? -Infinity, level[t - 1] ?? -Infinity)
    if (heard < loud - FAINT_DB) continue
    let isPeak = true
    for (let k = -2; k <= 2 && isPeak; k++) {
      if (k !== 0 && (rise[t + k] ?? 0) > value) isPeak = false
    }
    if (!isPeak) continue
    const start = Math.max(0, t - reach)
    const end = Math.min(frames, t + reach + 1)
    const n = end - start
    const average = ((sums[end] ?? 0) - (sums[start] ?? 0)) / n
    const variance =
      ((squares[end] ?? 0) - (squares[start] ?? 0)) / n - average * average
    if (value > average + DEVIATIONS * Math.sqrt(Math.max(0, variance))) {
      candidates.push({ frame: t, value })
    }
  }
  const strongest = quantile(
    candidates.map(candidate => candidate.value),
    0.9,
  )
  // Strongest first, each clearing the gap around those already taken.
  const taken = new Uint8Array(frames)
  const chosen: Array<Hit> = []
  for (const { frame, value } of [...candidates].sort(
    (a, b) => b.value - a.value,
  )) {
    let isClear = true
    for (
      let k = Math.max(0, frame - gap + 1);
      k < Math.min(frames, frame + gap) && isClear;
      k++
    ) {
      if (taken[k] === 1) isClear = false
    }
    if (!isClear) continue
    taken[frame] = 1
    chosen.push({
      frame: refinePeak(rise, frame),
      strength: Math.min(1, value / Math.max(strongest, 1e-6)),
    })
  }
  return chosen.sort((a, b) => a.frame - b.frame)
}

/**
 * The hits above the kick, told apart by where they rise. A snare or a
 * clap lifts the low mids (its body, or a clap's crack) with its rattle; a
 * hi-hat lifts mostly the top. Mixes differ too much for one dB threshold
 * to tell them apart, so each song's hits are ranked by how much more they
 * lift the low mids than the top, and the lowest-reaching share of them
 * are snares, if they lift the low mids nearly as much as the top. Snares are kept at least
 * `SNARE_GAP` apart, the stronger first.
 */
export const snaresAndHats = (
  spec: Spectrogram,
  percussive: Float32Array,
): {
  readonly snares: ReadonlyArray<Hit>
  readonly hats: ReadonlyArray<Hit>
} => {
  const body = riseIn(spec, percussive, ...BODY_HZ).rise
  const crack = riseIn(spec, percussive, ...CRACK_HZ).rise
  const sizzle = riseIn(spec, percussive, ...SIZZLE_HZ).rise
  const near = (rise: Float32Array, frame: number) => {
    const at = Math.round(frame)
    return Math.max(rise[at - 1] ?? 0, rise[at] ?? 0, rise[at + 1] ?? 0)
  }
  const hits = drumHits(spec, percussive, HIGHS)
  const low = hits.map(hit =>
    Math.max(near(body, hit.frame), near(crack, hit.frame)),
  )
  const reach = hits.map((hit, i) => (low[i] ?? 0) - near(sizzle, hit.frame))
  const line = quantile(reach, 1 - SNARE_SHARE)
  const snares: Array<Hit> = []
  const hats: Array<Hit> = []
  const snareGap = SNARE_GAP * spec.frameRate
  hits.forEach((hit, i) => {
    const isSnare =
      (reach[i] ?? 0) >= Math.max(line, -SNARE_REACH_DB) &&
      (low[i] ?? 0) >= 3 &&
      hit.strength >= 0.3
    const last = snares[snares.length - 1]
    if (isSnare && (last === undefined || hit.frame - last.frame >= snareGap)) {
      snares.push(hit)
    } else if (isSnare && last !== undefined && hit.strength > last.strength) {
      snares[snares.length - 1] = hit
    } else if (near(sizzle, hit.frame) >= 2) {
      hats.push(hit)
    }
  })
  return { snares, hats }
}

/** The share of the hits above the kick that reach lowest, at most, that are snares. */
const SNARE_SHARE = 0.4
const SNARE_GAP = 0.11
/** A snare lifts the low mids at most this much (dB) less than the top. */
const SNARE_REACH_DB = 6
