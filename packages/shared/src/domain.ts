import { Schema } from 'effect'

// ARTWORK

/** One image size of a piece of artwork, as served by YouTube Music. */
export const Thumbnail = Schema.Struct({
  url: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
})
export type Thumbnail = typeof Thumbnail.Type

/** Every available size of one image, smallest first. */
export const Artwork = Schema.Array(Thumbnail)
export type Artwork = typeof Artwork.Type

// LINKS

/** An artist credit. Some credits are plain text with no artist page. */
export const ArtistLink = Schema.Struct({
  maybeId: Schema.Option(Schema.String),
  name: Schema.String,
})
export type ArtistLink = typeof ArtistLink.Type

/** The album a song appears on. */
export const AlbumLink = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})
export type AlbumLink = typeof AlbumLink.Type

// SONG

/** A song as it appears in a list: search results, tracklists, top songs. */
export const Song = Schema.Struct({
  videoId: Schema.String,
  title: Schema.String,
  artists: Schema.Array(ArtistLink),
  maybeAlbum: Schema.Option(AlbumLink),
  maybeDurationSeconds: Schema.Option(Schema.Number),
  artwork: Artwork,
})
export type Song = typeof Song.Type

/** One word of a timed line, for songs timed word by word. */
export const LyricWord = Schema.Struct({
  startSeconds: Schema.Number,
  text: Schema.String,
})
export type LyricWord = typeof LyricWord.Type

/**
 * One line of timed lyrics, sung from `startSeconds` until the next line
 * starts. An empty `text` marks an instrumental break. `words` is empty
 * unless the lyrics are timed word by word; each word keeps its own spacing.
 */
export const LyricLine = Schema.Struct({
  startSeconds: Schema.Number,
  text: Schema.String,
  words: Schema.Array(LyricWord),
})
export type LyricLine = typeof LyricLine.Type

/**
 * Song lyrics and the service that provided them. `maybeLines` holds the
 * same lyrics timed line by line, when a timed copy matches the song.
 */
export const Lyrics = Schema.Struct({
  text: Schema.String,
  maybeSource: Schema.Option(Schema.String),
  maybeLines: Schema.Option(Schema.Array(LyricLine)),
})
export type Lyrics = typeof Lyrics.Type

/** Everything the song page shows. */
export const SongDetails = Schema.Struct({
  song: Song,
  maybeViewCount: Schema.Option(Schema.Number),
  maybeLyrics: Schema.Option(Lyrics),
  relatedSongs: Schema.Array(Song),
})
export type SongDetails = typeof SongDetails.Type

// ARTIST

/** An artist as it appears in a list. */
export const ArtistSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  maybeAudience: Schema.Option(Schema.String),
  artwork: Artwork,
})
export type ArtistSummary = typeof ArtistSummary.Type

// ALBUM

/** How YouTube Music labels a release. */
export const ReleaseKind = Schema.Literals(['Album', 'Single', 'EP'])
export type ReleaseKind = typeof ReleaseKind.Type

/** An album, single, or EP as it appears in a list. */
export const AlbumSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  artists: Schema.Array(ArtistLink),
  maybeKind: Schema.Option(ReleaseKind),
  maybeYear: Schema.Option(Schema.String),
  artwork: Artwork,
})
export type AlbumSummary = typeof AlbumSummary.Type

/** Everything the album page shows. */
export const AlbumDetails = Schema.Struct({
  album: AlbumSummary,
  maybeDescription: Schema.Option(Schema.String),
  maybeLengthSummary: Schema.Option(Schema.String),
  tracks: Schema.Array(Song),
})
export type AlbumDetails = typeof AlbumDetails.Type

/** Everything the artist page shows. */
export const ArtistDetails = Schema.Struct({
  artist: ArtistSummary,
  maybeDescription: Schema.Option(Schema.String),
  topSongs: Schema.Array(Song),
  albums: Schema.Array(AlbumSummary),
  singles: Schema.Array(AlbumSummary),
  similarArtists: Schema.Array(ArtistSummary),
})
export type ArtistDetails = typeof ArtistDetails.Type

// PLAYLIST

/** A playlist as it appears on a shelf. */
export const PlaylistSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** Who made it, or a few of the artists in it. */
  maybeSubtitle: Schema.Option(Schema.String),
  artwork: Artwork,
})
export type PlaylistSummary = typeof PlaylistSummary.Type

/** Everything the playlist page shows. */
export const PlaylistDetails = Schema.Struct({
  playlist: PlaylistSummary,
  maybeDescription: Schema.Option(Schema.String),
  maybeLengthSummary: Schema.Option(Schema.String),
  tracks: Schema.Array(Song),
})
export type PlaylistDetails = typeof PlaylistDetails.Type

// MY PLAYLISTS

/** The id of the built-in Liked songs playlist, which cannot be renamed or deleted. */
export const LIKED_PLAYLIST_ID = 'liked'

/** The longest playlist title the server keeps. */
export const MAX_PLAYLIST_TITLE_LENGTH = 100

/** A playlist made in this app and kept on the music server. */
export const MyPlaylistSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** The built-in Liked songs playlist. */
  isLiked: Schema.Boolean,
  songCount: Schema.Number,
  totalSeconds: Schema.Number,
  /** Up to four different covers from its first songs, for the mosaic. */
  covers: Schema.Array(Artwork),
  /** When it last changed, in milliseconds since the epoch. */
  updatedAt: Schema.Number,
})
export type MyPlaylistSummary = typeof MyPlaylistSummary.Type

/** Every playlist made in this app, and which songs are liked. */
export const MyLibrary = Schema.Struct({
  /** Liked songs first, then the most recently changed. */
  playlists: Schema.Array(MyPlaylistSummary),
  likedVideoIds: Schema.Array(Schema.String),
})
export type MyLibrary = typeof MyLibrary.Type

/** One of my playlists with its songs in order. Each song appears once. */
export const MyPlaylistDetails = Schema.Struct({
  playlist: MyPlaylistSummary,
  songs: Schema.Array(Song),
})
export type MyPlaylistDetails = typeof MyPlaylistDetails.Type

/** A change to my playlists. */
export const PlaylistEdit = Schema.Union([
  /** A new playlist, empty or holding a copy of `songs`. */
  Schema.TaggedStruct('Create', {
    title: Schema.String,
    songs: Schema.Array(Song),
  }),
  Schema.TaggedStruct('Rename', {
    playlistId: Schema.String,
    title: Schema.String,
  }),
  Schema.TaggedStruct('Delete', { playlistId: Schema.String }),
  /** Adds the songs to the end, skipping any already in it. */
  Schema.TaggedStruct('AddSongs', {
    playlistId: Schema.String,
    songs: Schema.Array(Song),
  }),
  Schema.TaggedStruct('RemoveSong', {
    playlistId: Schema.String,
    videoId: Schema.String,
  }),
  /** Likes a song, putting it first in Liked songs, or unlikes it. */
  Schema.TaggedStruct('SetLiked', { song: Song, isLiked: Schema.Boolean }),
])
export type PlaylistEdit = typeof PlaylistEdit.Type

/** My playlists after an edit, and the playlist it changed. */
export const PlaylistEditResult = Schema.Struct({
  library: MyLibrary,
  /** The changed playlist as it now stands. None after a delete. */
  maybePlaylist: Schema.Option(MyPlaylistDetails),
})
export type PlaylistEditResult = typeof PlaylistEditResult.Type

// HOME

/** One titled row of the home feed. Each holds one kind of item. */
export const HomeShelf = Schema.Union([
  Schema.TaggedStruct('SongShelf', {
    title: Schema.String,
    songs: Schema.Array(Song),
  }),
  Schema.TaggedStruct('AlbumShelf', {
    title: Schema.String,
    albums: Schema.Array(AlbumSummary),
  }),
  Schema.TaggedStruct('PlaylistShelf', {
    title: Schema.String,
    playlists: Schema.Array(PlaylistSummary),
  }),
  Schema.TaggedStruct('ArtistShelf', {
    title: Schema.String,
    artists: Schema.Array(ArtistSummary),
  }),
])
export type HomeShelf = typeof HomeShelf.Type

/** What YouTube Music recommends on its home page. */
export const HomeFeed = Schema.Struct({
  shelves: Schema.Array(HomeShelf),
})
export type HomeFeed = typeof HomeFeed.Type

// ERRORS

/** The requested song, artist, album, or playlist does not exist. */
export class MusicNotFoundError extends Schema.TaggedError<MusicNotFoundError>()(
  'MusicNotFoundError',
  { id: Schema.String },
) {}

/** The music server could not read or write its playlist database. */
export class PlaylistStoreError extends Schema.TaggedError<PlaylistStoreError>()(
  'PlaylistStoreError',
  { message: Schema.String },
) {}

/** YouTube Music did not answer, or answered with something unusable. */
export class YouTubeMusicError extends Schema.TaggedError<YouTubeMusicError>()(
  'YouTubeMusicError',
  { message: Schema.String },
) {}
