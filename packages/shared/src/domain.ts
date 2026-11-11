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

/** Song lyrics and the service that provided them. */
export const Lyrics = Schema.Struct({
  text: Schema.String,
  maybeSource: Schema.Option(Schema.String),
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

/** The requested song, artist, or album does not exist on YouTube Music. */
export class MusicNotFoundError extends Schema.TaggedError<MusicNotFoundError>()(
  'MusicNotFoundError',
  { id: Schema.String },
) {}

/** YouTube Music did not answer, or answered with something unusable. */
export class YouTubeMusicError extends Schema.TaggedError<YouTubeMusicError>()(
  'YouTubeMusicError',
  { message: Schema.String },
) {}
