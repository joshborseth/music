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
  Queue,
  Schema,
  Scope,
  Semaphore,
} from 'effect'
import { ChildProcessSpawner } from 'effect/process'
import sharp from 'sharp'

import { Tv } from '@music/shared'

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
 * plays; the TV asking for one not made yet waits for it.
 */

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
/** Montages made in a day, at most: each one is a YouTube download. */
const DAILY_BUILDS = 300
const DAY_MS = 24 * 60 * 60 * 1000
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
})
const StoredJson = Schema.fromJsonString(Schema.toCodecJson(StoredMontage))
const decodeStored = Schema.decodeUnknownOption(StoredJson)
const encodeStored = Schema.encodeSync(StoredJson)

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

    const stored = (
      videoId: string,
    ): Effect.Effect<Option.Option<Tv.TvMontage>> =>
      fs.readFileString(jsonPath(videoId)).pipe(
        Effect.map(text =>
          Option.flatMap(decodeStored(text), saved =>
            saved.version === MONTAGE_VERSION
              ? Option.some(saved.montage)
              : Option.none(),
          ),
        ),
        Effect.orElseSucceed(() => Option.none<Tv.TvMontage>()),
      )

    const evict = Effect.gen(function* () {
      const names = yield* fs.readDirectory(directory)
      const sizes = yield* Effect.forEach(names, name =>
        fs.stat(path.join(directory, name)).pipe(
          Effect.map(info => ({
            videoId: name.replace(/\.(json|jpg|part)$/u, ''),
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
      for (const entry of Array.getSomes(sizes)) {
        const before = byVideo.get(entry.videoId)
        byVideo.set(entry.videoId, {
          videoId: entry.videoId,
          size: (before?.size ?? 0) + entry.size,
          usedAt: Math.max(before?.usedAt ?? 0, entry.usedAt),
        })
      }
      yield* Effect.forEach(
        montagesToEvict([...byVideo.values()], maxBytes),
        montage =>
          Effect.ignore(
            Effect.andThen(
              fs.remove(jsonPath(montage.videoId)),
              fs.remove(jpegPath(montage.videoId)),
            ),
          ),
        { discard: true },
      )
    }).pipe(Effect.ignore)

    const save = (made: Made) =>
      Effect.gen(function* () {
        const { videoId } = made.montage
        const partial = `${jpegPath(videoId)}.part`
        yield* fs.writeFile(partial, made.jpeg)
        yield* fs.rename(partial, jpegPath(videoId))
        // The metadata last: a montage is there once its JSON is.
        yield* fs.writeFileString(
          `${jsonPath(videoId)}.part`,
          encodeStored({ version: MONTAGE_VERSION, montage: made.montage }),
        )
        yield* fs.rename(`${jsonPath(videoId)}.part`, jsonPath(videoId))
        yield* evict
      }).pipe(
        Effect.mapError(error =>
          failure(made.montage.videoId, 'Failed')(error.message),
        ),
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

    /** The montage from the song's music video, if it has one that moves. */
    const fromVideo = (song: SongToMatch) =>
      Effect.gen(function* () {
        const videos = yield* youTubeMusic.searchVideos(videoQuery(song)).pipe(
          Effect.tapError(error =>
            Effect.logWarning(
              'Montage: the video search failed',
              song.videoId,
              error.message,
            ),
          ),
          Effect.orElseSucceed(() => []),
        )
        for (const video of Array.take(
          rankMusicVideos(song, videos),
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
          if (Option.isNone(extracted)) continue
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
          return Option.some(
            yield* assemble(
              song,
              'Video',
              video.videoId,
              frames,
              CELL_WIDTH,
              CELL_HEIGHT,
            ),
          )
        }
        return Option.none<Made>()
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

    const make = (videoId: string): Effect.Effect<Tv.TvMontage, MontageError> =>
      Effect.gen(function* () {
        if (!(yield* spendBuild)) {
          return yield* failure(
            videoId,
            'Unavailable',
          )(`${DAILY_BUILDS} montages made in the last day`)
        }
        const started = Date.now()
        const song = yield* songOf(videoId)
        const maybeVideo = yield* fromVideo(song)
        const made = Option.isSome(maybeVideo)
          ? maybeVideo
          : yield* fromArtist(song)
        if (Option.isNone(made)) {
          return yield* failure(
            videoId,
            'Nothing',
          )('no music video and no pictures of the artist')
        }
        yield* save(made.value)
        yield* Effect.logInfo(
          'Montage made',
          videoId,
          made.value.montage.source,
          `${made.value.montage.frames.length} pictures`,
          `${Math.round(made.value.jpeg.length / 1024)} KB`,
          `${((Date.now() - started) / 1000).toFixed(1)} s`,
        )
        return made.value.montage
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

    // ONE AT A TIME

    // Downloads and decoding a video take a CPU core: one song at a time.
    const working = yield* Semaphore.make(1)
    const pending = new Map<
      string,
      Deferred.Deferred<Tv.TvMontage, MontageError>
    >()
    const failures = new Map<
      string,
      { readonly at: number; readonly error: MontageError }
    >()

    const recentFailure = (videoId: string): Option.Option<MontageError> => {
      const failed = failures.get(videoId)
      if (failed === undefined) return Option.none()
      const wait =
        failed.error.reason === 'Nothing' ? NOTHING_RETRY_MS : FAILURE_RETRY_MS
      if (Date.now() - failed.at < wait) return Option.some(failed.error)
      failures.delete(videoId)
      return Option.none()
    }

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
        yield* Effect.suspend(() =>
          // Another ask may have made it while this one waited its turn.
          Effect.flatMap(
            stored(videoId),
            Option.match({
              onSome: Effect.succeed,
              onNone: () => make(videoId),
            }),
          ),
        ).pipe(
          working.withPermits(1),
          Effect.tapError(error =>
            Effect.sync(() =>
              failures.set(videoId, { at: Date.now(), error }),
            ).pipe(
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

    const montage = (
      videoId: string,
    ): Effect.Effect<Tv.TvMontage, MontageError> =>
      Effect.gen(function* () {
        const saved = yield* stored(videoId)
        if (Option.isSome(saved)) {
          yield* touch(videoId)
          return saved.value
        }
        const failed = recentFailure(videoId)
        if (Option.isSome(failed)) return yield* failed.value
        return yield* Deferred.await(yield* start(videoId))
      })

    // BACKGROUND

    const queued = new Set<string>()
    const background = yield* Queue.unbounded<string>()
    yield* Queue.take(background).pipe(
      Effect.tap(videoId => Effect.sync(() => queued.delete(videoId))),
      Effect.flatMap(videoId => Effect.ignore(montage(videoId))),
      Effect.forever,
      Effect.forkIn(scope),
    )

    const warm = (videoId: string) =>
      Effect.gen(function* () {
        if (
          queued.has(videoId) ||
          pending.has(videoId) ||
          Option.isSome(recentFailure(videoId))
        )
          return
        if (Option.isSome(yield* stored(videoId))) return
        queued.add(videoId)
        yield* Queue.offer(background, videoId)
      })

    const atlasFile = (videoId: string) =>
      fs.exists(jpegPath(videoId)).pipe(
        Effect.map(exists =>
          exists ? Option.some(jpegPath(videoId)) : Option.none<string>(),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      )

    return SongMontage.of({ montage, atlasFile, warm })
  }),
)

const pictureOf = (pixels: Uint8Array) => ({
  pixels,
  width: CELL_WIDTH,
  height: CELL_HEIGHT,
})
