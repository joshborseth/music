import { Effect, Match, Schema } from 'effect'
import { type RpcClientError } from 'effect/rpc'
import { Query } from 'foldkit/experimental'

import {
  AlbumDetails,
  AlbumSummary,
  ArtistDetails,
  ArtistSummary,
  HomeFeed,
  LibrarySong,
  MoodDetails,
  MoodGroup,
  type MusicNotFoundError,
  MyLibrary,
  MyPlaylistDetails,
  People,
  PlaylistDetails,
  type PlaylistStoreError,
  PlaylistSummary,
  Song,
  SongDetails,
  TopResult,
  Viewer,
  type YouTubeMusicError,
} from '@music/shared'

import { AccountFailure, toAccountFailure } from './account/domain'
import { MusicClient } from './rpc'

/** What the person sees when a request fails. */
export const RequestError = Schema.Literals([
  'NotFound',
  'YouTubeUnavailable',
  'ServerUnreachable',
  'PlaylistsUnavailable',
])
export type RequestError = typeof RequestError.Type

type MusicRequestFailure =
  | MusicNotFoundError
  | PlaylistStoreError
  | YouTubeMusicError
  | RpcClientError.RpcClientError

const toRequestError = (failure: MusicRequestFailure): RequestError =>
  Match.valueTags(failure, {
    MusicNotFoundError: (): RequestError => 'NotFound',
    YouTubeMusicError: (): RequestError => 'YouTubeUnavailable',
    PlaylistStoreError: (): RequestError => 'PlaylistsUnavailable',
    RpcClientError: (): RequestError => 'ServerUnreachable',
  })

export const withRequestError = <A, E extends MusicRequestFailure, R>(
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

export const playlistSearchQuery = Query.define({
  name: 'PlaylistSearch',
  args: SearchArgs,
  data: Schema.Array(PlaylistSummary),
  error: RequestError,
  execute: ({ query }) =>
    MusicClient.use(client => client.searchPlaylists({ query })).pipe(
      withRequestError,
    ),
})

/** What YouTube Music shows first for a search, if anything. */
export const topResultSearchQuery = Query.define({
  name: 'TopResultSearch',
  args: SearchArgs,
  data: Schema.Option(TopResult),
  error: RequestError,
  execute: ({ query }) =>
    MusicClient.use(client => client.searchTopResult({ query })).pipe(
      withRequestError,
    ),
})

/** What YouTube Music suggests searching for as something is typed. */
export const searchSuggestionsQuery = Query.define({
  name: 'SearchSuggestions',
  args: SearchArgs,
  data: Schema.Array(Schema.String),
  error: RequestError,
  execute: ({ query }) =>
    MusicClient.use(client => client.searchSuggestions({ query })).pipe(
      withRequestError,
    ),
})

/** YouTube Music's moods and genres, for browsing from an empty search. */
export const moodGroupsQuery = Query.define({
  name: 'MoodGroups',
  data: Schema.Array(MoodGroup),
  error: RequestError,
  execute: MusicClient.use(client => client.getMoodsAndGenres()).pipe(
    withRequestError,
  ),
})

export const moodQuery = Query.define({
  name: 'Mood',
  args: { params: Schema.String },
  data: MoodDetails,
  error: RequestError,
  execute: ({ params }) =>
    MusicClient.use(client => client.getMood({ params })).pipe(
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

export const playlistQuery = Query.define({
  name: 'Playlist',
  args: { playlistId: Schema.String },
  data: PlaylistDetails,
  error: RequestError,
  execute: ({ playlistId }) =>
    MusicClient.use(client => client.getPlaylist({ playlistId })).pipe(
      withRequestError,
    ),
})

/** Every playlist made in the app, and which songs are liked. */
export const myLibraryQuery = Query.define({
  name: 'MyLibrary',
  data: MyLibrary,
  error: RequestError,
  execute: MusicClient.use(client => client.getMyLibrary()).pipe(
    withRequestError,
  ),
})

/** Every song in my playlists and Liked Songs, each once, latest added first. */
export const librarySongsQuery = Query.define({
  name: 'LibrarySongs',
  data: Schema.Array(LibrarySong),
  error: RequestError,
  execute: MusicClient.use(client => client.getLibrarySongs()).pipe(
    withRequestError,
  ),
})

export const myPlaylistQuery = Query.define({
  name: 'MyPlaylist',
  args: { playlistId: Schema.String },
  data: MyPlaylistDetails,
  error: RequestError,
  execute: ({ playlistId }) =>
    MusicClient.use(client => client.getMyPlaylist({ playlistId })).pipe(
      withRequestError,
    ),
})

/** What played lately on any device, for Home. */
export const homeQuery = Query.define({
  name: 'Home',
  data: HomeFeed,
  error: RequestError,
  execute: MusicClient.use(client => client.getHome()).pipe(withRequestError),
})

/** The latest releases of the artists I follow, for Home. */
export const newReleasesQuery = Query.define({
  name: 'NewReleases',
  data: Schema.Array(AlbumSummary),
  error: RequestError,
  execute: MusicClient.use(client => client.getNewReleases()).pipe(
    withRequestError,
  ),
})

/** YouTube Music's radio for a song: what it would play after it. */
export const songRadioQuery = Query.define({
  name: 'SongRadio',
  args: { videoId: Schema.String },
  data: Schema.Array(Song),
  error: RequestError,
  execute: ({ videoId }) =>
    MusicClient.use(client => client.getSongRadio({ videoId })).pipe(
      withRequestError,
    ),
})

/** The full player's background for a song's artwork: a solid color. */
export const artworkBackdropQuery = Query.define({
  name: 'ArtworkBackdrop',
  args: { artworkUrl: Schema.String },
  data: Schema.NullOr(Schema.String),
  error: RequestError,
  execute: ({ artworkUrl }) =>
    MusicClient.use(client => client.getArtworkBackdrop({ artworkUrl })).pipe(
      withRequestError,
    ),
})

// ACCOUNTS

/** Who is using the app: a signed-in account, or a guest on the home Wi-Fi. */
export const viewerQuery = Query.define({
  name: 'Viewer',
  data: Viewer,
  error: AccountFailure,
  execute: MusicClient.use(client => client.getViewer()).pipe(
    Effect.mapError(toAccountFailure),
  ),
})

/** Everyone with an account, and the invites not used yet. Admins only. */
export const peopleQuery = Query.define({
  name: 'People',
  data: People,
  error: AccountFailure,
  execute: MusicClient.use(client => client.getPeople()).pipe(
    Effect.mapError(toAccountFailure),
  ),
})
