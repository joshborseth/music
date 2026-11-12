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
  type PlaylistDetails,
  type PlaylistSummary,
  ReleaseKind,
  type Song,
  type Thumbnail,
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
 * An album from an artist page carousel. Those cards omit the artist and
 * sometimes the release kind, so the caller supplies both.
 */
export const albumFromTwoRowItem =
  (artist: ArtistLink, defaultKind: Option.Option<ReleaseKind>) =>
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
          onEmpty: () => [artist],
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
            albumFromTwoRowItem(artistLink, Option.some('Album')),
          ),
          singles: filterSome(
            carouselItems(page.sections, SINGLES_SHELF_TITLE),
            albumFromTwoRowItem(artistLink, Option.none()),
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
