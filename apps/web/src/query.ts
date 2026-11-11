import { Effect, Match, Schema } from 'effect'
import { type RpcClientError } from 'effect/rpc'
import { Query } from 'foldkit/experimental'

import {
  AlbumDetails,
  AlbumSummary,
  ArtistDetails,
  ArtistSummary,
  type MusicNotFoundError,
  Song,
  SongDetails,
  type YouTubeMusicError,
} from '@music/shared'

import { MusicClient } from './rpc'

/** What the person sees when a request fails. */
export const RequestError = Schema.Literals([
  'NotFound',
  'YouTubeUnavailable',
  'ServerUnreachable',
])
export type RequestError = typeof RequestError.Type

type MusicRequestFailure =
  | MusicNotFoundError
  | YouTubeMusicError
  | RpcClientError.RpcClientError

const toRequestError = (failure: MusicRequestFailure): RequestError =>
  Match.valueTags(failure, {
    MusicNotFoundError: (): RequestError => 'NotFound',
    YouTubeMusicError: (): RequestError => 'YouTubeUnavailable',
    RpcClientError: (): RequestError => 'ServerUnreachable',
  })

const withRequestError = <A, E extends MusicRequestFailure, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.mapError(effect, toRequestError)

const SearchArgs = { query: Schema.String }

export const songSearchQuery = Query.define({
  name: 'SongSearch',
  args: SearchArgs,
  data: Schema.Array(Song),
  error: RequestError,
  execute: ({ query }) =>
    MusicClient.use(client => client.searchSongs({ query })).pipe(
      withRequestError,
    ),
})

export const artistSearchQuery = Query.define({
  name: 'ArtistSearch',
  args: SearchArgs,
  data: Schema.Array(ArtistSummary),
  error: RequestError,
  execute: ({ query }) =>
    MusicClient.use(client => client.searchArtists({ query })).pipe(
      withRequestError,
    ),
})

export const albumSearchQuery = Query.define({
  name: 'AlbumSearch',
  args: SearchArgs,
  data: Schema.Array(AlbumSummary),
  error: RequestError,
  execute: ({ query }) =>
    MusicClient.use(client => client.searchAlbums({ query })).pipe(
      withRequestError,
    ),
})

export const songQuery = Query.define({
  name: 'Song',
  args: { videoId: Schema.String },
  data: SongDetails,
  error: RequestError,
  execute: ({ videoId }) =>
    MusicClient.use(client => client.getSong({ videoId })).pipe(
      withRequestError,
    ),
})

export const artistQuery = Query.define({
  name: 'Artist',
  args: { artistId: Schema.String },
  data: ArtistDetails,
  error: RequestError,
  execute: ({ artistId }) =>
    MusicClient.use(client => client.getArtist({ artistId })).pipe(
      withRequestError,
    ),
})

export const albumQuery = Query.define({
  name: 'Album',
  args: { albumId: Schema.String },
  data: AlbumDetails,
  error: RequestError,
  execute: ({ albumId }) =>
    MusicClient.use(client => client.getAlbum({ albumId })).pipe(
      withRequestError,
    ),
})
