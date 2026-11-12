import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import {
  AlbumDetails,
  AlbumSummary,
  ArtistDetails,
  ArtistSummary,
  MusicNotFoundError,
  MyLibrary,
  MyPlaylistDetails,
  PlaylistDetails,
  PlaylistEdit,
  PlaylistEditResult,
  PlaylistStoreError,
  PlaylistSummary,
  Song,
  SongDetails,
  YouTubeMusicError,
} from './domain.ts'

/** A color as `#rrggbb` sRGB. */
const HexColor = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/))

const SearchPayload = Schema.Struct({ query: Schema.String })

const LookupError = Schema.Union([MusicNotFoundError, YouTubeMusicError])

export const searchSongsRpc = Rpc.make('searchSongs', {
  payload: SearchPayload,
  success: Schema.Array(Song),
  error: YouTubeMusicError,
})

export const searchArtistsRpc = Rpc.make('searchArtists', {
  payload: SearchPayload,
  success: Schema.Array(ArtistSummary),
  error: YouTubeMusicError,
})

export const searchAlbumsRpc = Rpc.make('searchAlbums', {
  payload: SearchPayload,
  success: Schema.Array(AlbumSummary),
  error: YouTubeMusicError,
})

export const searchPlaylistsRpc = Rpc.make('searchPlaylists', {
  payload: SearchPayload,
  success: Schema.Array(PlaylistSummary),
  error: YouTubeMusicError,
})

export const getSongRpc = Rpc.make('getSong', {
  payload: Schema.Struct({ videoId: Schema.String }),
  success: SongDetails,
  error: LookupError,
})

export const getArtistRpc = Rpc.make('getArtist', {
  payload: Schema.Struct({ artistId: Schema.String }),
  success: ArtistDetails,
  error: LookupError,
})

export const getAlbumRpc = Rpc.make('getAlbum', {
  payload: Schema.Struct({ albumId: Schema.String }),
  success: AlbumDetails,
  error: LookupError,
})

export const getPlaylistRpc = Rpc.make('getPlaylist', {
  payload: Schema.Struct({ playlistId: Schema.String }),
  success: PlaylistDetails,
  error: LookupError,
})

export const getMyLibraryRpc = Rpc.make('getMyLibrary', {
  success: MyLibrary,
  error: PlaylistStoreError,
})

export const getMyPlaylistRpc = Rpc.make('getMyPlaylist', {
  payload: Schema.Struct({ playlistId: Schema.String }),
  success: MyPlaylistDetails,
  error: Schema.Union([MusicNotFoundError, PlaylistStoreError]),
})

export const editPlaylistsRpc = Rpc.make('editPlaylists', {
  payload: Schema.Struct({ edit: PlaylistEdit }),
  success: PlaylistEditResult,
  error: Schema.Union([MusicNotFoundError, PlaylistStoreError]),
})

/**
 * The full player's background for a song's artwork: a dark version of the
 * color the cover reads as. Null when the artwork cannot be read.
 */
export const getArtworkBackdropRpc = Rpc.make('getArtworkBackdrop', {
  payload: Schema.Struct({ artworkUrl: Schema.String }),
  success: Schema.NullOr(HexColor),
})

/**
 * Every call the web app makes to the music server: the YouTube Music
 * catalog, and the playlists made in the app.
 */
export const MusicRpcs = RpcGroup.make(
  searchSongsRpc,
  searchArtistsRpc,
  searchAlbumsRpc,
  searchPlaylistsRpc,
  getSongRpc,
  getArtistRpc,
  getAlbumRpc,
  getPlaylistRpc,
  getMyLibraryRpc,
  getMyPlaylistRpc,
  editPlaylistsRpc,
  getArtworkBackdropRpc,
)
export type MusicRpcs = typeof MusicRpcs
