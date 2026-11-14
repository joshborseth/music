import { Array, Effect, Option, Order, Schema, String, pipe } from 'effect'

import {
  type AlbumSummary,
  type ArtistSummary,
  type LibrarySong,
  type MyLibrary,
  type MyPlaylistSummary,
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
  'Songs',
  'Downloaded',
])
export type LibraryFilter = typeof LibraryFilter.Type

/** The filters the Library offers as chips. All is none of them picked. */
export const LIBRARY_FILTER_CHIPS: ReadonlyArray<LibraryFilter> = [
  'Playlists',
  'Albums',
  'Artists',
  'Songs',
  'Downloaded',
]

// SORTING AND LAYOUT

/** The kinds of thing the Library sorts, each in its own order. */
export const SortableKind = Schema.Literals([
  'Playlists',
  'Albums',
  'Artists',
  'Songs',
])
export type SortableKind = typeof SortableKind.Type

/** The kinds of thing the Library shows as a list or as a grid of covers. */
export const LayoutKind = Schema.Literals(['Playlists', 'Albums'])
export type LayoutKind = typeof LayoutKind.Type

/** How the Library orders one kind of thing. */
export const LibrarySort = Schema.Literals([
  'RecentlyAdded',
  'RecentlyUpdated',
  'RecentlyPlayed',
  'Title',
  'Artist',
])
export type LibrarySort = typeof LibrarySort.Type

export const LIBRARY_SORT_LABELS: { readonly [S in LibrarySort]: string } = {
  RecentlyAdded: 'Recently Added',
  RecentlyUpdated: 'Recently Updated',
  RecentlyPlayed: 'Recently Played',
  Title: 'A–Z',
  Artist: 'Artist',
}

/** The orders each kind offers, its default first. */
export const LIBRARY_SORTS: {
  readonly [K in SortableKind]: ReadonlyArray<LibrarySort>
} = {
  Playlists: ['RecentlyUpdated', 'RecentlyAdded', 'RecentlyPlayed', 'Title'],
  Albums: ['RecentlyAdded', 'RecentlyPlayed', 'Title', 'Artist'],
  Artists: ['RecentlyAdded', 'RecentlyPlayed', 'Title'],
  Songs: ['RecentlyAdded', 'Title'],
}

export const LibraryLayout = Schema.Literals(['List', 'Grid'])
export type LibraryLayout = typeof LibraryLayout.Type

/** How this device shows the Library: each kind's order and layout. */
export const LibraryPrefs = Schema.Struct({
  sorts: Schema.Struct({
    Playlists: LibrarySort,
    Albums: LibrarySort,
    Artists: LibrarySort,
    /** Added after the others, so prefs saved before it start Recently Added. */
    Songs: LibrarySort.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed('RecentlyAdded')),
    ),
  }),
  layouts: Schema.Struct({ Playlists: LibraryLayout, Albums: LibraryLayout }),
})
export type LibraryPrefs = typeof LibraryPrefs.Type

export const DEFAULT_LIBRARY_PREFS: LibraryPrefs = {
  sorts: {
    Playlists: 'RecentlyUpdated',
    Albums: 'RecentlyAdded',
    Artists: 'RecentlyAdded',
    Songs: 'RecentlyAdded',
  },
  layouts: { Playlists: 'List', Albums: 'Grid' },
}

export const LibraryPrefsJson = Schema.fromJsonString(LibraryPrefs)

export const LIBRARY_PREFS_KEY = 'music:library-view'

const collator = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
})

const byText: Order.Order<string> = (left, right) => {
  const comparison = collator.compare(left, right)
  return comparison < 0 ? -1 : comparison > 0 ? 1 : 0
}

/** The latest played first; never played after everything that has. */
const byPlayedAt: Order.Order<Option.Option<number>> = Order.mapInput(
  Order.flip(Order.Number),
  maybePlayedAt => Option.getOrElse(maybePlayedAt, () => -Infinity),
)

const artistNamesOf = (credited: AlbumSummary | Song): string =>
  pipe(
    credited.artists,
    Array.map(({ name }) => name),
    Array.join(', '),
  )

/**
 * My playlists in `sort`'s order, Liked Songs always first. The server
 * already lists them the most recently changed first.
 */
export const sortPlaylists = (
  playlists: ReadonlyArray<MyPlaylistSummary>,
  sort: LibrarySort,
): ReadonlyArray<MyPlaylistSummary> => {
  const liked = Array.filter(playlists, ({ isLiked }) => isLiked)
  const mine = Array.filter(playlists, ({ isLiked }) => !isLiked)
  const sorted: ReadonlyArray<MyPlaylistSummary> =
    sort === 'RecentlyAdded'
      ? Array.sort(
          mine,
          Order.mapInput(
            Order.flip(Order.Number),
            (playlist: MyPlaylistSummary) => playlist.createdAt,
          ),
        )
      : sort === 'RecentlyPlayed'
        ? Array.sort(
            mine,
            Order.mapInput(
              byPlayedAt,
              (playlist: MyPlaylistSummary) => playlist.maybePlayedAt,
            ),
          )
        : sort === 'Title' || sort === 'Artist'
          ? Array.sort(
              mine,
              Order.mapInput(
                byText,
                (playlist: MyPlaylistSummary) => playlist.title,
              ),
            )
          : mine
  return [...liked, ...sorted]
}

/** Saved albums in `sort`'s order. The server lists the latest saved first. */
export const sortAlbums = (
  library: MyLibrary,
  sort: LibrarySort,
): ReadonlyArray<AlbumSummary> =>
  sort === 'RecentlyPlayed'
    ? Array.sort(
        library.albums,
        Order.mapInput(byPlayedAt, (album: AlbumSummary) =>
          Option.fromNullishOr(library.albumPlayedAt[album.id]),
        ),
      )
    : sort === 'Title'
      ? Array.sort(
          library.albums,
          Order.mapInput(byText, (album: AlbumSummary) => album.title),
        )
      : sort === 'Artist'
        ? Array.sort(
            library.albums,
            Order.combine(
              Order.mapInput(byText, artistNamesOf),
              Order.mapInput(byText, (album: AlbumSummary) => album.title),
            ),
          )
        : library.albums

/** Followed artists in `sort`'s order. The server lists the latest first. */
export const sortArtists = (
  library: MyLibrary,
  sort: LibrarySort,
): ReadonlyArray<ArtistSummary> =>
  sort === 'RecentlyPlayed'
    ? Array.sort(
        library.artists,
        Order.mapInput(byPlayedAt, (artist: ArtistSummary) =>
          Option.fromNullishOr(library.artistPlayedAt[artist.id]),
        ),
      )
    : sort === 'Title' || sort === 'Artist'
      ? Array.sort(
          library.artists,
          Order.mapInput(byText, (artist: ArtistSummary) => artist.name),
        )
      : library.artists

/**
 * The songs in my playlists and Liked Songs in `sort`'s order: A–Z by
 * title, then artist, or as the server lists them, the latest added first.
 */
export const sortSongs = (
  songs: ReadonlyArray<LibrarySong>,
  sort: LibrarySort,
): ReadonlyArray<LibrarySong> =>
  sort === 'Title'
    ? Array.sort(
        songs,
        Order.combine(
          Order.mapInput(byText, ({ song }: LibrarySong) => song.title),
          Order.mapInput(byText, ({ song }: LibrarySong) =>
            artistNamesOf(song),
          ),
        ),
      )
    : songs

// SEARCH

/** Lower case with the accents taken off, so "beyonce" finds "Beyoncé". */
const searchable = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()

/**
 * Whether every word typed appears somewhere in `texts`. An empty search
 * matches everything.
 */
export const matchesLibrarySearch = (
  search: string,
  texts: ReadonlyArray<string>,
): boolean => {
  const haystack = searchable(Array.join(texts, ' '))
  return pipe(
    searchable(search),
    String.split(/\s+/),
    Array.filter(String.isNonEmpty),
    Array.every(word => haystack.includes(word)),
  )
}

/** Whether a song's title, artists, or album has every word typed. */
export const songMatchesLibrarySearch = (search: string, song: Song): boolean =>
  matchesLibrarySearch(search, [
    song.title,
    artistNamesOf(song),
    Option.match(song.maybeAlbum, {
      onNone: () => '',
      onSome: ({ name }) => name,
    }),
  ])

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
