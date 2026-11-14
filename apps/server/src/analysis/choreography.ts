import type { Tv } from '@music/shared'

/*
 * The song planned as a VJ would cue it, from what the rest of the analysis
 * found: where it builds and exactly where each build lands, where it holds
 * its breath, its climax, the bars where hard strobing fits, and how the
 * scene should change at each section's start. Knowing the whole song ahead
 * lets the TV anticipate a moment (push in through the build, go dark the
 * half beat before, hit on the frame) instead of reacting after it.
 *
 * Pure: it reads only the analysis's own fields, so it can be planned again
 * for any cached analysis.
 */

/** What the plan reads from the analysis. */
export type ChoreographyInput = Pick<
  Tv.TvAnalysis,
  | 'durationSeconds'
  | 'tempo'
  | 'beats'
  | 'downbeats'
  | 'sections'
  | 'drops'
  | 'drive'
  | 'keys'
  | 'stops'
  | 'risers'
  | 'fills'
>

const round3 = (value: number): number => Math.round(value * 1000) / 1000

/** Two moments this close (seconds) are the same moment. */
const SAME = 0.2
/** A drop's build when no riser leads into it, in bars. */
const DROP_BUILD_BARS = 4
/** A lift into a louder section without a riser, in bars. */
const LIFT_BUILD_BARS = 2
/** A section this much louder than the one before lands as a lift. */
const LIFT_JUMP = 0.25
/** The shortest build worth playing, in bars. */
const SHORTEST_BUILD_BARS = 1
/** Bars of strobing after a drop lands, and after the climax lands. */
const DROP_STROBE_BARS = 4
const CLIMAX_STROBE_BARS = 8
/** The longest run of strobing, in seconds, however slow the song. */
const LONGEST_STROBE_SECONDS = 16
/**
 * How driving a song must be (`drive`) for any strobing: a ballad's loudest
 * chorus never strobes.
 */
const STROBE_DRIVE = 0.45
/** The quietest a section may be and still strobe or be the climax. */
const STROBE_ENERGY = 0.75
const CLIMAX_ENERGY = 0.55
/** The shortest stop that is a breath (shorter ones are a hiccup). */
const BREATH_SECONDS = 0.25

/** How long each kind of change takes, in beats. */
const TRANSITION_BEATS: Record<Tv.TvTransitionKind, number> = {
  Cut: 0,
  Shatter: 2,
  ZoomThrough: 2,
  Datamosh: 4,
  Melt: 4,
  Wipe: 4,
}
/** A calm section's wipe takes twice as long. */
const SLOW_WIPE_BEATS = 8

/** The downbeat nearest `seconds`, if one is within `SAME`. */
const nearestDownbeat = (
  downbeats: ReadonlyArray<number>,
  seconds: number,
): number | undefined => {
  let best: number | undefined
  for (const downbeat of downbeats) {
    if (
      Math.abs(downbeat - seconds) < SAME &&
      (best === undefined ||
        Math.abs(downbeat - seconds) < Math.abs(best - seconds))
    )
      best = downbeat
  }
  return best
}

/** The first downbeat at or after `seconds` (or `seconds` itself). */
const downbeatFrom = (
  downbeats: ReadonlyArray<number>,
  seconds: number,
): number => downbeats.find(downbeat => downbeat >= seconds - 0.05) ?? seconds

/** Seconds a bar lasts: the downbeats' median gap, or the tempo's bar. */
const barSecondsOf = (input: ChoreographyInput): number => {
  const gaps = input.downbeats
    .slice(1)
    .map((downbeat, i) => downbeat - (input.downbeats[i] ?? 0))
    .filter(gap => gap > 0)
    .sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)] ?? 240 / Math.max(1, input.tempo)
}

const isNear = (times: ReadonlyArray<number>, seconds: number): boolean =>
  times.some(time => Math.abs(time - seconds) < SAME)

/**
 * The build-ups and where each lands: every drop (a full-strength landing,
 * built over its riser or the four bars before it), and every section that
 * starts after a riser or comes in much louder than the one before (a
 * lift, built over its riser or two bars). Builds never overlap: one starts
 * a bar after the landing before it, at the earliest.
 */
export const findBuilds = (
  input: ChoreographyInput,
): ReadonlyArray<Tv.TvBuild> => {
  const bar = barSecondsOf(input)
  const landings: Array<{ land: number; strength: number; bars: number }> = []
  for (const drop of input.drops) {
    landings.push({ land: drop, strength: 1, bars: DROP_BUILD_BARS })
  }
  input.sections.forEach((section, i) => {
    if (i === 0 || isNear(input.drops, section.startSeconds)) return
    const before = input.sections[i - 1]?.energy ?? section.energy
    const jump = section.energy - before
    const risen = isNear(
      input.risers.map(riser => riser.endSeconds),
      section.startSeconds,
    )
    // A riser into a quieter section is no build: what it climbs into is
    // smaller than what it leaves.
    if (risen ? jump < -0.1 : jump < LIFT_JUMP) return
    landings.push({
      land: section.startSeconds,
      strength: round3(
        Math.min(0.85, 0.35 + 0.4 * section.energy + Math.max(0, jump)),
      ),
      bars: LIFT_BUILD_BARS,
    })
  })
  landings.sort((a, b) => a.land - b.land)

  const builds: Array<Tv.TvBuild> = []
  let earliest = 0
  for (const { land, strength, bars } of landings) {
    const exact = nearestDownbeat(input.downbeats, land) ?? land
    const riser = input.risers.find(
      span => Math.abs(span.endSeconds - land) < SAME,
    )
    const wanted = riser?.startSeconds ?? exact - bars * bar
    const start = downbeatFrom(input.downbeats, Math.max(wanted, earliest, 0))
    if (exact - start >= SHORTEST_BUILD_BARS * bar - SAME) {
      builds.push({
        startSeconds: round3(start),
        landSeconds: round3(exact),
        strength,
      })
    }
    earliest = Math.max(earliest, exact + bar)
  }
  return builds
}

/**
 * The song's biggest stretch: the loudest section, favoring a drop, a
 * chorus, one late in the song, one that came before (its last time is
 * the big one), one that starts with a landing, and one where the key
 * moves up (a last chorus a step higher). None when no section is loud
 * enough to stand out.
 */
export const findClimax = (
  input: ChoreographyInput,
  builds: ReadonlyArray<Tv.TvBuild>,
): Tv.TvClimax | null => {
  const duration = Math.max(1, input.durationSeconds)
  const bar = barSecondsOf(input)
  let best: { score: number; index: number } | undefined
  input.sections.forEach((section, i) => {
    if (section.kind === 'Intro' || section.kind === 'Outro') return
    if (section.energy < CLIMAX_ENERGY) return
    if (section.endSeconds - section.startSeconds < 4 * bar - SAME) return
    const repeats = input.sections
      .slice(0, i)
      .filter(before => before.group === section.group).length
    const landing = builds.find(
      build =>
        build.landSeconds >= section.startSeconds - SAME &&
        build.landSeconds < section.startSeconds + 2 * bar,
    )
    const keyUp = input.keys.some(
      (key, k) =>
        k > 0 &&
        Math.abs(key.startSeconds - section.startSeconds) < 2 * bar &&
        (key.tonic - (input.keys[k - 1]?.tonic ?? key.tonic) + 12) % 12 <= 3 &&
        key.tonic !== input.keys[k - 1]?.tonic,
    )
    // Loudness counts most; the rest tips the balance between sections
    // nearly as loud.
    const score =
      1.5 * section.energy +
      (section.kind === 'Drop' ? 0.2 : section.kind === 'Chorus' ? 0.12 : 0) +
      0.15 * (section.startSeconds / duration) +
      0.05 * Math.min(3, repeats) +
      0.15 * (landing?.strength ?? 0) +
      (keyUp ? 0.15 : 0)
    if (best === undefined || score > best.score) best = { score, index: i }
  })
  if (best === undefined) return null
  const section = input.sections[best.index]
  if (section === undefined) return null
  const land =
    input.drops.find(
      drop => drop >= section.startSeconds - SAME && drop < section.endSeconds,
    ) ?? section.startSeconds
  return {
    startSeconds: round3(section.startSeconds),
    endSeconds: round3(section.endSeconds),
    landSeconds: round3(land),
  }
}

/**
 * The bars where hard strobing fits: the first bars of each loud drop and
 * of the climax, in a driving song only, at most `LONGEST_STROBE_SECONDS`
 * each. Spans from downbeat to downbeat (or the cap), merged where they
 * meet.
 */
export const findStrobes = (
  input: ChoreographyInput,
  climax: Tv.TvClimax | null,
): ReadonlyArray<Tv.TvSpan> => {
  if (input.drive < STROBE_DRIVE) return []
  const bar = barSecondsOf(input)
  const sectionAt = (seconds: number) =>
    input.sections.find(
      section =>
        section.startSeconds - SAME <= seconds && seconds < section.endSeconds,
    )
  const runs: Array<{ from: number; bars: number; until: number }> = []
  for (const drop of input.drops) {
    const section = sectionAt(drop)
    if (section === undefined || section.energy < STROBE_ENERGY) continue
    runs.push({ from: drop, bars: DROP_STROBE_BARS, until: section.endSeconds })
  }
  if (climax !== null) {
    runs.push({
      from: climax.landSeconds,
      bars: CLIMAX_STROBE_BARS,
      until: climax.endSeconds,
    })
  }
  const spans = runs
    .map(({ from, bars, until }) => {
      const start = nearestDownbeat(input.downbeats, from) ?? from
      const downbeats = input.downbeats.filter(
        downbeat => downbeat > start + SAME && downbeat <= until + SAME,
      )
      const end = Math.min(
        downbeats[bars - 1] ?? start + bars * bar,
        until,
        start + LONGEST_STROBE_SECONDS,
      )
      return { startSeconds: round3(start), endSeconds: round3(end) }
    })
    .filter(span => span.endSeconds - span.startSeconds > bar / 2)
    .sort((a, b) => a.startSeconds - b.startSeconds)
  const merged: Array<Tv.TvSpan> = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.startSeconds <= last.endSeconds + SAME) {
      merged[merged.length - 1] = {
        startSeconds: last.startSeconds,
        endSeconds: Math.max(last.endSeconds, span.endSeconds),
      }
    } else {
      merged.push(span)
    }
  }
  return merged
}

/**
 * How the scene changes at each section's start but the first: a drop
 * (and the climax) shatters the old picture on its beat, a riser's end
 * rushes through it, a chorus coming back datamoshes into its old scene,
 * a section falling quieter melts away, a calm one wipes slowly, and the
 * rest wipe.
 */
export const findTransitions = (
  input: ChoreographyInput,
  climax: Tv.TvClimax | null,
): ReadonlyArray<Tv.TvTransition> =>
  input.sections.flatMap((section, i) => {
    if (i === 0) return []
    const at = section.startSeconds
    const before = input.sections[i - 1]
    const jump = section.energy - (before?.energy ?? section.energy)
    const returning =
      section.kind === 'Chorus' &&
      input.sections
        .slice(0, i)
        .some(earlier => earlier.group === section.group)
    const risen = isNear(
      input.risers.map(riser => riser.endSeconds),
      at,
    )
    const climaxLands =
      climax !== null && Math.abs(climax.landSeconds - at) < SAME
    const calm = section.energy < 0.5 && (before?.energy ?? 0) < 0.5
    const kind: Tv.TvTransitionKind =
      isNear(input.drops, at) || climaxLands
        ? 'Shatter'
        : risen || jump >= LIFT_JUMP
          ? 'ZoomThrough'
          : returning
            ? 'Datamosh'
            : jump <= -0.2
              ? 'Melt'
              : 'Wipe'
    const beats =
      kind === 'Wipe' && calm ? SLOW_WIPE_BEATS : TRANSITION_BEATS[kind]
    return [{ atSeconds: round3(at), kind, beats }]
  })

/** The song's choreography, planned from the rest of its analysis. */
export const planChoreography = (
  input: ChoreographyInput,
): Tv.TvChoreography => {
  const builds = findBuilds(input)
  const climax = findClimax(input, builds)
  return {
    climax,
    builds,
    breaths: input.stops.filter(
      stop => stop.endSeconds - stop.startSeconds >= BREATH_SECONDS,
    ),
    strobes: findStrobes(input, climax),
    transitions: findTransitions(input, climax),
  }
}
