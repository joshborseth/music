import { Schema } from 'effect'

import { Tv } from '@music/shared'

/** What the server sends the analysis worker: the song's samples, transferred. */
export const WorkerRequest = Schema.Struct({
  videoId: Schema.String,
  samples: Schema.instanceOf(Float32Array),
})
export type WorkerRequest = typeof WorkerRequest.Type

/** What the worker answers. */
export const WorkerReply = Schema.Union([
  Schema.TaggedStruct('Done', { analysis: Tv.TvAnalysis }),
  Schema.TaggedStruct('Failed', { message: Schema.String }),
])
export type WorkerReply = typeof WorkerReply.Type
