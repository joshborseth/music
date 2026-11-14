import type { Tv } from '@music/shared'

import { type Hit, quantile } from './drums.ts'

/*
 * The moments a VJ would cue: where the music stops dead mid-song, the
 * sweeps that climb into what follows, and the drum fills that lead into a
 * new section.
 */

const round3 = (value: number): number => Math.round(value * 1000) / 1000

/** Frames this far under the song's loud level are silence. */
const STOP_DB = 28
const STOP_MIN_SECONDS = 0.18
/** The music before a stop must have been going this long, this loud. */
const STOP_BEFORE_SECONDS = 1
const STOP_BEFORE_DB = 12

/**
 * Where the music cuts out between its first and last beats, after a
 * second of playing: runs of frames well under the song's loud level.
 */
export const findStops = (
  power: Float32Array,
  frameRate: number,
  firstBeat: number,
  lastBeat: number,
): ReadonlyArray<Tv.TvSpan> => {
  const db = Float32Array.from(power, value => 10 * Math.log10(value + 1e-12))
  const loud = quantile(db, 0.9)
  const quiet = loud - STOP_DB
  const before = Math.round(STOP_BEFORE_SECONDS * frameRate)
  const shortest = Math.round(STOP_MIN_SECONDS * frameRate)
  const from = Math.max(before, Math.ceil(firstBeat * frameRate))
  const to = Math.floor(lastBeat * frameRate)
  const stops: Array<Tv.TvSpan> = []
  let t = from
  while (t < to) {
    if ((db[t] ?? 0) >= quiet) {
      t++
      continue
    }
    let end = t
    while (end < db.length && (db[end] ?? 0) < quiet) end++
    if (end - t >= shortest && end < to + shortest) {
      let sum = 0
      for (let k = t - before; k < t; k++) sum += db[k] ?? 0
      if (sum / before > loud - STOP_BEFORE_DB) {
        stops.push({
          startSeconds: round3(t / frameRate),
          endSeconds: round3(end / frameRate),
        })
      }
    }
    t = end
  }
  return stops
}

/** The bars a riser may climb over, at most, and the climb it needs (dB). */
const RISER_MAX_BARS = 8
const RISER_MIN_BARS = 2
const RISER_RISE_DB = 6
/** A bar may dip this much (dB) under the one before and still climb. */
const RISER_DIP_DB = 1

/**
 * Sweeps and builds into each of `targets` (sections' starts and drops):
 * the longest run of bars just before it over which the highs (noise,
 * cymbals, a filter opening) climb bar after bar, by enough.
 */
export const findRisers = (
  highDb: Float32Array,
  frameRate: number,
  downbeats: ReadonlyArray<number>,
  targets: ReadonlyArray<number>,
): ReadonlyArray<Tv.TvSpan> => {
  const barLevel = (start: number, end: number) => {
    const from = Math.round(start * frameRate)
    const to = Math.max(from + 1, Math.round(end * frameRate))
    let sum = 0
    for (let t = from; t < to; t++) sum += highDb[t] ?? 0
    return sum / (to - from)
  }
  const risers: Array<Tv.TvSpan> = []
  for (const target of targets) {
    const at = downbeats.findIndex(time => Math.abs(time - target) < 0.15)
    if (at < RISER_MIN_BARS) continue
    const levels: Array<number> = []
    for (let bar = at - 1; bar >= Math.max(0, at - RISER_MAX_BARS); bar--) {
      levels.unshift(
        barLevel(downbeats[bar] ?? 0, downbeats[bar + 1] ?? target),
      )
    }
    // The longest climbing run that ends at the target.
    let bars = 1
    for (let i = levels.length - 1; i > 0; i--) {
      if ((levels[i] ?? 0) < (levels[i - 1] ?? 0) - RISER_DIP_DB) break
      bars++
    }
    const climb =
      (levels[levels.length - 1] ?? 0) - (levels[levels.length - bars] ?? 0)
    if (bars >= RISER_MIN_BARS && climb >= RISER_RISE_DB) {
      risers.push({
        startSeconds: round3(downbeats[at - bars] ?? 0),
        endSeconds: round3(target),
      })
    }
  }
  return risers
}

/** A fill has this many times the hits of the bars before it, and at least `FILL_MIN_HITS`. */
const FILL_RATIO = 1.75
const FILL_MIN_HITS = 5

/**
 * Drum fills into each of `targets`: a last bar (or its second half) with
 * far more hits than the bars before it.
 */
export const findFills = (
  hits: ReadonlyArray<Hit>,
  frameRate: number,
  downbeats: ReadonlyArray<number>,
  targets: ReadonlyArray<number>,
): ReadonlyArray<Tv.TvSpan> => {
  const times = hits.map(hit => hit.frame / frameRate)
  const count = (start: number, end: number) =>
    times.filter(time => time >= start && time < end).length
  const fills: Array<Tv.TvSpan> = []
  for (const target of targets) {
    const at = downbeats.findIndex(time => Math.abs(time - target) < 0.15)
    if (at < 5) continue
    const barStart = downbeats[at - 1] ?? 0
    const half = (barStart + target) / 2
    let before = 0
    for (let bar = at - 5; bar < at - 1; bar++) {
      before += count(downbeats[bar] ?? 0, downbeats[bar + 1] ?? 0)
    }
    const usual = before / 4
    const last = count(barStart, target)
    const lastHalf = count(half, target)
    if (
      lastHalf * 2 >= Math.max(FILL_MIN_HITS, usual * FILL_RATIO) &&
      lastHalf * 2 > last
    ) {
      fills.push({ startSeconds: round3(half), endSeconds: round3(target) })
    } else if (last >= Math.max(FILL_MIN_HITS, usual * FILL_RATIO)) {
      fills.push({ startSeconds: round3(barStart), endSeconds: round3(target) })
    }
  }
  return fills
}
