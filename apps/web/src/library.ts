import { Array, Option, Schema, pipe } from 'effect'

import {
  type AlbumSummary,
  type ArtistSummary,
  type MyLibrary,
  type PlaylistSummary,
  type Session,
  type Song,
} from '@music/shared'

/** What the Library lists: everything, or one kind of thing. */
export const LibraryFilter = Schema.Literals([
  'All',
  'Playlists',
  'Albums',
  'Artists',
  'Downloaded',
])
export type LibraryFilter = typeof LibraryFilter.Type

/** The filters the Library offers as chips. All is none of them picked. */
export const LIBRARY_FILTER_CHIPS: ReadonlyArray<LibraryFilter> = [
  'Playlists',
  'Albums',
  'Artists',
  'Downloaded',
]

/** Something the person opened, so the Library can take them back to it. */
export const LibraryItem = Schema.Struct({
  kind: Schema.Literals(['Album', 'Artist', 'Playlist']),
  id: Schema.String,
  title: Schema.String,
  subtitle: Schema.String,
  maybeArtworkUrl: Schema.OptionFromNullOr(Schema.String),
})
export type LibraryItem = typeof LibraryItem.Type

export const RecentlyViewedJson = Schema.fromJsonString(
  Schema.Array(LibraryItem),
)

export const RECENTLY_VIEWED_KEY = 'music:recently-viewed'

export const MAX_RECENTLY_VIEWED = 24

/** Artwork width kept for Library cards. */
export const LIBRARY_ARTWORK_WIDTH = 180

/** Puts `item` first, drops any older copy of it, and keeps at most `max`. */
export const rememberFirst = <A>(
  items: ReadonlyArray<A>,
  item: A,
  isSame: (left: A, right: A) => boolean,
  max: number,
): ReadonlyArray<A> =>
  pipe(
    items,
    Array.filter(existing => !isSame(existing, item)),
    Array.prepend(item),
    Array.take(max),
  )

export const isAlbumSaved = (library: MyLibrary, albumId: string): boolean =>
  Array.some(library.albums, ({ id }) => id === albumId)

export const isArtistFollowed = (
  library: MyLibrary,
  artistId: string,
): boolean => Array.some(library.artists, ({ id }) => id === artistId)

export const isSameLibraryItem = (
  left: LibraryItem,
  right: LibraryItem,
): boolean => left.kind === right.kind && left.id === right.id

/**
 * A queued track as a Song, so Home can list and replay it. The queue keeps
 * the credits as one line of text, so they no longer link anywhere.
 */
export const songFromQueueTrack = (track: Session.QueueTrack): Song => ({
  videoId: track.videoId,
  title: track.title,
  artists: [{ maybeId: Option.none(), name: track.artists }],
  maybeAlbum: Option.none(),
  maybeDurationSeconds: Option.fromNullishOr(track.durationSeconds),
  artwork: pipe(
    Option.fromNullishOr(track.artworkUrl),
    Option.match({
      onNone: () => [],
      onSome: url => [
        {
          url,
          width: LIBRARY_ARTWORK_WIDTH * 2,
          height: LIBRARY_ARTWORK_WIDTH * 2,
        },
      ],
    }),
  ),
})

type ArtworkUrlOf = (artwork: AlbumSummary['artwork']) => Option.Option<string>

export const albumLibraryItem = (
  album: AlbumSummary,
  subtitle: string,
  artworkUrlOf: ArtworkUrlOf,
): LibraryItem => ({
  kind: 'Album',
  id: album.id,
  title: album.title,
  subtitle,
  maybeArtworkUrl: artworkUrlOf(album.artwork),
})

export const artistLibraryItem = (
  artist: ArtistSummary,
  artworkUrlOf: ArtworkUrlOf,
): LibraryItem => ({
  kind: 'Artist',
  id: artist.id,
  title: artist.name,
  subtitle: 'Artist',
  maybeArtworkUrl: artworkUrlOf(artist.artwork),
})

export const playlistLibraryItem = (
  playlist: PlaylistSummary,
  artworkUrlOf: ArtworkUrlOf,
): LibraryItem => ({
  kind: 'Playlist',
  id: playlist.id,
  title: playlist.title,
  subtitle: Option.getOrElse(playlist.maybeSubtitle, () => 'Playlist'),
  maybeArtworkUrl: artworkUrlOf(playlist.artwork),
})
