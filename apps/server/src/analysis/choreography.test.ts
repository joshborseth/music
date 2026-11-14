import { describe, expect, test } from 'bun:test'

import type { Tv } from '@music/shared'

import { type ChoreographyInput, planChoreography } from './choreography.ts'

/**
 * A made-up club track at 120 BPM (a bar is 2 seconds): an 8-bar intro, a
 * verse, a riser into the first drop, a breakdown with a stop, the chorus
 * coming back louder after a key change, and an outro.
 */
const BAR = 2
const sections: ReadonlyArray<
  readonly [number, number, Tv.TvSectionKind, number, number]
> = [
  // start bar, bars, kind, group, energy
  [0, 8, 'Intro', 0, 0.2],
  [8, 16, 'Verse', 1, 0.6],
  [24, 16, 'Drop', 2, 0.95],
  [40, 8, 'Breakdown', 3, 0.3],
  [48, 16, 'Verse', 1, 0.62],
  [64, 16, 'Chorus', 2, 1],
  [80, 8, 'Outro', 4, 0.35],
]
const bars = 88

const song = (drive: number): ChoreographyInput => ({
  durationSeconds: bars * BAR,
  tempo: 120,
  beats: Array.from({ length: bars * 4 }, (_, i) => i * 0.5),
  downbeats: Array.from({ length: bars }, (_, i) => i * BAR),
  sections: sections.map(([start, length, kind, group, energy]) => ({
    startSeconds: start * BAR,
    endSeconds: (start + length) * BAR,
    kind,
    group,
    energy,
  })),
  drops: [24 * BAR],
  drive,
  keys: [
    { startSeconds: 0, tonic: 9, minor: true },
    { startSeconds: 64 * BAR, tonic: 11, minor: true },
  ],
  stops: [
    { startSeconds: 46 * BAR - 0.6, endSeconds: 46 * BAR },
    { startSeconds: 60 * BAR, endSeconds: 60 * BAR + 0.1 },
  ],
  risers: [{ startSeconds: 20 * BAR, endSeconds: 24 * BAR }],
  fills: [{ startSeconds: 63 * BAR, endSeconds: 64 * BAR }],
})

describe('choreography', () => {
  const plan = planChoreography(song(0.8))

  test('the drop builds over its riser and lands on its downbeat', () => {
    expect(plan.builds).toContainEqual({
      startSeconds: 20 * BAR,
      landSeconds: 24 * BAR,
      strength: 1,
    })
  })

  test('a section coming in much louder is a smaller lift', () => {
    const lifts = plan.builds.filter(build => build.strength < 1)
    // Each verse after a quiet part, and the chorus after the second verse.
    expect(lifts.map(build => build.landSeconds)).toEqual([
      8 * BAR,
      48 * BAR,
      64 * BAR,
    ])
    for (const lift of lifts) {
      expect(lift.landSeconds - lift.startSeconds).toBe(2 * BAR)
      expect(lift.strength).toBeGreaterThan(0.4)
    }
  })

  test('builds never overlap', () => {
    plan.builds.forEach((build, i) => {
      expect(build.startSeconds).toBeLessThan(build.landSeconds)
      const before = plan.builds[i - 1]
      if (before !== undefined)
        expect(build.startSeconds).toBeGreaterThanOrEqual(before.landSeconds)
    })
  })

  test('the climax is the last, louder chorus a step up', () => {
    expect(plan.climax).toEqual({
      startSeconds: 64 * BAR,
      endSeconds: 80 * BAR,
      landSeconds: 64 * BAR,
    })
  })

  test('a stop is a breath, a hiccup is not', () => {
    expect(plan.breaths).toEqual([
      { startSeconds: 46 * BAR - 0.6, endSeconds: 46 * BAR },
    ])
  })

  test('the drop and the climax strobe for their first bars, and nothing else does', () => {
    expect(plan.strobes).toEqual([
      { startSeconds: 24 * BAR, endSeconds: 28 * BAR },
      { startSeconds: 64 * BAR, endSeconds: 72 * BAR },
    ])
  })

  test('each section after the first changes the scene its own way', () => {
    expect(
      plan.transitions.map(({ atSeconds, kind, beats }) => [
        atSeconds / BAR,
        kind,
        beats,
      ]),
    ).toEqual([
      // Into the verse, much louder: rushes through.
      [8, 'ZoomThrough', 2],
      // The drop shatters on its beat.
      [24, 'Shatter', 2],
      // Falling into the breakdown: melts.
      [40, 'Melt', 4],
      // A louder verse after the breakdown: rushes through.
      [48, 'ZoomThrough', 2],
      // The climax lands: shatters.
      [64, 'Shatter', 2],
      [80, 'Melt', 4],
    ])
  })

  test('a ballad never strobes, but still has its climax', () => {
    const ballad = planChoreography(song(0.1))
    expect(ballad.strobes).toEqual([])
    expect(ballad.climax?.startSeconds).toBe(64 * BAR)
  })

  test('a chorus coming back datamoshes, and a calm change wipes slowly', () => {
    const calm = planChoreography({
      ...song(0.8),
      drops: [],
      risers: [],
      sections: [
        {
          startSeconds: 0,
          endSeconds: 20,
          kind: 'Intro',
          group: 0,
          energy: 0.3,
        },
        {
          startSeconds: 20,
          endSeconds: 40,
          kind: 'Verse',
          group: 1,
          energy: 0.4,
        },
        {
          startSeconds: 40,
          endSeconds: 60,
          kind: 'Chorus',
          group: 2,
          energy: 0.66,
        },
        {
          startSeconds: 60,
          endSeconds: 80,
          kind: 'Verse',
          group: 1,
          energy: 0.55,
        },
        {
          startSeconds: 80,
          endSeconds: 100,
          kind: 'Chorus',
          group: 2,
          energy: 0.58,
        },
      ],
    })
    expect(calm.transitions.map(({ kind, beats }) => [kind, beats])).toEqual([
      ['Wipe', 8],
      // The louder chorus is the climax.
      ['Shatter', 2],
      ['Wipe', 4],
      ['Datamosh', 4],
    ])
  })

  test('a song with nothing loud has no climax', () => {
    const flat = planChoreography({
      ...song(0.1),
      drops: [],
      sections: [
        {
          startSeconds: 0,
          endSeconds: 88,
          kind: 'Verse',
          group: 0,
          energy: 0.4,
        },
        {
          startSeconds: 88,
          endSeconds: 176,
          kind: 'Verse',
          group: 1,
          energy: 0.45,
        },
      ],
    })
    expect(flat.climax).toBeNull()
  })
})
