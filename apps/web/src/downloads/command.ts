import { Effect, Match, Option, Schema } from 'effect'
import { Command } from 'foldkit'

import { Message } from '../message'
import {
  downloadSong,
  loadDownloads,
  removeSongs,
  saveDownloads,
  storageEstimate,
} from '../playback/songCache'
import { MusicClient } from '../rpc'
import {
  DownloadKind,
  DownloadedCollection,
  OfflineCopy,
  hasRoomForSong,
} from './domain'
import {
  loadOfflineCopies,
  removeOfflineCopy,
  saveOfflineCopy,
} from './offlineCopies'

// COMMAND

export const LoadDownloads = Command.define('LoadDownloads', {
  messages: [Message.SucceededLoadDownloads, Message.FailedLoadDownloads],
  execute: Effect.gen(function* () {
    const maybeLoaded = yield* loadDownloads
    const maybeStorage = yield* storageEstimate
    const copies = yield* loadOfflineCopies
    return Option.match(maybeLoaded, {
      onNone: () => Message.FailedLoadDownloads(),
      onSome: ({ collections, savedBytes }) =>
        Message.SucceededLoadDownloads({
          collections,
          savedBytes,
          copies,
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

/** Keep a download's page and covers, for when the server can't be reached. */
export const SaveOfflineCopy = Command.define('SaveOfflineCopy', {
  args: { copy: OfflineCopy },
  messages: [Message.CompletedSaveOfflineCopy],
  execute: ({ copy }) =>
    saveOfflineCopy(copy).pipe(Effect.as(Message.CompletedSaveOfflineCopy())),
})

/**
 * Fetch and keep the page of a download made before downloads kept one, so
 * it too shows with no server.
 */
export const FetchOfflineCopy = Command.define('FetchOfflineCopy', {
  args: { kind: DownloadKind, id: Schema.String },
  messages: [Message.SucceededFetchOfflineCopy, Message.FailedFetchOfflineCopy],
  execute: ({ kind, id }) =>
    MusicClient.use(client =>
      Match.value(kind).pipe(
        Match.when('Album', () =>
          Effect.map(client.getAlbum({ albumId: id }), details =>
            OfflineCopy.Album({ details }),
          ),
        ),
        Match.when('Playlist', () =>
          Effect.map(client.getPlaylist({ playlistId: id }), details =>
            OfflineCopy.Playlist({ details }),
          ),
        ),
        Match.when('MyPlaylist', () =>
          Effect.map(client.getMyPlaylist({ playlistId: id }), details =>
            OfflineCopy.MyPlaylist({ details }),
          ),
        ),
        Match.exhaustive,
      ),
    ).pipe(
      Effect.tap(saveOfflineCopy),
      Effect.map(copy => Message.SucceededFetchOfflineCopy({ copy })),
      Effect.catch(() => Effect.succeed(Message.FailedFetchOfflineCopy())),
    ),
})

/** Forget a removed download's page, and the covers no other one shows. */
export const RemoveOfflineCopy = Command.define('RemoveOfflineCopy', {
  args: {
    kind: DownloadKind,
    id: Schema.String,
    maybeCopy: Schema.Option(OfflineCopy),
    keptArtworkUrls: Schema.Array(Schema.String),
  },
  messages: [Message.CompletedRemoveOfflineCopy],
  execute: ({ kind, id, maybeCopy, keptArtworkUrls }) =>
    removeOfflineCopy(kind, id, maybeCopy, keptArtworkUrls).pipe(
      Effect.as(Message.CompletedRemoveOfflineCopy()),
    ),
})
