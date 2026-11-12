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
import { bandsBetween, spectrogram } from './spectrogram.ts'
import { type Bar, analyzeStructure } from './structure.ts'

/*
 * Everything the TV's visuals know about a song, from its samples (mono,
 * float). Pure and synchronous: the server runs it in a worker.
 */

/** Bump when the analysis changes, so cached results are worked out again. */
export const ANALYZER_VERSION = 1

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

  return {
    videoId,
    durationSeconds: round3(durationSeconds),
    tempo: round3(tempo),
    beats: beatTimes.map(round3),
    downbeats: beatTimes.filter((_, i) => isDownbeat(i)).map(round3),
    sections: structure.sections.map((section, i) => ({
      startSeconds: i === 0 ? 0 : round3(barTime(section.startBar)),
      endSeconds:
        i === structure.sections.length - 1
          ? round3(durationSeconds)
          : round3(barTime(section.endBar)),
      kind: section.kind,
      group: section.group,
      energy: round3(section.energy),
    })),
    drops: structure.dropBars.map(bar => round3(barTime(bar))),
    accents: accentFrames(onset, snareOnset, spec.frameRate).map(frame =>
      round3(frameTime(refinePeak(onset, frame))),
    ),
    energyStepSeconds: ENERGY_STEP_SECONDS,
    energy: energyCurve(samples, SAMPLE_RATE),
  }
}
