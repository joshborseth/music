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
  Schema,
  Semaphore,
  pipe,
} from 'effect'

import {
  AudioSource,
  AudioUnavailableError,
  type ResolvedAudio,
} from './audio.ts'
import { SongDownload, pump, responseLength } from './songDownload.ts'

/*
 * Every song any player asks for is downloaded whole, once, into a disk
 * cache. Players can start on the first bytes while it downloads; after
 * that it plays straight from disk. When the cache passes its size limit,
 * songs played once or twice go before favorites, oldest first, and the
 * songs about to play are never dropped.
 */

/** Where a player reads a song from. */
export type SongSource =
  | { readonly _tag: 'Stored'; readonly path: string; readonly size: number }
  | { readonly _tag: 'Downloading'; readonly download: SongDownload }

export class AudioStore extends Context.Service<
  AudioStore,
  {
    /** The song for a player: on disk, or arriving now. Starts the download if needed. */
    readonly open: (
      videoId: string,
    ) => Effect.Effect<SongSource, AudioUnavailableError>
    /** Wait until the whole song is on disk, downloading it if needed. */
    readonly ensure: (
      videoId: string,
    ) => Effect.Effect<void, AudioUnavailableError>
    readonly isStored: (videoId: string) => Effect.Effect<boolean>
    /** Count a play, so favorites stay cached longest. */
    readonly markPlayed: (videoId: string) => Effect.Effect<void>
    /** The songs playing now and next: never evicted. */
    readonly protect: (videoIds: ReadonlyArray<string>) => Effect.Effect<void>
  }
>()('music/AudioStore') {}

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024
/** Evicting stops once the cache is this far under its limit. */
const EVICT_TO_FRACTION = 0.9
/** A song played this many times is a favorite. */
export const FAVORITE_PLAYS = 3
const START_CAPACITY = 64
/** Shares one starting download between requests that arrive together. */
const START_TTL = Duration.seconds(10)
const FAILURE_TTL = Duration.seconds(20)
const EXTENSION = '.m4a'
const INDEX_FILE = 'plays.json'

// EVICTION

const SongUse = Schema.Struct({
  plays: Schema.Number,
  lastPlayedAt: Schema.Number,
})
type SongUse = typeof SongUse.Type
const PlayIndex = Schema.Record(Schema.String, SongUse)
type PlayIndex = typeof PlayIndex.Type
const decodePlayIndex = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PlayIndex),
)

export interface CachedSong {
  readonly videoId: string
  readonly size: number
  /** When the file was written (or last played, for older caches). */
  readonly savedAt: number
}

/**
 * Which songs to delete so the cache fits: nothing protected, songs that
 * are not favorites first, and within each group the least recently used.
 */
export const songsToEvict = (
  songs: ReadonlyArray<CachedSong>,
  uses: Readonly<Record<string, SongUse>>,
  protectedIds: ReadonlySet<string>,
  maxBytes: number,
): ReadonlyArray<CachedSong> => {
  const total = Array.reduce(songs, 0, (sum, song) => sum + song.size)
  if (total <= maxBytes) return []
  const lastUsed = (song: CachedSong) =>
    Math.max(song.savedAt, uses[song.videoId]?.lastPlayedAt ?? 0)
  const isFavorite = (song: CachedSong) =>
    (uses[song.videoId]?.plays ?? 0) >= FAVORITE_PLAYS
  const candidates = Array.sort(
    Array.filter(songs, song => !protectedIds.has(song.videoId)),
    Order.combine(
      Order.mapInput(Order.Boolean, isFavorite),
      Order.mapInput(Order.Number, lastUsed),
    ),
  )
  const target = maxBytes * EVICT_TO_FRACTION
  let remaining = total
  return Array.takeWhile(candidates, song => {
    if (remaining <= target) return false
    remaining -= song.size
    return true
  })
}

// DOWNLOADING

const startRequest = (videoId: string, audio: ResolvedAudio) =>
  Effect.tryPromise({
    try: async () => {
      const range = Option.match(audio.maybeSize, {
        onNone: () => 'bytes=0-',
        onSome: size => `bytes=0-${size - 1}`,
      })
      // No abort signal: the download outlives the request that started it.
      const response = await fetch(audio.url, {
        headers: { ...audio.headers, range, 'accept-encoding': 'identity' },
      })
      const size = responseLength(response.headers)
      if (!response.ok || response.body === null || size === undefined) {
        await response.body?.cancel()
        throw new Error(`YouTube answered ${response.status}`)
      }
      return { body: response.body, size }
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

    const indexPath = path.join(directory, INDEX_FILE)
    const plays: Record<string, SongUse> = yield* fs
      .readFileString(indexPath)
      .pipe(
        Effect.flatMap(decodePlayIndex),
        Effect.map(index => ({ ...index })),
        Effect.orElseSucceed((): Record<string, SongUse> => ({})),
      )
    const indexLock = yield* Semaphore.make(1)
    let protectedIds: ReadonlySet<string> = new Set()
    const active = new Map<string, SongDownload>()

    const songPath = (videoId: string) =>
      path.join(directory, videoId + EXTENSION)

    const storedSong = (videoId: string) =>
      fs.stat(songPath(videoId)).pipe(
        Effect.map((info): SongSource => ({
          _tag: 'Stored',
          path: songPath(videoId),
          size: Number(info.size),
        })),
        Effect.option,
      )

    const saveIndex = indexLock.withPermits(1)(
      Effect.suspend(() => {
        const temporary = `${indexPath}.part`
        const snapshot: PlayIndex = { ...plays }
        return fs
          .writeFileString(temporary, JSON.stringify(snapshot))
          .pipe(Effect.andThen(fs.rename(temporary, indexPath)))
      }),
    )

    const evict = Effect.gen(function* () {
      const names = yield* fs.readDirectory(directory)
      const songs = yield* Effect.forEach(
        Array.filter(names, name => name.endsWith(EXTENSION)),
        name =>
          fs.stat(path.join(directory, name)).pipe(
            Effect.map((info): CachedSong => ({
              videoId: name.slice(0, -EXTENSION.length),
              size: Number(info.size),
              savedAt: Option.match(info.mtime, {
                onNone: () => 0,
                onSome: date => date.getTime(),
              }),
            })),
            Effect.option,
          ),
      ).pipe(Effect.map(Array.getSomes))
      yield* Effect.forEach(
        songsToEvict(songs, plays, protectedIds, maxBytes),
        song => Effect.ignore(fs.remove(songPath(song.videoId))),
        { discard: true },
      )
    }).pipe(Effect.ignore)

    /** Write the finished download to disk, or forget it if it failed. */
    const settle = (
      videoId: string,
      download: SongDownload,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const isComplete = yield* Effect.promise(() => download.finished)
        if (isComplete) {
          const temporary = `${songPath(videoId)}.part`
          yield* pipe(
            fs.writeFile(temporary, download.buffer),
            Effect.andThen(fs.rename(temporary, songPath(videoId))),
            Effect.tapError(error =>
              Effect.logWarning('Saving a song failed', videoId, error.message),
            ),
            Effect.ignore,
          )
        } else {
          yield* Effect.logWarning('A song download stopped early', videoId)
        }
        active.delete(videoId)
        yield* Cache.invalidate(starting, videoId)
        yield* evict
      })

    const start = (
      videoId: string,
    ): Effect.Effect<SongDownload, AudioUnavailableError> =>
      Effect.gen(function* () {
        const audio = yield* audioSource.resolve(videoId)
        const { body, size } = yield* startRequest(videoId, audio).pipe(
          Effect.catch(() =>
            Effect.andThen(
              audioSource.invalidate(videoId),
              Effect.flatMap(audioSource.resolve(videoId), fresh =>
                startRequest(videoId, fresh),
              ),
            ),
          ),
        )
        const download = new SongDownload(size)
        active.set(videoId, download)
        void pump(body, download)
        yield* Effect.forkDetach(settle(videoId, download))
        return download
      }).pipe(
        // A player that hangs up must not strand a half-started download.
        Effect.uninterruptible,
        Effect.withSpan('AudioStore.start', { attributes: { videoId } }),
      )

    const starting = yield* Cache.makeWith(start, {
      capacity: START_CAPACITY,
      timeToLive: Exit.match({
        onFailure: () => FAILURE_TTL,
        onSuccess: () => START_TTL,
      }),
    })

    const open = (
      videoId: string,
    ): Effect.Effect<SongSource, AudioUnavailableError> =>
      Effect.flatMap(storedSong(videoId), maybeStored => {
        if (Option.isSome(maybeStored)) return Effect.succeed(maybeStored.value)
        const maybeActive = active.get(videoId)
        return maybeActive === undefined
          ? Effect.map(
              Cache.get(starting, videoId),
              (download): SongSource => ({ _tag: 'Downloading', download }),
            )
          : Effect.succeed({ _tag: 'Downloading', download: maybeActive })
      })

    const ensure = (videoId: string) =>
      Effect.flatMap(open(videoId), source =>
        source._tag === 'Stored'
          ? Effect.void
          : Effect.flatMap(
              Effect.promise(() => source.download.finished),
              isComplete =>
                isComplete
                  ? Effect.void
                  : Effect.fail(
                      new AudioUnavailableError({
                        videoId,
                        message: 'The download stopped early',
                      }),
                    ),
            ),
      )

    return AudioStore.of({
      open,
      ensure,
      isStored: videoId => Effect.map(storedSong(videoId), Option.isSome),
      markPlayed: videoId =>
        Effect.suspend(() => {
          plays[videoId] = {
            plays: (plays[videoId]?.plays ?? 0) + 1,
            lastPlayedAt: Date.now(),
          }
          return saveIndex
        }).pipe(
          Effect.tapError(error =>
            Effect.logWarning('Saving play counts failed', error.message),
          ),
          Effect.ignore,
        ),
      protect: videoIds =>
        Effect.sync(() => {
          protectedIds = new Set(videoIds)
        }),
    })
  }),
)
