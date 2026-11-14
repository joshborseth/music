import { Option } from 'effect'

/*
 * When a song counts as played: once it has really played for 30 seconds,
 * or for half of it when it is shorter, as Spotify counts. The time comes
 * from the player's position reports (`Progress`), whichever device plays,
 * so flicking through a queue, or seeking to the end, counts nothing.
 */

/** A song has played once it played this long. */
export const PLAY_SECONDS = 30

/**
 * How much further a report may be than the wall clock allows, for reports
 * that arrive unevenly (a busy phone, a slow network). A step past that is
 * a seek, and is not heard.
 */
export const STEP_SLACK_SECONDS = 2

/**
 * The longest step one report may add. Players report every second; a
 * longer silence (a reload, a lost connection) is not taken as heard, even
 * when the session's clock moved on as far.
 */
export const MAX_STEP_SECONDS = 10

/** How long a song must play before it counts as played. */
export const playThreshold = (durationSeconds: number | null): number =>
  durationSeconds !== null && durationSeconds > 0
    ? Math.min(PLAY_SECONDS, durationSeconds / 2)
    : PLAY_SECONDS

/** How much of the current entry the player has played. */
export interface Listening {
  readonly entryId: string
  readonly heardSeconds: number
  /** The last report's position and when it came (epoch ms). */
  readonly maybeLast: Option.Option<{
    readonly positionSeconds: number
    readonly at: number
  }>
  readonly isCounted: boolean
}

/** A position report from the player, for the current entry. */
export interface HeardReport {
  readonly entryId: string
  readonly positionSeconds: number
  readonly playing: boolean
  readonly durationSeconds: number | null
  readonly at: number
}

const fresh = (entryId: string): Listening => ({
  entryId,
  heardSeconds: 0,
  maybeLast: Option.none(),
  isCounted: false,
})

/**
 * Add a report's time to what was heard of its entry, and say whether the
 * entry has just become a play. Each entry counts once. A report for another
 * entry starts over. Only forward steps no longer than the time between
 * reports count, and none past `MAX_STEP_SECONDS`: a seek or skip jumps
 * further than the clock moved. The first report of an entry counts the
 * time from its start when it is near the start.
 */
export const hear = (
  maybeListening: Option.Option<Listening>,
  report: HeardReport,
): { readonly listening: Listening; readonly isNewPlay: boolean } => {
  const listening = Option.getOrElse(
    Option.filter(maybeListening, ({ entryId }) => entryId === report.entryId),
    () => fresh(report.entryId),
  )
  const step = Option.match(listening.maybeLast, {
    onNone: () =>
      report.positionSeconds <= STEP_SLACK_SECONDS + 1
        ? report.positionSeconds
        : 0,
    onSome: last => {
      const moved = report.positionSeconds - last.positionSeconds
      const elapsed = Math.max(0, report.at - last.at) / 1000
      return moved > 0 &&
        moved <= elapsed + STEP_SLACK_SECONDS &&
        moved <= MAX_STEP_SECONDS
        ? moved
        : 0
    },
  })
  const heardSeconds =
    listening.heardSeconds + (report.playing ? Math.max(0, step) : 0)
  const isNewPlay =
    !listening.isCounted &&
    heardSeconds >= playThreshold(report.durationSeconds)
  return {
    listening: {
      entryId: report.entryId,
      heardSeconds,
      maybeLast: Option.some({
        positionSeconds: report.positionSeconds,
        at: report.at,
      }),
      isCounted: listening.isCounted || isNewPlay,
    },
    isNewPlay,
  }
}
