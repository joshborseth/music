import { Array, Option, Record, Schema, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { defineTaggedUnion } from 'foldkit/schema'
import type { IconNode } from 'lucide'

import {
  AlbumDetails,
  type Artwork,
  MyPlaylistDetails,
  PlaylistDetails,
} from '@music/shared'

/*
 * Albums and playlists downloaded on this phone. Their songs are kept in the
 * phone's song cache (`playback/songCache.ts`) and never trimmed while a
 * download holds them, so they play with no network. The list lives in
 * localStorage, the songs in Cache Storage.
 *
 * Each download also keeps a copy of its page (`OfflineCopy`: the album's or
 * playlist's title, artists, and cover, and each song's), and its covers, in
 * Cache Storage (`offlineCopies.ts`). With no server, its page, its songs,
 * and the Library show from that copy.
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

/**
 * A download's page as it was when it was downloaded: everything its page
 * shows and plays, for when the server can't be reached.
 */
export const OfflineCopy = defineTaggedUnion({
  Album: { details: AlbumDetails },
  Playlist: { details: PlaylistDetails },
  MyPlaylist: { details: MyPlaylistDetails },
})
export type OfflineCopy = typeof OfflineCopy.Type

export const OfflineCopyJson = Schema.fromJsonString(
  Schema.toCodecJson(OfflineCopy),
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
    /** Each download's page, by `copyKey`, once it is saved. */
    copies: Schema.Record(Schema.String, OfflineCopy),
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

/** Where a download's copy is kept, in the Model and in Cache Storage. */
export const copyKey = (kind: DownloadKind, id: string): string =>
  `${kind}:${id}`

/** The album or playlist a copy is of. */
type CollectionId = Readonly<{ kind: DownloadKind; id: string }>

export const copyOf = (copy: OfflineCopy): CollectionId =>
  OfflineCopy.match(copy, {
    Album: ({ details }): CollectionId => ({
      kind: 'Album',
      id: details.album.id,
    }),
    Playlist: ({ details }): CollectionId => ({
      kind: 'Playlist',
      id: details.playlist.id,
    }),
    MyPlaylist: ({ details }): CollectionId => ({
      kind: 'MyPlaylist',
      id: details.playlist.id,
    }),
  })

const findCopy = (
  downloads: Downloads,
  kind: DownloadKind,
  id: string,
): Option.Option<OfflineCopy> =>
  downloads._tag === 'Ready' && Option.isSome(findDownload(downloads, kind, id))
    ? Record.get(downloads.copies, copyKey(kind, id))
    : Option.none()

/** The saved copy of a downloaded album's page. */
export const offlineAlbum = (
  downloads: Downloads,
  albumId: string,
): Option.Option<AlbumDetails> =>
  Option.flatMap(findCopy(downloads, 'Album', albumId), copy =>
    copy._tag === 'Album' ? Option.some(copy.details) : Option.none(),
  )

/** The saved copy of a downloaded YouTube Music playlist's page. */
export const offlinePlaylist = (
  downloads: Downloads,
  playlistId: string,
): Option.Option<PlaylistDetails> =>
  Option.flatMap(findCopy(downloads, 'Playlist', playlistId), copy =>
    copy._tag === 'Playlist' ? Option.some(copy.details) : Option.none(),
  )

/** The saved copy of one of my downloaded playlists. */
export const offlineMyPlaylist = (
  downloads: Downloads,
  playlistId: string,
): Option.Option<MyPlaylistDetails> =>
  Option.flatMap(findCopy(downloads, 'MyPlaylist', playlistId), copy =>
    copy._tag === 'MyPlaylist' ? Option.some(copy.details) : Option.none(),
  )

/**
 * A page's data, or a download's saved copy of it until the server
 * answers: the copy shows at once, and stays when the server can't be
 * reached. What the server sends replaces it.
 */
export const orOfflineCopy = <A, E>(
  data: AsyncData.AsyncData<A, E>,
  maybeCopy: Option.Option<A>,
): AsyncData.AsyncData<A, E> =>
  AsyncData.hasData(data)
    ? data
    : Option.match(maybeCopy, {
        onNone: () => data,
        onSome: copy => AsyncData.succeed<A, E>(copy),
      })

// ARTWORK

/**
 * The cache the covers of downloads are kept in. The service worker looks
 * there when an image can't be fetched (`vite.config.ts`), so keep the name
 * and `artworkKey` in step with it.
 */
export const DOWNLOAD_ARTWORK_CACHE = 'music-download-artwork-v1'

const GOOGLE_IMAGE_HOSTS = /^https:\/\/(lh3|yt3)\.googleusercontent\.com\//
const RESIZABLE_GOOGLE_IMAGE = /=w\d+-h\d+/

/**
 * One image whatever size it is asked for: a Google image without its
 * `=w…-h…` options, any other without its query. The service worker finds a
 * download's cover by it, whatever size the page asks for.
 */
export const artworkKey = (url: string): string =>
  GOOGLE_IMAGE_HOSTS.test(url)
    ? (url.split('=')[0] ?? url)
    : (url.split('?')[0] ?? url)

/** A cover's URL at `pixels`, or as it comes when it can't be resized. */
const sizedArtwork = (
  artwork: Artwork,
  pixels: number,
): Option.Option<string> =>
  Option.map(Array.last(artwork), ({ url }) =>
    url.replace(RESIZABLE_GOOGLE_IMAGE, `=w${pixels}-h${pixels}`),
  )

/** Covers big enough for a page's hero and the full player. */
const COVER_PIXELS = 1080
/** Songs' covers, big enough for a row and, a little soft, the player. */
const SONG_PIXELS = 544

/**
 * The covers a download keeps, each image once: the album's or playlist's
 * own at full size, then its songs'.
 */
export const offlineArtworkUrls = (
  copy: OfflineCopy,
): ReadonlyArray<string> => {
  const { covers, songs } = OfflineCopy.match(copy, {
    Album: ({ details }) => ({
      covers: [details.album.artwork],
      songs: details.tracks,
    }),
    Playlist: ({ details }) => ({
      covers: [details.playlist.artwork],
      songs: details.tracks,
    }),
    MyPlaylist: ({ details }) => ({
      covers: details.playlist.covers,
      songs: details.songs,
    }),
  })
  return pipe(
    [
      ...Array.map(covers, cover => sizedArtwork(cover, COVER_PIXELS)),
      ...Array.map(songs, ({ artwork }) => sizedArtwork(artwork, SONG_PIXELS)),
    ],
    Array.getSomes,
    Array.dedupeWith((left, right) => artworkKey(left) === artworkKey(right)),
  )
}

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
