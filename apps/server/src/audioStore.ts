import {
  Array,
  Cache,
  Config,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  pipe,
} from 'effect'

import {
  AudioSource,
  AudioUnavailableError,
  type ResolvedAudio,
} from './audio.ts'

/*
 * Every song any player asks for is downloaded whole, once, into a disk
 * cache. After that it plays straight from disk: no yt-dlp, no waiting for
 * YouTube's link to become valid, and seeking anywhere is instant. The least
 * recently played songs are dropped when the cache passes its size limit.
 */

/** A song complete on disk. */
export interface StoredSong {
  readonly path: string
  readonly size: number
}

export class AudioStore extends Context.Service<
  AudioStore,
  {
    /** The song on disk, downloading it first if needed. */
    readonly ensure: (
      videoId: string,
    ) => Effect.Effect<StoredSong, AudioUnavailableError>
    /** Download songs in the background so they start instantly later. */
    readonly warm: (videoIds: ReadonlyArray<string>) => Effect.Effect<void>
  }
>()('music/AudioStore') {}

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024
/** Evicting stops once the cache is this far under its limit. */
const EVICT_TO_FRACTION = 0.9
const IN_FLIGHT_CAPACITY = 64
/** Long enough to share one download between concurrent requests. */
const IN_FLIGHT_TTL = Duration.seconds(30)
const FAILURE_TTL = Duration.seconds(20)
const EXTENSION = '.m4a'

const downloadWhole = (videoId: string, audio: ResolvedAudio) =>
  Effect.tryPromise({
    try: async signal => {
      const range = Option.match(audio.maybeSize, {
        onNone: () => 'bytes=0-',
        onSome: size => `bytes=0-${size - 1}`,
      })
      const response = await fetch(audio.url, {
        headers: { ...audio.headers, range, 'accept-encoding': 'identity' },
        signal,
      })
      if (!response.ok) {
        throw new Error(`YouTube answered ${response.status}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    },
    catch: cause =>
      new AudioUnavailableError({
        videoId,
        message: cause instanceof Error ? cause.message : 'Download failed',
      }),
  })

export const AudioStoreLive = Layer.effect(AudioStore)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const audioSource = yield* AudioSource
    const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
    const directory = yield* Config.String('AUDIO_CACHE_DIR').pipe(
      Config.withDefault(path.join(home, '.cache', 'music', 'audio')),
    )
    const maxBytes = yield* Config.Number('AUDIO_CACHE_MAX_BYTES').pipe(
      Config.withDefault(DEFAULT_MAX_BYTES),
    )
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie)

    const songPath = (videoId: string) =>
      path.join(directory, videoId + EXTENSION)

    const storedSong = (videoId: string) =>
      fs.stat(songPath(videoId)).pipe(
        Effect.map(info => ({
          path: songPath(videoId),
          size: Number(info.size),
        })),
        Effect.option,
      )

    /** Drop the least recently played songs until the cache fits. */
    const evict = Effect.gen(function* () {
      const names = yield* fs.readDirectory(directory)
      const songs = yield* Effect.forEach(
        Array.filter(names, name => name.endsWith(EXTENSION)),
        name =>
          fs.stat(path.join(directory, name)).pipe(
            Effect.map(info => ({
              file: path.join(directory, name),
              size: Number(info.size),
              playedAt: Option.match(info.mtime, {
                onNone: () => 0,
                onSome: date => date.getTime(),
              }),
            })),
            Effect.option,
          ),
      ).pipe(Effect.map(Array.getSomes))
      const total = Array.reduce(songs, 0, (sum, song) => sum + song.size)
      if (total <= maxBytes) {
        return
      }
      const oldestFirst = Array.sort(
        songs,
        Order.mapInput(
          Order.Number,
          (song: (typeof songs)[number]) => song.playedAt,
        ),
      )
      yield* Effect.reduce(
        oldestFirst,
        () => total,
        (remaining: number, song) =>
          remaining <= maxBytes * EVICT_TO_FRACTION
            ? Effect.succeed(remaining)
            : fs.remove(song.file).pipe(
                Effect.as(remaining - song.size),
                Effect.orElseSucceed(() => remaining),
              ),
      )
    }).pipe(Effect.ignore)

    const download = (videoId: string) =>
      Effect.gen(function* () {
        const audio = yield* audioSource.resolve(videoId)
        const bytes = yield* downloadWhole(videoId, audio).pipe(
          Effect.catch(() =>
            Effect.andThen(
              audioSource.invalidate(videoId),
              Effect.flatMap(audioSource.resolve(videoId), fresh =>
                downloadWhole(videoId, fresh),
              ),
            ),
          ),
        )
        const temporary = `${songPath(videoId)}.part`
        yield* pipe(
          fs.writeFile(temporary, bytes),
          Effect.andThen(fs.rename(temporary, songPath(videoId))),
          Effect.mapError(
            error =>
              new AudioUnavailableError({ videoId, message: error.message }),
          ),
        )
        yield* Effect.forkDetach(evict)
        return { path: songPath(videoId), size: bytes.byteLength }
      }).pipe(
        Effect.withSpan('AudioStore.download', { attributes: { videoId } }),
      )

    const inFlight = yield* Cache.makeWith(download, {
      capacity: IN_FLIGHT_CAPACITY,
      timeToLive: Exit.match({
        onFailure: () => FAILURE_TTL,
        onSuccess: () => IN_FLIGHT_TTL,
      }),
    })

    const ensure = (videoId: string) =>
      Effect.flatMap(storedSong(videoId), maybeStored =>
        Option.match(maybeStored, {
          onNone: () => Cache.get(inFlight, videoId),
          onSome: stored => {
            const now = new Date()
            return fs
              .utimes(stored.path, now, now)
              .pipe(Effect.ignore, Effect.as(stored))
          },
        }),
      )

    return AudioStore.of({
      ensure,
      warm: videoIds =>
        Effect.forEach(
          videoIds,
          videoId => Effect.forkDetach(Effect.ignore(ensure(videoId))),
          { discard: true },
        ),
    })
  }),
)
