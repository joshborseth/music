import { Array, Option } from 'effect'

import { type AlbumDetails, type PlaylistDetails } from '@music/shared'

import { type DownloadedCollection } from '../downloads/domain'
import { artistNames, artworkUrl } from './shared'

/** Artwork width kept for a download's row in the Library. */
export const DOWNLOAD_ARTWORK_WIDTH = 180

/** What downloading an album keeps, for its page's arrow and its ⋯ sheet. */
export const albumDownload = ({
  album,
  tracks,
}: AlbumDetails): DownloadedCollection => ({
  kind: 'Album',
  id: album.id,
  title: album.title,
  subtitle: artistNames(album.artists),
  maybeArtworkUrl: artworkUrl(album.artwork, DOWNLOAD_ARTWORK_WIDTH),
  videoIds: Array.map(tracks, ({ videoId }) => videoId),
})

/** What downloading a playlist keeps, for its page's arrow and its ⋯ sheet. */
export const playlistDownload = ({
  playlist,
  maybeOwner,
  tracks,
}: PlaylistDetails): DownloadedCollection => ({
  kind: 'Playlist',
  id: playlist.id,
  title: playlist.title,
  subtitle: Option.match(maybeOwner, {
    onNone: () => Option.getOrElse(playlist.maybeSubtitle, () => 'Playlist'),
    onSome: ({ name }) => name,
  }),
  maybeArtworkUrl: artworkUrl(playlist.artwork, DOWNLOAD_ARTWORK_WIDTH),
  videoIds: Array.map(tracks, ({ videoId }) => videoId),
})
