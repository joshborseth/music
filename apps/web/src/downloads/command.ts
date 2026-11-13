import { Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'

import { Message } from '../message'
import {
  downloadSong,
  loadDownloads,
  removeSongs,
  saveDownloads,
  storageEstimate,
} from '../playback/songCache'
import { DownloadedCollection, hasRoomForSong } from './domain'

// COMMAND

export const LoadDownloads = Command.define('LoadDownloads', {
  messages: [Message.SucceededLoadDownloads, Message.FailedLoadDownloads],
  execute: Effect.gen(function* () {
    const maybeLoaded = yield* loadDownloads
    const maybeStorage = yield* storageEstimate
    return Option.match(maybeLoaded, {
      onNone: () => Message.FailedLoadDownloads(),
      onSome: ({ collections, savedBytes }) =>
        Message.SucceededLoadDownloads({
          collections,
          savedBytes,
          maybeStorage,
        }),
    })
  }),
})

export const SaveDownloads = Command.define('SaveDownloads', {
  args: { collections: Schema.Array(DownloadedCollection) },
  messages: [Message.CompletedSaveDownloads],
  execute: ({ collections }) =>
    saveDownloads(collections).pipe(
      Effect.as(Message.CompletedSaveDownloads()),
    ),
})

/**
 * Save one song of a download on the phone, unless the phone is nearly
 * full: the browser would start clearing the app's storage, songs and all.
 */
export const DownloadSong = Command.define('DownloadSong', {
  args: { videoId: Schema.String },
  messages: [Message.SucceededDownloadSong, Message.FailedDownloadSong],
  execute: ({ videoId }) =>
    Effect.gen(function* () {
      const maybeBefore = yield* storageEstimate
      if (!hasRoomForSong(maybeBefore)) {
        return Message.FailedDownloadSong({
          videoId,
          failure: 'OutOfSpace',
          maybeStorage: maybeBefore,
        })
      }
      const bytes = yield* downloadSong(videoId)
      const maybeStorage = yield* storageEstimate
      return Message.SucceededDownloadSong({ videoId, bytes, maybeStorage })
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          Message.FailedDownloadSong({
            videoId,
            failure: 'Failed',
            maybeStorage: Option.none(),
          }),
        ),
      ),
    ),
})

/** Give back the room a removed download's songs took. */
export const RemoveDownloadedSongs = Command.define('RemoveDownloadedSongs', {
  args: { videoIds: Schema.Array(Schema.String) },
  messages: [Message.CompletedRemoveDownloadedSongs],
  execute: ({ videoIds }) =>
    Effect.andThen(removeSongs(videoIds), storageEstimate).pipe(
      Effect.map(maybeStorage =>
        Message.CompletedRemoveDownloadedSongs({ maybeStorage }),
      ),
    ),
})
