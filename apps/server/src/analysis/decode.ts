import { Effect, Option, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { SAMPLE_RATE } from './analyze.ts'
import {
  EBUR128_FILTER,
  type Loudness,
  parseEbur128Summary,
} from './loudness.ts'

/*
 * A song's audio as samples: ffmpeg decodes the file to raw 32-bit float,
 * mono, at the analysis sample rate, and writes it to its stdout. Its log
 * (stderr) carries the song's loudness, for Sound Check.
 */

/** Songs longer than this are analyzed only this far. */
export const MAX_SECONDS = 15 * 60

export class DecodeError extends Schema.TaggedError<DecodeError>()(
  'DecodeError',
  { message: Schema.String },
) {}

/** The bytes of all `chunks`, back to back, as float samples. */
const toSamples = (
  chunks: ReadonlyArray<Uint8Array>,
): Float32Array<ArrayBuffer> => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total - (total % 4))
  let at = 0
  for (const chunk of chunks) {
    const piece = chunk.subarray(0, Math.max(0, bytes.length - at))
    bytes.set(piece, at)
    at += piece.byteLength
  }
  return new Float32Array(bytes.buffer)
}

/** Runs ffmpeg with `args`: the bytes it wrote to stdout, and its log. */
export const runFfmpeg = (
  ffmpeg: string,
  args: ReadonlyArray<string>,
): Effect.Effect<
  { readonly chunks: ReadonlyArray<Uint8Array>; readonly log: string },
  DecodeError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(ffmpeg, args))
    const [chunks, log, exitCode] = yield* Effect.all(
      [
        Stream.runCollect(handle.stdout),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: 'unbounded' },
    )
    if (exitCode !== 0) {
      return yield* new DecodeError({
        message: `ffmpeg exited ${exitCode}: ${log.trim().slice(-300)}`,
      })
    }
    return { chunks, log }
  }).pipe(
    Effect.scoped,
    Effect.catchTag('PlatformError', error =>
      Effect.fail(new DecodeError({ message: error.message })),
    ),
  )

/**
 * ffmpeg's options up to the input: no stdin, banner, or progress, and the
 * `info` log level the `ebur128` summary is written at. `-t` before `-i`
 * cuts the input itself, so the measurement stops where the decode does.
 */
const inputArgs = (path: string): ReadonlyArray<string> => [
  '-nostdin',
  '-hide_banner',
  '-nostats',
  '-v',
  'info',
  '-t',
  String(MAX_SECONDS),
  '-i',
  path,
]

export interface Decoded {
  readonly samples: Float32Array<ArrayBuffer>
  /** None when ffmpeg's loudness summary could not be read. */
  readonly maybeLoudness: Option.Option<Loudness>
}

/**
 * Decodes the audio file at `path` with the ffmpeg at `ffmpeg`, and
 * measures its loudness in the same pass: the decoded audio is split, one
 * copy measured as it is (stereo, at its own rate), the other mixed to
 * mono and resampled for the analysis.
 */
export const decodeAudio = (
  ffmpeg: string,
  path: string,
): Effect.Effect<
  Decoded,
  DecodeError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const { chunks, log } = yield* runFfmpeg(ffmpeg, [
      ...inputArgs(path),
      '-filter_complex',
      `[0:a:0]asplit=2[measure][decode];[measure]${EBUR128_FILTER},anullsink`,
      '-map',
      '[decode]',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      '-',
    ])
    const samples = toSamples(chunks)
    if (samples.length === 0) {
      return yield* new DecodeError({ message: 'ffmpeg produced no audio' })
    }
    return { samples, maybeLoudness: parseEbur128Summary(log) }
  })

/**
 * Only the loudness of the audio file at `path`, for a song whose analysis
 * was made before Sound Check, or that the TV needs before its analysis.
 */
export const measureLoudness = (
  ffmpeg: string,
  path: string,
): Effect.Effect<
  Loudness,
  DecodeError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  runFfmpeg(ffmpeg, [
    ...inputArgs(path),
    '-map',
    '0:a:0',
    '-af',
    EBUR128_FILTER,
    '-f',
    'null',
    '-',
  ]).pipe(
    Effect.flatMap(({ log }) =>
      Option.match(parseEbur128Summary(log), {
        onNone: () =>
          Effect.fail(
            new DecodeError({ message: 'ffmpeg measured no loudness' }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  )
