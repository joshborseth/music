import { describe, expect, test } from 'bun:test'
import { Schema } from 'effect'

import { Tv } from '@music/shared'

import { SAMPLE_RATE, analyzeSamples } from './analyze.ts'
import { makeRealFft } from './fft.ts'

/** A repeatable noise source, so the tests never flake. */
const noise = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 31 - 1
  }
}

interface Hit {
  readonly at: number
  readonly gain: number
  /** Tone frequency; 0 for a noise burst. */
  readonly hz: number
  readonly seconds: number
}

/** `seconds` of audio with each hit added: a decaying tone or noise burst. */
const render = (seconds: number, hits: ReadonlyArray<Hit>): Float32Array => {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  const random = noise(7)
  for (const hit of hits) {
    const start = Math.round(hit.at * SAMPLE_RATE)
    const length = Math.round(hit.seconds * SAMPLE_RATE)
    for (let i = 0; i < length && start + i < samples.length; i++) {
      const t = i / SAMPLE_RATE
      const decay = Math.exp((-5 * i) / length)
      const wave = hit.hz > 0 ? Math.sin(2 * Math.PI * hit.hz * t) : random()
      samples[start + i] = (samples[start + i] ?? 0) + hit.gain * decay * wave
    }
  }
  return samples
}

const beatTimes = (bpm: number, from: number, until: number) =>
  Array.from(
    { length: Math.floor(((until - from) * bpm) / 60) },
    (_, i) => from + (i * 60) / bpm,
  )

describe('FFT', () => {
  test('matches a plain DFT', () => {
    const size = 64
    const random = noise(1)
    const input = Float64Array.from({ length: size }, () => random())
    const power = new Float64Array(size / 2 + 1)
    makeRealFft(size).powerSpectrum(input, power)
    for (let k = 0; k <= size / 2; k++) {
      let re = 0
      let im = 0
      input.forEach((x, n) => {
        re += x * Math.cos((2 * Math.PI * k * n) / size)
        im -= x * Math.sin((2 * Math.PI * k * n) / size)
      })
      expect(power[k]).toBeCloseTo(re * re + im * im, 8)
    }
  })
})

describe('beats', () => {
  test.each([128, 95])('a click track at %d BPM', bpm => {
    const clicks = beatTimes(bpm, 0.5, 40)
    const samples = render(
      40,
      clicks.map(at => ({ at, gain: 0.8, hz: 0, seconds: 0.03 })),
    )
    const analysis = analyzeSamples('clicks', samples)

    expect(Math.abs(analysis.tempo - bpm) / bpm).toBeLessThan(0.02)
    expect(analysis.beats.length).toBeGreaterThan(clicks.length * 0.9)
    for (const beat of analysis.beats) {
      const nearest = Math.min(...clicks.map(click => Math.abs(click - beat)))
      expect(nearest).toBeLessThan(0.03)
    }
    // Downbeats are every fourth beat.
    expect(analysis.downbeats.length).toBe(
      Math.ceil(
        (analysis.beats.length -
          analysis.beats.indexOf(analysis.downbeats[0] ?? 0)) /
          4,
      ),
    )
  })

  test('the downbeat is the beat with the kick', () => {
    const bpm = 120
    const beats = beatTimes(bpm, 0.25, 40)
    const samples = render(40, [
      ...beats.map(at => ({ at, gain: 0.3, hz: 0, seconds: 0.03 })),
      // A kick on the second beat of every bar.
      ...beats
        .filter((_, i) => i % 4 === 1)
        .map(at => ({ at, gain: 0.9, hz: 55, seconds: 0.25 })),
    ])
    const analysis = analyzeSamples('kick', samples)
    const kicks = beats.filter((_, i) => i % 4 === 1)
    for (const downbeat of analysis.downbeats) {
      const nearest = Math.min(...kicks.map(kick => Math.abs(kick - downbeat)))
      expect(nearest).toBeLessThan(0.03)
    }
  })
})

describe('structure', () => {
  /** 32 quiet bars of hi-hats, then 32 loud bars with kick, bass, and snare. */
  const quietThenLoud = () => {
    const bpm = 120
    const change = 0.5 + 32 * 2
    const end = change + 32 * 2
    const beats = beatTimes(bpm, 0.5, end)
    const hits: Array<Hit> = beats.flatMap((at, i): ReadonlyArray<Hit> => {
      const hat = { at, gain: 0.06, hz: 0, seconds: 0.03 }
      if (at < change - 0.01) return [hat]
      return [
        { ...hat, gain: 0.25 },
        i % 2 === 0
          ? { at, gain: 0.9, hz: 50, seconds: 0.3 }
          : { at, gain: 0.5, hz: 0, seconds: 0.12 },
        { at, gain: 0.3, hz: 110, seconds: 0.45 },
      ]
    })
    return { samples: render(end + 1, hits), change }
  }

  test('a quiet stretch then a loud one: a boundary and a drop at the change', () => {
    const { samples, change } = quietThenLoud()
    const analysis = analyzeSamples('drop', samples)

    const starts = analysis.sections.map(section => section.startSeconds)
    expect(
      Math.min(...starts.map(start => Math.abs(start - change))),
    ).toBeLessThan(2.1)
    expect(analysis.drops.length).toBeGreaterThan(0)
    expect(
      Math.min(...analysis.drops.map(drop => Math.abs(drop - change))),
    ).toBeLessThan(2.1)

    const before = analysis.sections.find(
      section => section.endSeconds <= change + 2.1,
    )
    const after = analysis.sections.find(
      section => section.startSeconds >= change - 2.1,
    )
    expect(before?.energy ?? 1).toBeLessThan(0.6)
    expect(after?.energy).toBe(1)
    expect(after?.kind).toBe('Drop')
  })

  test('sections cover the song in order, and the result fits the Schema', () => {
    const { samples } = quietThenLoud()
    const analysis = analyzeSamples('drop', samples)
    expect(Schema.decodeExit(Tv.TvAnalysis)(analysis)._tag).toBe('Success')

    expect(analysis.sections[0]?.startSeconds).toBe(0)
    expect(analysis.sections.at(-1)?.endSeconds).toBe(analysis.durationSeconds)
    analysis.sections.forEach((section, i) => {
      expect(section.endSeconds).toBeGreaterThan(section.startSeconds)
      const next = analysis.sections[i + 1]
      if (next !== undefined) expect(next.startSeconds).toBe(section.endSeconds)
    })
  })

  test('energy is per step, smoothed, and peaks at 1', () => {
    const { samples, change } = quietThenLoud()
    const analysis = analyzeSamples('drop', samples)
    expect(analysis.energyStepSeconds).toBe(0.1)
    expect(analysis.energy.length).toBe(
      Math.ceil(analysis.durationSeconds / 0.1),
    )
    expect(Math.max(...analysis.energy)).toBe(1)
    const at = (seconds: number) =>
      analysis.energy[Math.round(seconds / 0.1)] ?? 0
    expect(at(change - 10)).toBeLessThan(at(change + 10))
  })

  test('accents are strong hits, at most four a second', () => {
    const { samples, change } = quietThenLoud()
    const analysis = analyzeSamples('drop', samples)
    expect(analysis.accents.length).toBeGreaterThan(0)
    expect(analysis.accents.length).toBeLessThanOrEqual(
      analysis.durationSeconds * 4,
    )
    analysis.accents.forEach((accent, i) => {
      const next = analysis.accents[i + 1]
      if (next !== undefined) expect(next - accent).toBeGreaterThanOrEqual(0.23)
    })
    // The loud half has the hits that stand out.
    expect(analysis.accents.some(accent => accent >= change - 0.1)).toBe(true)
  })

  test('drive tells a soft, tonal song from a hard, gritty one at any volume', () => {
    const { samples } = quietThenLoud()
    // Slow, soft notes: tones that swell and fade, two seconds each.
    const notes = beatTimes(30, 0.5, 40).map((at, i) => ({
      at,
      gain: 0.5,
      hz: [220, 277, 330, 262][i % 4] ?? 220,
      seconds: 1.9,
    }))
    const soft = analyzeSamples('soft', render(40, notes)).drive
    const hard = analyzeSamples('hard', samples).drive
    const quietHard = analyzeSamples(
      'quiet hard',
      samples.map(sample => sample * 0.1),
    ).drive
    expect(soft).toBeLessThan(0.2)
    expect(hard).toBeGreaterThan(soft + 0.3)
    expect(Math.abs(quietHard - hard)).toBeLessThan(0.05)
  })

  test('silence and very short songs still get an answer', () => {
    for (const samples of [
      new Float32Array(SAMPLE_RATE * 3),
      new Float32Array(100),
    ]) {
      const analysis = analyzeSamples('quiet', samples)
      expect(analysis.beats).toEqual([])
      expect(analysis.sections).toHaveLength(1)
      expect(Schema.decodeExit(Tv.TvAnalysis)(analysis)._tag).toBe('Success')
    }
  })
})
