import { rename } from 'node:fs/promises'

import { Effect, Schema } from 'effect'

/*
 * The depth model's weights: Depth Anything V2 Small (Apache-2.0; the
 * larger ones are not licensed for commercial use), exported to ONNX by
 * onnx-community. Downloaded once, at a pinned revision, into the server's
 * data directory, and checked against its hash before every first use, so
 * a cut-off download or a changed file is never run.
 *
 * The half-precision export: half the size of the full one (50 MB), and on
 * album art its depth matches the full one's to within 2 levels of 255
 * (mean 0.1). The 8-bit quantized one is a little smaller still, but greys
 * out the far parts of a cover.
 */

const REVISION = '4472b7362082ad9968fee890ca0f1e5aca36b93d'

export const MODEL = {
  fileName: 'depth-anything-v2-small-fp16.onnx',
  url: `https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/${REVISION}/onnx/model_fp16.onnx`,
  sha256: '2df6223f206b5164e21f664ace61dabeb9bb6a49b8b5a3e00510b4807d0f5b04',
  bytes: 49_642_442,
} as const

export class ModelError extends Schema.TaggedError<ModelError>()(
  'ModelError',
  { message: Schema.String },
) {}

/** The SHA-256 of the file at `path`, as hex, read in chunks. */
export const fileSha256 = (path: string): Effect.Effect<string, ModelError> =>
  Effect.tryPromise({
    try: async () => {
      const hasher = new Bun.CryptoHasher('sha256')
      for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
      return hasher.digest('hex')
    },
    catch: error => new ModelError({ message: `Reading ${path}: ${error}` }),
  })

const exists = (path: string) =>
  Effect.promise(() => Bun.file(path).exists())

/**
 * Downloads `url` to `path`, through a `.part` file that only becomes
 * `path` once its hash is `sha256`.
 */
export const download = (
  url: string,
  path: string,
  sha256: string,
): Effect.Effect<void, ModelError> =>
  Effect.gen(function* () {
    const part = `${path}.part`
    yield* Effect.tryPromise({
      try: async signal => {
        const response = await fetch(url, { signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        await Bun.write(part, response)
      },
      catch: error =>
        new ModelError({ message: `Downloading the depth model: ${error}` }),
    })
    const hash = yield* fileSha256(part)
    if (hash !== sha256) {
      yield* Effect.promise(() => Bun.file(part).delete())
      return yield* new ModelError({
        message: `The downloaded depth model's hash is ${hash}, not ${sha256}`,
      })
    }
    yield* Effect.tryPromise({
      try: () => rename(part, path),
      catch: error => new ModelError({ message: `Keeping the model: ${error}` }),
    })
  })

/**
 * The model at `path`, checked: downloaded first when it is missing and
 * `mayDownload`. Fails when it can't be had or its hash is wrong.
 */
export const ensureModel = (
  path: string,
  mayDownload: boolean,
  model: { readonly url: string; readonly sha256: string } = MODEL,
): Effect.Effect<string, ModelError> =>
  Effect.gen(function* () {
    if (!(yield* exists(path))) {
      if (!mayDownload) {
        return yield* new ModelError({ message: `No depth model at ${path}` })
      }
      yield* Effect.logInfo('Downloading the depth model', model.url)
      yield* download(model.url, path, model.sha256)
      return path
    }
    const hash = yield* fileSha256(path)
    if (hash !== model.sha256) {
      return yield* new ModelError({
        message: `The depth model at ${path} has hash ${hash}, not ${model.sha256}`,
      })
    }
    return path
  })
