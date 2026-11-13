import { Array, Number, Option, Order, Record, String, pipe } from 'effect'

import {
  type AlbumSummary,
  type ArtistDetails,
  type HomeFeed,
  type PlaylistDetails,
  type PlaylistSummary,
  type Song,
} from '@music/shared'

import { type PlayedSong } from './playlists/store.ts'

/*
 * The phone's Home, made only from my own music: the play history every
 * device adds to, my likes, and the artists I follow. The TV's Home is made
 * from the same feed (`homeShelves` in `tvCatalog/mapping.ts`), and both
 * read it through `homeSources.ts`.
 */

/** How far back Home looks for albums to jump back into. */
export const HOME_HISTORY_DEPTH = 60
/** The most songs "Recently played" shows. */
export const HOME_RECENT_SONGS = 20
/** The most albums "Jump back in" shows. */
export const HOME_RECENT_ALBUMS = 12
/** An album shows in "Jump back in" once this many of its songs played. */
export const ALBUM_SONGS_TO_JUMP_BACK = 2

/**
 * The album a song was played from, as far as the song knows it. The cover
 * is the song's own, which for an album track is the album's. The album's
 * artist is the song's first: a song's featured guests are not the album's.
 */
const albumOf = (song: Song): Option.Option<AlbumSummary> =>
  Option.map(song.maybeAlbum, album => ({
    id: album.id,
    title: album.name,
    artists: song.artists.slice(0, 1),
    maybeKind: Option.none(),
    maybeYear: Option.none(),
    artwork: song.artwork,
  }))

/** How many of the songs played lately came from each album. */
const songsPerAlbum = (
  recentSongs: ReadonlyArray<Song>,
): Readonly<Record<string, number>> =>
  pipe(
    recentSongs,
    Array.map(song => Option.map(song.maybeAlbum, ({ id }) => id)),
    Array.getSomes,
    Array.groupBy(id => id),
    Record.map(ids => ids.length),
  )

/**
 * Splits the songs played lately (latest first, each once) between the two
 * history shelves, so nothing shows twice: an album more than one song
 * played from goes to "Jump back in", and the other songs stay on their own
 * in "Recently played". A song with no album (a video, say) is always on
 * its own.
 */
export const foldRecent = (
  recentSongs: ReadonlyArray<Song>,
): Pick<HomeFeed, 'jumpBackIn' | 'recentlyPlayed'> => {
  const counts = songsPerAlbum(recentSongs)
  const isAlbumPlay = (song: Song): boolean =>
    Option.exists(
      song.maybeAlbum,
      ({ id }) => (counts[id] ?? 0) >= ALBUM_SONGS_TO_JUMP_BACK,
    )
  return {
    jumpBackIn: pipe(
      recentSongs,
      Array.filter(isAlbumPlay),
      Array.map(albumOf),
      Array.getSomes,
      Array.dedupeWith((left, right) => left.id === right.id),
      Array.take(HOME_RECENT_ALBUMS),
    ),
    recentlyPlayed: pipe(
      recentSongs,
      Array.filter(song => !isAlbumPlay(song)),
      Array.take(HOME_RECENT_SONGS),
    ),
  }
}

// MIXES

/**
 * A mix is YouTube Music's radio for one song, which YouTube itself names
 * `RDAMVM` and the song's id. The playlist page opens it like any playlist.
 */
export const MIX_PLAYLIST_PREFIX = 'RDAMVM'

export const mixPlaylistId = (videoId: string): string =>
  `${MIX_PLAYLIST_PREFIX}${videoId}`

/** The song a mix is the radio of, when the playlist id is a mix. */
export const mixSeedOf = (playlistId: string): Option.Option<string> =>
  pipe(
    Option.liftPredicate(playlistId, id => id.startsWith(MIX_PLAYLIST_PREFIX)),
    Option.map(id => id.slice(MIX_PLAYLIST_PREFIX.length)),
    Option.filter(String.isNonEmpty),
  )

/** The most mixes Home shows. */
export const HOME_MIXES = 4
/** A like counts as this many plays when choosing what to mix. */
const LIKE_WEIGHT = 2
/** An artist needs at least this many plays (or a like) to get a mix. */
const MIN_MIX_WEIGHT = 2
/** The most songs a mix lists. */
export const MIX_SONGS = 50

type Weighted = Readonly<{ song: Song; weight: number; order: number }>

const firstArtistName = (song: Song): Option.Option<string> =>
  pipe(
    Array.head(song.artists),
    Option.map(({ name }) => name.trim()),
    Option.filter(String.isNonEmpty),
  )

/** One key per artist: their page when they have one, else their name. */
const artistKey = (song: Song): Option.Option<string> =>
  Option.flatMap(Array.head(song.artists), artist =>
    Option.match(artist.maybeId, {
      onSome: id => Option.some(`id:${id}`),
      onNone: () =>
        Option.map(firstArtistName(song), name => `name:${name.toLowerCase()}`),
    }),
  )

export const mixTitle = (artistName: string): string => `Mix: ${artistName}`

const sumWeights = (items: ReadonlyArray<Weighted>): number =>
  Number.sumAll(Array.map(items, ({ weight }) => weight))

const byWeightThenOrder = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (group: Weighted) => group.weight),
  Order.mapInput(Order.Number, (group: Weighted) => group.order),
)

/**
 * A group of weighted songs as one: the song played and liked most (the
 * earliest listed on a tie), with the whole group's weight and the place of
 * its first song. Groups keep their songs in the order they were listed.
 */
const asOne = (items: Array.NonEmptyReadonlyArray<Weighted>): Weighted => {
  const top = pipe(
    Array.groupBy(items, ({ song }) => song.videoId),
    Record.values,
    Array.map((copies): Weighted => ({
      song: copies[0].song,
      weight: sumWeights(copies),
      order: copies[0].order,
    })),
    Array.sort(byWeightThenOrder),
    Array.head,
    Option.getOrElse(() => items[0]),
  )
  return { song: top.song, weight: sumWeights(items), order: items[0].order }
}

/**
 * Mixes from the artists I play and like most: one per artist, the radio of
 * their song I play and like most. `played` is the play history, most
 * played first; `liked` is Liked songs.
 */
export const homeMixes = (
  played: ReadonlyArray<PlayedSong>,
  liked: ReadonlyArray<Song>,
): ReadonlyArray<PlaylistSummary> => {
  const weighted: ReadonlyArray<Weighted> = [
    ...Array.map(played, ({ song, playCount }, order) => ({
      song,
      weight: playCount,
      order,
    })),
    ...Array.map(liked, (song, index) => ({
      song,
      weight: LIKE_WEIGHT,
      order: played.length + index,
    })),
  ]
  return pipe(
    Array.filter(weighted, ({ song }) => Option.isSome(artistKey(song))),
    Array.groupBy(({ song }) =>
      Option.getOrElse(artistKey(song), () => song.videoId),
    ),
    Record.values,
    Array.map(asOne),
    Array.filter(({ weight }) => weight >= MIN_MIX_WEIGHT),
    Array.sort(byWeightThenOrder),
    Array.take(HOME_MIXES),
    Array.map(({ song }): PlaylistSummary => ({
      id: mixPlaylistId(song.videoId),
      title: mixTitle(
        Option.getOrElse(firstArtistName(song), () => song.title),
      ),
      maybeSubtitle: Option.some(`Based on ${song.title}`),
      artwork: song.artwork,
    })),
  )
}

/**
 * A mix as a playlist page: the seed song, then what YouTube Music's radio
 * plays after it. `upNext` is the radio as YouTube sends it, which starts
 * with the seed. None when the radio is empty.
 */
export const mixDetails = (
  seedVideoId: string,
  upNext: ReadonlyArray<Song>,
): Option.Option<PlaylistDetails> => {
  const maybeSeed = Option.orElse(
    Array.findFirst(upNext, ({ videoId }) => videoId === seedVideoId),
    () => Array.head(upNext),
  )
  return Option.map(maybeSeed, seed => {
    const tracks = pipe(
      [seed, ...upNext],
      Array.dedupeWith((left, right) => left.videoId === right.videoId),
      Array.take(MIX_SONGS),
    )
    const artistName = firstArtistName(seed)
    return {
      playlist: {
        id: mixPlaylistId(seedVideoId),
        title: mixTitle(Option.getOrElse(artistName, () => seed.title)),
        maybeSubtitle: Option.some(`Based on ${seed.title}`),
        artwork: seed.artwork,
      },
      maybeOwner: Option.none(),
      maybeDescription: Option.some(
        Option.match(artistName, {
          onNone: () =>
            `Songs like “${seed.title}”, from YouTube Music’s radio.`,
          onSome: name =>
            `Songs like “${seed.title}” by ${name}, from YouTube Music’s radio.`,
        }),
      ),
      maybeLengthSummary: Option.some(`${tracks.length} songs`),
      tracks,
    }
  })
}

// NEW RELEASES

/** The most releases "New from artists you follow" shows. */
export const HOME_NEW_RELEASES = 12
/** The most releases one artist adds, so one busy artist can't fill it. */
const RELEASES_PER_ARTIST = 2
/** How many of each list on an artist page are looked at, newest first. */
const RELEASES_LOOKED_AT = 3
/** Releases from this many years before this one still count as new. */
const NEW_RELEASE_YEARS = 1

const yearOf = (album: AlbumSummary): Option.Option<number> =>
  Option.flatMap(album.maybeYear, Number.parse)

const byYearNewestFirst = Order.mapInput(
  Order.flip(Order.Number),
  (album: AlbumSummary) => Option.getOrElse(yearOf(album), () => 0),
)

/**
 * The latest releases of the artists I follow, newest first: from each
 * artist page (followed order, the latest followed first), the newest
 * albums, singles, and EPs from this year or last. An artist page lists
 * releases newest first; YouTube gives only their year.
 */
export const newReleases = (
  artists: ReadonlyArray<ArtistDetails>,
  currentYear: number,
): ReadonlyArray<AlbumSummary> =>
  pipe(
    artists,
    Array.flatMap(details =>
      pipe(
        [
          ...Array.take(details.albums, RELEASES_LOOKED_AT),
          ...Array.take(details.singles, RELEASES_LOOKED_AT),
        ],
        Array.filter(album =>
          Option.exists(
            yearOf(album),
            year => year >= currentYear - NEW_RELEASE_YEARS,
          ),
        ),
        Array.sort(byYearNewestFirst),
        Array.take(RELEASES_PER_ARTIST),
      ),
    ),
    Array.sort(byYearNewestFirst),
    Array.dedupeWith((left, right) => left.id === right.id),
    Array.take(HOME_NEW_RELEASES),
  )

// FEED

/** What Home is made from: the play history, and Liked songs. */
export type HomeFeedInput = Readonly<{
  /** The songs played lately, the latest first, each once. */
  recentSongs: ReadonlyArray<Song>
  /** The songs played most, the most played first. */
  played: ReadonlyArray<PlayedSong>
  liked: ReadonlyArray<Song>
}>

export const homeFeed = (input: HomeFeedInput): HomeFeed => ({
  ...foldRecent(input.recentSongs),
  maybeLastPlayed: Array.head(input.recentSongs),
  mixes: homeMixes(input.played, input.liked),
})
