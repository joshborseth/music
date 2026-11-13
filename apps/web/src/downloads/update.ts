import { Array, Option, Record } from 'effect'
import { type Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import type { Message } from '../message'
import type { Model } from '../model'
import type { PlaybackServices } from '../playback/resource'
import { receiveNotice } from '../playback/update'
import { type MusicClient } from '../rpc'
import {
  DownloadSong,
  FetchOfflineCopy,
  RemoveDownloadedSongs,
  RemoveOfflineCopy,
  SaveDownloads,
  SaveOfflineCopy,
} from './command'
import {
  type DownloadFailure,
  type DownloadKind,
  type DownloadedCollection,
  Downloads,
  type OfflineCopy,
  type ReadyDownloads,
  type StorageEstimate,
  copyKey,
  copyOf,
  isSameCollection,
  nextToDownload,
  offlineArtworkUrls,
  pinnedVideoIds,
} from './domain'

type DownloadsReturn = Update.Return<
  Model,
  Message,
  MusicClient | PlaybackServices
>

// UPDATE

/** Change the downloads once they have loaded; before that nothing can. */
const withReady = (
  model: Model,
  change: (ready: ReadyDownloads) => DownloadsReturn,
): DownloadsReturn =>
  model.downloads._tag === 'Ready' ? change(model.downloads) : { model }

const withDownloads = (model: Model, ready: ReadyDownloads): Model =>
  modifyFields(model, { downloads: () => ready })

const latestStorage =
  (maybeStorage: Option.Option<StorageEstimate>) =>
  (before: Option.Option<StorageEstimate>) =>
    Option.orElse(maybeStorage, () => before)

/** Start the next missing song, one at a time, while there is room. */
const continueDownloading = (model: Model): DownloadsReturn =>
  withReady(model, ready => {
    if (Option.isSome(ready.maybeDownloading) || ready.isOutOfSpace) {
      return { model }
    }
    return Option.match(nextToDownload(ready), {
      onNone: () => ({ model }),
      onSome: videoId => ({
        model: withDownloads(
          model,
          modifyFields(ready, {
            maybeDownloading: () => Option.some(videoId),
          }),
        ),
        commands: [DownloadSong({ videoId })],
      }),
    })
  })

/**
 * The downloads on the phone pick up where they left off. One made before
 * downloads kept a copy of their page fetches it now.
 */
export const succeedLoadDownloads = (
  model: Model,
  collections: ReadonlyArray<DownloadedCollection>,
  savedBytes: Readonly<Record<string, number>>,
  copies: Readonly<Record<string, OfflineCopy>>,
  maybeStorage: Option.Option<StorageEstimate>,
): DownloadsReturn => {
  const continued = continueDownloading(
    modifyFields(model, {
      downloads: () =>
        Downloads.Ready({
          collections,
          savedBytes,
          copies,
          failedVideoIds: [],
          maybeDownloading: Option.none(),
          maybeStorage,
          isOutOfSpace: false,
        }),
    }),
  )
  const missingCopies = Array.filter(
    collections,
    ({ kind, id }) => !Record.has(copies, copyKey(kind, id)),
  )
  return {
    model: continued.model,
    commands: [
      ...(continued.commands ?? []),
      ...Array.map(missingCopies, ({ kind, id }) =>
        FetchOfflineCopy({ kind, id }),
      ),
    ],
  }
}

/** A download made before downloads kept a copy of their page has one now. */
export const succeedFetchOfflineCopy = (
  model: Model,
  copy: OfflineCopy,
): DownloadsReturn =>
  withReady(model, ready => {
    const { kind, id } = copyOf(copy)
    return {
      model: withDownloads(
        model,
        modifyFields(ready, {
          copies: copies => Record.set(copies, copyKey(kind, id), copy),
        }),
      ),
    }
  })

export const failLoadDownloads = (model: Model): DownloadsReturn => ({
  model: modifyFields(model, { downloads: () => Downloads.Unavailable() }),
})

/**
 * Download an album or playlist: keep it in the list and fetch its songs.
 * Asking again after the phone ran out of room tries once more.
 */
export const startDownload = (
  model: Model,
  collection: DownloadedCollection,
  copy: OfflineCopy,
): DownloadsReturn =>
  withReady(model, ready => {
    const collections = [
      collection,
      ...Array.filter(
        ready.collections,
        existing => !isSameCollection(existing, collection),
      ),
    ]
    const started = continueDownloading(
      withDownloads(
        model,
        modifyFields(ready, {
          collections: () => collections,
          copies: copies =>
            Record.set(copies, copyKey(collection.kind, collection.id), copy),
          failedVideoIds: failed =>
            Array.filter(
              failed,
              videoId => !Array.contains(collection.videoIds, videoId),
            ),
          isOutOfSpace: () => false,
        }),
      ),
    )
    return {
      model: started.model,
      commands: [
        SaveDownloads({ collections }),
        SaveOfflineCopy({ copy }),
        ...(started.commands ?? []),
      ],
    }
  })

export const succeedDownloadSong = (
  model: Model,
  videoId: string,
  bytes: number,
  maybeStorage: Option.Option<StorageEstimate>,
): DownloadsReturn =>
  withReady(model, ready =>
    continueDownloading(
      withDownloads(
        model,
        modifyFields(ready, {
          savedBytes: saved => Record.set(saved, videoId, bytes),
          maybeDownloading: () => Option.none(),
          maybeStorage: latestStorage(maybeStorage),
        }),
      ),
    ),
  )

/**
 * A song did not download. Out of room, downloading stops and says so;
 * otherwise the song is skipped until the app opens again.
 */
export const failDownloadSong = (
  model: Model,
  videoId: string,
  failure: DownloadFailure,
  maybeStorage: Option.Option<StorageEstimate>,
): DownloadsReturn =>
  withReady(model, ready => {
    const stopped = modifyFields(ready, {
      maybeDownloading: () => Option.none(),
      maybeStorage: latestStorage(maybeStorage),
    })
    return failure === 'OutOfSpace'
      ? receiveNotice(
          withDownloads(
            model,
            modifyFields(stopped, { isOutOfSpace: () => true }),
          ),
          'This phone is nearly full, so downloading stopped.',
        )
      : continueDownloading(
          withDownloads(
            model,
            modifyFields(stopped, {
              failedVideoIds: failed => Array.append(failed, videoId),
            }),
          ),
        )
  })

/**
 * Remove a download. Its songs that no other download holds leave the
 * phone, and the room they took is free for the rest.
 */
export const removeDownload = (
  model: Model,
  kind: DownloadKind,
  id: string,
): DownloadsReturn =>
  withReady(model, ready =>
    Option.match(
      Array.findFirst(ready.collections, collection =>
        isSameCollection(collection, { kind, id }),
      ),
      {
        onNone: () => ({ model }),
        onSome: removed => {
          const collections = Array.filter(
            ready.collections,
            collection => !isSameCollection(collection, removed),
          )
          const stillPinned = pinnedVideoIds(collections)
          const freed = Array.filter(
            Array.dedupe(removed.videoIds),
            videoId => !stillPinned.has(videoId),
          )
          const key = copyKey(removed.kind, removed.id)
          const copies = Record.remove(ready.copies, key)
          const continued = continueDownloading(
            withDownloads(
              model,
              modifyFields(ready, {
                collections: () => collections,
                copies: () => copies,
                savedBytes: saved =>
                  Record.filter(
                    saved,
                    (_, videoId) => !Array.contains(freed, videoId),
                  ),
                isOutOfSpace: () => false,
              }),
            ),
          )
          return {
            model: continued.model,
            commands: [
              SaveDownloads({ collections }),
              RemoveDownloadedSongs({ videoIds: freed }),
              RemoveOfflineCopy({
                kind: removed.kind,
                id: removed.id,
                maybeCopy: Record.get(ready.copies, key),
                keptArtworkUrls: Array.flatMap(
                  Record.values(copies),
                  offlineArtworkUrls,
                ),
              }),
              ...(continued.commands ?? []),
            ],
          }
        },
      },
    ),
  )

export const completeRemoveDownloadedSongs = (
  model: Model,
  maybeStorage: Option.Option<StorageEstimate>,
): DownloadsReturn =>
  withReady(model, ready => ({
    model: withDownloads(
      model,
      modifyFields(ready, { maybeStorage: latestStorage(maybeStorage) }),
    ),
  }))
