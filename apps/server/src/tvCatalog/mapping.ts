import { Array, Match, Option, pipe } from 'effect'

import {
  type AlbumDetails,
  type AlbumSummary,
  type ArtistDetails,
  type ArtistLink,
  type ArtistSummary,
  type Artwork,
  type HomeFeed,
  type HomeShelf,
  type MyLibrary,
  type MyPlaylistDetails,
  type MyPlaylistSummary,
  type PlaylistDetails,
  type PlaylistSummary,
  type Session,
  type Song,
  type SongDetails,
  type Tv,
} from '@music/shared'

/*
 * Pure mappings from the catalog's domain Schemas to the TV's plain JSON
 * shapes in `packages/shared/src/tv.ts`. Song → QueueTrack mirrors the web
 * app's `toQueueTrack` (`apps/web/src/playback/queueTrack.ts`), so the phone
 * and the TV queue identical tracks.
 */

// FORMATTING

const RETINA_SCALE = 2
/** Artwork width the web app hands to the TV and the lock screen. */
const QUEUE_ARTWORK_WIDTH = 360
/** Artwork width for a card on a 1080p TV shelf. */
const CARD_ARTWORK_WIDTH = 360

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE

/** Joins the non-empty parts with a middle dot. */
export const joinDetails = (parts: ReadonlyArray<string>): string =>
  pipe(
    parts,
    Array.filter(part => part.length > 0),
    Array.join(' · '),
  )

/**
 * `subtitle` led by `label`: "Playlist · YouTube Music". YouTube's own
 * subtitles sometimes already start with it, and use "•" between parts.
 */
export const labelled = (label: string, subtitle: string): string => {
  const parts = subtitle
    .split(/\s+[·•]\s+/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
  return joinDetails(parts[0] === label ? parts : [label, ...parts])
}

/** Every credited artist, joined for display, as the web app does. */
export const artistNames = (artists: ReadonlyArray<ArtistLink>): string =>
  pipe(
    artists,
    Array.map(({ name }) => name),
    Array.join(', '),
  )

/**
 * The smallest image at least `displayWidth` pixels wide on a retina screen,
 * or the largest there is. The same rule as the web app's `artworkUrl`.
 */
export const artworkUrl = (
  artwork: Artwork,
  displayWidth: number,
): string | null =>
  pipe(
    Array.findFirst(
      artwork,
      ({ width }) => width >= displayWidth * RETINA_SCALE,
    ),
    Option.orElse(() => Array.last(artwork)),
    Option.map(({ url }) => url),
    Option.getOrNull,
  )

/** The largest image there is. Artwork lists sizes smallest first. */
export const largestArtworkUrl = (artwork: Artwork): string | null =>
  pipe(
    Array.last(artwork),
    Option.map(({ url }) => url),
    Option.getOrNull,
  )

const songCount = (count: number): string =>
  `${count} ${count === 1 ? 'song' : 'songs'}`

/** "12 songs · 1 hr 5 min", as the web app writes a playlist's length. */
export const playlistLength = (playlist: MyPlaylistSummary): string => {
  const hours = Math.floor(playlist.totalSeconds / SECONDS_PER_HOUR)
  const minutes = Math.round(
    (playlist.totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE,
  )
  const length =
    hours > 0
      ? `${hours} hr ${minutes} min`
      : minutes > 0
        ? `${minutes} min`
        : ''
  return joinDetails([songCount(playlist.songCount), length])
}

const firstCover = (playlist: MyPlaylistSummary): Artwork =>
  Option.getOrElse(Array.head(playlist.covers), () => [])

// TRACKS

/** A song as the queue keeps it. Identical to the web app's `toQueueTrack`. */
export const toQueueTrack = (song: Song): Session.QueueTrack => ({
  videoId: song.videoId,
  title: song.title,
  artists: artistNames(song.artists),
  album: Option.getOrNull(Option.map(song.maybeAlbum, ({ name }) => name)),
  durationSeconds: Option.getOrNull(song.maybeDurationSeconds),
  artworkUrl: artworkUrl(song.artwork, QUEUE_ARTWORK_WIDTH),
})

/**
 * A queued track as a Song, for Liked songs. The queue keeps the credits as
 * one line of text, so they no longer link anywhere, and the album only by
 * name, so it is left out. The web app likes a playing song the same way
 * (`songFromQueueTrack` in `apps/web/src/library.ts`).
 */
export const songFromQueueTrack = (track: Session.QueueTrack): Song => ({
  videoId: track.videoId,
  title: track.title,
  artists: [{ maybeId: Option.none(), name: track.artists }],
  maybeAlbum: Option.none(),
  maybeDurationSeconds: Option.fromNullishOr(track.durationSeconds),
  artwork:
    track.artworkUrl === null
      ? []
      : [
          {
            url: track.artworkUrl,
            width: QUEUE_ARTWORK_WIDTH * RETINA_SCALE,
            height: QUEUE_ARTWORK_WIDTH * RETINA_SCALE,
          },
        ],
})

// CARDS

export const songCard = (song: Song): Tv.TvCard => ({
  kind: 'Song',
  id: song.videoId,
  title: song.title,
  subtitle: artistNames(song.artists),
  artworkUrl: artworkUrl(song.artwork, CARD_ARTWORK_WIDTH),
  track: toQueueTrack(song),
})

/**
 * "Album · Rick Astley · 1987". On an artist's own page the artist goes
 * without saying, so `withArtists` is false there: "Single · 2024".
 */
export const albumSubtitle = (
  album: AlbumSummary,
  withArtists: boolean,
): string =>
  joinDetails([
    Option.getOrElse(album.maybeKind, () => 'Album'),
    withArtists ? artistNames(album.artists) : '',
    Option.getOrElse(album.maybeYear, () => ''),
  ])

export const albumCard = (
  album: AlbumSummary,
  withArtists = true,
): Tv.TvCard => ({
  kind: 'Album',
  id: album.id,
  title: album.title,
  subtitle: albumSubtitle(album, withArtists),
  artworkUrl: artworkUrl(album.artwork, CARD_ARTWORK_WIDTH),
  track: null,
})

export const artistCard = (artist: ArtistSummary): Tv.TvCard => ({
  kind: 'Artist',
  id: artist.id,
  title: artist.name,
  subtitle: joinDetails([
    'Artist',
    Option.getOrElse(artist.maybeAudience, () => ''),
  ]),
  artworkUrl: artworkUrl(artist.artwork, CARD_ARTWORK_WIDTH),
  track: null,
})

export const playlistCard = (playlist: PlaylistSummary): Tv.TvCard => ({
  kind: 'Playlist',
  id: playlist.id,
  title: playlist.title,
  subtitle: labelled(
    'Playlist',
    Option.getOrElse(playlist.maybeSubtitle, () => ''),
  ),
  artworkUrl: artworkUrl(playlist.artwork, CARD_ARTWORK_WIDTH),
  track: null,
})

/** "Playlist · 12 songs". The cover is the first of its mosaic. */
export const myPlaylistCard = (playlist: MyPlaylistSummary): Tv.TvCard => ({
  kind: 'MyPlaylist',
  id: playlist.id,
  title: playlist.title,
  subtitle: joinDetails(['Playlist', songCount(playlist.songCount)]),
  artworkUrl: artworkUrl(firstCover(playlist), CARD_ARTWORK_WIDTH),
  track: null,
})

// SHELVES

/** Leaves out shelves with nothing on them. */
export const nonEmptyShelves = (
  shelves: ReadonlyArray<Tv.TvShelf>,
): ReadonlyArray<Tv.TvShelf> =>
  Array.filter(shelves, shelf => Array.isReadonlyArrayNonEmpty(shelf.cards))

export const YOUR_PLAYLISTS_TITLE = 'Your playlists'

/** Liked songs first: the library already keeps that order. */
export const yourPlaylistsShelf = (library: MyLibrary): Tv.TvShelf => ({
  title: YOUR_PLAYLISTS_TITLE,
  cards: Array.map(library.playlists, myPlaylistCard),
})

export const homeShelf = (shelf: HomeShelf): Tv.TvShelf =>
  Match.valueTags(shelf, {
    SongShelf: ({ title, songs }) => ({
      title,
      cards: Array.map(songs, songCard),
    }),
    AlbumShelf: ({ title, albums }) => ({
      title,
      cards: Array.map(albums, album => albumCard(album)),
    }),
    PlaylistShelf: ({ title, playlists }) => ({
      title,
      cards: Array.map(playlists, playlistCard),
    }),
    ArtistShelf: ({ title, artists }) => ({
      title,
      cards: Array.map(artists, artistCard),
    }),
  })

/** Your playlists first, then YouTube Music's home feed. */
export const homeShelves = (
  library: MyLibrary,
  feed: HomeFeed,
): Tv.TvShelves => ({
  shelves: nonEmptyShelves([
    yourPlaylistsShelf(library),
    ...Array.map(feed.shelves, homeShelf),
  ]),
})

/** The most cards a search shelf shows. */
export const SEARCH_SHELF_SIZE = 12

export const searchShelves = (
  results: Readonly<{
    songs: ReadonlyArray<Song>
    artists: ReadonlyArray<ArtistSummary>
    albums: ReadonlyArray<AlbumSummary>
    playlists: ReadonlyArray<PlaylistSummary>
  }>,
): Tv.TvShelves => {
  const shelf = <A>(
    title: string,
    items: ReadonlyArray<A>,
    toCard: (item: A) => Tv.TvCard,
  ): Tv.TvShelf => ({
    title,
    cards: Array.map(Array.take(items, SEARCH_SHELF_SIZE), toCard),
  })
  return {
    shelves: nonEmptyShelves([
      shelf('Songs', results.songs, songCard),
      shelf('Artists', results.artists, artistCard),
      shelf('Albums', results.albums, album => albumCard(album)),
      shelf('Playlists', results.playlists, playlistCard),
    ]),
  }
}

// COLLECTIONS

export const albumCollection = (details: AlbumDetails): Tv.TvCollection => ({
  kind: 'Album',
  id: details.album.id,
  title: details.album.title,
  subtitle: albumSubtitle(details.album, true),
  description: Option.getOrNull(details.maybeDescription),
  artworkUrl: largestArtworkUrl(details.album.artwork),
  tracks: Array.map(details.tracks, toQueueTrack),
  shelves: [],
})

export const playlistCollection = (
  details: PlaylistDetails,
): Tv.TvCollection => ({
  kind: 'Playlist',
  id: details.playlist.id,
  title: details.playlist.title,
  subtitle: labelled(
    'Playlist',
    joinDetails([
      Option.getOrElse(details.playlist.maybeSubtitle, () => ''),
      Option.getOrElse(details.maybeLengthSummary, () => ''),
    ]),
  ),
  description: Option.getOrNull(details.maybeDescription),
  artworkUrl: largestArtworkUrl(details.playlist.artwork),
  tracks: Array.map(details.tracks, toQueueTrack),
  shelves: [],
})

export const myPlaylistCollection = (
  details: MyPlaylistDetails,
): Tv.TvCollection => ({
  kind: 'MyPlaylist',
  id: details.playlist.id,
  title: details.playlist.title,
  subtitle: joinDetails(['Playlist', playlistLength(details.playlist)]),
  description: null,
  artworkUrl: largestArtworkUrl(firstCover(details.playlist)),
  tracks: Array.map(details.songs, toQueueTrack),
  shelves: [],
})

/** Top songs to play, then albums, singles and EPs, and similar artists. */
export const artistCollection = (details: ArtistDetails): Tv.TvCollection => ({
  kind: 'Artist',
  id: details.artist.id,
  title: details.artist.name,
  subtitle: joinDetails([
    'Artist',
    Option.getOrElse(details.artist.maybeAudience, () => ''),
  ]),
  description: Option.getOrNull(details.maybeDescription),
  artworkUrl: largestArtworkUrl(details.artist.artwork),
  tracks: Array.map(details.topSongs, toQueueTrack),
  shelves: nonEmptyShelves([
    {
      title: 'Albums',
      cards: Array.map(details.albums, album => albumCard(album, false)),
    },
    {
      title: 'Singles & EPs',
      cards: Array.map(details.singles, album => albumCard(album, false)),
    },
    {
      title: 'Fans might also like',
      cards: Array.map(details.similarArtists, artistCard),
    },
  ]),
})

// LYRICS AND LIKES

export const lyricsOf = (details: SongDetails): Tv.TvLyrics =>
  Option.match(details.maybeLyrics, {
    onNone: () => ({ text: null, source: null }),
    onSome: lyrics => ({
      text: lyrics.text,
      source: Option.getOrNull(lyrics.maybeSource),
    }),
  })

export const likedOf = (library: MyLibrary, videoId: string): Tv.TvLiked => ({
  videoId,
  liked: library.likedVideoIds.includes(videoId),
})
