import {
  Array,
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
} from 'effect'

import { SongAnalysis } from './analysis/service.ts'
import { AudioSource } from './audio.ts'
import { AudioStore } from './audioStore.ts'
import { CoverDepth } from './depth/service.ts'
import { SongMontage } from './montage/service.ts'

/*
 * Gets songs ready before anyone presses Play. The session, the page being
 * browsed, and the end of the queue each hand over a plan: songs to download
 * whole, and songs to only find a link for (the slow part, so they start
 * in about a second). A new plan from a source replaces its old one.
 *
 * Two workers take the most urgent job first. A song someone is waiting on
 * never queues behind this: players call `AudioStore` directly, and these
 * workers hold at most two of yt-dlp's three slots. Every yt-dlp run here
 * counts against a daily limit, and a run of failures (YouTube pushing
 * back) pauses prefetching for a while.
 *
 * A song downloaded whole is also queued for analysis (its beats and
 * sections, for the TV's visuals), which runs in the background. A song
 * the queue will play soon has its cover's depth worked out too, for the
 * TV's Diorama, whether or not its audio comes.
 * The queue's next few songs also get their montage made (the music
 * video's key frames, for the visuals), one at a time, after their audio.
 */

export type PlanSource = 'Queue' | 'Page'

export interface PrefetchJob {
  readonly videoId: string
  /** `Download` saves the whole song; `Resolve` only finds its link. */
  readonly kind: 'Download' | 'Resolve'
  /** Lower runs first. */
  readonly priority: number
  /** The song's cover, when its depth should be ready before it plays. */
  readonly artworkUrl?: string | undefined
  /**
   * Make the song's montage early too. Only a TV shows one, so the session
   * asks for it only while a TV is on (`tvWatching` in `session/hub.ts`).
   */
  readonly montage?: boolean | undefined
}

export class Prefetcher extends Context.Service<
  Prefetcher,
  {
    readonly plan: (
      source: PlanSource,
      jobs: ReadonlyArray<PrefetchJob>,
    ) => Effect.Effect<void>
  }
>()('music/Prefetcher') {}

const WORKERS = 2
/** The queue's songs, from the one playing, that get a montage made early. */
const QUEUE_MONTAGES = 3
/** yt-dlp runs prefetching may spend in a day, leaving room for real plays. */
const DAILY_YT_DLP_RUNS = 400
const DAY_MS = 24 * 60 * 60 * 1000
const FAILURES_BEFORE_PAUSE = 3
const PAUSE = Duration.minutes(15)

/** Page songs: the first `downloads` saved whole, the rest only resolved. */
export const pageJobs = (
  videoIds: ReadonlyArray<string>,
  downloads: number,
  resolves: number,
): ReadonlyArray<PrefetchJob> =>
  Array.map(Array.take(videoIds, downloads + resolves), (videoId, index) =>
    index < downloads
      ? { videoId, kind: 'Download', priority: 1.5 + index }
      : { videoId, kind: 'Resolve', priority: 10 + index },
  )

/**
 * Take the most urgent job out of the plans, skipping songs a worker is
 * already on. Earlier sources win ties.
 */
export const takeNextJob = (
  plans: Map<PlanSource, Array<PrefetchJob>>,
  running: ReadonlySet<string>,
): Option.Option<PrefetchJob> => {
  let best: { source: PlanSource; index: number; job: PrefetchJob } | undefined
  for (const [source, jobs] of plans) {
    jobs.forEach((job, index) => {
      if (running.has(job.videoId)) return
      if (best === undefined || job.priority < best.job.priority) {
        best = { source, index, job }
      }
    })
  }
  if (best === undefined) return Option.none()
  plans.get(best.source)?.splice(best.index, 1)
  return Option.some(best.job)
}

export const PrefetcherLive = Layer.effect(Prefetcher)(
  Effect.gen(function* () {
    const store = yield* AudioStore
    const audioSource = yield* AudioSource
    const analysis = yield* SongAnalysis
    const coverDepth = yield* CoverDepth
    const songMontage = yield* SongMontage
    const plans = new Map<PlanSource, Array<PrefetchJob>>()
    /** The songs up next in the queue whose montage is made early. */
    let montageSongs: ReadonlySet<string> = new Set()
    const running = new Set<string>()
    const wake = yield* Queue.sliding<void>(WORKERS)
    let runs: Array<number> = []
    let failuresInARow = 0
    let pausedUntil = 0
    let isOverBudgetLogged = false

    /** Whether prefetching may run yt-dlp now; counts the run if so. */
    const spendRun = Effect.gen(function* () {
      const now = Date.now()
      if (now < pausedUntil) return false
      runs = runs.filter(at => now - at < DAY_MS)
      if (runs.length >= DAILY_YT_DLP_RUNS) {
        if (!isOverBudgetLogged) {
          isOverBudgetLogged = true
          yield* Effect.logWarning(
            `Prefetching paused: ${DAILY_YT_DLP_RUNS} yt-dlp runs in the last day`,
          )
        }
        return false
      }
      isOverBudgetLogged = false
      runs.push(now)
      return true
    })

    const noteResult = (isSuccess: boolean) =>
      Effect.gen(function* () {
        if (isSuccess) {
          failuresInARow = 0
          return
        }
        failuresInARow += 1
        if (failuresInARow >= FAILURES_BEFORE_PAUSE) {
          failuresInARow = 0
          pausedUntil = Date.now() + Duration.toMillis(PAUSE)
          yield* Effect.logWarning(
            'Prefetching paused for 15 minutes after repeated yt-dlp failures',
          )
        }
      })

    const analyze = (job: PrefetchJob) =>
      job.kind === 'Download'
        ? Effect.andThen(
            analysis.warm(job.videoId),
            montageSongs.has(job.videoId)
              ? songMontage.warm(job.videoId)
              : Effect.void,
          )
        : Effect.void

    const run = (job: PrefetchJob) =>
      Effect.gen(function* () {
        if (job.kind === 'Download' && job.artworkUrl !== undefined) {
          yield* coverDepth.warm(job.artworkUrl)
        }
        if (yield* store.isStored(job.videoId)) {
          yield* analyze(job)
          return
        }
        const needsYtDlp = !(yield* audioSource.isResolved(job.videoId))
        if (needsYtDlp && !(yield* spendRun)) return
        const exit = yield* Effect.exit(
          job.kind === 'Download'
            ? store.ensure(job.videoId)
            : Effect.asVoid(audioSource.resolve(job.videoId)),
        )
        if (needsYtDlp) yield* noteResult(Exit.isSuccess(exit))
        if (Exit.isSuccess(exit)) yield* analyze(job)
      }).pipe(
        Effect.ensuring(
          Effect.andThen(
            Effect.sync(() => running.delete(job.videoId)),
            // A job left waiting on this song can go now.
            Queue.offer(wake, undefined),
          ),
        ),
        Effect.withSpan('Prefetcher.run', {
          attributes: { videoId: job.videoId, kind: job.kind },
        }),
      )

    const worker = Effect.gen(function* () {
      const maybeJob = takeNextJob(plans, running)
      if (Option.isNone(maybeJob)) {
        yield* Queue.take(wake)
        return
      }
      running.add(maybeJob.value.videoId)
      const job = maybeJob.value
      // One job's bug is logged; the worker goes on to the next.
      yield* run(job).pipe(
        Effect.catchCause(cause =>
          Effect.logError(
            'Prefetching a song failed',
            job.videoId,
            Cause.pretty(cause),
          ),
        ),
      )
    }).pipe(Effect.forever)

    yield* Effect.forEach(
      Array.range(1, WORKERS),
      () => Effect.forkScoped(worker),
      { discard: true },
    )

    return Prefetcher.of({
      plan: (source, jobs) =>
        Effect.andThen(
          Effect.sync(() => {
            plans.set(source, [...jobs])
            if (source === 'Queue') {
              montageSongs = new Set(
                Array.take(
                  Array.filter(
                    jobs,
                    job => job.kind === 'Download' && job.montage === true,
                  ),
                  QUEUE_MONTAGES,
                ).map(job => job.videoId),
              )
            }
          }),
          Effect.forEach(
            Array.range(1, WORKERS),
            () => Queue.offer(wake, undefined),
            { discard: true },
          ),
        ),
    })
  }),
)
