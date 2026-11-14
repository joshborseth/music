import type { Tv } from '@music/shared'

import { makeRealFft } from './fft.ts'

/*
 * The song's harmony and its tune, from a finer look at the spectrum than
 * the rest of the analysis takes (a 4096-sample window, 5 Hz a bin), with
 * each frame whitened so peaks stand out whatever the mix's tilt.
 *
 * - The lead: for each candidate pitch, the sum of the whitened spectrum at
 *   its first six harmonics, each a little weaker (harmonic summation, as in
 *   Klapuri's and Salamon's melody extraction). The best pitch is the tune
 *   this frame, and how far it stands above the rest is how clearly a lead
 *   (a voice, a solo) carries one.
 * - Chroma for the chords (80 Hz to 2.5 kHz) and for the bass (40 to 250 Hz):
 *   each peak's energy given to its nearest pitch class, less the further
 *   it lies from it.
 * - Chords, beat by beat: the major or minor triad (or none) that fits each
 *   beat's chroma and bass best, held unless the next fits clearly better
 *   (a Viterbi path with a cost to change).
 * - Keys: Krumhansl and Kessler's key profiles against each section's
 *   chroma; a section moves to a new key only when it clearly fits it
 *   better than the song's own, for a while.
 */

const WINDOW = 4096
export const PITCH_HOP = 1024
const LEAD_MIN_MIDI = 45
const LEAD_MAX_MIDI = 84
/** Candidates a semitone apart are split in this many steps. */
const LEAD_STEPS = 2
const HARMONICS = 6
const HARMONIC_DECAY = 0.84
/** The whitening's reach, each side, in bins (about a third of an octave at 300 Hz). */
const WHITEN_REACH = 12
const CHORD_HZ = [80, 2500] as const
const BASS_HZ = [40, 250] as const

export interface Tune {
  readonly frameRate: number
  readonly frames: number
  /** The lead's pitch each frame, in MIDI notes; NaN where none stands out. */
  readonly melody: Float32Array
  /** How clearly a lead stands out, 0 to 1. */
  readonly lead: Float32Array
  /** `frames × 12` chroma for chords, and for the bass. */
  readonly chroma: Float32Array
  readonly bass: Float32Array
}

const midiHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12)

export const listenForTune = (
  samples: Float32Array,
  sampleRate: number,
): Tune => {
  const fft = makeRealFft(WINDOW)
  const bins = WINDOW / 2 + 1
  const binHz = sampleRate / WINDOW
  const frames = Math.floor(samples.length / PITCH_HOP) + 1
  const window = Float64Array.from(
    { length: WINDOW },
    (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / WINDOW),
  )
  const frame = new Float64Array(WINDOW)
  const spectrum = new Float64Array(bins)
  const magnitude = new Float64Array(bins)
  const running = new Float64Array(bins + 1)
  const white = new Float64Array(bins)

  const candidates = (LEAD_MAX_MIDI - LEAD_MIN_MIDI) * LEAD_STEPS + 1
  const harmonicBins = Float64Array.from(
    { length: candidates * HARMONICS },
    (_, i) => {
      const midi = LEAD_MIN_MIDI + Math.floor(i / HARMONICS) / LEAD_STEPS
      return (midiHz(midi) * ((i % HARMONICS) + 1)) / binHz
    },
  )
  const salience = new Float64Array(candidates)

  // Each bin's pitch class and how near its center it lies (1 at the center).
  const classOf = new Int8Array(bins).fill(-1)
  const nearness = new Float64Array(bins)
  for (let bin = 1; bin < bins; bin++) {
    const midi = 69 + 12 * Math.log2((bin * binHz) / 440)
    const nearest = Math.round(midi)
    classOf[bin] = ((nearest % 12) + 12) % 12
    nearness[bin] = Math.cos(Math.PI * Math.min(0.5, Math.abs(midi - nearest)))
  }
  const binRange = ([low, high]: readonly [number, number]) =>
    [
      Math.max(1, Math.ceil(low / binHz)),
      Math.min(bins - 1, Math.floor(high / binHz)),
    ] as const
  const [chordFrom, chordTo] = binRange(CHORD_HZ)
  const [bassFrom, bassTo] = binRange(BASS_HZ)

  const melody = new Float32Array(frames).fill(Number.NaN)
  const rawLead = new Float32Array(frames)
  const loudness = new Float32Array(frames)
  const chroma = new Float32Array(frames * 12)
  const bass = new Float32Array(frames * 12)

  for (let t = 0; t < frames; t++) {
    const start = t * PITCH_HOP - WINDOW / 2
    for (let n = 0; n < WINDOW; n++) {
      const i = start + n
      frame[n] =
        i >= 0 && i < samples.length ? (samples[i] ?? 0) * (window[n] ?? 0) : 0
    }
    fft.powerSpectrum(frame, spectrum)
    let total = 0
    for (let bin = 0; bin < bins; bin++) {
      const value = Math.sqrt(spectrum[bin] ?? 0)
      magnitude[bin] = value
      running[bin + 1] = (running[bin] ?? 0) + value
      total += spectrum[bin] ?? 0
    }
    loudness[t] = 10 * Math.log10(total + 1e-12)
    for (let bin = 0; bin < bins; bin++) {
      const from = Math.max(0, bin - WHITEN_REACH)
      const to = Math.min(bins, bin + WHITEN_REACH + 1)
      const local = ((running[to] ?? 0) - (running[from] ?? 0)) / (to - from)
      white[bin] = Math.max(0, (magnitude[bin] ?? 0) - local)
    }

    let best = 0
    let bestAt = -1
    let sum = 0
    for (let c = 0; c < candidates; c++) {
      let value = 0
      let weight = 1
      for (let h = 0; h < HARMONICS; h++) {
        const at = harmonicBins[c * HARMONICS + h] ?? 0
        const near = Math.round(at)
        if (near + 1 >= bins) break
        value +=
          weight *
          Math.max(white[near - 1] ?? 0, white[near] ?? 0, white[near + 1] ?? 0)
        weight *= HARMONIC_DECAY
      }
      salience[c] = value
      sum += value
      if (value > best) {
        best = value
        bestAt = c
      }
    }
    if (bestAt >= 0 && sum > 0) {
      const before = salience[bestAt - 1] ?? 0
      const after = salience[bestAt + 1] ?? 0
      const curve = before - 2 * best + after
      const shift =
        curve < 0
          ? Math.max(-0.5, Math.min(0.5, (0.5 * (before - after)) / curve))
          : 0
      melody[t] = LEAD_MIN_MIDI + (bestAt + shift) / LEAD_STEPS
      rawLead[t] = best / (sum / candidates)
    }

    for (let bin = chordFrom; bin <= chordTo; bin++) {
      const pitchClass = classOf[bin] ?? -1
      if (pitchClass >= 0) {
        chroma[t * 12 + pitchClass] =
          (chroma[t * 12 + pitchClass] ?? 0) +
          (white[bin] ?? 0) * (nearness[bin] ?? 0)
      }
    }
    for (let bin = bassFrom; bin <= bassTo; bin++) {
      const pitchClass = classOf[bin] ?? -1
      if (pitchClass >= 0) {
        bass[t * 12 + pitchClass] =
          (bass[t * 12 + pitchClass] ?? 0) +
          (white[bin] ?? 0) * (nearness[bin] ?? 0)
      }
    }
  }

  // A lead stands out when its pitch sums several times the average
  // candidate's, in a frame loud enough to hear. Quiet frames carry none.
  let loudest = -Infinity
  loudness.forEach(value => {
    loudest = Math.max(loudest, value)
  })
  const lead = Float32Array.from(rawLead, (value, t) => {
    const audible = (loudness[t] ?? -Infinity) > loudest - 35
    return audible ? Math.min(1, Math.max(0, (value - 2.2) / 3)) : 0
  })
  // Steady the tune: a frame's pitch is the median of the five around it,
  // and it counts only where the lead holds for a moment.
  const steady = new Float32Array(frames).fill(Number.NaN)
  const near: Array<number> = []
  for (let t = 0; t < frames; t++) {
    near.length = 0
    for (let k = t - 2; k <= t + 2; k++) {
      const value = melody[k]
      if (
        value !== undefined &&
        Number.isFinite(value) &&
        (lead[k] ?? 0) > 0.15
      )
        near.push(value)
    }
    if (near.length >= 3 && (lead[t] ?? 0) > 0.15) {
      near.sort((a, b) => a - b)
      steady[t] = near[near.length >> 1] ?? Number.NaN
    }
  }
  return {
    frameRate: sampleRate / PITCH_HOP,
    frames,
    melody: steady,
    lead,
    chroma,
    bass,
  }
}

// CHORDS

/** A chord for each beat; `null` root for none. */
interface BeatChord {
  readonly root: number | null
  readonly minor: boolean
}

const NO_CHORD_SCORE = 0.62
const CHANGE_COST = 0.12
const BASS_WEIGHT = 0.2

/** The mean of rows `[from, to)` of a `frames × 12` table, scaled to unit length. */
const meanRow = (
  table: Float32Array,
  from: number,
  to: number,
): Float64Array => {
  const out = new Float64Array(12)
  const frames = table.length / 12
  for (let t = Math.max(0, from); t < Math.min(frames, to); t++) {
    for (let c = 0; c < 12; c++)
      out[c] = (out[c] ?? 0) + (table[t * 12 + c] ?? 0)
  }
  const length = Math.hypot(...out)
  return length > 0 ? out.map(value => value / length) : out
}

/**
 * How well each of the 25 chords (12 major, 12 minor, none) fits a beat:
 * the chroma against the triad's three notes, plus the bass on its root.
 */
const chordScores = (
  chroma: Float64Array,
  bass: Float64Array,
): Float64Array => {
  const scores = new Float64Array(25)
  const third = 1 / Math.sqrt(3)
  for (let root = 0; root < 12; root++) {
    const fifth = chroma[(root + 7) % 12] ?? 0
    const base = chroma[root] ?? 0
    const bassOn = BASS_WEIGHT * (bass[root] ?? 0)
    scores[root] =
      third * (base + (chroma[(root + 4) % 12] ?? 0) + fifth) + bassOn
    scores[12 + root] =
      third * (base + (chroma[(root + 3) % 12] ?? 0) + fifth) + bassOn
  }
  scores[24] = NO_CHORD_SCORE
  return scores
}

/** The chords from beat to beat, as changes. */
export const findChords = (
  tune: Tune,
  beatTimes: ReadonlyArray<number>,
  durationSeconds: number,
): ReadonlyArray<Tv.TvChord> => {
  if (beatTimes.length < 2) return []
  const frameOf = (time: number) => Math.round(time * tune.frameRate)
  const beats = beatTimes.map((time, i) => {
    const end =
      beatTimes[i + 1] ??
      Math.min(durationSeconds, time + (time - (beatTimes[i - 1] ?? time)))
    const chroma = meanRow(
      tune.chroma,
      frameOf(time),
      Math.max(frameOf(end), frameOf(time) + 1),
    )
    const bass = meanRow(
      tune.bass,
      frameOf(time),
      Math.max(frameOf(end), frameOf(time) + 1),
    )
    return Math.hypot(...chroma) > 0
      ? chordScores(chroma, bass)
      : Float64Array.from({ length: 25 }, (_, s) => (s === 24 ? 1 : 0))
  })
  // Viterbi: the best path of chords, each change costing a little.
  const states = 25
  let score = Float64Array.from(beats[0] ?? new Float64Array(states))
  const back: Array<Int8Array> = [new Int8Array(states)]
  for (let i = 1; i < beats.length; i++) {
    const fit = beats[i] ?? new Float64Array(states)
    let bestPrevious = 0
    for (let s = 1; s < states; s++)
      if ((score[s] ?? 0) > (score[bestPrevious] ?? 0)) bestPrevious = s
    const next = new Float64Array(states)
    const links = new Int8Array(states)
    for (let s = 0; s < states; s++) {
      const stay = score[s] ?? 0
      const change = (score[bestPrevious] ?? 0) - CHANGE_COST
      if (stay >= change) {
        next[s] = stay + (fit[s] ?? 0)
        links[s] = s
      } else {
        next[s] = change + (fit[s] ?? 0)
        links[s] = bestPrevious
      }
    }
    score = next
    back.push(links)
  }
  let state = 0
  for (let s = 1; s < states; s++)
    if ((score[s] ?? 0) > (score[state] ?? 0)) state = s
  const path = new Array<number>(beats.length)
  for (let i = beats.length - 1; i >= 0; i--) {
    path[i] = state
    state = back[i]?.[state] ?? state
  }
  const chordOf = (s: number): BeatChord =>
    s === 24 ? { root: null, minor: false } : { root: s % 12, minor: s >= 12 }
  const changes: Array<Tv.TvChord> = []
  path.forEach((s, i) => {
    const chord = chordOf(s)
    const last = changes[changes.length - 1]
    if (
      last === undefined ||
      last.root !== chord.root ||
      last.minor !== chord.minor
    ) {
      changes.push({
        startSeconds:
          Math.round((i === 0 ? 0 : (beatTimes[i] ?? 0)) * 1000) / 1000,
        ...chord,
      })
    }
  })
  return changes
}

// KEYS

const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
]
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
]

const correlation = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < 12; i++) {
    meanA += (a[i] ?? 0) / 12
    meanB += (b[i] ?? 0) / 12
  }
  let top = 0
  let squaresA = 0
  let squaresB = 0
  for (let i = 0; i < 12; i++) {
    const da = (a[i] ?? 0) - meanA
    const db = (b[i] ?? 0) - meanB
    top += da * db
    squaresA += da * da
    squaresB += db * db
  }
  return squaresA > 0 && squaresB > 0 ? top / Math.sqrt(squaresA * squaresB) : 0
}

/** Each key's fit to `chroma`: 0 to 11 major from C, 12 to 23 minor. */
const keyFits = (chroma: ArrayLike<number>): Float64Array =>
  Float64Array.from({ length: 24 }, (_, key) => {
    const tonic = key % 12
    const profile = key < 12 ? MAJOR_PROFILE : MINOR_PROFILE
    const turned = Array.from(
      { length: 12 },
      (_, c) => profile[(c - tonic + 12) % 12] ?? 0,
    )
    return correlation(chroma, turned)
  })

const bestKey = (fits: Float64Array): number => {
  let best = 0
  for (let key = 1; key < 24; key++)
    if ((fits[key] ?? 0) > (fits[best] ?? 0)) best = key
  return best
}

/** How much better a section must fit a new key than the song's own. */
const KEY_MARGIN = 0.12
/** A modulation lasts at least this long. */
const MIN_KEY_SECONDS = 20

/** The key through the song, as changes. */
export const findKeys = (
  tune: Tune,
  sections: ReadonlyArray<{
    readonly startSeconds: number
    readonly endSeconds: number
  }>,
): ReadonlyArray<Tv.TvKey> => {
  const frameOf = (time: number) => Math.round(time * tune.frameRate)
  const whole = meanRow(tune.chroma, 0, tune.frames)
  if (Math.hypot(...whole) === 0) return []
  const songKey = bestKey(keyFits(whole))
  const keyOf = (key: number) => ({ tonic: key % 12, minor: key >= 12 })
  const regions: Array<{ start: number; end: number; key: number }> = []
  for (const section of sections) {
    const fits = keyFits(
      meanRow(
        tune.chroma,
        frameOf(section.startSeconds),
        frameOf(section.endSeconds),
      ),
    )
    const own = bestKey(fits)
    // Major against minor on one tonic is a mood, not a modulation: the
    // profiles confuse them readily.
    const isModulation = own % 12 !== songKey % 12
    const key =
      isModulation && (fits[own] ?? 0) - (fits[songKey] ?? 0) > KEY_MARGIN
        ? own
        : songKey
    const last = regions[regions.length - 1]
    if (last !== undefined && last.key === key) last.end = section.endSeconds
    else
      regions.push({
        start: section.startSeconds,
        end: section.endSeconds,
        key,
      })
  }
  // A short excursion is the song's own key after all.
  const kept = regions.map(region =>
    region.key !== songKey && region.end - region.start < MIN_KEY_SECONDS
      ? { ...region, key: songKey }
      : region,
  )
  const changes: Array<Tv.TvKey> = []
  for (const region of kept) {
    const last = changes[changes.length - 1]
    const key = keyOf(region.key)
    if (last === undefined) changes.push({ startSeconds: 0, ...key })
    else if (last.tonic !== key.tonic || last.minor !== key.minor) {
      changes.push({
        startSeconds: Math.round(region.start * 1000) / 1000,
        ...key,
      })
    }
  }
  return changes.length > 0 ? changes : [{ startSeconds: 0, ...keyOf(songKey) }]
}
