import { Duration, Effect, Fiber, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import {
  CELL_HEIGHT,
  CELL_WIDTH,
  type Candidate,
  FRAMES_PER_SECOND,
  FRAME_BYTES,
  FrameSifter,
} from './frames.ts'

/*
 * A music video's frames, straight off YouTube and never kept: yt-dlp
 * writes the smallest useful video-only stream (240p to 360p, H.264 where
 * there is one, a few megabytes) to its stdout, ffmpeg reads it from there
 * and writes two frames a second, scaled to cover a 16:9 cell, as raw RGB,
 * and `FrameSifter` keeps the best frame of each shot as they come. Both run
 * at a low priority (`nice`), so playback never waits on them.
 */

export class ExtractError extends Schema.TaggedError<ExtractError>()(
  'ExtractError',
  {
    videoId: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Video only, 200 to 360 lines, as a plain download (not HLS). H.264 decodes
 * quickest; then any codec; then up to 480 lines; then anything.
 */
const FORMAT = [
  'bv[height<=360][height>=200][vcodec^=avc1][protocol=https]',
  'bv[height<=360][height>=200][protocol=https]',
  'bv[height<=480][protocol=https]',
  'wv[protocol=https]',
  'wv',
].join('/')

/** A video longer than this is read only this far. */
const MAX_SECONDS = 12 * 60
/**
 * A video still on its first picture or two after this many frames (45
 * seconds) is a still picture with the song under it: reading stops there.
 */
const STILL_FRAMES = 45 * FRAMES_PER_SECOND
const STILL_SHOTS = 2
/** How long a program stopped early gets to end before it is killed. */
const KILL_AFTER = Duration.seconds(1)

export interface ExtractTools {
  readonly ytDlp: string
  readonly jsRuntime: string
  readonly ffmpeg: string
}

/** Splits raw RGB bytes from ffmpeg into frames, in order. */
export const frameReader = (
  onFrame: (frame: Uint8Array, index: number) => void,
) => {
  const frame = new Uint8Array(FRAME_BYTES)
  let filled = 0
  let index = 0
  return {
    push: (chunk: Uint8Array): void => {
      let at = 0
      while (at < chunk.length) {
        const take = Math.min(FRAME_BYTES - filled, chunk.length - at)
        frame.set(chunk.subarray(at, at + take), filled)
        filled += take
        at += take
        if (filled === FRAME_BYTES) {
          onFrame(frame, index)
          index++
          filled = 0
        }
      }
    },
    frames: (): number => index,
  }
}

/** The candidate frames of the video `videoId`, and how many shots it had. */
export const extractCandidates = (
  tools: ExtractTools,
  videoId: string,
): Effect.Effect<
  {
    readonly candidates: ReadonlyArray<Candidate>
    readonly shots: number
    readonly frames: number
  },
  ExtractError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const download = ChildProcess.make(
      'nice',
      [
        '-n',
        '15',
        tools.ytDlp,
        '--js-runtimes',
        tools.jsRuntime,
        '--no-playlist',
        '--no-warnings',
        '--quiet',
        '--no-progress',
        '--format',
        FORMAT,
        '--output',
        '-',
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { stderr: 'ignore', forceKillAfter: KILL_AFTER },
    )
    const decode = ChildProcess.make(
      'nice',
      [
        '-n',
        '15',
        tools.ffmpeg,
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-threads',
        '2',
        '-t',
        String(MAX_SECONDS),
        '-i',
        'pipe:0',
        '-an',
        '-vf',
        `fps=${FRAMES_PER_SECOND},scale=${CELL_WIDTH}:${CELL_HEIGHT}:force_original_aspect_ratio=increase,crop=${CELL_WIDTH}:${CELL_HEIGHT}`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      // Stopped early, ffmpeg can sit blocked on a full pipe past SIGTERM.
      { forceKillAfter: KILL_AFTER },
    )
    const handle = yield* spawner.spawn(
      download.pipe(ChildProcess.pipeTo(decode)),
    )
    const sifter = new FrameSifter()
    const reader = frameReader((frame, index) =>
      sifter.push(frame, index / FRAMES_PER_SECOND),
    )
    const isStill = () =>
      reader.frames() >= STILL_FRAMES && sifter.shots <= STILL_SHOTS
    const log = yield* Effect.forkScoped(
      Stream.mkString(Stream.decodeText(handle.stderr)),
    )
    yield* Stream.runForEachWhile(handle.stdout, chunk =>
      Effect.sync(() => {
        reader.push(chunk)
        return !isStill()
      }),
    )
    if (isStill()) {
      // A still picture: no need to read the rest. Closing the scope ends
      // both programs.
      return { candidates: [], shots: sifter.shots, frames: reader.frames() }
    }
    const exitCode = yield* handle.exitCode
    if (exitCode !== 0 || reader.frames() === 0) {
      const text = yield* Fiber.join(log)
      return yield* new ExtractError({
        videoId,
        message: `no frames (ffmpeg exited ${exitCode}): ${text.trim().slice(-200)}`,
      })
    }
    return {
      candidates: sifter.finish(),
      shots: sifter.shots,
      frames: reader.frames(),
    }
  }).pipe(
    Effect.scoped,
    Effect.catchTag('PlatformError', error =>
      Effect.fail(new ExtractError({ videoId, message: error.message })),
    ),
  )
