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
})
export type SongDetails = typeof SongDetails.Type

// RADIO

/**
 * One of YouTube Music's radios: what an artist's "Radio" button or an
 * album's "Start mix" plays, songs like theirs from many artists. The fields
 * are YouTube's own, passed back as they came.
 */
export const RadioStation = Schema.Struct({
  playlistId: Schema.String,
  maybeParams: Schema.Option(Schema.String),
  /** The song the radio starts from, when YouTube names one. */
  maybeVideoId: Schema.Option(Schema.String),
})
export type RadioStation = typeof RadioStation.Type

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
  /** The tracks YouTube Music marks explicit. */
  explicitVideoIds: Schema.Array(Schema.String),
  /** The album's radio ("Start mix"), when YouTube Music offers one. */
  maybeRadio: Schema.Option(RadioStation),
})
export type AlbumDetails = typeof AlbumDetails.Type

/** Everything the artist page shows. */
export const ArtistDetails = Schema.Struct({
  artist: ArtistSummary,
  maybeDescription: Schema.Option(Schema.String),
  topSongs: Schema.Array(Song),
  /**
   * How often each top song was played, as YouTube Music words it
   * ("1.2B plays"), by video id. Songs it gives no count for are missing.
   */
  topSongPlays: Schema.Record(Schema.String, Schema.String),
  /** YouTube Music's playlist of every song by the artist, most played first. */
  maybeAllSongsPlaylistId: Schema.Option(Schema.String),
  /** Every album, newest first, even past the few the artist page lists. */
  albums: Schema.Array(AlbumSummary),
  /** Every single and EP, newest first. */
  singles: Schema.Array(AlbumSummary),
  /** Artists their fans also listen to ("Fans might also like"). */
  relatedArtists: Schema.Array(ArtistSummary),
  /** The artist's radio, when YouTube Music offers one. */
  maybeRadio: Schema.Option(RadioStation),
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
  /**
   * Who made it, when YouTube Music says: an artist (with a page to open),
   * YouTube Music itself, or someone's channel.
   */
  maybeOwner: Schema.Option(ArtistLink),
  maybeDescription: Schema.Option(Schema.String),
  maybeLengthSummary: Schema.Option(Schema.String),
  tracks: Schema.Array(Song),
})
export type PlaylistDetails = typeof PlaylistDetails.Type

// SEARCH

/**
 * The one thing a search most likely means, as YouTube Music picks it: an
 * artist, an album, a song, or a playlist.
 */
export const TopResult = Schema.Union([
  /**
   * An artist, with their most played songs from their page, which the Top
   * tab lists in place of the song search: a search for an artist means
   * their hits, not every song that mentions them.
   */
  Schema.TaggedStruct('Artist', {
    artist: ArtistSummary,
    topSongs: Schema.Array(Song),
  }),
  Schema.TaggedStruct('Album', { album: AlbumSummary }),
  Schema.TaggedStruct('Song', { song: Song }),
  Schema.TaggedStruct('Playlist', { playlist: PlaylistSummary }),
])
export type TopResult = typeof TopResult.Type

// MOODS AND GENRES

/** One of YouTube Music's moods or genres, such as Chill or Jazz. */
export const MoodCategory = Schema.Struct({
  /** YouTube's opaque key for the category page. */
  params: Schema.String,
  title: Schema.String,
  /** YouTube Music's color for it, as `#rrggbb`. */
  maybeColor: Schema.Option(Schema.String),
})
export type MoodCategory = typeof MoodCategory.Type

/** A titled group of categories: "Moods & moments", "Genres". */
export const MoodGroup = Schema.Struct({
  title: Schema.String,
  categories: Schema.Array(MoodCategory),
})
export type MoodGroup = typeof MoodGroup.Type

/** A titled row of YouTube Music's playlists on a category page. */
export const PlaylistShelf = Schema.Struct({
  title: Schema.String,
  playlists: Schema.Array(PlaylistSummary),
})
export type PlaylistShelf = typeof PlaylistShelf.Type

/** A mood or genre's page: its songs, playlists in shelves, and albums. */
export const MoodDetails = Schema.Struct({
  title: Schema.String,
  songs: Schema.Array(Song),
  playlistShelves: Schema.Array(PlaylistShelf),
  albums: Schema.Array(AlbumSummary),
})
export type MoodDetails = typeof MoodDetails.Type

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

/**
 * Everything kept in my library: the playlists made in this app, which songs
 * are liked, and the albums saved and artists followed.
 */
export const MyLibrary = Schema.Struct({
  /** Liked songs first, then the most recently changed. */
  playlists: Schema.Array(MyPlaylistSummary),
  likedVideoIds: Schema.Array(Schema.String),
  /** The albums saved to the library, the latest saved first. */
  albums: Schema.Array(AlbumSummary),
  /** The artists followed, the latest followed first. */
  artists: Schema.Array(ArtistSummary),
})
export type MyLibrary = typeof MyLibrary.Type

/** One of my playlists with its songs in order. Each song appears once. */
export const MyPlaylistDetails = Schema.Struct({
  playlist: MyPlaylistSummary,
  songs: Schema.Array(Song),
})
export type MyPlaylistDetails = typeof MyPlaylistDetails.Type

/**
 * A change to my library: my playlists, Liked songs, saved albums, and
 * followed artists.
 */
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
  /** Saves an album to the library, putting it first, or removes it. */
  Schema.TaggedStruct('SetAlbumSaved', {
    album: AlbumSummary,
    isSaved: Schema.Boolean,
  }),
  /** Follows an artist, putting them first, or unfollows them. */
  Schema.TaggedStruct('SetArtistFollowed', {
    artist: ArtistSummary,
    isFollowed: Schema.Boolean,
  }),
])
export type PlaylistEdit = typeof PlaylistEdit.Type

/** My library after an edit, and the playlist it changed. */
export const PlaylistEditResult = Schema.Struct({
  library: MyLibrary,
  /**
   * The changed playlist as it now stands. None after a delete, and after
   * saving an album or following an artist.
   */
  maybePlaylist: Schema.Option(MyPlaylistDetails),
})
export type PlaylistEditResult = typeof PlaylistEditResult.Type

// HOME

/**
 * What Home shows from the play history, which every device adds to, and
 * from my likes. Each song played lately shows once: inside its album when
 * more than one song of the album played, on its own otherwise.
 */
export const HomeFeed = Schema.Struct({
  /**
   * The albums more than one song played from lately, the latest played
   * first, each once.
   */
  jumpBackIn: Schema.Array(AlbumSummary),
  /**
   * The other songs played lately on any device, the latest first, each
   * once: those whose album is not in `jumpBackIn`.
   */
  recentlyPlayed: Schema.Array(Song),
  /** The song played last, on any device, which "More like" follows. */
  maybeLastPlayed: Schema.Option(Song),
  /**
   * Mixes made from the artists I play and like most: each one YouTube
   * Music's radio for one of their songs, opened as a playlist.
   */
  mixes: Schema.Array(PlaylistSummary),
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
