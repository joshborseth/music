import { Effect, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { SAMPLE_RATE } from './analyze.ts'

/*
 * A song's audio as samples: ffmpeg decodes the file to raw 32-bit float,
 * mono, at the analysis sample rate, and writes it to its stdout.
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

/** Decodes the audio file at `path` with the ffmpeg at `ffmpeg`. */
export const decodeAudio = (
  ffmpeg: string,
  path: string,
): Effect.Effect<
  Float32Array<ArrayBuffer>,
  DecodeError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const command = ChildProcess.make(ffmpeg, [
      '-nostdin',
      '-v',
      'error',
      '-i',
      path,
      '-t',
      String(MAX_SECONDS),
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      '-',
    ])
    const handle = yield* spawner.spawn(command)
    const [chunks, errorText, exitCode] = yield* Effect.all(
      [
        Stream.runCollect(handle.stdout),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: 'unbounded' },
    )
    if (exitCode !== 0) {
      return yield* new DecodeError({
        message: `ffmpeg exited ${exitCode}: ${errorText.trim().slice(0, 300)}`,
      })
    }
    const samples = toSamples(chunks)
    if (samples.length === 0) {
      return yield* new DecodeError({ message: 'ffmpeg produced no audio' })
    }
    return samples
  }).pipe(
    Effect.scoped,
    Effect.catchTag('PlatformError', error =>
      Effect.fail(new DecodeError({ message: error.message })),
    ),
  )
