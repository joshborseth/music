import { Exit, Schema } from 'effect'

import { analyzeSamples } from './analyze.ts'
import { WorkerReply, WorkerRequest } from './protocol.ts'

/*
 * Runs one song's analysis off the server's main thread, which also drives
 * the playback session's WebSocket. Receives a `WorkerRequest`, answers one
 * `WorkerReply`.
 */

declare const self: Worker

const decodeRequest = Schema.decodeUnknownExit(WorkerRequest)
const encodeReply = Schema.encodeSync(WorkerReply)

const answer = (request: WorkerRequest): WorkerReply => {
  try {
    return {
      _tag: 'Done',
      analysis: analyzeSamples(request.videoId, request.samples),
    }
  } catch (error) {
    return {
      _tag: 'Failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

self.addEventListener('message', event => {
  const reply = Exit.match(decodeRequest(event.data), {
    onFailure: (): WorkerReply => ({
      _tag: 'Failed',
      message: 'The worker got a malformed request',
    }),
    onSuccess: answer,
  })
  self.postMessage(encodeReply(reply))
})
