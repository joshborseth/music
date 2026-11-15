import { Database } from 'bun:sqlite'
import {
  Array,
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Schema,
  Semaphore,
} from 'effect'
import { ChildProcessSpawner } from 'effect/process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { type LyricLine, Tv } from '@music/shared'

import { runFfmpeg } from '../analysis/decode.ts'
import { makeFailureMemory, tryCache } from '../background.ts'
import {
  type AtlasPlan,
  buildAtlas,
  capFor,
  drawFilter,
  glyphText,
  planAtlas,
} from './atlas.ts'
import { timeWords } from './timing.ts'
import { sungTrack } from './track.ts'

/*
 * The sung words of each song for the TV's visuals (`Tv.TvWords`): each
 * word's time, worked out from the timed lyrics and the song's analysis
 * (`timing.ts`), and every distinct word drawn into one distance-field
 * atlas (`atlas.ts`). Kept in a SQLite file, keyed by what they were made
 * from, so new lyrics or a new analysis make them again; only the songs
 * played latest are kept.
 */

/** Bumped when the timing or the atlas changes, so cached words are made again. */
export const WORDS_VERSION = 1
/** Songs whose words are kept. */
const KEPT_SONGS = 200
/**
 * Distinct words drawn into the atlas, at most: the most sung first. Past
 * about 400, capitals are at their smallest and ffmpeg's canvas (some
 * 45 million pixels, 370 MB of ffmpeg's memory) grows with every word; a
 * dense rap song of 1000 distinct words took 800 MB and still didn't fit.
 * The words left out are timed as usual, without a glyph.
 */
export const MOST_GLYPHS = 400
/** The longest one drawing by ffmpeg may take (about 4 s for most songs). */
const DRAW_TIMEOUT = Duration.seconds(30)
/** Drawings, each smaller, before giving up on fitting the words. */
const MOST_DRAWS = 3
/** A song whose words failed is not made again for this long. */
const FAILURE_RETRY_MS = 30 * 60 * 1000
/** Songs whose failure is remembered, at most. */
const FAILURES_KEPT = 200

export class WordsError extends Schema.TaggedError<WordsError>()('WordsError', {
  videoId: Schema.String,
  message: Schema.String,
}) {}

// CACHE

const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE song_words (
    video_id TEXT PRIMARY KEY,
    made_from TEXT NOT NULL,
    words TEXT NOT NULL,
    made_at INTEGER NOT NULL
  ) STRICT;
  `,
]

const WordsJson = Schema.fromJsonString(Schema.toCodecJson(Tv.TvWords))
const encodeWords = Schema.encodeSync(WordsJson)
const decodeWords = Schema.decodeUnknownOption(WordsJson)

const CacheRow = Schema.Struct({ words: Schema.String })
const decodeCacheRow = Schema.decodeUnknownOption(CacheRow)

const VersionRow = Schema.Struct({ user_version: Schema.Number })
const decodeVersionRow = Schema.decodeUnknownOption(VersionRow)

export interface WordsCache {
  /** The song's words, if they were made from `madeFrom`. */
  readonly get: (videoId: string, madeFrom: string) => Option.Option<Tv.TvWords>
  readonly put: (words: Tv.TvWords, madeFrom: string, now: number) => void
}

export const makeWordsCache = (db: Database, kept = KEPT_SONGS): WordsCache => {
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
    'SELECT words FROM song_words WHERE video_id = ? AND made_from = ?',
  )
  const upsert = db.query(
    `INSERT INTO song_words (video_id, made_from, words, made_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (video_id) DO UPDATE SET
       made_from = excluded.made_from, words = excluded.words, made_at = excluded.made_at`,
  )
  const trim = db.query(
    `DELETE FROM song_words WHERE video_id NOT IN
       (SELECT video_id FROM song_words ORDER BY made_at DESC LIMIT ?)`,
  )
  return {
    get: (videoId, madeFrom) =>
      Option.flatMap(decodeCacheRow(select.get(videoId, madeFrom)), row =>
        decodeWords(row.words),
      ),
    put: (words, madeFrom, now) => {
      upsert.run(words.videoId, madeFrom, encodeWords(words), now)
      trim.run(kept)
    },
  }
}

/** What a song's words are made from, in short: change any and they are made again. */
export const madeFrom = (
  lines: ReadonlyArray<LyricLine>,
  maybeAnalysis: Option.Option<Tv.TvAnalysis>,
): string =>
  createHash('sha1')
    .update(String(WORDS_VERSION))
    .update(JSON.stringify(lines))
    .update(
      Option.match(maybeAnalysis, {
        onNone: () => 'no analysis',
        onSome: analysis => `${analysis.beats.length}:${analysis.score.png}`,
      }),
    )
    .digest('base64url')

// WORDS

/** Draws `texts` into an atlas, or none when the font draws none of them. */
export type DrawAtlas = (
  texts: ReadonlyArray<string>,
) => Effect.Effect<Option.Option<Tv.TvWordAtlas>, WordsError>

export const emptyWords = (videoId: string): Tv.TvWords => ({
  videoId,
  phrase: null,
  lines: [],
  words: [],
  atlas: null,
})

/**
 * The texts to draw for `words`: each distinct word once, in the order
 * first sung; past `most`, only the most sung of them.
 */
export const glyphTexts = (
  words: ReadonlyArray<string>,
  most: number = MOST_GLYPHS,
): ReadonlyArray<string> => {
  const sung = new Map<string, number>()
  for (const word of words) {
    const text = glyphText(word)
    if (text !== null) sung.set(text, (sung.get(text) ?? 0) + 1)
  }
  const texts = [...sung.keys()]
  if (texts.length <= most) return texts
  // A stable sort: words sung as often keep the order first sung.
  const kept = new Set(
    Array.take(
      Array.sort(
        texts,
        Order.flip(
          Order.mapInput(Order.Number, (text: string) => sung.get(text) ?? 0),
        ),
      ),
      most,
    ),
  )
  return texts.filter(text => kept.has(text))
}

/** A song's words from its timed lines and analysis, drawn by `draw`. */
export const makeWords = (
  videoId: string,
  lines: ReadonlyArray<LyricLine>,
  maybeAnalysis: Option.Option<Tv.TvAnalysis>,
  draw: DrawAtlas,
): Effect.Effect<Tv.TvWords, WordsError> =>
  Effect.gen(function* () {
    const analysis = Option.getOrNull(maybeAnalysis)
    const track = analysis === null ? null : sungTrack(analysis.score)
    const timed = timeWords(
      lines,
      track,
      analysis?.beats ?? [],
      analysis?.durationSeconds ?? 0,
    )
    if (timed.words.length === 0) return emptyWords(videoId)
    const maybeAtlas = yield* draw(
      glyphTexts(timed.words.map(word => word.text)),
    )
    const atlas = Option.getOrNull(maybeAtlas)
    const glyphOf = new Map(
      atlas?.glyphs.map((glyph, index) => [glyph.text, index]),
    )
    const round = (seconds: number) => Math.round(seconds * 1000) / 1000
    return {
      videoId,
      phrase: timed.phrase,
      lines: timed.lines.map(line => ({
        ...line,
        startSeconds: round(line.startSeconds),
        endSeconds: round(line.endSeconds),
      })),
      words: timed.words.map(word => {
        const text = glyphText(word.text)
        return {
          ...word,
          startSeconds: round(word.startSeconds),
          endSeconds: round(word.endSeconds),
          glyph: text === null ? null : (glyphOf.get(text) ?? null),
        }
      }),
      atlas,
    }
  })

// DRAWING

/** The words drawn by ffmpeg with the font at `fontPath`, as `atlas.ts` plans. */
const drawWithFfmpeg = (
  ffmpeg: string,
  fontPath: string,
  plan: AtlasPlan,
  timeout: Duration.Input,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'music-words-' })
    // Each word from a file of its own, so none needs escaping.
    const files = plan.cells.map((_, i) => path.join(dir, `${i}.txt`))
    yield* Effect.forEach(
      plan.cells,
      (cell, i) => fs.writeFileString(files[i] ?? '', cell.text),
      { concurrency: 16, discard: true },
    )
    const script = path.join(dir, 'draw.txt')
    yield* fs.writeFileString(script, drawFilter(plan, fontPath, files))
    // Interrupted (by the timeout, or a TV that hangs up), ffmpeg is killed
    // with the scope it runs in.
    const { chunks } = yield* runFfmpeg(ffmpeg, [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${plan.canvasWidth}x${plan.canvasHeight}:d=1`,
      '-frames:v',
      '1',
      '-filter_script:v',
      script,
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      '-',
    ]).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail({ message: 'ffmpeg took too long to draw the words' }),
      }),
    )
    const pixels = new Uint8Array(plan.canvasWidth * plan.canvasHeight)
    let at = 0
    for (const chunk of chunks) {
      pixels.set(chunk.subarray(0, Math.max(0, pixels.length - at)), at)
      at += chunk.length
    }
    return pixels
  }).pipe(Effect.scoped)

/** Draws with ffmpeg, smaller each time the words don't fit. */
export const makeDrawAtlas =
  (
    ffmpeg: string,
    fontPath: string,
    videoId: string,
    timeout: Duration.Input = DRAW_TIMEOUT,
  ): ((
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<
    Option.Option<Tv.TvWordAtlas>,
    WordsError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >) =>
  texts =>
    Effect.gen(function* () {
      if (texts.length === 0) return Option.none()
      let cap = capFor(texts)
      for (let draws = 0; draws < MOST_DRAWS; draws++) {
        const plan = planAtlas(texts, cap)
        const pixels = yield* drawWithFfmpeg(ffmpeg, fontPath, plan, timeout)
        const atlas = buildAtlas(plan, pixels)
        if (atlas !== null) return Option.some(atlas)
        const smaller = capFor(texts, cap)
        if (smaller >= cap) break
        cap = smaller
      }
      return Option.none()
    }).pipe(
      Effect.mapError(
        error =>
          new WordsError({
            videoId,
            message: `Drawing the words failed: ${error.message}`,
          }),
      ),
    )

// SERVICE

export class SongWords extends Context.Service<
  SongWords,
  {
    /**
     * The song's words from its timed lines and its analysis (none: the
     * words are spread by their syllables alone): from the cache, or made
     * now.
     */
    readonly words: (
      videoId: string,
      lines: ReadonlyArray<LyricLine>,
      maybeAnalysis: Option.Option<Tv.TvAnalysis>,
    ) => Effect.Effect<Tv.TvWords, WordsError>
  }
>()('music/SongWords') {}

/** Builds the service on a cache and a way to draw atlases. */
export const makeSongWords = Effect.fnUntraced(function* (
  cache: WordsCache,
  draw: (videoId: string) => DrawAtlas,
  now: () => number,
) {
  // Drawing holds a tall canvas in memory: one song at a time, so a second
  // ask for the same song finds the first one's words in the cache.
  const drawing = yield* Semaphore.make(1)
  const failures = makeFailureMemory<WordsError>({
    retryMs: () => FAILURE_RETRY_MS,
    now,
    capacity: FAILURES_KEPT,
  })
  // The cache is SQLite, which throws: words it can't read are made
  // again, and words it can't keep are still answered with.
  const cached = (videoId: string, key: string) =>
    tryCache(
      'Reading cached words failed',
      videoId,
      () => cache.get(videoId, key),
      () => Option.none<Tv.TvWords>(),
    )
  const keep = (words: Tv.TvWords, key: string) =>
    tryCache(
      'Keeping the words failed',
      words.videoId,
      () => cache.put(words, key, now()),
      () => undefined,
    )

  return SongWords.of({
    words: (videoId, lines, maybeAnalysis) =>
      Effect.gen(function* () {
        const key = madeFrom(lines, maybeAnalysis)
        const known = yield* cached(videoId, key)
        if (Option.isSome(known)) return known.value
        const failed = failures.recent(`${videoId}:${key}`)
        if (Option.isSome(failed)) return yield* failed.value
        return yield* Effect.gen(function* () {
          const again = yield* cached(videoId, key)
          if (Option.isSome(again)) return again.value
          const words = yield* makeWords(
            videoId,
            lines,
            maybeAnalysis,
            draw(videoId),
          ).pipe(
            Effect.tapError(error =>
              Effect.sync(() => failures.remember(`${videoId}:${key}`, error)),
            ),
          )
          // Without an analysis they are a guess: made again once it comes.
          if (Option.isSome(maybeAnalysis)) yield* keep(words, key)
          return words
        }).pipe(
          drawing.withPermits(1),
          Effect.withSpan('SongWords.make', { attributes: { videoId } }),
        )
      }),
  })
})

/** The font the TV's UI uses, in its boldest weight, from the TV app's sources. */
const DEFAULT_FONT = fileURLToPath(
  new URL('../../../tv/ui/fonts/InterDisplay-ExtraBold.ttf', import.meta.url),
)

export const SongWordsLive = Layer.effect(SongWords)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
    const file = yield* Config.String('WORDS_DB_PATH').pipe(
      Config.withDefault(
        path.join(home, '.local', 'share', 'music', 'words.sqlite'),
      ),
    )
    const ffmpeg = yield* Config.String('FFMPEG_PATH').pipe(
      Config.withDefault('ffmpeg'),
    )
    const font = yield* Config.String('WORDS_FONT_PATH').pipe(
      Config.withDefault(DEFAULT_FONT),
    )
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.orDie)
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(file, { create: true, strict: true })),
      database => Effect.sync(() => database.close()),
    )
    const services = Context.make(FileSystem.FileSystem, fs).pipe(
      Context.add(Path.Path, path),
      Context.add(ChildProcessSpawner.ChildProcessSpawner, spawner),
    )
    return yield* makeSongWords(
      makeWordsCache(db),
      videoId => texts =>
        makeDrawAtlas(
          ffmpeg,
          font,
          videoId,
        )(texts).pipe(Effect.provide(services)),
      () => Date.now(),
    )
  }),
)
