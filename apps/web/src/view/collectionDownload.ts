import { Array, Option } from 'effect'

import {
  type AlbumDetails,
  type MyPlaylistDetails,
  type PlaylistDetails,
} from '@music/shared'

import { type DownloadedCollection, OfflineCopy } from '../downloads/domain'
import { artistNames, artworkUrl } from './shared'

/** Artwork width kept for a download's row in the Library. */
export const DOWNLOAD_ARTWORK_WIDTH = 180

/**
 * What downloading an album or playlist keeps: its row in the list, and a
 * copy of its page for when the server can't be reached.
 */
export interface DownloadRequest {
  readonly collection: DownloadedCollection
  readonly copy: OfflineCopy
}

/** What downloading an album keeps, for its page's arrow and its ⋯ sheet. */
export const albumDownload = (details: AlbumDetails): DownloadRequest => ({
  collection: {
    kind: 'Album',
    id: details.album.id,
    title: details.album.title,
    subtitle: artistNames(details.album.artists),
    maybeArtworkUrl: artworkUrl(details.album.artwork, DOWNLOAD_ARTWORK_WIDTH),
    videoIds: Array.map(details.tracks, ({ videoId }) => videoId),
  },
  copy: OfflineCopy.Album({ details }),
})

/** What downloading a playlist keeps, for its page's arrow and its ⋯ sheet. */
export const playlistDownload = (
  details: PlaylistDetails,
): DownloadRequest => ({
  collection: {
    kind: 'Playlist',
    id: details.playlist.id,
    title: details.playlist.title,
    subtitle: Option.match(details.maybeOwner, {
      onNone: () =>
        Option.getOrElse(details.playlist.maybeSubtitle, () => 'Playlist'),
      onSome: ({ name }) => name,
    }),
    maybeArtworkUrl: artworkUrl(
      details.playlist.artwork,
      DOWNLOAD_ARTWORK_WIDTH,
    ),
    videoIds: Array.map(details.tracks, ({ videoId }) => videoId),
  },
  copy: OfflineCopy.Playlist({ details }),
})

/** What downloading one of my playlists keeps, for its page's arrow. */
export const myPlaylistDownload = (
  details: MyPlaylistDetails,
): DownloadRequest => ({
  collection: {
    kind: 'MyPlaylist',
    id: details.playlist.id,
    title: details.playlist.title,
    subtitle: details.playlist.isLiked ? 'Your likes' : 'Your playlist',
    maybeArtworkUrl: Option.flatMap(
      Array.head(details.playlist.covers),
      cover => artworkUrl(cover, DOWNLOAD_ARTWORK_WIDTH),
    ),
    videoIds: Array.map(details.songs, ({ videoId }) => videoId),
  },
  copy: OfflineCopy.MyPlaylist({ details }),
})
