import { Array, Option, Record, Schema, pipe } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import type { IconNode } from 'lucide'

/*
 * Albums and playlists downloaded on this phone. Their songs are kept in the
 * phone's song cache (`playback/songCache.ts`) and never trimmed while a
 * download holds them, so they play with no network. The list lives in
 * localStorage, the songs in Cache Storage.
 */

// MODEL

export const DownloadKind = Schema.Literals(['Album', 'Playlist', 'MyPlaylist'])
export type DownloadKind = typeof DownloadKind.Type

/** An album or playlist downloaded on this phone, with its songs. */
export const DownloadedCollection = Schema.Struct({
  kind: DownloadKind,
  id: Schema.String,
  title: Schema.String,
  subtitle: Schema.String,
  maybeArtworkUrl: Schema.OptionFromNullOr(Schema.String),
  /** Its songs when it was downloaded, in its order. */
  videoIds: Schema.Array(Schema.String),
})
export type DownloadedCollection = typeof DownloadedCollection.Type

export const DownloadsJson = Schema.fromJsonString(
  Schema.Array(DownloadedCollection),
)

/** How much the browser lets this app store, and how much it uses. */
export const StorageEstimate = Schema.Struct({
  usageBytes: Schema.Number,
  quotaBytes: Schema.Number,
})
export type StorageEstimate = typeof StorageEstimate.Type

/** Why a song did not download. */
export const DownloadFailure = Schema.Literals(['OutOfSpace', 'Failed'])
export type DownloadFailure = typeof DownloadFailure.Type

export const Downloads = defineTaggedUnion({
  Loading: {},
  /**
   * The phone has no Cache Storage: a guest on plain HTTP over the home
   * Wi-Fi. Songs stream instead, and nothing can be downloaded.
   */
  Unavailable: {},
  Ready: {
    /** Newest first. */
    collections: Schema.Array(DownloadedCollection),
    /** Downloaded songs on this phone, with their size in bytes. */
    savedBytes: Schema.Record(Schema.String, Schema.Number),
    /** Songs that failed since the app opened; tried again next time. */
    failedVideoIds: Schema.Array(Schema.String),
    /** The song on its way now. One at a time keeps the network for playback. */
    maybeDownloading: Schema.Option(Schema.String),
    maybeStorage: Schema.Option(StorageEstimate),
    /** Downloading stopped because the phone ran out of room. */
    isOutOfSpace: Schema.Boolean,
  },
})
export type Downloads = typeof Downloads.Type
export type ReadyDownloads = Extract<Downloads, { readonly _tag: 'Ready' }>

// CONSTANTS

export const DOWNLOADS_KEY = 'music:downloads'

/**
 * Room left free for everything else the phone stores. A download stops
 * before it would eat into this.
 */
export const MIN_FREE_BYTES = 200 * 1024 * 1024

/** Room assumed for a song before it downloads, as `songCache` does. */
export const ASSUMED_SONG_BYTES = 5 * 1024 * 1024

// HELPERS

export const isSameCollection = (
  left: Readonly<{ kind: DownloadKind; id: string }>,
  right: Readonly<{ kind: DownloadKind; id: string }>,
): boolean => left.kind === right.kind && left.id === right.id

/** Every song any download holds. */
export const pinnedVideoIds = (
  collections: ReadonlyArray<DownloadedCollection>,
): ReadonlySet<string> =>
  new Set(Array.flatMap(collections, ({ videoIds }) => videoIds))

export const findDownload = (
  downloads: Downloads,
  kind: DownloadKind,
  id: string,
): Option.Option<DownloadedCollection> =>
  downloads._tag === 'Ready'
    ? Array.findFirst(downloads.collections, collection =>
        isSameCollection(collection, { kind, id }),
      )
    : Option.none()

/** The next song to download: the first one missing, oldest download first. */
export const nextToDownload = (ready: ReadyDownloads): Option.Option<string> =>
  pipe(
    Array.reverse(ready.collections),
    Array.flatMap(({ videoIds }) => videoIds),
    Array.findFirst(
      videoId =>
        !Record.has(ready.savedBytes, videoId) &&
        !Array.contains(ready.failedVideoIds, videoId),
    ),
  )

/** How far a download has got, and how much room its songs take. */
export interface DownloadProgress {
  readonly saved: number
  readonly total: number
  readonly bytes: number
}

export const downloadProgress = (
  ready: ReadyDownloads,
  collection: DownloadedCollection,
): DownloadProgress =>
  Array.reduce(
    Array.dedupe(collection.videoIds),
    { saved: 0, total: 0, bytes: 0 },
    (progress, videoId) =>
      Option.match(Record.get(ready.savedBytes, videoId), {
        onNone: () => ({ ...progress, total: progress.total + 1 }),
        onSome: bytes => ({
          saved: progress.saved + 1,
          total: progress.total + 1,
          bytes: progress.bytes + bytes,
        }),
      }),
  )

/** Room every downloaded song takes together, each counted once. */
export const totalDownloadedBytes = (ready: ReadyDownloads): number => {
  const pinned = pinnedVideoIds(ready.collections)
  return Array.reduce(
    Record.toEntries(ready.savedBytes),
    0,
    (total, [videoId, bytes]) => (pinned.has(videoId) ? total + bytes : total),
  )
}

/** What a page's Download button shows. */
export const DownloadStatus = defineTaggedUnion({
  /** Nothing can be downloaded on this phone, or it is still checking. */
  Unavailable: {},
  NotDownloaded: {},
  Downloading: { saved: Schema.Number, total: Schema.Number },
  /** Some songs could not be saved; they are tried again later. */
  Incomplete: { saved: Schema.Number, total: Schema.Number },
  Downloaded: { bytes: Schema.Number },
})
export type DownloadStatus = typeof DownloadStatus.Type

export const downloadStatus = (
  downloads: Downloads,
  kind: DownloadKind,
  id: string,
): DownloadStatus => {
  if (downloads._tag !== 'Ready') {
    return DownloadStatus.Unavailable()
  }
  return Option.match(findDownload(downloads, kind, id), {
    onNone: () => DownloadStatus.NotDownloaded(),
    onSome: collection => {
      const progress = downloadProgress(downloads, collection)
      if (progress.saved === progress.total) {
        return DownloadStatus.Downloaded({ bytes: progress.bytes })
      }
      const isWaiting = Array.some(
        collection.videoIds,
        videoId =>
          !Record.has(downloads.savedBytes, videoId) &&
          !Array.contains(downloads.failedVideoIds, videoId),
      )
      return isWaiting && !downloads.isOutOfSpace
        ? DownloadStatus.Downloading({
            saved: progress.saved,
            total: progress.total,
          })
        : DownloadStatus.Incomplete({
            saved: progress.saved,
            total: progress.total,
          })
    },
  })
}

/** Whether the phone has room for one more song, as far as it can tell. */
export const hasRoomForSong = (
  maybeStorage: Option.Option<StorageEstimate>,
): boolean =>
  Option.match(maybeStorage, {
    onNone: () => true,
    onSome: ({ usageBytes, quotaBytes }) =>
      quotaBytes - usageBytes >= MIN_FREE_BYTES + ASSUMED_SONG_BYTES,
  })

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

/** A size as people read it: "820 KB", "48 MB", "1.2 GB". */
export const formatBytes = (bytes: number): string => {
  if (bytes >= GB) {
    return `${(bytes / GB).toFixed(1)} GB`
  } else if (bytes >= MB) {
    return `${Math.round(bytes / MB)} MB`
  } else {
    return `${Math.max(0, Math.round(bytes / KB))} KB`
  }
}

/** "12 songs · 48 MB", or how far a download has got. */
export const downloadSummary = (
  ready: ReadyDownloads,
  collection: DownloadedCollection,
): string => {
  const progress = downloadProgress(ready, collection)
  const songs = `${progress.total} ${progress.total === 1 ? 'song' : 'songs'}`
  return progress.saved === progress.total
    ? `${songs} · ${formatBytes(progress.bytes)}`
    : `${progress.saved} of ${songs} · ${formatBytes(progress.bytes)}`
}

const RING_RADIUS = 9
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/**
 * A download's progress as an icon: a ring that fills as songs arrive, with
 * the arrow inside, drawn like lucide's icons so it sits among them.
 */
export const progressRing = (fraction: number): IconNode => [
  ['circle', { cx: '12', cy: '12', r: `${RING_RADIUS}`, opacity: '0.3' }],
  [
    'circle',
    {
      cx: '12',
      cy: '12',
      r: `${RING_RADIUS}`,
      'stroke-dasharray': `${(Math.min(1, Math.max(0, fraction)) * RING_LENGTH).toFixed(2)} ${RING_LENGTH.toFixed(2)}`,
      transform: 'rotate(-90 12 12)',
    },
  ],
  ['path', { d: 'M12 8v8' }],
  ['path', { d: 'm8.5 12.5 3.5 3.5 3.5-3.5' }],
]
