import { Cause, Effect, Option, Queue, Schema, Scope } from 'effect'

/*
 * What the services that work songs out ahead share (the analysis, cover
 * depths, montages): a queue of keys one background fiber
 * works through, a memory of recent failures, so a key that just failed is
 * not tried again at once, and a guard for their SQLite caches, which
 * throw. The queue and the memory are bounded, so a server that runs for
 * months never grows them without end.
 */

/** Keys waiting for the background fiber, each at most once. */
export interface BackgroundQueue {
  /** Queue `key`, unless it is waiting already; past capacity the oldest goes. */
  readonly offer: (key: string) => Effect.Effect<void>
  readonly has: (key: string) => boolean
  readonly size: () => number
}

/**
 * Starts one fiber, in the current scope, that runs `work` on each key
 * offered, oldest first. A failure or a defect in one key's work is logged
 * and the fiber goes on to the next, so background work never stops
 * because of one bad song.
 */
export const makeBackgroundQueue = Effect.fnUntraced(function* <E>(options: {
  /** Names the work in the log. */
  readonly name: string
  /** Keys kept waiting at most: past it, the one waiting longest is dropped. */
  readonly capacity: number
  readonly work: (key: string) => Effect.Effect<unknown, E>
}) {
  const scope = yield* Scope.Scope
  // A Set keeps insertion order: its first key is the one waiting longest.
  const queued = new Set<string>()
  const wake = yield* Queue.sliding<void>(1)

  const next = Effect.gen(function* () {
    const first = queued.values().next()
    if (first.done === true) {
      yield* Queue.take(wake)
      return
    }
    const key = first.value
    queued.delete(key)
    yield* options
      .work(key)
      .pipe(
        Effect.catchCause(cause =>
          Effect.logError(
            `${options.name}: background work failed`,
            key,
            Cause.pretty(cause),
          ),
        ),
      )
  })
  yield* Effect.forkIn(Effect.forever(next), scope)

  return {
    offer: (key: string) =>
      Effect.suspend(() => {
        if (queued.has(key)) return Effect.void
        while (queued.size >= options.capacity) {
          const oldest = queued.values().next()
          if (oldest.done === true) break
          queued.delete(oldest.value)
        }
        queued.add(key)
        return Effect.asVoid(Queue.offer(wake, undefined))
      }),
    has: (key: string) => queued.has(key),
    size: () => queued.size,
  } satisfies BackgroundQueue
})

/** The failures of the last while, by key. */
export interface FailureMemory<E> {
  /** The key's failure, while it is recent enough to not try again. */
  readonly recent: (key: string) => Option.Option<E>
  /** Remember the key's failure, forgetting expired ones and, past capacity, the oldest. */
  readonly remember: (key: string, error: E) => void
  readonly size: () => number
}

export const makeFailureMemory = <E>(options: {
  /** How long after `error` the key may be tried again. */
  readonly retryMs: (error: E) => number
  readonly now: () => number
  readonly capacity: number
}): FailureMemory<E> => {
  const entries = new Map<string, { readonly at: number; readonly error: E }>()
  const isExpired = (entry: { readonly at: number; readonly error: E }) =>
    options.now() - entry.at >= options.retryMs(entry.error)

  return {
    recent: key => {
      const entry = entries.get(key)
      if (entry === undefined) return Option.none()
      if (!isExpired(entry)) return Option.some(entry.error)
      entries.delete(key)
      return Option.none()
    },
    remember: (key, error) => {
      entries.delete(key)
      for (const [other, entry] of entries)
        if (isExpired(entry)) entries.delete(other)
      // A Map keeps insertion order: its first entry is the oldest.
      while (entries.size >= options.capacity) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
      entries.set(key, { at: options.now(), error })
    },
    size: () => entries.size,
  }
}

export class CacheError extends Schema.TaggedError<CacheError>()('CacheError', {
  message: Schema.String,
}) {}

/**
 * A call to a cache that may throw, as SQLite does when its disk is full or
 * its file is locked: a throw is logged with `what` and `key`, and answered
 * with `fallback`, so a broken cache costs work, never an answer or a
 * worker.
 */
export const tryCache = <A>(
  what: string,
  key: string,
  call: () => A,
  fallback: () => A,
): Effect.Effect<A> =>
  Effect.try({
    try: call,
    catch: error => new CacheError({ message: String(error) }),
  }).pipe(
    Effect.catch(error =>
      Effect.as(Effect.logWarning(what, key, error.message), fallback()),
    ),
  )
