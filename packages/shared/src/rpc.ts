import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import {
  AlbumDetails,
  AlbumSummary,
  ArtistDetails,
  ArtistSummary,
  HomeFeed,
  MoodDetails,
  MoodGroup,
  MusicNotFoundError,
  MyLibrary,
  MyPlaylistDetails,
  PlaylistDetails,
  PlaylistEdit,
  PlaylistEditResult,
  PlaylistStoreError,
  PlaylistSummary,
  RadioStation,
  Song,
  SongDetails,
  TopResult,
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

/** What YouTube Music shows first for a search, when it picks anything. */
export const searchTopResultRpc = Rpc.make('searchTopResult', {
  payload: SearchPayload,
  success: Schema.Option(TopResult),
  error: YouTubeMusicError,
})

/**
 * What YouTube Music suggests searching for as something is typed, for the
 * list under the search box. Empty for an empty query.
 */
export const searchSuggestionsRpc = Rpc.make('searchSuggestions', {
  payload: SearchPayload,
  success: Schema.Array(Schema.String),
  error: YouTubeMusicError,
})

/** YouTube Music's moods and genres, for browsing. */
export const getMoodsAndGenresRpc = Rpc.make('getMoodsAndGenres', {
  success: Schema.Array(MoodGroup),
  error: YouTubeMusicError,
})

export const getMoodRpc = Rpc.make('getMood', {
  payload: Schema.Struct({ params: Schema.String }),
  success: MoodDetails,
  error: LookupError,
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

/** What played lately on any device, for Home. */
export const getHomeRpc = Rpc.make('getHome', {
  success: HomeFeed,
  error: PlaylistStoreError,
})

/**
 * The latest releases of the artists I follow, newest first, for Home's
 * "New from artists you follow". Only releases from this year and last.
 */
export const getNewReleasesRpc = Rpc.make('getNewReleases', {
  success: Schema.Array(AlbumSummary),
  error: PlaylistStoreError,
})

/**
 * The songs YouTube Music's radio would play after a song, for Home's
 * "More like" shelf.
 */
export const getSongRadioRpc = Rpc.make('getSongRadio', {
  payload: Schema.Struct({ videoId: Schema.String }),
  success: Schema.Array(Song),
  error: LookupError,
})

/** The songs of an artist's or album's radio, in the order it plays them. */
export const getRadioRpc = Rpc.make('getRadio', {
  payload: Schema.Struct({ station: RadioStation }),
  success: Schema.Array(Song),
  error: LookupError,
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
 * catalog, the library kept in the app, and the play history.
 */
export const MusicRpcs = RpcGroup.make(
  searchSongsRpc,
  searchArtistsRpc,
  searchAlbumsRpc,
  searchPlaylistsRpc,
  searchTopResultRpc,
  searchSuggestionsRpc,
  getMoodsAndGenresRpc,
  getMoodRpc,
  getSongRpc,
  getArtistRpc,
  getAlbumRpc,
  getPlaylistRpc,
  getMyLibraryRpc,
  getMyPlaylistRpc,
  editPlaylistsRpc,
  getHomeRpc,
  getNewReleasesRpc,
  getSongRadioRpc,
  getRadioRpc,
  getArtworkBackdropRpc,
)
export type MusicRpcs = typeof MusicRpcs
