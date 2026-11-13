import {
  offlineAlbum,
  offlineMyPlaylist,
  offlinePlaylist,
  orOfflineCopy,
} from '../downloads/domain'
import { type Model } from '../model'
import { albumQuery, myPlaylistQuery, playlistQuery } from '../query'

/*
 * The pages a download keeps a copy of read through these: the server's
 * answer when it has one, otherwise the download's copy, so a downloaded
 * album or playlist opens and plays with no server.
 */

export const albumData = (
  model: Pick<Model, 'albums' | 'downloads'>,
  albumId: string,
) =>
  orOfflineCopy(
    albumQuery.read(model.albums, { albumId }),
    offlineAlbum(model.downloads, albumId),
  )

export const playlistData = (
  model: Pick<Model, 'playlists' | 'downloads'>,
  playlistId: string,
) =>
  orOfflineCopy(
    playlistQuery.read(model.playlists, { playlistId }),
    offlinePlaylist(model.downloads, playlistId),
  )

export const myPlaylistData = (
  model: Pick<Model, 'myPlaylists' | 'downloads'>,
  playlistId: string,
) =>
  orOfflineCopy(
    myPlaylistQuery.read(model.myPlaylists, { playlistId }),
    offlineMyPlaylist(model.downloads, playlistId),
  )
