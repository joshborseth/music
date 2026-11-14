import type { Tv } from '@music/shared'

import {
  BEATS_PER_BAR,
  downbeatPhase,
  estimatePeriod,
  onsetEnvelope,
  refinePeak,
  standardDeviation,
  tempoOf,
  trackBeats,
} from './beats.ts'
import {
  KICK,
  MIDS,
  bandDb,
  drumHits,
  separate,
  snaresAndHats,
} from './drums.ts'
import { findChords, findKeys, listenForTune } from './harmony.ts'
import { findFills, findRisers, findStops } from './moments.ts'
import { buildScore } from './score.ts'
import {
  MEL_BANDS,
  type Spectrogram,
  bandsBetween,
  spectrogram,
} from './spectrogram.ts'
import { type Bar, analyzeStructure } from './structure.ts'

/*
 * Everything the TV's visuals know about a song, from its samples (mono,
 * float). Pure and synchronous: the server runs it in a worker.
 */

/** Bump when the analysis changes, so cached results are worked out again. */
export const ANALYZER_VERSION = 3

/** The sample rate the analysis expects (ffmpeg resamples to it). */
export const SAMPLE_RATE = 22050

export const ENERGY_STEP_SECONDS = 0.1
/** Accents at least this far apart, so at most four a second. */
const ACCENT_GAP_SECONDS = 0.25
/** The window, each side, an accent must stand out from. */
const ACCENT_CONTEXT_SECONDS = 1
const ACCENT_DEVIATIONS = 2.5

const BASS_HZ = [30, 150] as const
const SNARE_HZ = [1500, 6000] as const

const round3 = (value: number): number => Math.round(value * 1000) / 1000

const smoothstep = (from: number, to: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/** Mel bands from about 150 Hz to 7 kHz, where grit and noise show. */
const FLATNESS_BANDS = [8, 80] as const
/** Frames this far under the song's loudest count as silence. */
const QUIET_DB = 40

/**
 * How driving the whole song is, 0 to 1, whatever its volume: the visuals
 * use it to keep a ballad's loudest chorus calm and let a club track's drop
 * go wild. Half is punch, the onset envelope's mean (how hard and how often
 * new sound starts: drums, stabs); half is grit, the spectrum's flatness in
 * dB (how noise-like the sound is: distorted guitars, cymbals, dense mixes,
 * against a voice, a piano, or a pad). Both are ratios, so a quiet master
 * scores as its loud copy would. Measured on real songs: piano and ambient
 * pieces score under 0.15, rock around 0.5, house and hip-hop 0.6 to 0.9.
 */
export const songDrive = (spec: Spectrogram, onset: Float32Array): number => {
  let loudest = 0
  spec.power.forEach(power => {
    loudest = Math.max(loudest, power)
  })
  const floor = loudest * 10 ** (-QUIET_DB / 10)
  const [from, to] = FLATNESS_BANDS
  const bands = to - from
  let flatness = 0
  let punch = 0
  let frames = 0
  for (let t = 0; t < spec.frames; t++) {
    if ((spec.power[t] ?? 0) <= floor) continue
    let meanDb = 0
    let meanPower = 0
    for (let band = from; band < to; band++) {
      const db = spec.melDb[t * MEL_BANDS + band] ?? 0
      meanDb += db / bands
      meanPower += 10 ** (db / 10) / bands
    }
    flatness += meanDb - 10 * Math.log10(meanPower + 1e-12)
    punch += onset[t] ?? 0
    frames++
  }
  if (frames === 0) return 0
  return round3(
    0.5 * smoothstep(0.85, 1.6, punch / frames) +
      0.5 * smoothstep(-14, -5, flatness / frames),
  )
}

/**
 * Loudness every `ENERGY_STEP_SECONDS`: RMS, smoothed over about a third of
 * a second, raised to 0.6 (roughly how loud it sounds rather than its
 * amplitude), and scaled so the loudest step is 1.
 */
export const energyCurve = (
  samples: Float32Array,
  sampleRate: number,
): ReadonlyArray<number> => {
  const step = Math.round(ENERGY_STEP_SECONDS * sampleRate)
  const count = Math.ceil(samples.length / step)
  const rms = Float64Array.from({ length: count }, (_, i) => {
    let sum = 0
    const end = Math.min(samples.length, (i + 1) * step)
    for (let s = i * step; s < end; s++) {
      const sample = samples[s] ?? 0
      sum += sample * sample
    }
    return Math.sqrt(sum / Math.max(1, end - i * step))
  })
  const smoothed = rms.map(
    (value, i) =>
      0.25 * (rms[i - 1] ?? value) + 0.5 * value + 0.25 * (rms[i + 1] ?? value),
  )
  let loudest = 0
  smoothed.forEach(value => {
    loudest = Math.max(loudest, value)
  })
  return Array.from(smoothed, value =>
    loudest > 0 ? round3((value / loudest) ** 0.6) : 0,
  )
}

/**
 * Strong hits: peaks of the onset envelope (full band and snare band
 * together) that stand well above the second around them, kept at least
 * `ACCENT_GAP_SECONDS` apart, strongest first. Frames, in order.
 */
export const accentFrames = (
  full: Float32Array,
  snare: Float32Array,
  frameRate: number,
): ReadonlyArray<number> => {
  const frames = full.length
  const fullScale = standardDeviation(full) || 1
  const snareScale = standardDeviation(snare) || 1
  const strength = Float64Array.from(
    { length: frames },
    (_, t) => ((full[t] ?? 0) / fullScale + (snare[t] ?? 0) / snareScale) / 2,
  )
  const sums = new Float64Array(frames + 1)
  const squares = new Float64Array(frames + 1)
  strength.forEach((value, t) => {
    sums[t + 1] = (sums[t] ?? 0) + value
    squares[t + 1] = (squares[t] ?? 0) + value * value
  })
  const reach = Math.round(ACCENT_CONTEXT_SECONDS * frameRate)
  const candidates: Array<{ frame: number; value: number }> = []
  for (let t = 2; t < frames - 2; t++) {
    const value = strength[t] ?? 0
    let isPeak = true
    for (let k = -2; k <= 2 && isPeak; k++) {
      if (k !== 0 && (strength[t + k] ?? 0) > value) isPeak = false
    }
    if (!isPeak) continue
    const from = Math.max(0, t - reach)
    const to = Math.min(frames, t + reach + 1)
    const n = to - from
    const average = ((sums[to] ?? 0) - (sums[from] ?? 0)) / n
    const variance =
      ((squares[to] ?? 0) - (squares[from] ?? 0)) / n - average * average
    const deviation = Math.sqrt(Math.max(0, variance))
    if (value > average + ACCENT_DEVIATIONS * deviation && value > 1.5) {
      candidates.push({ frame: t, value })
    }
  }
  candidates.sort((a, b) => b.value - a.value)
  const gap = ACCENT_GAP_SECONDS * frameRate
  const chosen: Array<number> = []
  const taken = new Set<number>()
  for (const { frame } of candidates) {
    let isClear = true
    for (let k = Math.ceil(-gap) + 1; k < gap && isClear; k++) {
      if (taken.has(frame + k)) isClear = false
    }
    if (isClear) {
      chosen.push(frame)
      taken.add(frame)
    }
  }
  return chosen.sort((a, b) => a - b)
}

/** The analysis of `samples` (mono, at `SAMPLE_RATE`), for `videoId`. */
export const analyzeSamples = (
  videoId: string,
  samples: Float32Array,
): Tv.TvAnalysis => {
  const durationSeconds = samples.length / SAMPLE_RATE
  const spec = spectrogram(samples, SAMPLE_RATE)
  const frameTime = (frame: number) => frame / spec.frameRate

  const onset = onsetEnvelope(spec)
  const bassBands = bandsBetween(spec, ...BASS_HZ)
  const snareBands = bandsBetween(spec, ...SNARE_HZ)
  const bassOnset = onsetEnvelope(spec, bassBands.from, bassBands.to)
  const snareOnset = onsetEnvelope(spec, snareBands.from, snareBands.to)

  const period = estimatePeriod(onset, spec.frameRate)
  const beats = trackBeats(onset, period)
  const beatTimes = beats.map(beat => frameTime(refinePeak(onset, beat)))
  const tempo = tempoOf(beatTimes, period, spec.frameRate)

  const phase = downbeatPhase(spec, beats, bassOnset)
  const isDownbeat = (i: number) =>
    i >= phase && (i - phase) % BEATS_PER_BAR === 0
  const downbeats = beats.filter((_, i) => isDownbeat(i))
  const barFrames = Math.round(BEATS_PER_BAR * period)
  const bars: ReadonlyArray<Bar> = downbeats.map((start, i) => ({
    start,
    end: downbeats[i + 1] ?? Math.min(spec.frames, start + barFrames),
  }))
  const structure = analyzeStructure(spec, bars, onset, bassBands)
  const barTime = (bar: number) =>
    frameTime(refinePeak(onset, bars[bar]?.start ?? 0))
  const sections = structure.sections.map((section, i) => ({
    startSeconds: i === 0 ? 0 : round3(barTime(section.startBar)),
    endSeconds:
      i === structure.sections.length - 1
        ? round3(durationSeconds)
        : round3(barTime(section.endBar)),
    kind: section.kind,
    group: section.group,
    energy: round3(section.energy),
  }))
  const drops = structure.dropBars.map(bar => round3(barTime(bar)))
  const downbeatTimes = beatTimes.filter((_, i) => isDownbeat(i)).map(round3)

  // The parts: drums told apart from the rest, the tune and the harmony.
  const parts = separate(spec)
  const kicks = drumHits(spec, parts.percussive, KICK)
  const { snares, hats } = snaresAndHats(spec, parts.percussive)
  const mids = drumHits(spec, parts.percussive, MIDS)
  const lowBands = bandsBetween(spec, 30, 200)
  const highBands = bandsBetween(spec, 3000, SAMPLE_RATE / 2)
  const tune = listenForTune(samples, SAMPLE_RATE)
  const brightness = Float32Array.from({ length: spec.frames }, (_, t) => {
    let weighted = 0
    let total = 0
    for (let band = 0; band < MEL_BANDS; band++) {
      const power = 10 ** ((spec.melDb[t * MEL_BANDS + band] ?? 0) / 10)
      weighted += power * Math.log2(spec.melHz[band] ?? 1)
      total += power
    }
    return total > 0 ? weighted / total : 0
  })
  const targets = [
    ...sections.slice(1).map(section => section.startSeconds),
    ...drops,
  ].sort((a, b) => a - b)
  const hitTimes = (hits: ReadonlyArray<{ readonly frame: number }>) =>
    hits.map(hit => round3(frameTime(hit.frame)))

  return {
    videoId,
    durationSeconds: round3(durationSeconds),
    tempo: round3(tempo),
    beats: beatTimes.map(round3),
    downbeats: downbeatTimes,
    sections,
    drops,
    accents: accentFrames(onset, snareOnset, spec.frameRate).map(frame =>
      round3(frameTime(refinePeak(onset, frame))),
    ),
    energyStepSeconds: ENERGY_STEP_SECONDS,
    energy: energyCurve(samples, SAMPLE_RATE),
    drive: songDrive(spec, onset),
    kicks: hitTimes(kicks),
    snares: hitTimes(snares),
    hats: hitTimes(hats),
    chords: findChords(tune, beatTimes, durationSeconds),
    keys: findKeys(tune, sections),
    stops: findStops(
      spec.power,
      spec.frameRate,
      beatTimes[0] ?? 0,
      beatTimes[beatTimes.length - 1] ?? 0,
    ),
    risers: findRisers(
      bandDb(parts.power, spec.frames, highBands.from, highBands.to),
      spec.frameRate,
      downbeatTimes,
      targets,
    ),
    fills: findFills(
      [...kicks, ...snares, ...mids].sort((a, b) => a.frame - b.frame),
      spec.frameRate,
      downbeatTimes,
      targets,
    ),
    score: buildScore({
      durationSeconds,
      spec,
      drumsDb: bandDb(parts.percussive, spec.frames, 0, MEL_BANDS),
      bassDb: bandDb(parts.harmonic, spec.frames, lowBands.from, lowBands.to),
      kicks,
      snares,
      hats,
      tune,
      brightness,
    }),
  }
}
