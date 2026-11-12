import type { Tv } from '@music/shared'

import { chromaBetween, mean, standardDeviation } from './beats.ts'
import { MEL_BANDS, type Spectrogram } from './spectrogram.ts'

/*
 * The song's sections, worked out bar by bar. Each bar gets a few features
 * (its harmony as chroma, its timbre as MFCC-like coefficients, its
 * loudness), every pair of bars a similarity, and a checkerboard kernel slid
 * down that matrix's diagonal (Foote's novelty) peaks where the music turns
 * into something else. The strongest peaks, at least `MIN_SECTION_BARS`
 * apart, are the boundaries. Sections that line up bar for bar share a
 * group, and loudness, repetition, and position give each one a kind.
 */

export const MIN_SECTION_BARS = 8
/** A longer stretch is split at its strongest change. */
const MAX_SECTION_BARS = 24
/** The first and last sections may be this short (a short intro or tag). */
const MIN_EDGE_BARS = 4
const KERNEL_SIZES = [4, 8] as const
/** The loudness range mapped onto section energy 0 to 1. */
const ENERGY_RANGE_DB = 12
/** How much louder (dB, overall and bass averaged) a drop lands than the bars before it. */
const DROP_JUMP_DB = 5
const MAX_DROPS = 5
const MFCC_COUNT = 12
/**
 * Two sections are the same part when they line up bar for bar better
 * than this share of all pairs of bars do.
 */
const GROUP_QUANTILE = 0.8

/** A bar as frames `[start, end)`. */
export interface Bar {
  readonly start: number
  readonly end: number
}

export interface PlannedSection {
  readonly startBar: number
  /** Exclusive. */
  readonly endBar: number
  readonly kind: Tv.TvSectionKind
  readonly group: number
  readonly energy: number
}

export interface Structure {
  readonly sections: ReadonlyArray<PlannedSection>
  /** Bars where the music drops, in order. */
  readonly dropBars: ReadonlyArray<number>
}

interface BarFeatures {
  readonly chroma: Float64Array
  readonly mfcc: Float64Array
  readonly power: number
  readonly bassPower: number
  readonly busy: number
}

const decibels = (power: number): number => 10 * Math.log10(power + 1e-12)

/** Orthonormal DCT-II coefficients 1..count of a log spectrum (0 is loudness, left out). */
const cepstrum = (logSpectrum: Float64Array, count: number): Float64Array => {
  const n = logSpectrum.length
  return Float64Array.from({ length: count }, (_, index) => {
    const k = index + 1
    let sum = 0
    for (let i = 0; i < n; i++) {
      sum +=
        (logSpectrum[i] ?? 0) * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n))
    }
    return sum * Math.sqrt(2 / n)
  })
}

const barFeatures = (
  spec: Spectrogram,
  bar: Bar,
  onset: Float32Array,
  bass: { readonly from: number; readonly to: number },
): BarFeatures => {
  const frames = Math.max(1, bar.end - bar.start)
  const meanDb = new Float64Array(MEL_BANDS)
  let power = 0
  let bassPower = 0
  let busy = 0
  for (let t = bar.start; t < bar.end; t++) {
    for (let band = 0; band < MEL_BANDS; band++) {
      const db = spec.melDb[t * MEL_BANDS + band] ?? 0
      meanDb[band] = (meanDb[band] ?? 0) + db / frames
      if (band >= bass.from && band < bass.to) bassPower += 10 ** (db / 10)
    }
    power += spec.power[t] ?? 0
    busy += onset[t] ?? 0
  }
  const raw = chromaBetween(spec, bar.start, bar.end)
  const average = mean(raw)
  const centered = raw.map(value => value - average)
  const length = Math.hypot(...centered)
  return {
    chroma: length > 0 ? centered.map(value => value / length) : centered,
    mfcc: cepstrum(meanDb, MFCC_COUNT),
    power: power / frames,
    bassPower: bassPower / frames / Math.max(1, bass.to - bass.from),
    busy: busy / frames,
  }
}

const squaredDistance = (a: Float64Array, b: Float64Array): number => {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    sum += d * d
  }
  return sum
}

const quantile = (values: ReadonlyArray<number>, q: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

const median = (values: ReadonlyArray<number>): number => quantile(values, 0.5)

/**
 * How alike each pair of bars is, 0 to 1. Each feature gives a distance:
 * harmony (1 minus the cosine of centered chroma), timbre (between the
 * coefficients), loudness (the dB gap). Each distance is scaled by its own
 * median across the song, so whatever varies in this song tells its parts
 * apart, with a floor so a steady feature's noise is not blown up.
 */
const similarityMatrix = (bars: ReadonlyArray<BarFeatures>): Float64Array => {
  const n = bars.length
  const features: ReadonlyArray<{
    readonly weight: number
    readonly floor: number
    readonly distance: (a: BarFeatures, b: BarFeatures) => number
  }> = [
    {
      weight: 0.45,
      floor: 0.1,
      distance: (a, b) => {
        let cosine = 0
        for (let c = 0; c < 12; c++) {
          cosine += (a.chroma[c] ?? 0) * (b.chroma[c] ?? 0)
        }
        return 1 - cosine
      },
    },
    {
      weight: 0.35,
      floor: 5,
      distance: (a, b) => Math.sqrt(squaredDistance(a.mfcc, b.mfcc)),
    },
    {
      weight: 0.2,
      floor: 1.5,
      distance: (a, b) => Math.abs(decibels(a.power) - decibels(b.power)),
    },
  ]
  const similarity = new Float64Array(n * n)
  for (const feature of features) {
    const distances = new Float64Array(n * n)
    const offDiagonal: Array<number> = []
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = bars[i]
        const b = bars[j]
        if (a === undefined || b === undefined) continue
        const d = feature.distance(a, b)
        distances[i * n + j] = d
        distances[j * n + i] = d
        offDiagonal.push(d)
      }
    }
    const scale = Math.max(median(offDiagonal), feature.floor)
    distances.forEach((d, at) => {
      similarity[at] =
        (similarity[at] ?? 0) + feature.weight * Math.exp(-d / scale)
    })
  }
  return similarity
}

/**
 * Foote's novelty at each bar boundary (before bar `b`): a Gaussian-tapered
 * checkerboard of half-width `size` bars, positive where the bars on each
 * side are alike and unlike the other side.
 */
const novelty = (
  similarity: Float64Array,
  n: number,
  size: number,
): Float64Array => {
  const taper = Float64Array.from({ length: 2 * size }, (_, k) => {
    const x = (k - size + 0.5) / (size / 2)
    return Math.exp(-0.5 * x * x)
  })
  return Float64Array.from({ length: n }, (_, b) => {
    if (b < MIN_EDGE_BARS || b > n - MIN_EDGE_BARS) return 0
    let sum = 0
    let weight = 0
    for (let i = -size; i < size; i++) {
      const row = b + i
      if (row < 0 || row >= n) continue
      for (let j = -size; j < size; j++) {
        const column = b + j
        if (column < 0 || column >= n) continue
        const w = (taper[i + size] ?? 0) * (taper[j + size] ?? 0)
        const sign = i < 0 === j < 0 ? 1 : -1
        sum += sign * w * (similarity[row * n + column] ?? 0)
        weight += w
      }
    }
    return weight > 0 ? Math.max(0, sum / weight) : 0
  })
}

const scaledToMax = (values: Float64Array): Float64Array => {
  let max = 0
  values.forEach(value => {
    max = Math.max(max, value)
  })
  return max > 0 ? values.map(value => value / max) : values
}

/** dB of the mean of `pick` over bars `[from, to)`. */
const meanDb = (
  bars: ReadonlyArray<BarFeatures>,
  from: number,
  to: number,
  pick: (bar: BarFeatures) => number,
): number => {
  const slice = bars.slice(Math.max(0, from), Math.max(0, to))
  return decibels(mean(slice.map(pick)))
}

/** How much louder, in dB, the four bars from `b` are than the four before. */
const jumpAt = (bars: ReadonlyArray<BarFeatures>, b: number): number => {
  const overall =
    meanDb(bars, b, b + 4, bar => bar.power) -
    meanDb(bars, b - 4, b, bar => bar.power)
  const bass =
    meanDb(bars, b, b + 4, bar => bar.bassPower) -
    meanDb(bars, b - 4, b, bar => bar.bassPower)
  return (overall + bass) / 2
}

/**
 * Boundary bars: the highest novelty peaks, kept apart by the minimum
 * section length. A section still longer than `MAX_SECTION_BARS` is split
 * at its own strongest peak.
 */
const pickBoundaries = (
  score: Float64Array,
  n: number,
): ReadonlyArray<number> => {
  const inner = Array.from(score).slice(MIN_EDGE_BARS, n - MIN_EDGE_BARS + 1)
  const threshold = mean(inner) + 0.25 * standardDeviation(inner)
  // Sections usually start on a four-bar phrase: favor the strongest phase.
  const phaseTotals = [0, 0, 0, 0]
  score.forEach((value, b) => {
    if (value >= threshold) {
      phaseTotals[b % 4] = (phaseTotals[b % 4] ?? 0) + value
    }
  })
  const phase = phaseTotals.indexOf(Math.max(...phaseTotals))
  const peaks: Array<{ bar: number; value: number }> = []
  for (let b = MIN_EDGE_BARS; b <= n - MIN_EDGE_BARS; b++) {
    const value = score[b] ?? 0
    const isPeak = value >= (score[b - 1] ?? 0) && value >= (score[b + 1] ?? 0)
    if (isPeak && value > 0) {
      peaks.push({ bar: b, value: b % 4 === phase ? value * 1.2 : value })
    }
  }
  peaks.sort((a, b) => b.value - a.value)
  const chosen: Array<number> = []
  const fits = (bar: number) =>
    chosen.every(other => Math.abs(other - bar) >= MIN_SECTION_BARS)
  for (const { bar, value } of peaks) {
    if (value >= threshold && fits(bar)) chosen.push(bar)
  }
  for (;;) {
    const edges = [0, ...[...chosen].sort((a, b) => a - b), n]
    const split = edges.flatMap((start, i) => {
      const end = edges[i + 1] ?? n
      if (end - start <= MAX_SECTION_BARS) return []
      const best = peaks.find(
        ({ bar }) =>
          bar >= start + MIN_SECTION_BARS &&
          bar <= end - MIN_SECTION_BARS &&
          fits(bar),
      )
      return best === undefined ? [] : [best.bar]
    })
    if (split.length === 0) break
    chosen.push(...split)
  }
  return chosen.sort((a, b) => a - b)
}

/**
 * How alike two sections are when laid over each other bar for bar: the
 * mean similarity along the diagonal, sliding the shorter along the longer.
 */
const alignedSimilarity = (
  similarity: Float64Array,
  n: number,
  a: { readonly startBar: number; readonly endBar: number },
  b: { readonly startBar: number; readonly endBar: number },
): number => {
  const lengthA = a.endBar - a.startBar
  const lengthB = b.endBar - b.startBar
  const length = Math.min(lengthA, lengthB)
  if (length <= 0) return 0
  let best = 0
  const slack = Math.abs(lengthA - lengthB)
  for (let shift = 0; shift <= slack; shift++) {
    const offsetA = lengthA > lengthB ? shift : 0
    const offsetB = lengthB > lengthA ? shift : 0
    let sum = 0
    for (let k = 0; k < length; k++) {
      sum +=
        similarity[
          (a.startBar + offsetA + k) * n + (b.startBar + offsetB + k)
        ] ?? 0
    }
    best = Math.max(best, sum / length)
  }
  return best
}

/**
 * Groups sections that repeat, by average linkage: two clusters join while
 * their sections line up at least as well as `threshold`.
 */
const groupSections = (
  spans: ReadonlyArray<{ readonly startBar: number; readonly endBar: number }>,
  similarity: Float64Array,
  n: number,
  threshold: number,
): ReadonlyArray<number> => {
  const count = spans.length
  const pairs = new Float64Array(count * count)
  spans.forEach((a, i) => {
    spans.forEach((b, j) => {
      if (j > i) {
        const value = alignedSimilarity(similarity, n, a, b)
        pairs[i * count + j] = value
        pairs[j * count + i] = value
      }
    })
  })
  let clusters: Array<Array<number>> = spans.map((_, i) => [i])
  for (;;) {
    let best = -Infinity
    let bestPair: readonly [number, number] | undefined
    clusters.forEach((left, x) => {
      clusters.forEach((right, y) => {
        if (y <= x) return
        let sum = 0
        for (const i of left) {
          for (const j of right) sum += pairs[i * count + j] ?? 0
        }
        const average = sum / (left.length * right.length)
        if (average > best) {
          best = average
          bestPair = [x, y]
        }
      })
    })
    if (bestPair === undefined || best < threshold) break
    const [x, y] = bestPair
    clusters = clusters.flatMap((cluster, index) =>
      index === x
        ? [[...cluster, ...(clusters[y] ?? [])]]
        : index === y
          ? []
          : [cluster],
    )
  }
  // Number groups in order of first appearance.
  const groupOf = new Array<number>(count).fill(0)
  const ordered = clusters
    .map(cluster => [...cluster].sort((a, b) => a - b))
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
  ordered.forEach((cluster, group) => {
    for (const i of cluster) groupOf[i] = group
  })
  return groupOf
}

interface SectionStats {
  readonly startBar: number
  readonly endBar: number
  readonly group: number
  readonly energy: number
  /** dB jump into the section, 0 for the first. */
  readonly jump: number
}

/** Kinds from loudness, repetition, and position. */
const labelSections = (
  sections: ReadonlyArray<SectionStats>,
  totalBars: number,
): ReadonlyArray<Tv.TvSectionKind> => {
  const count = sections.length
  const kinds: Array<Tv.TvSectionKind> = sections.map(() => 'Verse')
  if (count === 0) return kinds
  const groupCount = new Map<number, number>()
  const groupEnergy = new Map<number, number>()
  sections.forEach(section => {
    groupCount.set(section.group, (groupCount.get(section.group) ?? 0) + 1)
    groupEnergy.set(
      section.group,
      (groupEnergy.get(section.group) ?? 0) + section.energy,
    )
  })
  const repeats = (section: SectionStats) =>
    (groupCount.get(section.group) ?? 0) >= 2

  // The chorus: the group that repeats most and loudest.
  let chorusGroup = -1
  let chorusScore = 0
  groupCount.forEach((times, group) => {
    const energy = (groupEnergy.get(group) ?? 0) / times
    const score = times * energy * energy
    if (times >= 2 && energy >= 0.5 && score > chorusScore) {
      chorusScore = score
      chorusGroup = group
    }
  })

  const isDropStart = (section: SectionStats, index: number) =>
    index > 0 &&
    section.jump >= DROP_JUMP_DB &&
    section.energy >= 0.7 &&
    section.energy > (sections[index - 1]?.energy ?? 1)

  const chorusSections = sections.flatMap((section, index) =>
    section.group === chorusGroup ? [index] : [],
  )
  const chorusDrops = chorusSections.filter(index => {
    const section = sections[index]
    return section !== undefined && isDropStart(section, index)
  })
  // A chorus that keeps landing after a build-up is a drop (EDM's chorus).
  const chorusKind: Tv.TvSectionKind =
    chorusDrops.length >= 2 &&
    chorusDrops.length * 3 >= chorusSections.length * 2
      ? 'Drop'
      : 'Chorus'

  sections.forEach((section, index) => {
    if (section.group === chorusGroup) {
      kinds[index] = chorusKind
    } else if (isDropStart(section, index)) {
      kinds[index] = 'Drop'
    }
  })

  // A quiet stretch in the middle, after the song has been loud, that is
  // not a verse coming back.
  let loudestSoFar = 0
  const heard = new Set<number>()
  sections.forEach((section, index) => {
    if (
      index > 0 &&
      index < count - 1 &&
      kinds[index] === 'Verse' &&
      section.energy <= 0.6 &&
      loudestSoFar >= 0.8 &&
      !heard.has(section.group)
    ) {
      kinds[index] = 'Breakdown'
    }
    loudestSoFar = Math.max(loudestSoFar, section.energy)
    heard.add(section.group)
  })

  // A one-off section late in the song.
  const bridge = sections.findIndex(
    (section, index) =>
      index > 0 &&
      index < count - 1 &&
      kinds[index] === 'Verse' &&
      !repeats(section) &&
      section.startBar >= totalBars / 2,
  )
  if (bridge >= 0) kinds[bridge] = 'Bridge'

  const first = sections[0]
  if (
    first !== undefined &&
    count >= 2 &&
    (first.energy < 0.6 || (kinds[0] === 'Verse' && !repeats(first)))
  ) {
    kinds[0] = 'Intro'
  }
  const last = sections[count - 1]
  if (
    last !== undefined &&
    count >= 3 &&
    (last.energy < 0.6 || (kinds[count - 1] === 'Verse' && !repeats(last)))
  ) {
    kinds[count - 1] = 'Outro'
  }
  return kinds
}

/**
 * The sections and drops of a song whose bars are known. `onset` is the
 * onset envelope (for how busy each bar is) and `bass` the mel bands that
 * carry the bass.
 */
export const analyzeStructure = (
  spec: Spectrogram,
  bars: ReadonlyArray<Bar>,
  onset: Float32Array,
  bass: { readonly from: number; readonly to: number },
): Structure => {
  const n = bars.length
  if (n < 2 * MIN_SECTION_BARS) {
    return {
      sections: [
        { startBar: 0, endBar: n, kind: 'Verse', group: 0, energy: 1 },
      ],
      dropBars: [],
    }
  }
  const features = bars.map(bar => barFeatures(spec, bar, onset, bass))
  const similarity = similarityMatrix(features)

  const combined = new Float64Array(n)
  for (const size of KERNEL_SIZES) {
    const scaled = scaledToMax(novelty(similarity, n, size))
    scaled.forEach((value, b) => {
      combined[b] = (combined[b] ?? 0) + (0.75 * value) / KERNEL_SIZES.length
    })
  }
  const jumps = scaledToMax(
    Float64Array.from({ length: n }, (_, b) =>
      b < MIN_EDGE_BARS || b > n - MIN_EDGE_BARS
        ? 0
        : Math.abs(jumpAt(features, b)),
    ),
  )
  jumps.forEach((value, b) => {
    combined[b] = (combined[b] ?? 0) + 0.25 * value
  })

  const boundaries = pickBoundaries(combined, n)
  const starts = [0, ...boundaries]
  const spans = starts.map((startBar, i) => ({
    startBar,
    endBar: starts[i + 1] ?? n,
  }))

  const offDiagonal: Array<number> = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) offDiagonal.push(similarity[i * n + j] ?? 0)
  }
  const threshold = quantile(offDiagonal, GROUP_QUANTILE)
  const groups = groupSections(spans, similarity, n, threshold)

  const sections = spans.map((span, i) => ({ ...span, group: groups[i] ?? 0 }))
  const loudness = sections.map(section =>
    meanDb(features, section.startBar, section.endBar, bar => bar.power),
  )
  const busy = sections.map(section =>
    mean(features.slice(section.startBar, section.endBar).map(bar => bar.busy)),
  )
  const loudest = Math.max(...loudness)
  const busiest = Math.max(...busy, 1e-9)
  const raw = sections.map(
    (_, i) =>
      0.75 *
        Math.min(
          1,
          Math.max(0, 1 + ((loudness[i] ?? 0) - loudest) / ENERGY_RANGE_DB),
        ) +
      0.25 * ((busy[i] ?? 0) / busiest),
  )
  const top = Math.max(...raw, 1e-9)
  const stats: ReadonlyArray<SectionStats> = sections.map((section, i) => ({
    startBar: section.startBar,
    endBar: section.endBar,
    group: section.group,
    energy: (raw[i] ?? 0) / top,
    jump: i === 0 ? 0 : jumpAt(features, section.startBar),
  }))

  const kinds = labelSections(stats, n)
  const dropBars = stats
    .filter(
      (section, i) =>
        i > 0 &&
        section.jump >= DROP_JUMP_DB &&
        section.energy >= 0.7 &&
        section.energy > (stats[i - 1]?.energy ?? 1),
    )
    .sort((a, b) => b.jump - a.jump)
    .slice(0, MAX_DROPS)
    .map(section => section.startBar)
    .sort((a, b) => a - b)

  return {
    sections: stats.map((section, i) => ({
      startBar: section.startBar,
      endBar: section.endBar,
      kind: kinds[i] ?? 'Verse',
      group: section.group,
      energy: section.energy,
    })),
    dropBars,
  }
}
