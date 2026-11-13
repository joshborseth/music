import { Array, Option, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import {
  CircleAlert,
  CircleArrowDown,
  Disc3,
  Ellipsis,
  Heart,
  ListEnd,
  ListMusic,
  ListStart,
  Music,
  Play,
  Radio,
  RotateCw,
  Shuffle,
  User,
} from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  type AlbumLink,
  type AlbumSummary,
  type ArtistLink,
  type ArtistSummary,
  type Artwork,
  type MyPlaylistSummary,
  type PlaylistSummary,
  type RadioStation,
  type Session,
  type Song,
} from '@music/shared'

import { Message } from '../message'
import { type Model } from '../model'
import { currentEntry } from '../playback/domain'
import { type Swipe, SwipeTarget, swipeOn } from '../playback/swipe'
import { type RequestError } from '../query'
import {
  albumRouter,
  artistRouter,
  myPlaylistRouter,
  playlistRouter,
  songRouter,
} from '../route'
import { swipeableRow } from './swipe'

// FORMATTING

const SECONDS_PER_MINUTE = 60

/** `270` → `4:30`. */
export const formatDuration = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE

/** A playlist's length in words, such as "12 songs · 1 hr 5 min". */
export const playlistLength = (playlist: MyPlaylistSummary): string => {
  const songs = `${playlist.songCount} ${playlist.songCount === 1 ? 'song' : 'songs'}`
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
  return joinDetails([songs, length])
}

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

/** `168462775` → `168.5M views`. */
export const formatViews = (viewCount: number): string =>
  `${compactNumber.format(viewCount)} views`

/** Joins the non-empty parts with a middle dot. */
export const joinDetails = (parts: ReadonlyArray<string>): string =>
  pipe(
    parts,
    Array.filter(part => part.length > 0),
    Array.join(' · '),
  )

export const artistNames = (artists: ReadonlyArray<ArtistLink>): string =>
  pipe(
    artists,
    Array.map(({ name }) => name),
    Array.join(', '),
  )

// LINKS

export const songHref = (videoId: string): string => songRouter({ videoId })

export const artistHref = (artistId: string): string =>
  artistRouter({ artistId })

export const albumHref = (albumId: string): string => albumRouter({ albumId })

export const playlistHref = (playlistId: string): string =>
  playlistRouter({ playlistId })

export const myPlaylistHref = (playlistId: string): string =>
  myPlaylistRouter({ playlistId })

/** Artist credits, each linking to its artist page when it has one. */
export const artistLinks = (
  artists: ReadonlyArray<ArtistLink>,
  className: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> =>
  pipe(
    artists,
    Array.map(artist =>
      Option.match(artist.maybeId, {
        onNone: (): Html | string => artist.name,
        onSome: artistId =>
          h.a(
            [h.Href(artistHref(artistId)), h.Class(className)],
            [artist.name],
          ),
      }),
    ),
    Array.intersperse(', '),
  )

export const albumLink = (album: AlbumLink, h: HtmlBuilder<Message>): Html =>
  h.a([h.Href(albumHref(album.id)), h.Class('active:opacity-60')], [album.name])

/** The first credited artist that has a page. */
export const firstArtistId = (
  artists: ReadonlyArray<ArtistLink>,
): Option.Option<string> => Array.findFirst(artists, ({ maybeId }) => maybeId)

// NOW PLAYING

/** Which song is current, so lists can mark it. */
export type NowPlaying = Readonly<{
  maybeVideoId: Option.Option<string>
  isPlaying: boolean
}>

/** Where songs play, for the Play on button: another device, or this one. */
export type PlayOn = Readonly<{
  maybeDeviceName: Option.Option<string>
  isTv: boolean
}>

export const nowPlaying = (model: Model): NowPlaying => ({
  maybeVideoId: pipe(
    model.maybeSession,
    Option.flatMap(({ state }) => currentEntry(state)),
    Option.map(({ track }) => track.videoId),
  ),
  isPlaying: Option.exists(model.maybeSession, ({ state }) => state.playing),
})

const isCurrentSong = (playing: NowPlaying, videoId: string): boolean =>
  Option.contains(playing.maybeVideoId, videoId)

/** Three bouncing bars, still while paused. */
export const equalizer = (
  isPlaying: boolean,
  className: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.Class(cn('equalizer flex h-3.5 items-end gap-[2px]', className)),
      ...(isPlaying ? [] : [h.DataAttribute('paused', '')]),
    ],
    Array.makeBy(3, () =>
      h.span([h.Class('equalizer-bar h-full w-[3px] rounded-full bg-current')]),
    ),
  )

// ARTWORK

/**
 * Device pixels per CSS pixel, from 1 up to 3 (an iPhone Pro). It never
 * changes while the app runs, so it is read once.
 */
const PIXEL_RATIO = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 2))

/**
 * The sizes a square Google image is asked for when the artwork lists none
 * big enough: 544 for covers on a page, 1080 for the full player and the
 * heroes of album, playlist, and artist pages. A few fixed sizes keep the
 * service worker's artwork cache from holding one image at many sizes.
 */
const LARGE_ARTWORK_SIZES: ReadonlyArray<number> = [544, 1080]

const RESIZABLE_GOOGLE_IMAGE = /=w(\d+)-h(\d+)/

/**
 * The URL of a square Google image at the smallest of
 * `LARGE_ARTWORK_SIZES` that is at least `pixels` wide, or the largest. Any
 * other image keeps its URL.
 */
const resizedUrl = (url: string, pixels: number): string => {
  const match = RESIZABLE_GOOGLE_IMAGE.exec(url)
  if (match === null || match[1] !== match[2] || Number(match[1]) >= pixels) {
    return url
  }
  const size = pipe(
    Array.findFirst(LARGE_ARTWORK_SIZES, large => large >= pixels),
    Option.orElse(() => Array.last(LARGE_ARTWORK_SIZES)),
    Option.getOrElse(() => pixels),
  )
  return url.replace(RESIZABLE_GOOGLE_IMAGE, `=w${size}-h${size}`)
}

/** The pixels an image `displayWidth` CSS pixels wide needs on this screen. */
const devicePixels = (displayWidth: number): number =>
  Math.ceil(displayWidth * PIXEL_RATIO)

/**
 * The smallest image at least `displayWidth` CSS pixels wide on this screen.
 * When none is, a square Google image is asked for at a size that is.
 */
export const artworkUrl = (
  artwork: Artwork,
  displayWidth: number,
): Option.Option<string> => {
  const pixels = devicePixels(displayWidth)
  return pipe(
    Array.findFirst(artwork, ({ width }) => width >= pixels),
    Option.map(({ url }) => url),
    Option.orElse(() =>
      Option.map(Array.last(artwork), ({ url }) => resizedUrl(url, pixels)),
    ),
  )
}

/**
 * A cover's URL at a size sharp at `displayWidth` CSS pixels on this
 * screen, for a cover that comes as one URL, such as a queued song's.
 */
export const sizedArtworkUrl = (url: string, displayWidth: number): string =>
  resizedUrl(url, devicePixels(displayWidth))

export const ArtworkShape = {
  Square: 'rounded-md',
  Card: 'rounded-xl',
  Round: 'rounded-full',
} as const
export type ArtworkShape = (typeof ArtworkShape)[keyof typeof ArtworkShape]

type ArtworkConfig = Readonly<{
  artwork: Artwork
  displayWidth: number
  shape: ArtworkShape
  className: string
  isEager?: boolean
  placeholderIcon?: typeof Music
}>

/** An image with a placeholder for items that have no artwork. */
export const artworkImage = (
  config: ArtworkConfig,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(artworkUrl(config.artwork, config.displayWidth), {
    onNone: () =>
      h.div(
        [
          h.Class(
            cn(
              'bg-muted text-muted-foreground flex shrink-0 items-center justify-center',
              config.shape,
              config.className,
            ),
          ),
        ],
        [icon(h, config.placeholderIcon ?? Music, 'size-2/5')],
      ),
    onSome: url =>
      h.img([
        h.Src(url),
        h.Alt(''),
        h.Loading(config.isEager === true ? 'eager' : 'lazy'),
        h.Decoding('async'),
        h.Referrerpolicy('no-referrer'),
        h.Class(
          cn(
            'bg-muted shrink-0 object-cover outline-1 -outline-offset-1 outline-black/5 dark:outline-white/5',
            config.shape,
            config.className,
          ),
        ),
      ]),
  })

// PLAYLIST COVERS

/** How many covers a mosaic shows, two by two. */
export const MOSAIC_COVERS = 4

type CoverMosaicConfig = Readonly<{
  covers: ReadonlyArray<Artwork>
  displayWidth: number
  shape: ArtworkShape
  className: string
  isEager?: boolean
}>

/** The first four of `covers`, two by two, as a playlist's cover. */
export const coverMosaic = (
  config: CoverMosaicConfig,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class(
        cn(
          'bg-muted grid shrink-0 grid-cols-2 grid-rows-2 overflow-hidden',
          config.shape,
          config.className,
        ),
      ),
    ],
    Array.map(Array.take(config.covers, MOSAIC_COVERS), artwork =>
      Option.match(artworkUrl(artwork, config.displayWidth / 2), {
        onNone: () => h.span([h.Class('bg-muted')]),
        onSome: url =>
          h.img([
            h.Src(url),
            h.Alt(''),
            h.Loading(config.isEager === true ? 'eager' : 'lazy'),
            h.Decoding('async'),
            h.Referrerpolicy('no-referrer'),
            h.Class('size-full object-cover'),
          ]),
      }),
    ),
  )

type PlaylistCoverConfig = Readonly<{
  playlist: MyPlaylistSummary
  displayWidth: number
  shape: ArtworkShape
  className: string
  isEager?: boolean
}>

/**
 * The cover of one of my playlists: a heart for Liked songs, four album
 * covers once it has songs from four albums, else its first cover.
 */
export const playlistCover = (
  config: PlaylistCoverConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const { playlist } = config
  if (playlist.isLiked) {
    return h.div(
      [
        h.Class(
          cn(
            'flex shrink-0 items-center justify-center bg-gradient-to-br from-rose-400 to-fuchsia-600 text-white',
            config.shape,
            config.className,
          ),
        ),
      ],
      [icon(h, Heart, 'size-2/5 fill-current')],
    )
  } else if (playlist.covers.length >= MOSAIC_COVERS) {
    return coverMosaic({ ...config, covers: playlist.covers }, h)
  } else {
    return artworkImage(
      {
        artwork: Option.getOrElse(Array.head(playlist.covers), () => []),
        displayWidth: config.displayWidth,
        shape: config.shape,
        className: config.className,
        placeholderIcon: ListMusic,
        ...(config.isEager === true ? { isEager: true } : {}),
      },
      h,
    )
  }
}

// ROWS

const ROW_ARTWORK_WIDTH = 48

/**
 * What an album's tracklist knows about its rows: whose album it is, so a
 * row names its artists only when they differ, and which tracks are
 * explicit. Its rows also show their lengths.
 */
export type AlbumContext = Readonly<{
  artistNames: string
  explicitVideoIds: ReadonlyArray<string>
}>

type SongRowConfig = Readonly<{
  song: Song
  /** The list tapping this row plays, starting from this song. */
  playlist: ReadonlyArray<Song>
  /**
   * Where this row sits in `playlist`, when the list can hold one song
   * twice. Without it, tapping plays from the song's first copy.
   */
  maybeIndex?: Option.Option<number>
  maybeTrackNumber: Option.Option<number>
  isAlbumHidden: boolean
  /** Lets a long title take two lines, where versions of a song differ only at the end. */
  isTitleWrapped: boolean
  maybeAlbumContext: Option.Option<AlbumContext>
  /**
   * The line under the title, in place of the artists and album: an
   * artist's top songs name their album and how often they were played.
   */
  maybeDetails?: Option.Option<(song: Song) => string>
  playing: NowPlaying
  /**
   * Lets a finger swipe the row to queue the song. None when the row sits in
   * something that scrolls sideways, which needs those drags itself.
   */
  maybeSwipe: Option.Option<Swipe>
  /** The album, playlist, artist, or search `playlist` plays from. */
  maybePlayingFrom?: Option.Option<Session.PlayingFrom>
}>

const songRowArtists = (config: SongRowConfig): string => {
  const names = artistNames(config.song.artists)
  return Option.exists(
    config.maybeAlbumContext,
    context => context.artistNames === names,
  )
    ? ''
    : names
}

const songRowDetails = (config: SongRowConfig): string =>
  Option.match(config.maybeDetails ?? Option.none(), {
    onSome: details => details(config.song),
    onNone: () =>
      joinDetails([
        songRowArtists(config),
        config.isAlbumHidden
          ? ''
          : Option.match(config.song.maybeAlbum, {
              onNone: () => '',
              onSome: ({ name }) => name,
            }),
      ]),
  })

/** The small boxed E that marks an explicit song, as music apps show it. */
export const explicitBadge = (h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.AriaLabel('Explicit'),
      h.Role('img'),
      h.Class(
        'bg-muted-foreground/25 text-muted-foreground inline-flex size-[15px] shrink-0 items-center justify-center rounded-[3px] text-[10px] leading-none font-bold',
      ),
    ],
    ['E'],
  )

const isExplicitIn = (
  maybeAlbumContext: Option.Option<AlbumContext>,
  videoId: string,
): boolean =>
  Option.exists(maybeAlbumContext, ({ explicitVideoIds }) =>
    Array.contains(explicitVideoIds, videoId),
  )

/** Play `songs` from the one with this id. */
export const playFrom = (
  songs: ReadonlyArray<Song>,
  videoId: string,
  maybePlayingFrom: Option.Option<Session.PlayingFrom> = Option.none(),
): Message =>
  Message.ClickedPlaySongs({
    songs,
    startIndex: Option.getOrElse(
      Array.findFirstIndex(songs, song => song.videoId === videoId),
      () => 0,
    ),
    maybePlayingFrom,
  })

const songRowMedia = (
  config: SongRowConfig,
  isCurrent: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(config.maybeTrackNumber, {
    onNone: () =>
      h.span(
        [h.Class('relative shrink-0')],
        [
          artworkImage(
            {
              artwork: config.song.artwork,
              displayWidth: ROW_ARTWORK_WIDTH,
              shape: ArtworkShape.Square,
              className: 'size-12',
            },
            h,
          ),
          isCurrent
            ? h.span(
                [
                  h.Class(
                    'absolute inset-0 flex items-center justify-center rounded-md bg-black/45 text-white',
                  ),
                ],
                [equalizer(config.playing.isPlaying, '', h)],
              )
            : h.empty,
        ],
      ),
    onSome: trackNumber =>
      h.span(
        [
          h.Class(
            'text-muted-foreground flex w-7 shrink-0 justify-center text-[15px] tabular-nums',
          ),
        ],
        [
          isCurrent
            ? equalizer(config.playing.isPlaying, 'text-primary', h)
            : trackNumber.toString(),
        ],
      ),
  })

/**
 * A song in a list. Tapping it plays the list from here, as in any music
 * app; the trailing button opens everything else that can be done with it.
 */
export const songRow = (
  config: SongRowConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const { song } = config
  const isCurrent = isCurrentSong(config.playing, song.videoId)
  const details = songRowDetails(config)
  const content = h.div(
    [h.Class('flex items-center active:bg-muted/70 transition-colors')],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(
            Option.match(config.maybeIndex ?? Option.none(), {
              onNone: () =>
                playFrom(
                  config.playlist,
                  song.videoId,
                  config.maybePlayingFrom,
                ),
              onSome: startIndex =>
                Message.ClickedPlaySongs({
                  songs: config.playlist,
                  startIndex,
                  maybePlayingFrom: config.maybePlayingFrom ?? Option.none(),
                }),
            }),
          ),
          h.AriaLabel(joinDetails([song.title, details])),
          h.Class(
            'flex min-w-0 flex-1 items-center gap-3 py-2 pl-4 text-left outline-none',
          ),
        ],
        [
          songRowMedia(config, isCurrent, h),
          h.span(
            [h.Class('flex min-w-0 flex-1 flex-col')],
            [
              h.span(
                [h.Class('flex min-w-0 items-center gap-1.5')],
                [
                  h.span(
                    [
                      h.Class(
                        cn(
                          'min-w-0 text-[15px] leading-snug',
                          config.isTitleWrapped
                            ? 'line-clamp-2'
                            : 'line-clamp-1',
                          isCurrent
                            ? 'text-primary font-semibold'
                            : 'font-medium',
                        ),
                      ),
                    ],
                    [song.title],
                  ),
                  isExplicitIn(config.maybeAlbumContext, song.videoId)
                    ? explicitBadge(h)
                    : h.empty,
                ],
              ),
              details === ''
                ? h.empty
                : h.span(
                    [
                      h.Class(
                        'text-muted-foreground line-clamp-1 text-[13px] leading-snug',
                      ),
                    ],
                    [details],
                  ),
            ],
          ),
          Option.isSome(config.maybeAlbumContext)
            ? Option.match(song.maybeDurationSeconds, {
                onNone: () => h.empty,
                onSome: seconds =>
                  h.span(
                    [
                      h.Class(
                        'text-muted-foreground shrink-0 text-[13px] tabular-nums',
                      ),
                    ],
                    [formatDuration(Math.round(seconds))],
                  ),
              })
            : h.empty,
        ],
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedSongActions({ song })),
          h.AriaLabel(`More for ${song.title}`),
          h.Class(
            'text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-full active:opacity-50 mr-1',
          ),
        ],
        [icon(h, Ellipsis, 'size-5')],
      ),
    ],
  )
  return Option.match(config.maybeSwipe, {
    onNone: () => content,
    onSome: swipe =>
      swipeableRow(
        {
          target: SwipeTarget.SongRow({ song }),
          maybeSwipe: swipeOn(
            swipe,
            target =>
              target._tag === 'SongRow' && target.song.videoId === song.videoId,
          ),
          maybeRightReveal: Option.some({
            label: 'Add to Queue',
            icon: ListEnd,
            isDestructive: false,
          }),
          maybeLeftReveal: Option.some({
            label: 'Play Next',
            icon: ListStart,
            isDestructive: false,
          }),
        },
        content,
        h,
      ),
  })
}

/**
 * A list with each song once. Rows are keyed by song, and tapping one plays
 * from the first copy anyway, so a repeat would only be a dead row.
 */
const uniqueSongs = (songs: ReadonlyArray<Song>): ReadonlyArray<Song> =>
  Array.dedupeWith(songs, (left, right) => left.videoId === right.videoId)

/**
 * Each song with its place in the list and a key: the song's id, and for a
 * second copy of a song in the same list, which copy it is (`id#2`).
 */
const songRows = (
  songs: ReadonlyArray<Song>,
): ReadonlyArray<Readonly<{ song: Song; position: number; key: string }>> => {
  const seen = new Map<string, number>()
  return songs.map((song, position) => {
    const copy = (seen.get(song.videoId) ?? 0) + 1
    seen.set(song.videoId, copy)
    return {
      song,
      position,
      key: copy === 1 ? song.videoId : `${song.videoId}#${copy}`,
    }
  })
}

/**
 * Songs as a tappable list, each playing the whole list from itself, or with
 * `playsAlone`, only itself.
 */
export const songList = (
  config: Readonly<{
    songs: ReadonlyArray<Song>
    playing: NowPlaying
    swipe: Swipe
    isNumbered: boolean
    isAlbumHidden: boolean
    isTitleWrapped?: boolean
    maybeAlbumContext?: Option.Option<AlbumContext>
    /**
     * Tapping a row plays just its song, and autoplay follows it with similar
     * ones. Search results are not a list anyone would play through: covers,
     * karaoke, and other songs that only share some words.
     */
    playsAlone?: boolean
    maybeDetails?: Option.Option<(song: Song) => string>
    maybePlayingFrom?: Option.Option<Session.PlayingFrom>
  }>,
  h: HtmlBuilder<Message>,
): Html => {
  // Every row stays, even a song listed twice: YouTube sometimes gives two
  // tracks of an album the same video, and dropping one would renumber the
  // rest. Each row plays from its own place.
  const { songs } = config
  return h.div(
    [h.Role('list'), h.Class('flex flex-col')],
    Array.map(songRows(songs), ({ song, position, key }) =>
      h.keyed('div')(
        key,
        [h.Role('listitem')],
        [
          songRow(
            {
              song,
              playlist: config.playsAlone === true ? [song] : songs,
              maybeIndex: Option.some(
                config.playsAlone === true ? 0 : position,
              ),
              maybeTrackNumber: config.isNumbered
                ? Option.some(position + 1)
                : Option.none(),
              isAlbumHidden: config.isAlbumHidden,
              isTitleWrapped: config.isTitleWrapped === true,
              maybeAlbumContext: config.maybeAlbumContext ?? Option.none(),
              maybeDetails: config.maybeDetails ?? Option.none(),
              playing: config.playing,
              maybeSwipe: Option.some(config.swipe),
              maybePlayingFrom: config.maybePlayingFrom ?? Option.none(),
            },
            h,
          ),
        ],
      ),
    ),
  )
}

const linkRowClass =
  'flex items-center gap-3 px-4 py-2 active:bg-muted/70 transition-colors'

/**
 * A row's title and subtitle. Titles take up to two lines, so editions and
 * versions of one album, which differ only at the end, stay told apart.
 */
const rowText = (
  title: string,
  subtitle: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [h.Class('flex min-w-0 flex-1 flex-col')],
    [
      h.span(
        [h.Class('line-clamp-2 text-[15px] leading-snug font-medium')],
        [title],
      ),
      subtitle === ''
        ? h.empty
        : h.span(
            [
              h.Class(
                'text-muted-foreground line-clamp-1 text-[13px] leading-snug',
              ),
            ],
            [subtitle],
          ),
    ],
  )

/** An artist in a list: round photo, name, audience. */
export const artistRow = (
  artist: ArtistSummary,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [h.Href(artistHref(artist.id)), h.Class(linkRowClass)],
    [
      artworkImage(
        {
          artwork: artist.artwork,
          displayWidth: ROW_ARTWORK_WIDTH,
          shape: ArtworkShape.Round,
          className: 'size-12',
          placeholderIcon: User,
        },
        h,
      ),
      rowText(
        artist.name,
        Option.getOrElse(artist.maybeAudience, () => 'Artist'),
        h,
      ),
    ],
  )

const albumDetails = (album: AlbumSummary): string =>
  joinDetails([
    Option.getOrElse(album.maybeKind, () => ''),
    artistNames(album.artists),
    Option.getOrElse(album.maybeYear, () => ''),
  ])

/** An album in a list: cover, title, kind, artists, year. */
export const albumRow = (album: AlbumSummary, h: HtmlBuilder<Message>): Html =>
  h.a(
    [h.Href(albumHref(album.id)), h.Class(linkRowClass)],
    [
      artworkImage(
        {
          artwork: album.artwork,
          displayWidth: ROW_ARTWORK_WIDTH,
          shape: ArtworkShape.Square,
          className: 'size-12',
          placeholderIcon: Disc3,
        },
        h,
      ),
      rowText(album.title, albumDetails(album), h),
    ],
  )

/** A YouTube Music playlist in a list: cover, title, who made it. */
export const playlistRow = (
  playlist: PlaylistSummary,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [h.Href(playlistHref(playlist.id)), h.Class(linkRowClass)],
    [
      artworkImage(
        {
          artwork: playlist.artwork,
          displayWidth: ROW_ARTWORK_WIDTH,
          shape: ArtworkShape.Square,
          className: 'size-12',
          placeholderIcon: ListMusic,
        },
        h,
      ),
      rowText(
        playlist.title,
        Option.getOrElse(playlist.maybeSubtitle, () => 'Playlist'),
        h,
      ),
    ],
  )

const MY_PLAYLIST_ROW_ARTWORK_WIDTH = 56

/** One of my playlists in a list: cover, title, how many songs. */
export const myPlaylistRow = (
  playlist: MyPlaylistSummary,
  h: HtmlBuilder<Message>,
  isDownloaded: boolean = false,
): Html =>
  h.a(
    [h.Href(myPlaylistHref(playlist.id)), h.Class(linkRowClass)],
    [
      playlistCover(
        {
          playlist,
          displayWidth: MY_PLAYLIST_ROW_ARTWORK_WIDTH,
          shape: ArtworkShape.Square,
          className: 'size-14',
        },
        h,
      ),
      rowText(playlist.title, playlistLength(playlist), h),
      isDownloaded ? downloadedMark(h) : h.empty,
    ],
  )

/** The small arrow that marks something downloaded on this phone. */
export const downloadedMark = (h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Role('img'),
      h.AriaLabel('Downloaded'),
      h.Class('text-primary shrink-0'),
    ],
    [icon(h, CircleArrowDown, 'size-4')],
  )

/** Plain rows keyed by a stable id. */
export const list = <A>(
  items: ReadonlyArray<A>,
  config: Readonly<{
    toKey: (item: A) => string
    toRow: (item: A, h: HtmlBuilder<Message>) => Html
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Role('list'), h.Class('flex flex-col')],
    Array.map(items, item =>
      h.keyed('div')(
        config.toKey(item),
        [h.Role('listitem')],
        [config.toRow(item, h)],
      ),
    ),
  )

// ACTIONS

const playActionClass =
  'pressable flex h-12 items-center justify-center gap-2 rounded-xl text-[15px] font-semibold'

/** Play, the page's main action, in Joshify green. */
const primaryPlayActionClass = cn(
  playActionClass,
  'bg-brand text-brand-foreground',
)

/** Shuffle and Radio beside Play, in grey. */
const secondaryPlayActionClass = cn(
  playActionClass,
  'bg-secondary text-foreground',
)

/** Columns for one, two, or three play buttons. */
const PLAY_ACTION_COLUMNS = ['grid-cols-1', 'grid-cols-2', 'grid-cols-3']

/**
 * The big buttons under a header: Play in order, filled in Joshify green as
 * the page's main action, then in grey Shuffle, and Radio when YouTube Music
 * has a radio for the album or artist: songs like these from many artists.
 */
export const playActions = (
  songs: ReadonlyArray<Song>,
  h: HtmlBuilder<Message>,
  maybeRadio: Option.Option<RadioStation> = Option.none(),
  maybePlayingFrom: Option.Option<Session.PlayingFrom> = Option.none(),
): Html => {
  const buttons = [
    ...(Array.isReadonlyArrayNonEmpty(songs)
      ? [
          h.button(
            [
              h.Type('button'),
              h.OnClick(
                Message.ClickedPlaySongs({
                  songs,
                  startIndex: 0,
                  maybePlayingFrom,
                }),
              ),
              h.Class(primaryPlayActionClass),
            ],
            [icon(h, Play, 'size-4 fill-current'), 'Play'],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(
                Message.ClickedShuffleSongs({ songs, maybePlayingFrom }),
              ),
              h.Class(secondaryPlayActionClass),
            ],
            [icon(h, Shuffle, 'size-4'), 'Shuffle'],
          ),
        ]
      : []),
    ...Option.match(maybeRadio, {
      onNone: () => [],
      onSome: station => [
        h.button(
          [
            h.Type('button'),
            h.OnClick(
              Message.ClickedStartStationRadio({
                station,
                title: Option.match(maybePlayingFrom, {
                  onNone: () => '',
                  onSome: ({ title }) => title,
                }),
              }),
            ),
            h.AriaLabel('Start Radio'),
            h.Class(secondaryPlayActionClass),
          ],
          [icon(h, Radio, 'size-4'), 'Radio'],
        ),
      ],
    }),
  ]
  return Array.isReadonlyArrayNonEmpty(buttons)
    ? h.div(
        [
          h.Class(
            cn('grid gap-3 px-4', PLAY_ACTION_COLUMNS[buttons.length - 1]),
          ),
        ],
        buttons,
      )
    : h.empty
}

// CARDS

const CARD_ARTWORK_WIDTH = 168

const cardClass =
  'pressable flex w-[42vw] max-w-44 shrink-0 snap-start flex-col'

const cardTitle = (
  title: string,
  subtitle: string,
  isCentered: boolean,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  h.span(
    [
      h.Class(
        cn(
          'mt-2 line-clamp-2 text-[13px] leading-tight font-medium',
          isCentered && 'text-center',
        ),
      ),
    ],
    [title],
  ),
  subtitle === ''
    ? h.empty
    : h.span(
        [
          h.Class(
            cn(
              'text-muted-foreground mt-0.5 line-clamp-1 text-[13px] leading-tight',
              isCentered && 'text-center',
            ),
          ),
        ],
        [subtitle],
      ),
]

/** An album cover card for a horizontal shelf. */
export const albumCard = (album: AlbumSummary, h: HtmlBuilder<Message>): Html =>
  albumCardWith(
    cardClass,
    joinDetails([
      Option.getOrElse(album.maybeYear, () => ''),
      Array.isReadonlyArrayNonEmpty(album.artists)
        ? artistNames(album.artists)
        : Option.getOrElse(album.maybeKind, () => ''),
    ]),
    album,
    h,
  )

/** Its year and kind, for a release on its own artist's page. */
const releaseDetails = (album: AlbumSummary): string =>
  joinDetails([
    Option.getOrElse(album.maybeYear, () => ''),
    Option.getOrElse(album.maybeKind, () => ''),
  ])

/** An artist's own release on a shelf of their page: year and kind. */
export const releaseCard = (
  album: AlbumSummary,
  h: HtmlBuilder<Message>,
): Html => albumCardWith(cardClass, releaseDetails(album), album, h)

/** An artist's own release in a grid, as wide as its column. */
export const releaseGridCard = (
  album: AlbumSummary,
  h: HtmlBuilder<Message>,
): Html =>
  albumCardWith(
    'pressable flex min-w-0 flex-col',
    releaseDetails(album),
    album,
    h,
  )

const albumCardWith = (
  className: string,
  subtitle: string,
  album: AlbumSummary,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [h.Href(albumHref(album.id)), h.Class(className)],
    [
      artworkImage(
        {
          artwork: album.artwork,
          displayWidth: CARD_ARTWORK_WIDTH,
          shape: ArtworkShape.Card,
          className: 'aspect-square w-full',
          placeholderIcon: Disc3,
        },
        h,
      ),
      ...cardTitle(album.title, subtitle, false, h),
    ],
  )

/** A playlist cover card for a horizontal shelf. */
export const playlistCard = (
  playlist: PlaylistSummary,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [h.Href(playlistHref(playlist.id)), h.Class(cardClass)],
    [
      artworkImage(
        {
          artwork: playlist.artwork,
          displayWidth: CARD_ARTWORK_WIDTH,
          shape: ArtworkShape.Card,
          className: 'aspect-square w-full',
          placeholderIcon: ListMusic,
        },
        h,
      ),
      ...cardTitle(
        playlist.title,
        Option.getOrElse(playlist.maybeSubtitle, () => ''),
        false,
        h,
      ),
    ],
  )

/** An artist photo card for a horizontal shelf. */
export const artistCard = (
  artist: ArtistSummary,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [
      h.Href(artistHref(artist.id)),
      h.Class(cn(cardClass, 'w-[32vw] max-w-32')),
    ],
    [
      artworkImage(
        {
          artwork: artist.artwork,
          displayWidth: CARD_ARTWORK_WIDTH,
          shape: ArtworkShape.Round,
          className: 'aspect-square w-full',
          placeholderIcon: User,
        },
        h,
      ),
      ...cardTitle(artist.name, '', true, h),
    ],
  )

/** One of my playlists as a cover card for a horizontal shelf. */
export const myPlaylistCard = (
  playlist: MyPlaylistSummary,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [h.Href(myPlaylistHref(playlist.id)), h.Class(cardClass)],
    [
      playlistCover(
        {
          playlist,
          displayWidth: CARD_ARTWORK_WIDTH,
          shape: ArtworkShape.Card,
          className: 'aspect-square w-full',
        },
        h,
      ),
      ...cardTitle(playlist.title, playlistLength(playlist), false, h),
    ],
  )

// SECTIONS

const sectionHeading = (title: string, h: HtmlBuilder<Message>): Html =>
  h.h2(
    [h.Class('px-4 text-[22px] leading-tight font-bold tracking-tight')],
    [title],
  )

export const section = (
  title: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('flex flex-col gap-2')],
    [sectionHeading(title, h), ...children],
  )

/**
 * The end of a section's heading, such as See All: a button that sends
 * `onClick`, or a link to `href`, a page with everything in the section.
 */
export type SectionAction = Readonly<
  { label: string; accessibleLabel: string } & (
    | { onClick: Message }
    | { href: string }
  )
>

/** See All, opening a page with everything in the section `title`. */
export const seeAllLink = (title: string, href: string): SectionAction => ({
  label: 'See All',
  accessibleLabel: `See all ${title}`,
  href,
})

const sectionActionClass = 'text-primary shrink-0 text-[17px] active:opacity-50'

const sectionActionView = (
  action: SectionAction,
  h: HtmlBuilder<Message>,
): Html =>
  'href' in action
    ? h.a(
        [
          h.Href(action.href),
          h.AriaLabel(action.accessibleLabel),
          h.Class(sectionActionClass),
        ],
        [action.label],
      )
    : h.button(
        [
          h.Type('button'),
          h.OnClick(action.onClick),
          h.AriaLabel(action.accessibleLabel),
          h.Class(sectionActionClass),
        ],
        [action.label],
      )

/** A section with `maybeAction` at the end of its heading, when there is one. */
const sectionWithMaybeAction = (
  title: string,
  maybeAction: Option.Option<SectionAction>,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeAction, {
    onNone: () => section(title, children, h),
    onSome: action => sectionWithAction(title, action, children, h),
  })

/** A section whose heading ends in a button, as See All does in music apps. */
export const sectionWithAction = (
  title: string,
  action: SectionAction,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('flex flex-col gap-2')],
    [
      h.div(
        [h.Class('flex items-baseline justify-between gap-4 pr-4')],
        [sectionHeading(title, h), sectionActionView(action, h)],
      ),
      ...children,
    ],
  )

/**
 * A section whose title is a name, such as a song's, led by a small line
 * saying what the section is: "More like" over the song. A long name takes
 * one line.
 */
export const namedSection = (
  eyebrow: string,
  name: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class('flex flex-col gap-2')],
    [
      h.h2(
        [h.Class('flex flex-col px-4')],
        [
          h.span(
            [h.Class('text-muted-foreground text-[13px] font-semibold')],
            [`${eyebrow} `],
          ),
          h.span(
            [
              h.Class(
                'line-clamp-1 text-[22px] leading-tight font-bold tracking-tight',
              ),
            ],
            [name],
          ),
        ],
      ),
      ...children,
    ],
  )

const horizontalScrollerClass =
  'no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1'

/** A titled horizontal row of cards that scrolls sideways. */
export const shelf = <A>(
  config: Readonly<{
    title: string
    items: ReadonlyArray<A>
    toKey: (item: A) => string
    toCard: (item: A, h: HtmlBuilder<Message>) => Html
    maybeAction?: Option.Option<SectionAction>
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(config.items, {
    onEmpty: () => h.empty,
    onNonEmpty: items => {
      const scroller = h.div(
        [h.Class(horizontalScrollerClass)],
        Array.map(items, item =>
          h.keyed('div')(
            config.toKey(item),
            [h.Class('contents')],
            [config.toCard(item, h)],
          ),
        ),
      )
      return sectionWithMaybeAction(
        config.title,
        config.maybeAction ?? Option.none(),
        [scroller],
        h,
      )
    },
  })

const SONGS_PER_GRID_COLUMN = 4

/**
 * Songs laid out in columns of four that page sideways, so a long list of
 * picks fits in one band of the screen. Its rows do not swipe to queue: a
 * sideways drag pages the grid.
 */
export const songGridShelf = (
  config: Readonly<{
    title: string
    /** A small line over the title, which then reads as a name. */
    maybeEyebrow?: Option.Option<string>
    songs: ReadonlyArray<Song>
    playing: NowPlaying
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(uniqueSongs(config.songs), {
    onEmpty: () => h.empty,
    onNonEmpty: songs => {
      const grid = [
        h.div(
          [
            h.Role('list'),
            h.Class(
              cn(
                'no-scrollbar grid snap-x snap-mandatory grid-flow-col overflow-x-auto overscroll-x-contain',
                songs.length > SONGS_PER_GRID_COLUMN
                  ? 'auto-cols-[88%]'
                  : 'auto-cols-[100%]',
              ),
            ),
            h.Style({
              gridTemplateRows: `repeat(${Math.min(SONGS_PER_GRID_COLUMN, songs.length)}, auto)`,
            }),
          ],
          Array.map(songs, (song, index) =>
            h.keyed('div')(
              song.videoId,
              [
                h.Role('listitem'),
                h.Class(
                  index % SONGS_PER_GRID_COLUMN === 0 ? 'snap-start' : '',
                ),
              ],
              [
                songRow(
                  {
                    song,
                    playlist: songs,
                    maybeTrackNumber: Option.none(),
                    isAlbumHidden: false,
                    isTitleWrapped: false,
                    maybeAlbumContext: Option.none(),
                    playing: config.playing,
                    maybeSwipe: Option.none(),
                  },
                  h,
                ),
              ],
            ),
          ),
        ),
      ]
      return Option.match(config.maybeEyebrow ?? Option.none(), {
        onNone: () => section(config.title, grid, h),
        onSome: eyebrow => namedSection(eyebrow, config.title, grid, h),
      })
    },
  })

/** A titled vertical list, hidden when there is nothing in it. */
export const songSection = (
  config: Readonly<{
    title: string
    songs: ReadonlyArray<Song>
    playing: NowPlaying
    swipe: Swipe
    /** The line under each title, in place of its artists and album. */
    maybeDetails?: Option.Option<(song: Song) => string>
    /** At the end of the heading, such as See All. */
    maybeAction?: Option.Option<SectionAction>
    maybePlayingFrom?: Option.Option<Session.PlayingFrom>
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.isReadonlyArrayNonEmpty(config.songs)
    ? sectionWithMaybeAction(
        config.title,
        config.maybeAction ?? Option.none(),
        [
          songList(
            {
              songs: config.songs,
              playing: config.playing,
              swipe: config.swipe,
              isNumbered: false,
              isAlbumHidden: false,
              maybeDetails: config.maybeDetails ?? Option.none(),
              maybePlayingFrom: config.maybePlayingFrom ?? Option.none(),
            },
            h,
          ),
        ],
        h,
      )
    : h.empty

/** Long text that shows a few lines until tapped. */
export const expandableText = (text: string, h: HtmlBuilder<Message>): Html =>
  h.details(
    [h.Class('group px-4')],
    [
      h.summary(
        [
          h.Class(
            'text-muted-foreground line-clamp-3 list-none text-[15px] leading-relaxed group-open:line-clamp-none [&::-webkit-details-marker]:hidden',
          ),
        ],
        [text],
      ),
    ],
  )

// LOADING AND ERRORS

const skeletonBlock = (className: string, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class(cn('bg-muted shimmer rounded-md', className))])

const SKELETON_ROW_COUNT = 8

/** Placeholder rows while a list loads. */
export const loadingRows = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-4 px-4 py-2'), h.AriaLabel('Loading')],
    Array.makeBy(SKELETON_ROW_COUNT, () =>
      h.div(
        [h.Class('flex items-center gap-3')],
        [
          skeletonBlock('size-12 shrink-0', h),
          h.div(
            [h.Class('flex flex-1 flex-col gap-2')],
            [skeletonBlock('h-3.5 w-3/5', h), skeletonBlock('h-3 w-2/5', h)],
          ),
        ],
      ),
    ),
  )

/** Placeholder for a row of cards. */
export const loadingShelf = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-3')],
    [
      skeletonBlock('mx-4 h-5 w-40', h),
      h.div(
        [h.Class('flex gap-3 overflow-hidden px-4')],
        Array.makeBy(3, () =>
          h.div(
            [h.Class('flex w-[42vw] max-w-44 shrink-0 flex-col gap-2')],
            [
              skeletonBlock('aspect-square w-full rounded-xl', h),
              skeletonBlock('h-3 w-4/5', h),
              skeletonBlock('h-3 w-1/2', h),
            ],
          ),
        ),
      ),
    ],
  )

/** Placeholder for a detail page header and its first rows. */
export const loadingPage = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-6 pt-4'), h.AriaLabel('Loading')],
    [
      h.div(
        [h.Class('flex flex-col items-center gap-3')],
        [
          skeletonBlock('size-60 rounded-xl', h),
          skeletonBlock('h-6 w-48', h),
          skeletonBlock('h-4 w-32', h),
        ],
      ),
      loadingRows(h),
    ],
  )

const requestErrorText = (error: RequestError): string =>
  ({
    NotFound: 'There is nothing at this address.',
    YouTubeUnavailable:
      'YouTube Music did not answer. It may be busy; try again in a moment.',
    ServerUnreachable:
      'Could not reach the music server. Check your connection.',
    PlaylistsUnavailable:
      'The music server could not read your playlists. Try again in a moment.',
  })[error]

/** An error message with a retry button. */
export const requestErrorAlert = (
  error: RequestError,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Role('alert'),
      h.Class('flex flex-col items-center gap-3 px-8 py-16 text-center'),
    ],
    [
      h.span(
        [
          h.Class(
            'bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full',
          ),
        ],
        [icon(h, CircleAlert, 'size-6')],
      ),
      h.p([h.Class('text-lg font-semibold')], ['Something went wrong']),
      h.p(
        [h.Class('text-muted-foreground text-[15px]')],
        [requestErrorText(error)],
      ),
      error === 'NotFound'
        ? h.empty
        : h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedRetry()),
              h.Class(
                'pressable bg-secondary text-primary mt-2 flex h-10 items-center gap-2 rounded-full px-5 text-[15px] font-semibold',
              ),
            ],
            [icon(h, RotateCw, 'size-4'), 'Retry'],
          ),
    ],
  )

/** Renders remote data with shared loading and error states. */
export const remote = <A>(
  asyncData: AsyncData.AsyncData<A, RequestError>,
  config: Readonly<{
    onLoading: () => Html
    onData: (data: A) => Html
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  AsyncData.matchData(asyncData, {
    onEmpty: config.onLoading,
    onFailure: error => requestErrorAlert(error, h),
    onData: config.onData,
  })

const emptyStateIcons = {
  Song: Music,
  Artist: User,
  Album: Disc3,
  Playlist: ListMusic,
} as const

/** A centered message for empty screens. */
export const emptyState = (
  config: Readonly<{
    title: string
    description: string
    kind: keyof typeof emptyStateIcons
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col items-center gap-2 px-10 py-20 text-center')],
    [
      h.span(
        [
          h.Class(
            'bg-muted text-muted-foreground mb-2 flex size-16 items-center justify-center rounded-full',
          ),
        ],
        [icon(h, emptyStateIcons[config.kind], 'size-7')],
      ),
      h.p([h.Class('text-xl font-semibold tracking-tight')], [config.title]),
      h.p(
        [h.Class('text-muted-foreground text-[15px] leading-relaxed')],
        [config.description],
      ),
    ],
  )
