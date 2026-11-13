import { Array, Option, Order, Schema, String, pipe } from 'effect'
import { type Helpers, type Misc, YTNodes } from 'youtubei.js'

import {
  type AlbumDetails,
  type AlbumSummary,
  type ArtistDetails,
  type ArtistLink,
  type ArtistSummary,
  type Artwork,
  type Lyrics,
  type MoodCategory,
  type MoodDetails,
  type MoodGroup,
  type PlaylistDetails,
  type PlaylistShelf,
  type PlaylistSummary,
  ReleaseKind,
  type Song,
  type Thumbnail,
  type TopResult,
} from '@music/shared'

// COLLECTIONS

/** Maps each item and keeps only the results that are present. */
export const filterSome = <A, B>(
  items: ReadonlyArray<A>,
  toMaybe: (item: A) => Option.Option<B>,
): Array<B> => Array.getSomes(Array.map(items, toMaybe))

// TEXT

const SUBTITLE_SEPARATOR = ' • '

const LYRICS_SOURCE_PREFIX = 'Source: '

type TextLike = { readonly toString: () => string }

const textToOption = (maybeText: TextLike | null | undefined) =>
  pipe(
    Option.fromNullishOr(maybeText),
    Option.map(text => text.toString().trim()),
    Option.filter(String.isNonEmpty),
  )

const nonEmptyString = (maybeValue: string | null | undefined) =>
  pipe(
    Option.fromNullishOr(maybeValue),
    Option.map(String.trim),
    Option.filter(String.isNonEmpty),
  )

const subtitleSegments = (
  maybeSubtitle: TextLike | null | undefined,
): ReadonlyArray<string> =>
  Option.match(textToOption(maybeSubtitle), {
    onNone: () => [],
    onSome: subtitle =>
      pipe(
        subtitle.split(SUBTITLE_SEPARATOR),
        Array.map(String.trim),
        Array.filter(String.isNonEmpty),
      ),
  })

const decodeReleaseKind = Schema.decodeUnknownOption(ReleaseKind)

const releaseKindFromSubtitle = (
  maybeSubtitle: TextLike | null | undefined,
): Option.Option<ReleaseKind> =>
  pipe(
    subtitleSegments(maybeSubtitle),
    Array.findFirst(segment => decodeReleaseKind(segment)),
  )

// ENDPOINTS

const BrowsePayload = Schema.Struct({ browseId: Schema.String })

const decodeBrowsePayload = Schema.decodeUnknownOption(BrowsePayload)

const browseIdOf = (
  maybeEndpoint: YTNodes.NavigationEndpoint | null | undefined,
): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(maybeEndpoint),
    Option.flatMap(endpoint => decodeBrowsePayload(endpoint.payload)),
    Option.map(({ browseId }) => browseId),
  )

// ARTWORK

const LARGE_ARTWORK_SIZE = 544

const RESIZABLE_GOOGLE_IMAGE = /=w\d+-h\d+/

const absoluteUrl = (url: string): string =>
  url.startsWith('//') ? `https:${url}` : url

const toThumbnail = ({ url, width, height }: Misc.Thumbnail): Thumbnail => ({
  url: absoluteUrl(url),
  width,
  height,
})

const largeVariant = (thumbnail: Thumbnail): Option.Option<Thumbnail> =>
  Option.liftPredicate(
    {
      url: thumbnail.url.replace(
        RESIZABLE_GOOGLE_IMAGE,
        `=w${LARGE_ARTWORK_SIZE}-h${LARGE_ARTWORK_SIZE}`,
      ),
      width: LARGE_ARTWORK_SIZE,
      height: LARGE_ARTWORK_SIZE,
    },
    () =>
      RESIZABLE_GOOGLE_IMAGE.test(thumbnail.url) &&
      thumbnail.width < LARGE_ARTWORK_SIZE,
  )

const byWidth = Order.mapInput(Order.Number, ({ width }: Thumbnail) => width)

/**
 * Converts YouTube's thumbnails to Artwork, smallest first. Square Google
 * images can be served at any size, so a large variant is added when the
 * response only lists small ones.
 */
export const toArtwork = (
  maybeThumbnails: ReadonlyArray<Misc.Thumbnail> | null | undefined,
): Artwork => {
  const thumbnails = Array.map(maybeThumbnails ?? [], toThumbnail)
  const maybeLarge = pipe(
    Array.sort(thumbnails, byWidth),
    Array.last,
    Option.flatMap(largeVariant),
  )
  return Array.sort(
    Array.appendAll(thumbnails, Array.fromOption(maybeLarge)),
    byWidth,
  )
}

// ARTISTS

type ArtistCredit = {
  readonly name: string
  readonly channel_id?: string | undefined
}

const toArtistLink = ({ name, channel_id }: ArtistCredit): ArtistLink => ({
  maybeId: nonEmptyString(channel_id),
  name,
})

const toArtistLinks = (
  maybeCredits: ReadonlyArray<ArtistCredit> | null | undefined,
): ReadonlyArray<ArtistLink> => Array.map(maybeCredits ?? [], toArtistLink)

const listItemArtistLinks = (
  item: YTNodes.MusicResponsiveListItem,
): ReadonlyArray<ArtistLink> =>
  Array.match(toArtistLinks(item.artists), {
    onNonEmpty: links => links,
    onEmpty: () =>
      Array.match(toArtistLinks(item.authors), {
        onNonEmpty: links => links,
        onEmpty: () =>
          Array.map(Array.fromNullishOr(item.author), toArtistLink),
      }),
  })

const textArtistLinks = (
  maybeText: Misc.Text | null | undefined,
): ReadonlyArray<ArtistLink> => {
  const linkedArtists = filterSome(maybeText?.runs ?? [], run =>
    pipe(
      browseIdOf('endpoint' in run ? run.endpoint : undefined),
      Option.map(id => ({ maybeId: Option.some(id), name: run.text })),
    ),
  )
  return Array.match(linkedArtists, {
    onNonEmpty: links => links,
    onEmpty: () =>
      Array.map(Array.fromOption(textToOption(maybeText)), name => ({
        maybeId: Option.none(),
        name,
      })),
  })
}

/** An artist from a search result row. */
export const artistFromListItem = (
  item: YTNodes.MusicResponsiveListItem,
): Option.Option<ArtistSummary> =>
  Option.all({
    id: nonEmptyString(item.id),
    name: nonEmptyString(item.name ?? item.title),
  }).pipe(
    Option.map(({ id, name }) => ({
      id,
      name,
      maybeAudience: audienceFromSubtitle(item.subtitle),
      artwork: toArtwork(item.thumbnail?.contents),
    })),
  )

const ARTIST_LABEL = 'Artist'

const audienceFromSubtitle = (
  maybeSubtitle: TextLike | null | undefined,
): Option.Option<string> =>
  pipe(
    subtitleSegments(maybeSubtitle),
    Array.findFirst(segment => segment !== ARTIST_LABEL),
  )

// SONGS

/** A song from a search result, tracklist, or top-songs row. */
export const songFromListItem = (
  item: YTNodes.MusicResponsiveListItem,
): Option.Option<Song> =>
  Option.all({
    videoId: nonEmptyString(item.id),
    title: nonEmptyString(item.title),
  }).pipe(
    Option.map(({ videoId, title }) => ({
      videoId,
      title,
      artists: listItemArtistLinks(item),
      maybeAlbum: pipe(
        Option.fromNullishOr(item.album),
        Option.flatMap(({ id, name }) =>
          Option.map(nonEmptyString(id), albumId => ({ id: albumId, name })),
        ),
      ),
      maybeDurationSeconds: Option.fromNullishOr(item.duration?.seconds),
      artwork: toArtwork(item.thumbnail?.contents),
    })),
  )

/** A song from an "up next" queue. */
export const songFromPlaylistPanelVideo = (
  video: YTNodes.PlaylistPanelVideo,
): Option.Option<Song> =>
  Option.all({
    videoId: nonEmptyString(video.video_id),
    title: textToOption(video.title),
  }).pipe(
    Option.map(({ videoId, title }) => ({
      videoId,
      title,
      artists: toArtistLinks(video.artists),
      maybeAlbum: pipe(
        Option.fromNullishOr(video.album),
        Option.flatMap(({ id, name }) =>
          Option.map(nonEmptyString(id), albumId => ({ id: albumId, name })),
        ),
      ),
      maybeDurationSeconds: Option.liftPredicate(
        video.duration.seconds,
        seconds => seconds > 0,
      ),
      artwork: toArtwork(video.thumbnail),
    })),
  )

/** Lyrics from the song's lyrics tab. */
export const toLyrics = (
  shelf: YTNodes.MusicDescriptionShelf,
): Option.Option<Lyrics> =>
  Option.map(textToOption(shelf.description), text => ({
    text,
    maybeSource: pipe(
      textToOption(shelf.footer),
      Option.map(footer =>
        footer.startsWith(LYRICS_SOURCE_PREFIX)
          ? footer.slice(LYRICS_SOURCE_PREFIX.length)
          : footer,
      ),
    ),
    maybeLines: Option.none(),
  }))

// ALBUMS

/** An album from a search result row. */
export const albumFromListItem = (
  item: YTNodes.MusicResponsiveListItem,
): Option.Option<AlbumSummary> =>
  Option.all({
    id: nonEmptyString(item.id),
    title: nonEmptyString(item.title),
  }).pipe(
    Option.map(({ id, title }) => ({
      id,
      title,
      artists: listItemArtistLinks(item),
      maybeKind: Option.orElse(releaseKindFromSubtitle(item.subtitle), () =>
        releaseKindFromSubtitle(item.flex_columns.at(1)?.title),
      ),
      maybeYear: nonEmptyString(item.year),
      artwork: toArtwork(item.thumbnail?.contents),
    })),
  )

/**
 * An album from a carousel. Cards on an artist page omit the artist and
 * sometimes the release kind, so the caller supplies both.
 */
export const albumFromTwoRowItem =
  (
    fallbackArtists: ReadonlyArray<ArtistLink>,
    defaultKind: Option.Option<ReleaseKind>,
  ) =>
  (item: YTNodes.MusicTwoRowItem): Option.Option<AlbumSummary> =>
    Option.all({
      id: nonEmptyString(item.id),
      title: textToOption(item.title),
    }).pipe(
      Option.map(({ id, title }) => ({
        id,
        title,
        artists: Array.match(toArtistLinks(item.artists), {
          onNonEmpty: links => links,
          onEmpty: () => fallbackArtists,
        }),
        maybeKind: Option.orElse(
          releaseKindFromSubtitle(item.subtitle),
          () => defaultKind,
        ),
        maybeYear: nonEmptyString(item.year),
        artwork: toArtwork(item.thumbnail),
      })),
    )

const withAlbumContext =
  (album: AlbumSummary) =>
  (song: Song): Song => ({
    ...song,
    artists: Array.match(song.artists, {
      onNonEmpty: artists => artists,
      onEmpty: () => album.artists,
    }),
    maybeAlbum: Option.orElse(song.maybeAlbum, () =>
      Option.some({ id: album.id, name: album.title }),
    ),
    artwork: Array.match(song.artwork, {
      onNonEmpty: artwork => artwork,
      onEmpty: () => album.artwork,
    }),
  })

const EXPLICIT_BADGE = 'MUSIC_EXPLICIT_BADGE'

/** Whether YouTube Music marks a row explicit. */
export const isExplicit = (item: YTNodes.MusicResponsiveListItem): boolean =>
  Array.some(
    item.badges ?? [],
    badge =>
      badge.is(YTNodes.MusicInlineBadge) &&
      badge.as(YTNodes.MusicInlineBadge).icon_type === EXPLICIT_BADGE,
  )

/** The album page. Returns None when the page has no recognizable header. */
export const toAlbumDetails = (
  albumId: string,
  page: {
    readonly header?: YTNodes.MusicResponsiveHeader | YTNodes.MusicDetailHeader
    readonly contents: ReadonlyArray<YTNodes.MusicResponsiveListItem>
  },
): Option.Option<AlbumDetails> =>
  pipe(
    Option.fromNullishOr(page.header),
    Option.filter(header => header.is(YTNodes.MusicResponsiveHeader)),
    Option.map(header => header.as(YTNodes.MusicResponsiveHeader)),
    Option.flatMap(header =>
      Option.map(textToOption(header.title), title => {
        const segments = subtitleSegments(header.subtitle)
        const album: AlbumSummary = {
          id: albumId,
          title,
          artists: textArtistLinks(header.strapline_text_one),
          maybeKind: releaseKindFromSubtitle(header.subtitle),
          maybeYear: Array.findFirst(segments, segment =>
            /^\d{4}$/.test(segment),
          ),
          artwork: toArtwork(header.thumbnail?.contents),
        }
        return {
          album,
          maybeDescription: textToOption(header.description?.description),
          maybeLengthSummary: textToOption(header.second_subtitle),
          tracks: Array.map(
            filterSome(page.contents, songFromListItem),
            withAlbumContext(album),
          ),
          explicitVideoIds: filterSome(page.contents, item =>
            isExplicit(item) ? nonEmptyString(item.id) : Option.none(),
          ),
        }
      }),
    ),
  )

// ARTIST PAGE

const ALBUMS_SHELF_TITLE = 'Albums'
const SINGLES_SHELF_TITLE = 'Singles & EPs'

type ArtistPage = {
  readonly header?:
    | YTNodes.MusicImmersiveHeader
    | YTNodes.MusicVisualHeader
    | YTNodes.MusicHeader
  readonly sections: ReadonlyArray<
    YTNodes.MusicCarouselShelf | YTNodes.MusicShelf
  >
}

const headerTitle = (header: NonNullable<ArtistPage['header']>) =>
  header.is(YTNodes.MusicHeader)
    ? textToOption(header.as(YTNodes.MusicHeader).title)
    : textToOption(
        header.as(YTNodes.MusicImmersiveHeader, YTNodes.MusicVisualHeader)
          .title,
      )

const headerArtwork = (header: NonNullable<ArtistPage['header']>): Artwork => {
  if (header.is(YTNodes.MusicImmersiveHeader)) {
    return toArtwork(
      header.as(YTNodes.MusicImmersiveHeader).thumbnail?.contents,
    )
  }
  if (header.is(YTNodes.MusicVisualHeader)) {
    return toArtwork(header.as(YTNodes.MusicVisualHeader).thumbnail)
  }
  return []
}

const headerDescription = (header: NonNullable<ArtistPage['header']>) =>
  header.is(YTNodes.MusicImmersiveHeader)
    ? textToOption(header.as(YTNodes.MusicImmersiveHeader).description)
    : Option.none()

const carouselItems = (
  sections: ArtistPage['sections'],
  title: string,
): ReadonlyArray<YTNodes.MusicTwoRowItem> =>
  pipe(
    sections,
    Array.findFirst(section =>
      section.is(YTNodes.MusicCarouselShelf)
        ? Option.liftPredicate(
            section.as(YTNodes.MusicCarouselShelf),
            carousel => carousel.header?.title.toString().trim() === title,
          )
        : Option.none(),
    ),
    Option.match({
      onNone: () => [],
      onSome: carousel =>
        filterSome(carousel.contents, item =>
          item.is(YTNodes.MusicTwoRowItem)
            ? Option.some(item.as(YTNodes.MusicTwoRowItem))
            : Option.none(),
        ),
    }),
  )

/** The artist page. Returns None when YouTube has no artist with this id. */
export const toArtistDetails = (
  artistId: string,
  page: ArtistPage,
): Option.Option<ArtistDetails> =>
  pipe(
    Option.fromNullishOr(page.header),
    Option.flatMap(header =>
      Option.map(headerTitle(header), name => {
        const artistLink: ArtistLink = { maybeId: Option.some(artistId), name }
        return {
          artist: {
            id: artistId,
            name,
            maybeAudience: Option.none(),
            artwork: headerArtwork(header),
          },
          maybeDescription: headerDescription(header),
          topSongs: pipe(
            page.sections,
            Array.findFirst(section =>
              section.is(YTNodes.MusicShelf)
                ? Option.some(section.as(YTNodes.MusicShelf))
                : Option.none(),
            ),
            Option.match({
              onNone: () => [],
              onSome: shelf => filterSome(shelf.contents, songFromListItem),
            }),
          ),
          albums: filterSome(
            carouselItems(page.sections, ALBUMS_SHELF_TITLE),
            albumFromTwoRowItem([artistLink], Option.some('Album')),
          ),
          singles: filterSome(
            carouselItems(page.sections, SINGLES_SHELF_TITLE),
            albumFromTwoRowItem([artistLink], Option.none()),
          ),
        }
      }),
    ),
  )

// PLAYLISTS

/** A playlist from a search result row. */
export const playlistFromListItem = (
  item: YTNodes.MusicResponsiveListItem,
): Option.Option<PlaylistSummary> =>
  Option.all({
    id: nonEmptyString(item.id),
    title: nonEmptyString(item.title),
  }).pipe(
    Option.map(({ id, title }) => ({
      id,
      title,
      maybeSubtitle: pipe(
        subtitleSegments(item.flex_columns.at(1)?.title),
        Array.join(' · '),
        Option.liftPredicate(String.isNonEmpty),
      ),
      artwork: toArtwork(item.thumbnail?.contents),
    })),
  )

/**
 * The playlist page. Its header reads like an album's, except the subtitle
 * names the kind and year rather than the artists.
 */
export const toPlaylistDetails = (
  playlistId: string,
  page: {
    readonly header: Helpers.YTNode | undefined
    readonly items: ReadonlyArray<Helpers.YTNode>
  },
): Option.Option<PlaylistDetails> =>
  pipe(
    Option.fromNullishOr(page.header),
    Option.filter(header => header.is(YTNodes.MusicResponsiveHeader)),
    Option.map(header => header.as(YTNodes.MusicResponsiveHeader)),
    Option.flatMap(header =>
      Option.map(textToOption(header.title), title => ({
        playlist: {
          id: playlistId,
          title,
          maybeSubtitle: pipe(
            textToOption(header.strapline_text_one),
            Option.filter(text => text !== 'N/A'),
            Option.orElse(() =>
              pipe(
                subtitleSegments(header.subtitle),
                Array.join(' · '),
                Option.liftPredicate(String.isNonEmpty),
              ),
            ),
          ),
          artwork: toArtwork(header.thumbnail?.contents),
        },
        maybeDescription: textToOption(header.description?.description),
        maybeLengthSummary: textToOption(header.second_subtitle),
        tracks: filterSome(page.items, item =>
          item.is(YTNodes.MusicResponsiveListItem)
            ? songFromListItem(item.as(YTNodes.MusicResponsiveListItem))
            : Option.none(),
        ),
      })),
    ),
  )

// TOP RESULT

const PageTypePayload = Schema.Struct({
  browseId: Schema.String,
  browseEndpointContextSupportedConfigs: Schema.Struct({
    browseEndpointContextMusicConfig: Schema.Struct({
      pageType: Schema.String,
    }),
  }),
})

const decodePageTypePayload = Schema.decodeUnknownOption(PageTypePayload)

const WatchPayload = Schema.Struct({ videoId: Schema.String })

const decodeWatchPayload = Schema.decodeUnknownOption(WatchPayload)

const ARTIST_PAGE = 'MUSIC_PAGE_TYPE_ARTIST'
const ALBUM_PAGE = 'MUSIC_PAGE_TYPE_ALBUM'
const PLAYLIST_PAGE = 'MUSIC_PAGE_TYPE_PLAYLIST'

/**
 * Playlist ids that start with `VLRD` are YouTube's generated mixes and
 * radio stations, except `VLRDCLAK`, its own curated playlists.
 */
const isRadioPlaylist = (playlistId: string): boolean =>
  playlistId.startsWith('VLRD') && !playlistId.startsWith('VLRDCLAK')

const CLOCK = /^\d+(:\d{2}){1,2}$/

/** `3:57` → `237`, `1:02:03` → `3723`. */
export const secondsFromClock = (text: string): Option.Option<number> =>
  pipe(
    Option.liftPredicate(text, value => CLOCK.test(value)),
    Option.map(value =>
      Array.reduce(
        value.split(':'),
        0,
        (total, part) => total * 60 + Number(part),
      ),
    ),
  )

/** The credits in a subtitle: the runs that link to an artist page. */
const subtitleArtistLinks = (
  subtitle: Misc.Text | null | undefined,
): ReadonlyArray<ArtistLink> =>
  filterSome(subtitle?.runs ?? [], run =>
    pipe(
      decodePageTypePayload(
        'endpoint' in run ? run.endpoint?.payload : undefined,
      ),
      Option.filter(
        payload =>
          payload.browseEndpointContextSupportedConfigs
            .browseEndpointContextMusicConfig.pageType === ARTIST_PAGE,
      ),
      Option.map(({ browseId }) => ({
        maybeId: Option.some(browseId),
        name: run.text,
      })),
    ),
  )

const YEAR = /^\d{4}$/

const PLAYLIST_LABEL = 'Playlist'

const playlistSubtitle = (
  maybeSubtitle: TextLike | null | undefined,
): Option.Option<string> =>
  pipe(
    subtitleSegments(maybeSubtitle),
    Array.filter(segment => segment !== PLAYLIST_LABEL),
    Array.join(' · '),
    Option.liftPredicate(String.isNonEmpty),
  )

type TopResultCard = Readonly<{
  title: Misc.Text
  subtitle: Misc.Text
  on_tap: YTNodes.NavigationEndpoint
  thumbnail: Readonly<{ contents: ReadonlyArray<Misc.Thumbnail> }> | null
}>

const topResultFromPage = (
  card: TopResultCard,
  title: string,
  browseId: string,
  pageType: string,
): Option.Option<TopResult> => {
  const artwork = toArtwork(card.thumbnail?.contents)
  if (pageType === ARTIST_PAGE) {
    return Option.some({
      _tag: 'Artist',
      artist: {
        id: browseId,
        name: title,
        maybeAudience: audienceFromSubtitle(card.subtitle),
        artwork,
      },
    })
  }
  if (pageType === ALBUM_PAGE) {
    return Option.some({
      _tag: 'Album',
      album: {
        id: browseId,
        title,
        artists: subtitleArtistLinks(card.subtitle),
        maybeKind: releaseKindFromSubtitle(card.subtitle),
        maybeYear: Array.findFirst(subtitleSegments(card.subtitle), segment =>
          YEAR.test(segment),
        ),
        artwork,
      },
    })
  }
  if (pageType === PLAYLIST_PAGE && !isRadioPlaylist(browseId)) {
    return Option.some({
      _tag: 'Playlist',
      playlist: {
        id: browseId,
        title,
        maybeSubtitle: playlistSubtitle(card.subtitle),
        artwork,
      },
    })
  }
  return Option.none()
}

/** The labels a song or video subtitle starts with, before its credits. */
const WATCH_LABELS: ReadonlyArray<string> = ['Song', 'Video']

const COUNT = /\b(views|plays)$/

/**
 * The credits in a song or video subtitle. A video posted by a channel that
 * is not an artist page links nowhere, so then its name is kept as plain
 * text instead of leaving the song with no artist at all.
 */
const watchArtistLinks = (
  subtitle: Misc.Text | null | undefined,
): ReadonlyArray<ArtistLink> =>
  Array.match(subtitleArtistLinks(subtitle), {
    onNonEmpty: links => links,
    onEmpty: () =>
      pipe(
        subtitleSegments(subtitle),
        Array.findFirst(
          segment =>
            !Array.contains(WATCH_LABELS, segment) &&
            !COUNT.test(segment) &&
            Option.isNone(secondsFromClock(segment)),
        ),
        Option.match({
          onNone: () => [],
          onSome: name => [{ maybeId: Option.none(), name }],
        }),
      ),
  })

const topResultFromVideo = (
  card: TopResultCard,
  title: string,
  videoId: string,
): TopResult => ({
  _tag: 'Song',
  song: {
    videoId,
    title,
    artists: watchArtistLinks(card.subtitle),
    maybeAlbum: Option.none(),
    maybeDurationSeconds: Array.findFirst(
      Array.reverse(subtitleSegments(card.subtitle)),
      secondsFromClock,
    ),
    artwork: toArtwork(card.thumbnail?.contents),
  },
})

/**
 * The card YouTube Music puts above its search results: an artist, album,
 * playlist, or song (often its music video). Anything else, such as a
 * radio station, is left out.
 */
export const topResultFromCard = (
  card: TopResultCard,
): Option.Option<TopResult> => {
  const payload = (card.title.endpoint ?? card.on_tap).payload
  return Option.flatMap(textToOption(card.title), title =>
    Option.match(decodePageTypePayload(payload), {
      onSome: ({ browseId, browseEndpointContextSupportedConfigs }) =>
        topResultFromPage(
          card,
          title,
          browseId,
          browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig
            .pageType,
        ),
      onNone: () =>
        Option.map(decodeWatchPayload(payload), ({ videoId }) =>
          topResultFromVideo(card, title, videoId),
        ),
    }),
  )
}

/** Brackets that name a kind of video, not a version of the song. */
const VIDEO_BRACKET =
  /\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|m\/?v|hd|4k)\b[^)\]]*[)\]]/gi

const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu

const TITLE_ARTIST_SEPARATOR = ' - '

/**
 * A title cut down to what tells songs apart: no "(Official Music Video)",
 * no "Artist - " in front, and no case or punctuation. "Taylor Swift -
 * Anti-Hero (Official Music Video)" and "Anti-Hero" both become "antihero".
 */
const comparableTitle = (
  title: string,
  artists: ReadonlyArray<ArtistLink>,
): string => {
  const separator = title.indexOf(TITLE_ARTIST_SEPARATOR)
  const prefix = title.slice(0, Math.max(0, separator)).toLowerCase()
  const isArtistPrefix =
    separator > 0 &&
    Array.some(artists, ({ name }) => prefix.includes(name.toLowerCase()))
  return (
    isArtistPrefix
      ? title.slice(separator + TITLE_ARTIST_SEPARATOR.length)
      : title
  )
    .replace(VIDEO_BRACKET, '')
    .replace(NOT_LETTER_OR_DIGIT, '')
    .toLowerCase()
}

const isSameArtist = (left: ArtistLink, right: ArtistLink): boolean =>
  Option.isSome(left.maybeId) && Option.isSome(right.maybeId)
    ? left.maybeId.value === right.maybeId.value
    : left.name.toLowerCase() === right.name.toLowerCase()

/**
 * The audio track of a song that YouTube Music found as its music video: the
 * song among `songs` (a song search for the same words) with the same title
 * by the same artist. The video plays with its intro and skits and shows a
 * cropped frame for its cover, where Apple Music and Spotify would play the
 * song. A video that credits no artist page matches on its title alone, so
 * the song it becomes brings its artists along.
 */
export const audioTrackFor = (
  video: Song,
  songs: ReadonlyArray<Song>,
): Option.Option<Song> => {
  const title = comparableTitle(video.title, video.artists)
  const hasLinkedArtist = Array.some(video.artists, ({ maybeId }) =>
    Option.isSome(maybeId),
  )
  return pipe(
    Array.findFirst(songs, song => song.videoId === video.videoId),
    Option.orElse(() =>
      Array.findFirst(
        songs,
        song =>
          String.isNonEmpty(title) &&
          comparableTitle(song.title, song.artists) === title &&
          (!hasLinkedArtist ||
            Array.some(song.artists, artist =>
              Array.some(video.artists, other => isSameArtist(artist, other)),
            )),
      ),
    ),
  )
}

// MOODS AND GENRES

const RawText = Schema.Struct({
  runs: Schema.Array(Schema.Struct({ text: Schema.String })),
})

const RawNavigationButton = Schema.Struct({
  buttonText: RawText,
  solid: Schema.optional(
    Schema.Struct({ leftStripeColor: Schema.optional(Schema.Number) }),
  ),
  clickCommand: Schema.Struct({
    browseEndpoint: Schema.Struct({ params: Schema.String }),
  }),
})

const RawGrid = Schema.Struct({
  header: Schema.optional(
    Schema.Struct({ gridHeaderRenderer: Schema.Struct({ title: RawText }) }),
  ),
  items: Schema.Array(
    Schema.Struct({
      musicNavigationButtonRenderer: Schema.optional(RawNavigationButton),
    }),
  ),
})

/** The parts of the moods and genres page this app reads. */
const RawMoodsPage = Schema.Struct({
  contents: Schema.Struct({
    singleColumnBrowseResultsRenderer: Schema.Struct({
      tabs: Schema.Array(
        Schema.Struct({
          tabRenderer: Schema.Struct({
            content: Schema.Struct({
              sectionListRenderer: Schema.Struct({
                contents: Schema.Array(
                  Schema.Struct({ gridRenderer: Schema.optional(RawGrid) }),
                ),
              }),
            }),
          }),
        }),
      ),
    }),
  }),
})

const decodeRawMoodsPage = Schema.decodeUnknownOption(RawMoodsPage)

const rawText = ({ runs }: typeof RawText.Type): string =>
  pipe(
    runs,
    Array.map(({ text }) => text),
    Array.join(''),
    String.trim,
  )

const RGB_MASK = 0xffffff

/** YouTube's colors are ARGB numbers: `0xffa4c5ff` → `#a4c5ff`. */
export const hexFromArgb = (argb: number): string =>
  `#${(argb & RGB_MASK).toString(16).padStart(6, '0')}`

const toMoodCategory = (
  button: typeof RawNavigationButton.Type,
): Option.Option<MoodCategory> =>
  Option.map(nonEmptyString(rawText(button.buttonText)), title => ({
    params: button.clickCommand.browseEndpoint.params,
    title,
    maybeColor: Option.map(
      Option.fromNullishOr(button.solid?.leftStripeColor),
      hexFromArgb,
    ),
  }))

const toMoodGroup = (grid: typeof RawGrid.Type): Option.Option<MoodGroup> => {
  const categories = filterSome(grid.items, item =>
    Option.flatMap(
      Option.fromNullishOr(item.musicNavigationButtonRenderer),
      toMoodCategory,
    ),
  )
  return Array.isReadonlyArrayNonEmpty(categories)
    ? Option.some({
        title: Option.match(Option.fromNullishOr(grid.header), {
          onNone: () => '',
          onSome: ({ gridHeaderRenderer }) => rawText(gridHeaderRenderer.title),
        }),
        categories,
      })
    : Option.none()
}

/**
 * The moods and genres page, read from YouTube's raw response because the
 * parsed one drops each category's color. None when it no longer has the
 * shape this expects.
 */
export const toMoodGroups = (
  response: unknown,
): Option.Option<ReadonlyArray<MoodGroup>> =>
  Option.map(decodeRawMoodsPage(response), page =>
    pipe(
      page.contents.singleColumnBrowseResultsRenderer.tabs,
      Array.flatMap(
        ({ tabRenderer }) => tabRenderer.content.sectionListRenderer.contents,
      ),
      Array.flatMap(({ gridRenderer }) => Array.fromNullishOr(gridRenderer)),
      grids => filterSome(grids, toMoodGroup),
    ),
  )

/** A playlist card from a carousel. */
export const playlistFromTwoRowItem = (
  item: YTNodes.MusicTwoRowItem,
): Option.Option<PlaylistSummary> =>
  Option.all({
    id: nonEmptyString(item.id),
    title: textToOption(item.title),
  }).pipe(
    Option.map(({ id, title }) => ({
      id,
      title,
      maybeSubtitle: playlistSubtitle(item.subtitle),
      artwork: toArtwork(item.thumbnail),
    })),
  )

/** One shelf of a mood or genre page: a carousel, or a grid. */
export type MoodShelf = Readonly<{
  title: string
  items: ReadonlyArray<Helpers.YTNode>
}>

const twoRowItems = (
  shelf: MoodShelf,
): ReadonlyArray<YTNodes.MusicTwoRowItem> =>
  filterSome(shelf.items, item =>
    item.is(YTNodes.MusicTwoRowItem)
      ? Option.some(item.as(YTNodes.MusicTwoRowItem))
      : Option.none(),
  )

const PLAYLIST_ITEM = 'playlist'
const ALBUM_ITEM = 'album'

const toPlaylistShelf = (shelf: MoodShelf): Option.Option<PlaylistShelf> => {
  const playlists = filterSome(twoRowItems(shelf), item =>
    item.item_type === PLAYLIST_ITEM
      ? playlistFromTwoRowItem(item)
      : Option.none(),
  )
  return Array.isReadonlyArrayNonEmpty(playlists)
    ? Option.some({ title: shelf.title, playlists })
    : Option.none()
}

/**
 * A mood or genre's page: its songs, its playlists in shelves, and its
 * albums. Music videos are left out.
 */
export const toMoodDetails = (page: {
  readonly title: string
  readonly shelves: ReadonlyArray<MoodShelf>
}): MoodDetails => ({
  title: page.title,
  songs: filterSome(
    Array.flatMap(page.shelves, shelf => shelf.items),
    item =>
      item.is(YTNodes.MusicResponsiveListItem)
        ? songFromListItem(item.as(YTNodes.MusicResponsiveListItem))
        : Option.none(),
  ),
  playlistShelves: filterSome(page.shelves, toPlaylistShelf),
  albums: filterSome(
    Array.filter(
      Array.flatMap(page.shelves, twoRowItems),
      item => item.item_type === ALBUM_ITEM,
    ),
    albumFromTwoRowItem([], Option.none()),
  ),
})
