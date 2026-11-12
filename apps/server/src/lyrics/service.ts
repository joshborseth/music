import { Database } from 'bun:sqlite'
import {
  Array,
  Config,
  Context,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Scope,
} from 'effect'

import { LyricLine, type Song, type SongDetails } from '@music/shared'

import {
  type LrclibError,
  type LyricsQuery,
  fetchTimedLines,
  queryOf,
} from './lrclib.ts'

/*
 * Timed lyrics for the player, from LRCLIB, kept in a SQLite file so each
 * song is looked up once. A song LRCLIB had nothing for is asked again after
 * a week, since its database keeps growing. A failed lookup is not kept.
 */

/** Shown as where the lyrics came from. */
export const TIMED_LYRICS_SOURCE = 'LRCLIB'

/** How long a song page waits for a lookup before showing plain lyrics. */
const PAGE_WAIT = Duration.seconds(4)

/** A lookup that takes longer than this has failed. */
const LOOKUP_TIMEOUT = Duration.seconds(20)

const MISS_RETRY_MS = 7 * 24 * 60 * 60 * 1000

const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE timed_lyrics (
    video_id TEXT PRIMARY KEY,
    lines TEXT,
    fetched_at INTEGER NOT NULL
  ) STRICT;
  `,
]

const LinesJson = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Array(LyricLine)),
)
const encodeLines = Schema.encodeSync(LinesJson)
const decodeLines = Schema.decodeUnknownOption(LinesJson)

const CacheRow = Schema.Struct({
  lines: Schema.NullOr(Schema.String),
  fetched_at: Schema.Number,
})
const decodeCacheRow = Schema.decodeUnknownOption(CacheRow)

const VersionRow = Schema.Struct({ user_version: Schema.Number })
const decodeVersionRow = Schema.decodeUnknownOption(VersionRow)

type Lines = ReadonlyArray<LyricLine>

/** What the cache knows about a song: timed lines, none, or nothing yet. */
type Cached = Option.Option<Option.Option<Lines>>

export interface LyricsCache {
  readonly get: (videoId: string, now: number) => Cached
  readonly put: (
    videoId: string,
    maybeLines: Option.Option<Lines>,
    now: number,
  ) => void
}

export const makeLyricsCache = (db: Database): LyricsCache => {
  db.run('PRAGMA journal_mode = WAL')
  const version = Option.match(
    decodeVersionRow(db.query('PRAGMA user_version').get()),
    { onNone: () => 0, onSome: row => row.user_version },
  )
  db.transaction(() => {
    Array.forEach(MIGRATIONS.slice(version), step => db.run(step))
    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`)
  })()

  const select = db.query(
    'SELECT lines, fetched_at FROM timed_lyrics WHERE video_id = ?',
  )
  const upsert = db.query(
    `INSERT INTO timed_lyrics (video_id, lines, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT (video_id) DO UPDATE SET
       lines = excluded.lines, fetched_at = excluded.fetched_at`,
  )

  return {
    get: (videoId, now) =>
      Option.flatMap(decodeCacheRow(select.get(videoId)), row =>
        row.lines === null
          ? now - row.fetched_at < MISS_RETRY_MS
            ? Option.some(Option.none())
            : Option.none()
          : Option.map(decodeLines(row.lines), Option.some),
      ),
    put: (videoId, maybeLines, now) => {
      upsert.run(
        videoId,
        Option.getOrNull(Option.map(maybeLines, encodeLines)),
        now,
      )
    },
  }
}

/** Plain lyrics for the song page, read off the timed lines. */
const plainText = (lines: Lines): string =>
  Array.filter(lines, line => line.text !== '')
    .map(line => line.text)
    .join('\n')

/** The song's details with its timed lyrics, when there are any. */
export const withLines = (
  details: SongDetails,
  maybeLines: Option.Option<Lines>,
): SongDetails =>
  Option.match(maybeLines, {
    onNone: () => details,
    onSome: lines => ({
      ...details,
      maybeLyrics: Option.some({
        text: plainText(lines),
        maybeSource: Option.some(TIMED_LYRICS_SOURCE),
        maybeLines: Option.some(lines),
      }),
    }),
  })

export class TimedLyrics extends Context.Service<
  TimedLyrics,
  {
    /** Adds timed lyrics to a song's details, waiting a few seconds at most. */
    readonly withTimedLines: (
      details: SongDetails,
    ) => Effect.Effect<SongDetails>
    /** Looks a song up in the background, so its lyrics are ready on Play. */
    readonly warm: (song: Song) => Effect.Effect<void>
  }
>()('music/TimedLyrics') {}

export type FetchLines = (
  query: LyricsQuery,
) => Effect.Effect<Option.Option<Lines>, LrclibError>

/**
 * Builds the service on a cache and a fetcher. A lookup runs in the
 * service's scope, so a page that stops waiting still lets it finish and be
 * kept; two requests for one song share a lookup.
 */
export const makeTimedLyrics = Effect.fnUntraced(function* (
  cache: LyricsCache,
  fetchLines: FetchLines,
  now: () => number,
) {
  const scope = yield* Scope.Scope
  const pending = new Map<string, Deferred.Deferred<Option.Option<Lines>>>()

  const lookUp = (
    videoId: string,
    query: LyricsQuery,
  ): Effect.Effect<Deferred.Deferred<Option.Option<Lines>>> =>
    Effect.gen(function* () {
      const existing = pending.get(videoId)
      if (existing !== undefined) {
        return existing
      }
      const deferred = yield* Deferred.make<Option.Option<Lines>>()
      pending.set(videoId, deferred)
      // Unmarked before anyone waiting resumes, so a later ask looks again.
      const settle = (maybeLines: Option.Option<Lines>) =>
        Effect.sync(() => pending.delete(videoId)).pipe(
          Effect.andThen(Deferred.succeed(deferred, maybeLines)),
        )
      yield* fetchLines(query).pipe(
        Effect.timeout(LOOKUP_TIMEOUT),
        Effect.tap(maybeLines =>
          Effect.sync(() => cache.put(videoId, maybeLines, now())),
        ),
        Effect.orElseSucceed(() => Option.none<Lines>()),
        Effect.flatMap(settle),
        Effect.onInterrupt(() => settle(Option.none())),
        Effect.forkIn(scope),
      )
      return deferred
    })

  const linesFor = (song: Song, wait: Duration.Input) =>
    Option.match(queryOf(song), {
      onNone: () => Effect.succeed(Option.none<Lines>()),
      onSome: query =>
        Option.match(cache.get(song.videoId, now()), {
          onSome: Effect.succeed,
          onNone: () =>
            lookUp(song.videoId, query).pipe(
              Effect.flatMap(deferred =>
                Deferred.await(deferred).pipe(Effect.timeoutOption(wait)),
              ),
              Effect.map(Option.flatten),
            ),
        }),
    })

  return TimedLyrics.of({
    withTimedLines: details =>
      linesFor(details.song, PAGE_WAIT).pipe(
        Effect.map(maybeLines => withLines(details, maybeLines)),
      ),
    warm: song => Effect.asVoid(linesFor(song, Duration.zero)),
  })
})

export const TimedLyricsLive = Layer.effect(TimedLyrics)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
    const file = yield* Config.String('LYRICS_DB_PATH').pipe(
      Config.withDefault(
        path.join(home, '.local', 'share', 'music', 'lyrics.sqlite'),
      ),
    )
    const baseUrl = yield* Config.String('LRCLIB_URL').pipe(
      Config.withDefault('https://lrclib.net'),
    )
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.orDie)
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(file, { create: true, strict: true })),
      database => Effect.sync(() => database.close()),
    )
    return yield* makeTimedLyrics(
      makeLyricsCache(db),
      query => fetchTimedLines(baseUrl, query),
      () => Date.now(),
    )
  }),
)
