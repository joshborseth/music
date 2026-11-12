import { MEL_BANDS, type Spectrogram } from './spectrogram.ts'

/*
 * Where the beats fall. The onset envelope (how much new sound starts in
 * each frame) gives the tempo through its autocorrelation, and then Ellis's
 * dynamic-programming tracker (the one in librosa's `beat_track`) picks the
 * beats that best line up with the onsets while keeping that tempo. Bars
 * are assumed to be four beats; the downbeat is the beat of the four whose
 * hits carry the most bass and the most chord changes.
 */

const MIN_BPM = 60
const MAX_BPM = 200
const PRIOR_BPM = 120
/** Width of the tempo prior, in octaves. */
const PRIOR_OCTAVES = 1
/** How strongly the tracker keeps to the tempo (librosa's default). */
const TIGHTNESS = 100
export const BEATS_PER_BAR = 4
/** A hit is loudest in the flux about one frame before its own frame. */
const ONSET_DELAY = 1

/**
 * The onset envelope from mel bands `[from, to)`: the rise in dB from the
 * previous frame, half-wave rectified and averaged over the bands. A hit
 * shows up while it is still in the early part of the window, so the
 * envelope is shifted `ONSET_DELAY` frames later to land on the hit itself
 * (measured on clicks: the peak then sits within a few ms of the click).
 */
export const onsetEnvelope = (
  spec: Spectrogram,
  from = 0,
  to = MEL_BANDS,
): Float32Array => {
  const delay = ONSET_DELAY
  const onset = new Float32Array(spec.frames)
  const count = to - from
  for (let t = 1; t < spec.frames; t++) {
    let sum = 0
    for (let band = from; band < to; band++) {
      const rise =
        (spec.melDb[t * MEL_BANDS + band] ?? 0) -
        (spec.melDb[(t - 1) * MEL_BANDS + band] ?? 0)
      if (rise > 0) sum += rise
    }
    const at = t + delay
    if (at < spec.frames) onset[at] = sum / count
  }
  return onset
}

export const mean = (values: ArrayLike<number>): number => {
  if (values.length === 0) return 0
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i] ?? 0
  return sum / values.length
}

export const standardDeviation = (values: ArrayLike<number>): number => {
  if (values.length < 2) return 0
  const average = mean(values)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    const d = (values[i] ?? 0) - average
    sum += d * d
  }
  return Math.sqrt(sum / (values.length - 1))
}

/** The envelope divided by its standard deviation. */
export const normalized = (values: Float32Array): Float32Array => {
  const scale = standardDeviation(values)
  return scale > 0 ? values.map(value => value / scale) : values.slice()
}

/**
 * The beat period in frames (fractional): the autocorrelation lag between
 * `MIN_BPM` and `MAX_BPM` that scores best once weighted by a log-normal
 * prior around `PRIOR_BPM`, refined between frames by a parabola through
 * the peak.
 */
export const estimatePeriod = (
  onset: Float32Array,
  frameRate: number,
): number => {
  const average = mean(onset)
  const centered = onset.map(value => value - average)
  const minLag = Math.max(1, Math.floor((60 * frameRate) / MAX_BPM))
  const maxLag = Math.ceil((60 * frameRate) / MIN_BPM)
  const fallback = (60 * frameRate) / PRIOR_BPM
  if (centered.length <= maxLag + 2) return fallback

  const correlation = new Float64Array(maxLag + 2)
  for (let lag = 0; lag < correlation.length; lag++) {
    let sum = 0
    for (let t = lag; t < centered.length; t++) {
      sum += (centered[t] ?? 0) * (centered[t - lag] ?? 0)
    }
    correlation[lag] = sum / (centered.length - lag)
  }
  const zero = correlation[0] ?? 0
  if (zero <= 0) return fallback
  const at = (lag: number) => (correlation[lag] ?? 0) / zero

  let bestLag = -1
  let bestScore = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    const value = at(lag)
    const isPeak = value >= at(lag - 1) && value >= at(lag + 1)
    if (!isPeak || value <= 0) continue
    const bpm = (60 * frameRate) / lag
    const octaves = Math.log2(bpm / PRIOR_BPM) / PRIOR_OCTAVES
    const score = value * Math.exp(-0.5 * octaves * octaves)
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  if (bestLag < 0) return fallback

  const before = at(bestLag - 1)
  const peak = at(bestLag)
  const after = at(bestLag + 1)
  const curve = before - 2 * peak + after
  const shift = curve < 0 ? (0.5 * (before - after)) / curve : 0
  return bestLag + Math.max(-0.5, Math.min(0.5, shift))
}

/**
 * Ellis's tracker: each frame's best score is its own onset strength plus
 * the best earlier beat's score, less a penalty for spacing that strays
 * from the period. Returns beat frames, with weak beats at either end (a
 * fade, a quiet intro) trimmed.
 */
export const trackBeats = (
  onset: Float32Array,
  period: number,
): ReadonlyArray<number> => {
  const frames = onset.length
  if (frames === 0 || period <= 0) return []
  const strength = normalized(onset)

  // A narrow Gaussian smooths each onset over a few frames.
  const reach = Math.max(1, Math.round(period))
  const kernel = Float64Array.from({ length: 2 * reach + 1 }, (_, i) => {
    const x = ((i - reach) * 32) / period
    return Math.exp(-0.5 * x * x)
  })
  const local = new Float64Array(frames)
  for (let t = 0; t < frames; t++) {
    let sum = 0
    for (let k = 0; k < kernel.length; k++) {
      const at = t + k - reach
      if (at >= 0 && at < frames) sum += (kernel[k] ?? 0) * (strength[at] ?? 0)
    }
    local[t] = sum
  }

  let localMax = 0
  local.forEach(value => {
    localMax = Math.max(localMax, value)
  })
  if (localMax <= 0) return []
  const threshold = 0.01 * localMax
  const nearest = Math.round(period / 2)
  const farthest = Math.round(2 * period)
  const logPeriod = Math.log(period)

  const score = new Float64Array(frames)
  const backlink = new Int32Array(frames).fill(-1)
  let hasStarted = false
  for (let i = 0; i < frames; i++) {
    let best = -Infinity
    let from = -1
    for (let loc = i - nearest; loc >= i - farthest && loc >= 0; loc--) {
      const gap = Math.log(i - loc) - logPeriod
      const candidate = (score[loc] ?? 0) - TIGHTNESS * gap * gap
      if (candidate > best) {
        best = candidate
        from = loc
      }
    }
    const own = local[i] ?? 0
    score[i] = from >= 0 ? own + best : own
    if (!hasStarted && own < threshold) {
      backlink[i] = -1
    } else {
      backlink[i] = from
      hasStarted = true
    }
  }

  // The last beat: the latest local peak of the score above half their median.
  const peaks: Array<number> = []
  for (let i = 0; i < frames; i++) {
    const value = score[i] ?? 0
    const isPeak =
      (i === 0 || value > (score[i - 1] ?? 0)) &&
      (i === frames - 1 || value >= (score[i + 1] ?? 0))
    if (isPeak) peaks.push(i)
  }
  if (peaks.length === 0) return []
  const peakScores = peaks.map(i => score[i] ?? 0).sort((a, b) => a - b)
  const median = peakScores[Math.floor(peakScores.length / 2)] ?? 0
  let last = -1
  for (const i of peaks) {
    if ((score[i] ?? 0) >= 0.5 * median) last = i
  }
  if (last < 0) return []

  const beats: Array<number> = []
  for (let at = last; at >= 0; at = backlink[at] ?? -1) beats.push(at)
  beats.reverse()
  return trimBeats(local, beats)
}

/** Drops beats at either end whose (smoothed) onset strength is under half the RMS. */
const trimBeats = (
  local: Float64Array,
  beats: ReadonlyArray<number>,
): ReadonlyArray<number> => {
  const hann = [0.25, 0.75, 1, 0.75, 0.25]
  const values = beats.map(beat => local[beat] ?? 0)
  const smooth = values.map((_, i) =>
    hann.reduce((sum, weight, k) => sum + weight * (values[i + k - 2] ?? 0), 0),
  )
  const threshold = 0.5 * Math.sqrt(mean(smooth.map(value => value * value)))
  const strong = smooth.flatMap((value, i) => (value > threshold ? [i] : []))
  const first = strong[0]
  const last = strong[strong.length - 1]
  return first === undefined || last === undefined
    ? []
    : beats.slice(first, last + 1)
}

/**
 * The time of the onset peak at or next to `frame`, in fractional frames: a
 * parabola through the highest of the three frames and its neighbors. A
 * frame lies 23 ms from the next, too coarse to put a beat on a hit.
 */
export const refinePeak = (envelope: Float32Array, frame: number): number => {
  let peak = frame
  for (const candidate of [frame - 1, frame + 1]) {
    if ((envelope[candidate] ?? -Infinity) > (envelope[peak] ?? -Infinity)) {
      peak = candidate
    }
  }
  const before = envelope[peak - 1] ?? 0
  const at = envelope[peak] ?? 0
  const after = envelope[peak + 1] ?? 0
  const curve = before - 2 * at + after
  if (at <= 0 || curve >= 0) return frame
  const shift = (0.5 * (before - after)) / curve
  return peak + Math.max(-0.5, Math.min(0.5, shift))
}

/**
 * Beats per minute from the tracked beats: the slope of a straight line
 * through them, which is finer than any one gap between frames. Falls back
 * to the estimated period when there are too few beats.
 */
export const tempoOf = (
  beatTimes: ReadonlyArray<number>,
  period: number,
  frameRate: number,
): number => {
  const estimate = (60 * frameRate) / period
  const n = beatTimes.length
  if (n < 8) return estimate
  const meanIndex = (n - 1) / 2
  const meanTime = mean(beatTimes)
  let covariance = 0
  let variance = 0
  beatTimes.forEach((time, i) => {
    covariance += (i - meanIndex) * (time - meanTime)
    variance += (i - meanIndex) * (i - meanIndex)
  })
  const slope = covariance / variance
  if (slope <= 0) return estimate
  const fitted = 60 / slope
  return Math.abs(fitted - estimate) / estimate < 0.05 ? fitted : estimate
}

const zScores = (values: ReadonlyArray<number>): ReadonlyArray<number> => {
  const average = mean(values)
  const deviation = standardDeviation(values)
  return values.map(value =>
    deviation > 0 ? (value - average) / deviation : 0,
  )
}

/** The mean chroma of frames `[from, to)`, scaled to unit length. */
export const chromaBetween = (
  spec: Spectrogram,
  from: number,
  to: number,
): Float64Array => {
  const out = new Float64Array(12)
  for (let t = Math.max(0, from); t < Math.min(spec.frames, to); t++) {
    for (let c = 0; c < 12; c++) {
      out[c] = (out[c] ?? 0) + (spec.chroma[t * 12 + c] ?? 0)
    }
  }
  const length = Math.hypot(...out)
  return length > 0 ? out.map(value => value / length) : out
}

const dot = (a: Float64Array, b: Float64Array): number => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0)
  return sum
}

/**
 * Which of the first four beats starts the first bar (0 to 3). Each beat is
 * scored by its bass hit and by how much the harmony changes across it (two
 * beats before against two after); the phase whose beats score highest wins.
 */
export const downbeatPhase = (
  spec: Spectrogram,
  beats: ReadonlyArray<number>,
  bassOnset: Float32Array,
): number => {
  if (beats.length < 2 * BEATS_PER_BAR) return 0
  const bass = beats.map(beat =>
    Math.max(
      bassOnset[beat - 1] ?? 0,
      bassOnset[beat] ?? 0,
      bassOnset[beat + 1] ?? 0,
    ),
  )
  const change = beats.map((beat, i) => {
    const before = chromaBetween(spec, beats[i - 2] ?? beat, beat)
    const after = chromaBetween(spec, beat, beats[i + 2] ?? spec.frames)
    return 1 - dot(before, after)
  })
  const bassZ = zScores(bass)
  const changeZ = zScores(change)
  const totals = new Float64Array(BEATS_PER_BAR)
  const counts = new Float64Array(BEATS_PER_BAR)
  beats.forEach((_, i) => {
    const phase = i % BEATS_PER_BAR
    totals[phase] = (totals[phase] ?? 0) + (bassZ[i] ?? 0) + (changeZ[i] ?? 0)
    counts[phase] = (counts[phase] ?? 0) + 1
  })
  let best = 0
  let bestScore = -Infinity
  for (let phase = 0; phase < BEATS_PER_BAR; phase++) {
    const score = (totals[phase] ?? 0) / Math.max(1, counts[phase] ?? 0)
    if (score > bestScore) {
      bestScore = score
      best = phase
    }
  }
  return best
}
