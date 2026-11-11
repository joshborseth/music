import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import {
  AlbumDetails,
  AlbumSummary,
  ArtistDetails,
  ArtistSummary,
  MusicNotFoundError,
  Song,
  SongDetails,
  YouTubeMusicError,
} from './domain.ts'

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

/** Every read-only call the web app makes to the music server. */
export const MusicRpcs = RpcGroup.make(
  searchSongsRpc,
  searchArtistsRpc,
  searchAlbumsRpc,
  getSongRpc,
  getArtistRpc,
  getAlbumRpc,
)
export type MusicRpcs = typeof MusicRpcs
