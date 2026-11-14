import {
  Array,
  Config,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Schema,
  Scope,
  Semaphore,
} from 'effect'
import { ChildProcessSpawner } from 'effect/process'
import sharp from 'sharp'

import { Tv } from '@music/shared'

import { VIDEO_ID } from '../audio.ts'
import { makeBackgroundQueue, makeFailureMemory } from '../background.ts'
import { YouTubeMusic } from '../youtubeMusic/service.ts'
import { ARTIST_CELL, artistPictures } from './artist.ts'
import {
  type MontageFrame,
  contentBox,
  coverInto,
  frameInfo,
  pack,
} from './atlas.ts'
import { type ExtractTools, extractCandidates } from './extract.ts'
import { CELL_HEIGHT, CELL_WIDTH, MAX_FRAMES, selectFrames } from './frames.ts'
import { type SongToMatch, rankMusicVideos, videoQuery } from './match.ts'

/*
 * Each song's montage for the TV's visuals: key frames of its official
 * music video (`match.ts`, `extract.ts`, `frames.ts`), or, when it has
 * none, its artist's photos and covers (`artist.ts`), packed into one JPEG
 * atlas (`atlas.ts`) with what the TV needs to know about each picture.
 * Made once a song, one song at a time, and kept on disk under a size cap,
 * the least recently used dropped first. The prefetcher asks for the songs
 * coming up in the queue (`warm`), so a montage is ready before its song
 * plays; the TV asking for one not made yet waits for it. When the video
 * could not be had (YouTube's search or a download failed), the artist's
 * pictures stand in and are kept with a time to look for the video again
 * (`videoRetry`), so one bad moment doesn't cost a song its video for good.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Changes when montages are made differently, so old ones are made again. */
export const MONTAGE_VERSION = 1
/** Videos tried, likeliest first, before falling back to the artist. */
const VIDEOS_TRIED = 2
/** The longest a montage may take to make. */
const BUILD_TIMEOUT = Duration.minutes(2)
/** A song whose montage failed is not tried again for this long. */
const FAILURE_RETRY_MS = 30 * 60 * 1000
/** A song with no pictures at all is not looked at again for this long. */
const NOTHING_RETRY_MS = 12 * 60 * 60 * 1000
/**
 * The artist's pictures standing in for a music video that could not be
 * had (the search or the download failed) are made again after this long,
 * four times longer after each failure in a row, up to a week.
 */
export const VIDEO_RETRY_MS = 30 * 60 * 1000
const VIDEO_RETRY_MAX_MS = 7 * DAY_MS
/** Songs whose failure is remembered, at most. */
const FAILURES_KEPT = 500
/** Songs waiting to be made in the background, at most. */
const QUEUED_AT_MOST = 32
/** A `.part` file this old is left from a save that broke, and goes. */
const STRAY_PART_MS = 10 * 60 * 1000
/** Montages made in a day, at most: each one is a YouTube download. */
const DAILY_BUILDS = 300
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024
/** Evicting stops once the cache is this share of its cap. */
const EVICT_TO_FRACTION = 0.9
/** JPEG quality: the TV grades every picture, so fine detail is not needed. */
const JPEG_QUALITY = 72
const MOST_JPEG_BYTES = 420 * 1024
const LOWER_JPEG_QUALITY = 58

export class MontageError extends Schema.TaggedError<MontageError>()(
  'MontageError',
  {
    videoId: Schema.String,
    /**
     * `Nothing`: no video and no pictures of the artist; `Unavailable`:
     * YouTube did not answer, or the day's budget is spent; `Failed`: ours.
     */
    reason: Schema.Literals(['Nothing', 'Unavailable', 'Failed']),
    message: Schema.String,
  },
) {}

const StoredMontage = Schema.Struct({
  version: Schema.Number,
  montage: Tv.TvMontage,
  /**
   * Missing in montages saved before it was kept; read as below by
   * `savedOf`.
   */
  retryVideoAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  videoFailures: Schema.optionalKey(Schema.Number),
})
const StoredJson = Schema.fromJsonString(Schema.toCodecJson(StoredMontage))
const decodeStored = Schema.decodeUnknownOption(StoredJson)
const encodeStored = Schema.encodeSync(StoredJson)

/** A montage kept on disk, and whether its music video is looked for again. */
export interface SavedMontage {
  readonly montage: Tv.TvMontage
  /**
   * When to make it again, looking for the music video once more: set when
   * the artist's pictures stood in because the video could not be had (its
   * search or download failed), not because there is none. Null: never.
   */
  readonly retryVideoAt: number | null
  /** The looks for the video that failed in a row, for the backoff. */
  readonly videoFailures: number
}

/**
 * The saved montage in a montage file's text, if it is one of this
 * version. One of the artist's pictures saved before the retry was kept
 * may have stood in for a video that failed, so it is made again once.
 */
export const savedOf = (text: string): Option.Option<SavedMontage> =>
  Option.flatMap(decodeStored(text), saved =>
    saved.version === MONTAGE_VERSION
      ? Option.some({
          montage: saved.montage,
          retryVideoAt:
            saved.retryVideoAt !== undefined
              ? saved.retryVideoAt
              : saved.montage.source === 'Artist'
                ? 0
                : null,
          videoFailures: saved.videoFailures ?? 0,
        })
      : Option.none(),
  )

/** A saved montage as its file's text. */
export const savedText = (saved: SavedMontage): string =>
  encodeStored({
    version: MONTAGE_VERSION,
    montage: saved.montage,
    retryVideoAt: saved.retryVideoAt,
    videoFailures: saved.videoFailures,
  })

/** Whether the saved montage is due to be made again. */
export const isDue = (saved: SavedMontage, now: number): boolean =>
  saved.retryVideoAt !== null && now >= saved.retryVideoAt

/**
 * How a montage just made is saved: when its video could not be had, with
 * a time to look again, later after each failure in a row.
 */
export const videoRetry = (
  videoFailed: boolean,
  failuresBefore: number,
  now: number,
): Pick<SavedMontage, 'retryVideoAt' | 'videoFailures'> => {
  if (!videoFailed) return { retryVideoAt: null, videoFailures: 0 }
  const videoFailures = failuresBefore + 1
  return {
    retryVideoAt:
      now +
      Math.min(VIDEO_RETRY_MAX_MS, VIDEO_RETRY_MS * 4 ** (videoFailures - 1)),
    videoFailures,
  }
}

/** Where the TV fetches a song's atlas. */
export const atlasPathFor = (videoId: string): string =>
  `/tv/montage.jpg?videoId=${encodeURIComponent(videoId)}&v=${MONTAGE_VERSION}`

/** A montage on disk: its two files' combined size, and when last used. */
export interface CachedMontage {
  readonly videoId: string
  readonly size: number
  readonly usedAt: number
}

/** The montages to delete, least recently used first, to get under the cap. */
export const montagesToEvict = (
  cached: ReadonlyArray<CachedMontage>,
  maxBytes: number,
): ReadonlyArray<CachedMontage> => {
  const total = cached.reduce((sum, montage) => sum + montage.size, 0)
  if (total <= maxBytes) return []
  const evicted: Array<CachedMontage> = []
  let left = total
  for (const montage of Array.sort(
    cached,
    Order.mapInput(Order.Number, (m: CachedMontage) => m.usedAt),
  )) {
    if (left <= maxBytes * EVICT_TO_FRACTION) break
    evicted.push(montage)
    left -= montage.size
  }
  return evicted
}

/** What a file in the montage cache is: a montage's, a save's leftover, or neither. */
export const cacheEntryOf = (
  name: string,
):
  | { readonly kind: 'Montage'; readonly videoId: string }
  | { readonly kind: 'Partial' }
  | null => {
  if (name.endsWith('.part')) return { kind: 'Partial' }
  const videoId = /^(.+)\.(?:json|jpg)$/u.exec(name)?.[1]
  return videoId === undefined ? null : { kind: 'Montage', videoId }
}

/**
 * Trims the montage cache in `directory` back under `maxBytes`, least
 * recently used first, and deletes the `.part` files a save that broke
 * left behind.
 */
export const evictMontages = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  maxBytes: number,
  now: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const names = yield* fs.readDirectory(directory)
    const files = yield* Effect.forEach(names, name =>
      fs.stat(path.join(directory, name)).pipe(
        Effect.map(info => ({
          name,
          size: Number(info.size),
          usedAt: Option.match(info.mtime, {
            onNone: () => 0,
            onSome: date => date.getTime(),
          }),
        })),
        Effect.option,
      ),
    )
    const byVideo = new Map<string, CachedMontage>()
    const strays: Array<string> = []
    for (const file of Array.getSomes(files)) {
      const entry = cacheEntryOf(file.name)
      if (entry === null) continue
      if (entry.kind === 'Partial') {
        if (now - file.usedAt >= STRAY_PART_MS) strays.push(file.name)
        continue
      }
      const before = byVideo.get(entry.videoId)
      byVideo.set(entry.videoId, {
        videoId: entry.videoId,
        size: (before?.size ?? 0) + file.size,
        usedAt: Math.max(before?.usedAt ?? 0, file.usedAt),
      })
    }
    const doomed = [
      ...strays,
      ...montagesToEvict([...byVideo.values()], maxBytes).flatMap(montage => [
        `${montage.videoId}.json`,
        `${montage.videoId}.jpg`,
      ]),
    ]
    yield* Effect.forEach(
      doomed,
      name => Effect.ignore(fs.remove(path.join(directory, name))),
      { discard: true },
    )
  }).pipe(Effect.ignore)

export class SongMontage extends Context.Service<
  SongMontage,
  {
    /** The song's montage: from disk, or made now. */
    readonly montage: (
      videoId: string,
    ) => Effect.Effect<Tv.TvMontage, MontageError>
    /** The file of the song's atlas, if its montage is made. */
    readonly atlasFile: (
      videoId: string,
    ) => Effect.Effect<Option.Option<string>>
    /** Make the song's montage in the background, unless it has one. */
    readonly warm: (videoId: string) => Effect.Effect<void>
  }
>()('music/SongMontage') {}

/** A montage made, before it is saved. */
export interface Made {
  readonly montage: Tv.TvMontage
  readonly jpeg: Uint8Array
}

/** A montage made, and whether the music video could not be had this time. */
export interface Built {
  readonly made: Made
  /**
   * The search for the music video failed, or a likelier video than the
   * one used could not be read: worth looking again later.
   */
  readonly videoFailed: boolean
}

/** Makes a song's montage. */
export type BuildMontage = (
  videoId: string,
) => Effect.Effect<Built, MontageError>

/** Where montages are kept. */
export interface MontageStore {
  readonly read: (videoId: string) => Effect.Effect<Option.Option<SavedMontage>>
  readonly write: (
    saved: SavedMontage,
    jpeg: Uint8Array,
  ) => Effect.Effect<void, MontageError>
  /** Marks the song's montage used, for eviction. */
  readonly touch: (videoId: string) => Effect.Effect<void>
}

/**
 * The service on a store and a way to make montages. One song at a time,
 * however many ask for it; a failure is remembered for a while. A montage
 * whose video could not be had is served while it waits to be made again,
 * then made again in the background.
 */
export const makeSongMontage = Effect.fnUntraced(function* (
  store: MontageStore,
  build: BuildMontage,
  now: () => number,
) {
  const scope = yield* Scope.Scope
  const failure =
    (videoId: string, reason: MontageError['reason']) => (message: string) =>
      new MontageError({ videoId, reason, message })

  // Downloads and decoding a video take a CPU core: one song at a time.
  const working = yield* Semaphore.make(1)
  const pending = new Map<
    string,
    Deferred.Deferred<Tv.TvMontage, MontageError>
  >()
  const failures = makeFailureMemory<MontageError>({
    retryMs: error =>
      error.reason === 'Nothing' ? NOTHING_RETRY_MS : FAILURE_RETRY_MS,
    now,
    capacity: FAILURES_KEPT,
  })

  /** Makes the montage and saves it, unless one saved meanwhile is current. */
  const makeAndSave = (videoId: string) =>
    Effect.gen(function* () {
      // Another ask may have made it while this one waited its turn.
      const before = yield* store.read(videoId)
      if (Option.isSome(before) && !isDue(before.value, now())) {
        return before.value.montage
      }
      const started = now()
      const built = yield* build(videoId)
      const retry = videoRetry(
        built.videoFailed,
        Option.match(before, {
          onNone: () => 0,
          onSome: saved => saved.videoFailures,
        }),
        now(),
      )
      yield* store.write(
        { montage: built.made.montage, ...retry },
        built.made.jpeg,
      )
      yield* Effect.logInfo(
        'Montage made',
        videoId,
        built.made.montage.source,
        `${built.made.montage.frames.length} pictures`,
        `${Math.round(built.made.jpeg.length / 1024)} KB`,
        `${((now() - started) / 1000).toFixed(1)} s`,
        ...(retry.retryVideoAt === null
          ? []
          : [
              `the video is looked for again in ${Math.round((retry.retryVideoAt - now()) / 60_000)} min`,
            ]),
      )
      return built.made.montage
    })

  const start = (videoId: string) =>
    Effect.gen(function* () {
      const existing = pending.get(videoId)
      if (existing !== undefined) return existing
      const deferred = yield* Deferred.make<Tv.TvMontage, MontageError>()
      pending.set(videoId, deferred)
      const settle = (result: Exit.Exit<Tv.TvMontage, MontageError>) =>
        Effect.sync(() => pending.delete(videoId)).pipe(
          Effect.andThen(Deferred.done(deferred, result)),
        )
      yield* makeAndSave(videoId).pipe(
        working.withPermits(1),
        // A bug is a failure too: remembered, and answered as one.
        Effect.catchDefect(defect =>
          Effect.fail(
            failure(videoId, 'Failed')(`a defect: ${String(defect)}`),
          ),
        ),
        Effect.tapError(error =>
          Effect.sync(() => failures.remember(videoId, error)).pipe(
            Effect.andThen(
              Effect.logWarning(
                'Montage: none for this song',
                videoId,
                error.reason,
                error.message,
              ),
            ),
          ),
        ),
        Effect.exit,
        Effect.flatMap(settle),
        Effect.onInterrupt(() =>
          settle(Exit.fail(failure(videoId, 'Failed')('interrupted'))),
        ),
        Effect.forkIn(scope),
      )
      return deferred
    })

  /** Makes the montage unless a current one is saved or it failed lately. */
  const refresh = (videoId: string) =>
    Effect.gen(function* () {
      const saved = yield* store.read(videoId)
      if (Option.isSome(saved) && !isDue(saved.value, now())) return
      if (Option.isSome(failures.recent(videoId))) return
      // A failure is logged where it happens; only a bug reaches the worker.
      yield* Effect.ignore(Deferred.await(yield* start(videoId)))
    })

  const background = yield* makeBackgroundQueue({
    name: 'Montage',
    capacity: QUEUED_AT_MOST,
    work: refresh,
  })

  const warm = (videoId: string) =>
    Effect.gen(function* () {
      if (
        background.has(videoId) ||
        pending.has(videoId) ||
        Option.isSome(failures.recent(videoId))
      )
        return
      const saved = yield* store.read(videoId)
      if (Option.isSome(saved) && !isDue(saved.value, now())) return
      yield* background.offer(videoId)
    })

  const montage = (
    videoId: string,
  ): Effect.Effect<Tv.TvMontage, MontageError> =>
    Effect.gen(function* () {
      const saved = yield* store.read(videoId)
      if (Option.isSome(saved)) {
        yield* store.touch(videoId)
        // Served as it is; made again, looking for its video, meanwhile.
        if (isDue(saved.value, now())) yield* warm(videoId)
        return saved.value.montage
      }
      const failed = failures.recent(videoId)
      if (Option.isSome(failed)) return yield* failed.value
      return yield* Deferred.await(yield* start(videoId))
    })

  return { montage, warm }
})

/**
 * The atlas as a JPEG, at a lower quality when a busy video's frames would
 * take more than `MOST_JPEG_BYTES`.
 */
const encodeJpeg = (atlas: ReturnType<typeof pack>) =>
  Effect.tryPromise({
    try: async () => {
      const encode = (quality: number) =>
        sharp(atlas.pixels, {
          raw: { width: atlas.width, height: atlas.height, channels: 3 },
        })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer()
      const first = await encode(JPEG_QUALITY)
      const buffer =
        first.length > MOST_JPEG_BYTES
          ? await encode(LOWER_JPEG_QUALITY)
          : first
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length)
    },
    catch: error => String(error),
  })

/** The montage made of `frames`, each already its cell's size. */
const assemble = (
  song: SongToMatch,
  source: Tv.TvMontageSource,
  musicVideoId: string | null,
  frames: ReadonlyArray<MontageFrame>,
  cellWidth: number,
  cellHeight: number,
) =>
  Effect.gen(function* () {
    const atlas = pack(
      frames.map(frame => frame.picture),
      cellWidth,
      cellHeight,
    )
    const jpeg = yield* encodeJpeg(atlas).pipe(
      Effect.mapError(
        message =>
          new MontageError({
            videoId: song.videoId,
            reason: 'Failed',
            message,
          }),
      ),
    )
    const montage: Tv.TvMontage = {
      videoId: song.videoId,
      source,
      musicVideoId,
      columns: atlas.columns,
      rows: atlas.rows,
      cellWidth,
      cellHeight,
      frames: frames.map(frameInfo),
      atlasPath: atlasPathFor(song.videoId),
    }
    return { montage, jpeg } satisfies Made
  })

export const SongMontageLive = Layer.effect(SongMontage)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const youTubeMusic = yield* YouTubeMusic
    const scope = yield* Scope.Scope
    const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
    const directory = yield* Config.String('MONTAGE_CACHE_DIR').pipe(
      Config.withDefault(path.join(home, '.cache', 'music', 'montage')),
    )
    const maxBytes = yield* Config.Number('MONTAGE_CACHE_MAX_BYTES').pipe(
      Config.withDefault(DEFAULT_MAX_BYTES),
    )
    const tools: ExtractTools = {
      ytDlp: yield* Config.String('YTDLP_PATH').pipe(
        Config.withDefault('yt-dlp'),
      ),
      jsRuntime: yield* Config.String('YTDLP_JS_RUNTIME').pipe(
        Config.withDefault('bun'),
      ),
      ffmpeg: yield* Config.String('FFMPEG_PATH').pipe(
        Config.withDefault('ffmpeg'),
      ),
    }
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie)

    const jsonPath = (videoId: string) =>
      path.join(directory, `${videoId}.json`)
    const jpegPath = (videoId: string) => path.join(directory, `${videoId}.jpg`)
    const failure =
      (videoId: string, reason: MontageError['reason']) => (message: string) =>
        new MontageError({ videoId, reason, message })

    // DISK

    const touch = (videoId: string) =>
      Effect.ignore(
        Effect.forEach(
          [jsonPath(videoId), jpegPath(videoId)],
          file => fs.utimes(file, new Date(), new Date()),
          {
            discard: true,
          },
        ),
      )

    const read = (
      videoId: string,
    ): Effect.Effect<Option.Option<SavedMontage>> =>
      fs.readFileString(jsonPath(videoId)).pipe(
        Effect.map(savedOf),
        Effect.orElseSucceed(() => Option.none<SavedMontage>()),
      )

    const write = (saved: SavedMontage, jpeg: Uint8Array) => {
      const { videoId } = saved.montage
      const jpegPart = `${jpegPath(videoId)}.part`
      const jsonPart = `${jsonPath(videoId)}.part`
      return Effect.gen(function* () {
        yield* fs.writeFile(jpegPart, jpeg)
        yield* fs.writeFileString(jsonPart, savedText(saved))
        // A montage is there while its JSON is: the old one goes first, so
        // its JSON never describes the new atlas, and the new JSON comes last.
        yield* fs.remove(jsonPath(videoId), { force: true })
        yield* fs.rename(jpegPart, jpegPath(videoId))
        yield* fs.rename(jsonPart, jsonPath(videoId))
        yield* evictMontages(fs, path, directory, maxBytes, Date.now())
      }).pipe(
        Effect.tapError(() =>
          Effect.forEach(
            [jpegPart, jsonPart],
            part => Effect.ignore(fs.remove(part)),
            { discard: true },
          ),
        ),
        Effect.mapError(error => failure(videoId, 'Failed')(error.message)),
      )
    }

    // Leftovers of a run that ended while saving.
    yield* Effect.forkIn(
      evictMontages(fs, path, directory, maxBytes, Date.now()),
      scope,
    )

    // MAKING

    const withSpawner = <A, E>(
      effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
    ) =>
      Effect.provideService(
        effect,
        ChildProcessSpawner.ChildProcessSpawner,
        spawner,
      )

    /**
     * The montage from the song's music video, if it has one that moves;
     * and whether the video could not be had this time (the search failed,
     * or a likelier video than the one used could not be read), which is
     * worth looking at again, unlike a song with no video.
     */
    const fromVideo = (song: SongToMatch) =>
      Effect.gen(function* () {
        const searched = yield* youTubeMusic
          .searchVideos(videoQuery(song))
          .pipe(
            Effect.tapError(error =>
              Effect.logWarning(
                'Montage: the video search failed',
                song.videoId,
                error.message,
              ),
            ),
            Effect.option,
          )
        if (Option.isNone(searched)) {
          return { made: Option.none<Made>(), failed: true }
        }
        let failed = false
        for (const video of Array.take(
          rankMusicVideos(song, searched.value),
          VIDEOS_TRIED,
        )) {
          const extracted = yield* withSpawner(
            extractCandidates(tools, video.videoId),
          ).pipe(
            Effect.tapError(error =>
              Effect.logWarning(
                'Montage: reading a video failed',
                video.videoId,
                error.message,
              ),
            ),
            Effect.option,
          )
          if (Option.isNone(extracted)) {
            failed = true
            continue
          }
          const selection = selectFrames(extracted.value.candidates, MAX_FRAMES)
          if (selection.isStatic) {
            yield* Effect.logInfo(
              'Montage: a still picture, not a video',
              video.videoId,
              video.title,
              `${selection.distinct} different pictures`,
            )
            continue
          }
          const box = contentBox(
            selection.frames.map(candidate => pictureOf(candidate.pixels)),
          )
          const frames = selection.frames.map((candidate): MontageFrame => ({
            picture: coverInto(
              pictureOf(candidate.pixels),
              box,
              CELL_WIDTH,
              CELL_HEIGHT,
            ),
            stats: candidate.stats,
            seconds: candidate.seconds,
          }))
          yield* Effect.logInfo(
            'Montage: frames from the music video',
            song.videoId,
            video.videoId,
            video.title,
            `${frames.length} of ${extracted.value.candidates.length} shots`,
          )
          const made = yield* assemble(
            song,
            'Video',
            video.videoId,
            frames,
            CELL_WIDTH,
            CELL_HEIGHT,
          )
          return { made: Option.some(made), failed }
        }
        return { made: Option.none<Made>(), failed }
      })

    /** The montage from the artist's photos and covers, if there are any. */
    const fromArtist = (song: SongToMatch) =>
      Effect.gen(function* () {
        const maybeArtistId = Array.findFirst(
          song.artists,
          artist => artist.maybeId,
        )
        if (Option.isNone(maybeArtistId)) return Option.none<Made>()
        const artist = yield* youTubeMusic
          .getArtistOverview(maybeArtistId.value)
          .pipe(
            Effect.mapError(error =>
              failure(song.videoId, 'Unavailable')(error.message),
            ),
          )
        const pictures = yield* artistPictures(artist)
        if (pictures.length === 0) return Option.none<Made>()
        yield* Effect.logInfo(
          "Montage: the artist's pictures",
          song.videoId,
          `${pictures.length} pictures`,
        )
        return Option.some(
          yield* assemble(
            song,
            'Artist',
            null,
            pictures,
            ARTIST_CELL,
            ARTIST_CELL,
          ),
        )
      })

    const songOf = (videoId: string) =>
      Effect.gen(function* () {
        const details = yield* youTubeMusic
          .getSong(videoId)
          .pipe(
            Effect.mapError(error =>
              failure(
                videoId,
                'Unavailable',
              )(
                error._tag === 'MusicNotFoundError'
                  ? 'no such song'
                  : error.message,
              ),
            ),
          )
        const { song } = details
        const maybeDurationSeconds = Option.isSome(song.maybeDurationSeconds)
          ? song.maybeDurationSeconds
          : yield* youTubeMusic
              .getDurationSeconds(videoId)
              .pipe(Effect.orElseSucceed(() => Option.none<number>()))
        return {
          videoId,
          title: song.title,
          artists: song.artists,
          maybeDurationSeconds,
        } satisfies SongToMatch
      })

    let builds: Array<number> = []
    const spendBuild = Effect.sync(() => {
      const now = Date.now()
      builds = builds.filter(at => now - at < DAY_MS)
      if (builds.length >= DAILY_BUILDS) return false
      builds.push(now)
      return true
    })

    const build: BuildMontage = videoId =>
      Effect.gen(function* () {
        if (!(yield* spendBuild)) {
          return yield* failure(
            videoId,
            'Unavailable',
          )(`${DAILY_BUILDS} montages made in the last day`)
        }
        const song = yield* songOf(videoId)
        const video = yield* fromVideo(song)
        if (Option.isSome(video.made)) {
          return { made: video.made.value, videoFailed: video.failed }
        }
        const artist = yield* fromArtist(song)
        if (Option.isNone(artist)) {
          return yield* video.failed
            ? failure(
                videoId,
                'Unavailable',
              )(
                'the music video could not be had, and the artist has no pictures',
              )
            : failure(
                videoId,
                'Nothing',
              )('no music video and no pictures of the artist')
        }
        return { made: artist.value, videoFailed: video.failed }
      }).pipe(
        Effect.timeoutOrElse({
          duration: BUILD_TIMEOUT,
          orElse: () =>
            Effect.fail(
              failure(videoId, 'Failed')('making the montage took too long'),
            ),
        }),
        Effect.withSpan('SongMontage.make', { attributes: { videoId } }),
      )

    const service = yield* makeSongMontage({ read, write, touch }, build, () =>
      Date.now(),
    )

    // Video IDs name files here, and the queue's come from any client: only
    // real ones are looked at, so none reaches outside the cache.
    const montage = (videoId: string) =>
      VIDEO_ID.test(videoId)
        ? service.montage(videoId)
        : Effect.fail(failure(videoId, 'Nothing')('not a video ID'))
    const warm = (videoId: string) =>
      VIDEO_ID.test(videoId) ? service.warm(videoId) : Effect.void
    const atlasFile = (videoId: string) =>
      VIDEO_ID.test(videoId)
        ? fs.exists(jpegPath(videoId)).pipe(
            Effect.map(exists =>
              exists ? Option.some(jpegPath(videoId)) : Option.none<string>(),
            ),
            Effect.orElseSucceed(() => Option.none<string>()),
          )
        : Effect.succeed(Option.none<string>())

    return SongMontage.of({ montage, atlasFile, warm })
  }),
)

const pictureOf = (pixels: Uint8Array) => ({
  pixels,
  width: CELL_WIDTH,
  height: CELL_HEIGHT,
})
