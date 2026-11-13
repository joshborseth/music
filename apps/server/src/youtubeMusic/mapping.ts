import {
  Array,
  Match,
  Option,
  Order,
  Record,
  Schema,
  String,
  pipe,
} from 'effect'
import { type Helpers, type Misc, YTNodes } from 'youtubei.js'

import {
  type AlbumDetails,
  type AlbumLink,
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
  type RadioStation,
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

const RadioPayload = Schema.Struct({
  playlistId: Schema.String,
  params: Schema.optionalKey(Schema.String),
  videoId: Schema.optionalKey(Schema.String),
})

const decodeRadioPayload = Schema.decodeUnknownOption(RadioPayload)

/**
 * The radio a button or menu item starts, if it starts one: YouTube Music's
 * radios and mixes are playlists whose ids start with `RD`, played through
 * a watch endpoint. Its other buttons (Play, Shuffle) play the songs
 * themselves, which is not a radio.
 */
export const radioOf = (
  maybeEndpoint: YTNodes.NavigationEndpoint | null | undefined,
): Option.Option<RadioStation> =>
  pipe(
    Option.fromNullishOr(maybeEndpoint),
    Option.flatMap(endpoint => decodeRadioPayload(endpoint.payload)),
    Option.filter(({ playlistId }) => playlistId.startsWith('RD')),
    Option.map(({ playlistId, params, videoId }) => ({
      playlistId,
      maybeParams: Option.fromNullishOr(params),
      maybeVideoId: Option.fromNullishOr(videoId),
    })),
  )

/**
 * An album's radio, from the "Start mix" item in its header's menu: a mix
 * of the album's playlist (`RDAMPL` and the album's playlist id).
 */
export const albumRadio = (
  buttons: ReadonlyArray<Helpers.YTNode>,
): Option.Option<RadioStation> =>
  pipe(
    buttons,
    Array.filter(button => button.is(YTNodes.Menu)),
    Array.flatMap(button => Array.fromIterable(button.as(YTNodes.Menu).items)),
    Array.filter(item =>
      item.is(YTNodes.MenuNavigationItem, YTNodes.MenuServiceItem),
    ),
    Array.findFirst(item =>
      Option.filter(
        radioOf(
          item.as(YTNodes.MenuNavigationItem, YTNodes.MenuServiceItem).endpoint,
        ),
        ({ playlistId }) => playlistId.startsWith('RDAMPL'),
      ),
    ),
  )

const PageTypePayload = Schema.Struct({
  browseId: Schema.String,
  browseEndpointContextSupportedConfigs: Schema.Struct({
    browseEndpointContextMusicConfig: Schema.Struct({
      pageType: Schema.String,
    }),
  }),
})

const decodePageTypePayload = Schema.decodeUnknownOption(PageTypePayload)

const ARTIST_PAGE = 'MUSIC_PAGE_TYPE_ARTIST'
const ALBUM_PAGE = 'MUSIC_PAGE_TYPE_ALBUM'
const PLAYLIST_PAGE = 'MUSIC_PAGE_TYPE_PLAYLIST'

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

/**
 * The album a row links to in one of its columns. youtubei.js only reads
 * it from some layouts; an artist's top songs name it in their last column.
 */
const albumFromColumns = (
  item: YTNodes.MusicResponsiveListItem,
): Option.Option<AlbumLink> =>
  pipe(
    item.flex_columns,
    Array.flatMap(column => column.title.runs ?? []),
    Array.findFirst(run =>
      pipe(
        decodePageTypePayload(
          'endpoint' in run ? run.endpoint?.payload : undefined,
        ),
        Option.filter(
          payload =>
            payload.browseEndpointContextSupportedConfigs
              .browseEndpointContextMusicConfig.pageType === ALBUM_PAGE,
        ),
        Option.flatMap(({ browseId }) =>
          Option.map(nonEmptyString(run.text), name => ({
            id: browseId,
            name,
          })),
        ),
      ),
    ),
  )

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
        Option.orElse(() => albumFromColumns(item)),
      ),
      maybeDurationSeconds: Option.fromNullishOr(item.duration?.seconds),
      artwork: toArtwork(item.thumbnail?.contents),
    })),
    Option.map(song =>
      Option.isSome(musicVideoIdOf(item)) ? withVideoTitle(song) : song,
    ),
  )

const PLAY_COUNT = /^[\d.,]+[KMB]? plays?$/

/** How often a top song was played, as YouTube Music words it: "1.2B plays". */
export const playsFromListItem = (
  item: YTNodes.MusicResponsiveListItem,
): Option.Option<string> =>
  pipe(
    item.flex_columns,
    Array.map(column => column.title.toString().trim()),
    Array.findFirst(text => PLAY_COUNT.test(text)),
  )

/**
 * The credits of an "up next" song. youtubei.js only reads the artists that
 * link to an artist page; an artist without one (a self-released song, say)
 * is named only in the byline, so the byline stands in as one credit.
 */
const panelVideoArtistLinks = (
  video: YTNodes.PlaylistPanelVideo,
): ReadonlyArray<ArtistLink> =>
  Array.match(toArtistLinks(video.artists), {
    onNonEmpty: links => links,
    onEmpty: () =>
      Array.map(
        Array.fromOption(nonEmptyString(video.author?.trim())),
        name => ({
          maybeId: Option.none(),
          name,
        }),
      ),
  })

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
      artists: panelVideoArtistLinks(video),
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
    Option.map(song =>
      Option.isSome(musicVideoIdOf(video)) ? withVideoTitle(song) : song,
    ),
  )

const PlayerLoudness = Schema.Struct({
  playerConfig: Schema.Struct({
    audioConfig: Schema.Struct({ perceptualLoudnessDb: Schema.Number }),
  }),
})
const decodePlayerLoudness = Schema.decodeUnknownOption(PlayerLoudness)

/**
 * YouTube's loudness figure from a raw `/player` response: the song's
 * integrated loudness in LUFS (`perceptualLoudnessDb`, the same figure as
 * its `trackAbsoluteLoudnessLkfs`). Only the mobile clients' responses
 * carry it. On real songs it is within 0.1 LU of ffmpeg's EBU R128 reading.
 */
export const perceptualLoudnessOf = (
  response: unknown,
): Option.Option<number> =>
  Option.map(
    decodePlayerLoudness(response),
    player => player.playerConfig.audioConfig.perceptualLoudnessDb,
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
          maybeRadio: albumRadio(Array.fromIterable(header.buttons)),
        }
      }),
    ),
  )

// ARTIST PAGE

/** The artist page's carousels this app reads, by their English titles. */
export const ArtistShelfTitle = {
  Albums: 'Albums',
  Singles: 'Singles & EPs',
  Related: 'Fans might also like',
} as const

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

/** The artist's radio, from the Radio button on their photo. */
const headerRadio = (
  header: NonNullable<ArtistPage['header']>,
): Option.Option<RadioStation> =>
  header.is(YTNodes.MusicImmersiveHeader)
    ? radioOf(
        header.as(YTNodes.MusicImmersiveHeader).start_radio_button?.endpoint,
      )
    : Option.none()

const headerDescription = (header: NonNullable<ArtistPage['header']>) =>
  header.is(YTNodes.MusicImmersiveHeader)
    ? textToOption(header.as(YTNodes.MusicImmersiveHeader).description)
    : Option.none()

const carouselTitled = (
  sections: ArtistPage['sections'],
  title: string,
): Option.Option<YTNodes.MusicCarouselShelf> =>
  Array.findFirst(sections, section =>
    section.is(YTNodes.MusicCarouselShelf)
      ? Option.liftPredicate(
          section.as(YTNodes.MusicCarouselShelf),
          carousel => carousel.header?.title.toString().trim() === title,
        )
      : Option.none(),
  )

/** The cards among `items`, leaving out anything else. */
export const twoRowItemsOf = (
  items: ReadonlyArray<Helpers.YTNode>,
): ReadonlyArray<YTNodes.MusicTwoRowItem> =>
  filterSome(items, item =>
    item.is(YTNodes.MusicTwoRowItem)
      ? Option.some(item.as(YTNodes.MusicTwoRowItem))
      : Option.none(),
  )

const carouselItems = (
  sections: ArtistPage['sections'],
  title: string,
): ReadonlyArray<YTNodes.MusicTwoRowItem> =>
  Option.match(carouselTitled(sections, title), {
    onNone: () => [],
    onSome: carousel => twoRowItemsOf(carousel.contents),
  })

const topSongsShelf = (
  sections: ArtistPage['sections'],
): Option.Option<YTNodes.MusicShelf> =>
  Array.findFirst(sections, section =>
    section.is(YTNodes.MusicShelf)
      ? Option.some(section.as(YTNodes.MusicShelf))
      : Option.none(),
  )

const DiscographyPayload = Schema.Struct({
  browseId: Schema.String,
  params: Schema.String,
  browseEndpointContextSupportedConfigs: Schema.Struct({
    browseEndpointContextMusicConfig: Schema.Struct({
      pageType: Schema.Literal('MUSIC_PAGE_TYPE_ARTIST_DISCOGRAPHY'),
    }),
  }),
})

const decodeDiscographyPayload = Schema.decodeUnknownOption(DiscographyPayload)

/** Where YouTube Music lists every release of one kind by an artist. */
export type DiscographyLink = Readonly<{ browseId: string; params: string }>

/**
 * The page behind a release carousel's "More", when the carousel shows only
 * some of the releases. None when it already shows them all.
 */
export const discographyLink = (
  page: ArtistPage,
  title: string,
): Option.Option<DiscographyLink> =>
  pipe(
    carouselTitled(page.sections, title),
    Option.flatMap(carousel =>
      decodeDiscographyPayload(
        carousel.header?.more_content?.endpoint?.payload,
      ),
    ),
    Option.map(({ browseId, params }) => ({ browseId, params })),
  )

/** An artist from a card, such as one their fans also like. */
export const artistFromTwoRowItem = (
  item: YTNodes.MusicTwoRowItem,
): Option.Option<ArtistSummary> =>
  Option.all({
    id: nonEmptyString(item.id),
    name: textToOption(item.title),
  }).pipe(
    Option.map(({ id, name }) => ({
      id,
      name,
      maybeAudience: audienceFromSubtitle(item.subtitle),
      artwork: toArtwork(item.thumbnail),
    })),
  )

/**
 * Releases from a carousel or a discography page. Their cards leave out the
 * artist the page is about, so it is credited here.
 */
export const releasesFromItems = (
  artist: Readonly<{ id: string; name: string }>,
  items: ReadonlyArray<YTNodes.MusicTwoRowItem>,
  defaultKind: Option.Option<ReleaseKind>,
): ReadonlyArray<AlbumSummary> =>
  filterSome(
    items,
    albumFromTwoRowItem(
      [{ maybeId: Option.some(artist.id), name: artist.name }],
      defaultKind,
    ),
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
        const artist = { id: artistId, name }
        const maybeTopSongs = topSongsShelf(page.sections)
        const topSongItems = Option.match(maybeTopSongs, {
          onNone: () => [],
          onSome: shelf => shelf.contents,
        })
        return {
          artist: {
            ...artist,
            maybeAudience: Option.none(),
            artwork: headerArtwork(header),
          },
          maybeDescription: headerDescription(header),
          topSongs: filterSome(topSongItems, songFromListItem),
          topSongPlays: Record.fromEntries(
            filterSome(topSongItems, item =>
              Option.all([nonEmptyString(item.id), playsFromListItem(item)]),
            ),
          ),
          maybeAllSongsPlaylistId: Option.flatMap(maybeTopSongs, shelf =>
            Option.orElse(browseIdOf(shelf.endpoint), () =>
              browseIdOf(shelf.bottom_button?.endpoint),
            ),
          ),
          albums: releasesFromItems(
            artist,
            carouselItems(page.sections, ArtistShelfTitle.Albums),
            Option.some('Album'),
          ),
          singles: releasesFromItems(
            artist,
            carouselItems(page.sections, ArtistShelfTitle.Singles),
            Option.none(),
          ),
          relatedArtists: filterSome(
            carouselItems(page.sections, ArtistShelfTitle.Related),
            artistFromTwoRowItem,
          ),
          maybeRadio: headerRadio(header),
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
 * Who made a playlist, from the row of avatars in its header. youtubei.js
 * drops that row, so it is read from YouTube's raw response.
 */
const RawFacepile = Schema.Struct({
  avatarStackViewModel: Schema.Struct({
    text: Schema.Struct({ content: Schema.String }),
    rendererContext: Schema.optional(
      Schema.Struct({
        commandContext: Schema.optional(
          Schema.Struct({
            onTap: Schema.Struct({
              innertubeCommand: Schema.Struct({
                browseEndpoint: Schema.optional(PageTypePayload),
              }),
            }),
          }),
        ),
      }),
    ),
  }),
})

const RawPlaylistPage = Schema.Struct({
  contents: Schema.Struct({
    twoColumnBrowseResultsRenderer: Schema.Struct({
      tabs: Schema.Array(
        Schema.Struct({
          tabRenderer: Schema.Struct({
            content: Schema.Struct({
              sectionListRenderer: Schema.Struct({
                contents: Schema.Array(
                  Schema.Struct({
                    musicResponsiveHeaderRenderer: Schema.optional(
                      Schema.Struct({ facepile: Schema.optional(RawFacepile) }),
                    ),
                  }),
                ),
              }),
            }),
          }),
        }),
      ),
    }),
  }),
})

const decodeRawPlaylistPage = Schema.decodeUnknownOption(RawPlaylistPage)

/**
 * Who made a playlist, from YouTube's raw response for its page: an artist,
 * linked to their page, or a name alone (YouTube Music, someone's channel).
 */
export const playlistOwnerFromResponse = (
  response: unknown,
): Option.Option<ArtistLink> =>
  pipe(
    decodeRawPlaylistPage(response),
    Option.flatMap(page =>
      pipe(
        page.contents.twoColumnBrowseResultsRenderer.tabs,
        Array.flatMap(
          ({ tabRenderer }) => tabRenderer.content.sectionListRenderer.contents,
        ),
        Array.findFirst(({ musicResponsiveHeaderRenderer }) =>
          Option.fromNullishOr(musicResponsiveHeaderRenderer?.facepile),
        ),
      ),
    ),
    Option.flatMap(({ avatarStackViewModel }) =>
      Option.map(nonEmptyString(avatarStackViewModel.text.content), name => ({
        name,
        maybeId: pipe(
          Option.fromNullishOr(
            avatarStackViewModel.rendererContext?.commandContext?.onTap
              .innertubeCommand.browseEndpoint,
          ),
          Option.filter(
            endpoint =>
              endpoint.browseEndpointContextSupportedConfigs
                .browseEndpointContextMusicConfig.pageType === ARTIST_PAGE,
          ),
          Option.map(({ browseId }) => browseId),
        ),
      })),
    ),
  )

/**
 * The playlist page. Its header reads like an album's, except the subtitle
 * names the kind and year rather than the artists. `maybeOwner` comes from
 * `playlistOwnerFromResponse`.
 */
export const toPlaylistDetails = (
  playlistId: string,
  page: {
    readonly header: Helpers.YTNode | undefined
    readonly items: ReadonlyArray<Helpers.YTNode>
    readonly maybeOwner: Option.Option<ArtistLink>
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
        maybeOwner: Option.orElse(page.maybeOwner, () =>
          pipe(
            textToOption(header.strapline_text_one),
            Option.filter(text => text !== 'N/A'),
            Option.map(name => ({ maybeId: Option.none(), name })),
          ),
        ),
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

const WatchPayload = Schema.Struct({ videoId: Schema.String })

const decodeWatchPayload = Schema.decodeUnknownOption(WatchPayload)

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
      topSongs: [],
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
const SONG_LABEL = 'Song'
const WATCH_LABELS: ReadonlyArray<string> = [SONG_LABEL, 'Video']

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
): TopResult => {
  const song: Song = {
    videoId,
    title,
    artists: watchArtistLinks(card.subtitle),
    maybeAlbum: Option.none(),
    maybeDurationSeconds: Array.findFirst(
      Array.reverse(subtitleSegments(card.subtitle)),
      secondsFromClock,
    ),
    artwork: toArtwork(card.thumbnail?.contents),
  }
  const isSong = Option.contains(
    Array.head(subtitleSegments(card.subtitle)),
    SONG_LABEL,
  )
  return { _tag: 'Song', song: isSong ? song : withVideoTitle(song) }
}

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

// MUSIC VIDEOS

/**
 * The music video types YouTube Music gives a watch link: `ATV` is a song
 * (its album audio), `OMV` an official music video, and `UGC` a video anyone
 * uploaded.
 */
const MUSIC_VIDEO_TYPES: ReadonlyArray<string> = [
  'MUSIC_VIDEO_TYPE_OMV',
  'MUSIC_VIDEO_TYPE_UGC',
]

const MusicVideoTypePayload = Schema.Struct({
  watchEndpointMusicSupportedConfigs: Schema.Struct({
    watchEndpointMusicConfig: Schema.Struct({
      musicVideoType: Schema.String,
    }),
  }),
})

const decodeMusicVideoTypePayload = Schema.decodeUnknownOption(
  MusicVideoTypePayload,
)

const VIDEO_ITEM = 'video'

/**
 * The id of a row or queue item that is a music video rather than a song.
 * None for songs and anything else.
 */
const musicVideoIdOf = (node: Helpers.YTNode): Option.Option<string> => {
  if (node.is(YTNodes.MusicResponsiveListItem)) {
    const item = node.as(YTNodes.MusicResponsiveListItem)
    return item.item_type === VIDEO_ITEM
      ? nonEmptyString(item.id)
      : Option.none()
  }
  if (node.is(YTNodes.PlaylistPanelVideo)) {
    const video = node.as(YTNodes.PlaylistPanelVideo)
    return pipe(
      decodeMusicVideoTypePayload(video.endpoint.payload),
      Option.filter(payload =>
        Array.contains(
          MUSIC_VIDEO_TYPES,
          payload.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig
            .musicVideoType,
        ),
      ),
      Option.flatMap(() => nonEmptyString(video.video_id)),
    )
  }
  return Option.none()
}

/** The ids of the music videos among `nodes`. */
export const musicVideoIds = (
  nodes: Iterable<Helpers.YTNode>,
): ReadonlySet<string> =>
  new Set(filterSome(Array.fromIterable(nodes), musicVideoIdOf))

/** What finding a music video's song needs to know about the video. */
export type MusicVideo = Pick<Song, 'videoId' | 'title' | 'artists'>

/**
 * Words that name a kind of video, not a version of the song: "(Official
 * Video)", "[4K]", "[1080p]", "(HQ)". "(Full Album)" is not one: the title
 * keeps it, so a whole album uploaded as one video is still known as one.
 */
const VIDEO_WORDS = globalThis.String
  .raw`\b(official|video|audio|lyrics?|visuali[sz]er|m\/?v|hd|hq|4k|\d{3,4}p)\b`

/**
 * A bracket that names a kind of video: "(Official Video)", "[4K]", or one
 * that YouTube cut short, "[Official Music ...", up to the next bracket.
 */
const VIDEO_BRACKET = new RegExp(
  globalThis.String
    .raw`\s*(\([^()]*${VIDEO_WORDS}[^()]*\)|\[[^[\]()]*${VIDEO_WORDS}[^[\]()]*(\]|(?=\s*\(|$)))`,
  'gi',
)

/** Any bracket, closed or cut short: "(feat. X)", "[Official Music ...". */
const ANY_BRACKET = /\s*[([][^)\]]*([)\]]|$)/g

const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu

const TITLE_ARTIST_SEPARATOR = ' - '

/** A title without "Artist - " in front, as a video's title often has. */
const titleWithoutArtist = (
  title: string,
  artists: ReadonlyArray<ArtistLink>,
): string => {
  const separator = title.indexOf(TITLE_ARTIST_SEPARATOR)
  const prefix = title.slice(0, Math.max(0, separator)).toLowerCase()
  const isArtistPrefix =
    separator > 0 &&
    Array.some(artists, ({ name }) => prefix.includes(name.toLowerCase()))
  return isArtistPrefix
    ? title.slice(separator + TITLE_ARTIST_SEPARATOR.length)
    : title
}

/**
 * A title cut down to what tells songs apart: no "(Official Music Video)",
 * no "Artist - " in front, and no case or punctuation. "Taylor Swift -
 * Anti-Hero (Official Music Video)" and "Anti-Hero" both become "antihero".
 */
const comparableTitle = (
  title: string,
  artists: ReadonlyArray<ArtistLink>,
): string =>
  titleWithoutArtist(title, artists)
    .replace(VIDEO_BRACKET, '')
    .replace(NOT_LETTER_OR_DIGIT, '')
    .toLowerCase()

/**
 * The same artist: the same artist page, or the same name. A video and its
 * song can credit the same artist through different pages.
 */
const isSameArtist = (left: ArtistLink, right: ArtistLink): boolean =>
  (Option.isSome(left.maybeId) &&
    Option.isSome(right.maybeId) &&
    left.maybeId.value === right.maybeId.value) ||
  left.name.toLowerCase() === right.name.toLowerCase()

// VIDEO TITLES

/**
 * Words that make a bracket name a version of the song, which the title
 * keeps even when it also says "Official": "(Official Remix)", "(Live
 * Audio)", "(4K Remaster)", "(8D Audio)".
 */
const VERSION_WORDS =
  /\b(remix|mix|live|version|edit|acoustic|cover|remaster(ed)?|demo|session|instrumental|extended|slowed|sped|reverb|unplugged|stripped|karaoke|feat|ft|with|from|prod|8d|nightcore|tiktok)\b/i

/** A " | Official Music Video" tail. */
const VIDEO_PIPE_TAIL = new RegExp(
  globalThis.String.raw`\s+\|\s+[^|]*${VIDEO_WORDS}[^|]*$`,
  'i',
)

/** A " - by Tobias Stretch" tail, naming who made the video. */
const BY_TAIL = /\s+[-–—|]\s+by\s+[^-–—|]+$/i

/** The dashes that set an artist apart from a title: "Pixies - Debaser". */
const DASH_SEPARATOR = /\s+[-–—]\s+/

/** What joins the artists in front of a title: "A & B", "A x B", "A ft. B". */
const ARTIST_JOINER =
  /\s*(?:,|&|\+|\/|\bx\b|\band\b|\bwith\b|\bfeat\.?|\bft\.?)\s*/i

/** Separators and spaces left hanging at either end of a title. */
const DANGLING_SEPARATORS = /^[\s\-–—|:·•]+|[\s\-–—|:·•]+$/g

const DOUBLED_SPACES = /\s{2,}/g

/**
 * Whether `text` names a credited artist: the whole text is one of their
 * names, or the artists it joins start with one ("Daft Punk ft. Pharrell").
 */
const namesCreditedArtist = (
  text: string,
  artists: ReadonlyArray<ArtistLink>,
): boolean => {
  const names = Array.filter(
    Array.map(artists, ({ name }) => compactName(name)),
    String.isNonEmpty,
  )
  const firstName = compactName(text.split(ARTIST_JOINER)[0] ?? '')
  return (
    Array.contains(names, compactName(text)) || Array.contains(names, firstName)
  )
}

/** The title without a credited artist before or after a dash. */
const withoutArtistAround = (
  title: string,
  artists: ReadonlyArray<ArtistLink>,
): string => {
  const [first = '', ...rest] = title.split(DASH_SEPARATOR)
  if (Array.isArrayEmpty(rest)) {
    return title
  }
  if (namesCreditedArtist(first, artists)) {
    return title.slice(title.search(DASH_SEPARATOR)).replace(DASH_SEPARATOR, '')
  }
  const last = rest.at(-1) ?? ''
  if (namesCreditedArtist(last, artists)) {
    return title
      .slice(0, title.length - last.length)
      .replace(/\s+[-–—]\s+$/, '')
  }
  return title
}

const withoutVideoBrackets = (title: string): string =>
  title.replace(VIDEO_BRACKET, bracket =>
    VERSION_WORDS.test(bracket) ? bracket : ' ',
  )

/**
 * A music video's title as a song's: "HOTEL UGLY - SHUT UP MY MOMS CALLING
 * (Official Music Video)" by Hotel Ugly becomes "SHUT UP MY MOMS CALLING".
 * It takes off a credited artist before or after a dash, brackets that only
 * name the kind of video ("(Official HD Video)", "[Official Audio]",
 * "(Visualizer)"), a " - by …" tail naming who made the video, and the
 * spaces and separators they leave. Anything else stays: "Hold On -
 * Remastered", "(feat. X)", "(Live at Wembley)", "(Official Remix)".
 */
export const cleanVideoTitle = (
  title: string,
  artists: ReadonlyArray<ArtistLink>,
): string => {
  const cleaned = pipe(
    title.replace(DOUBLED_SPACES, ' ').trim(),
    withoutVideoBrackets,
    text => text.replace(VIDEO_PIPE_TAIL, ''),
    text => text.replace(BY_TAIL, ''),
    text => withoutArtistAround(text, artists),
    text => text.replace(DOUBLED_SPACES, ' ').replace(DANGLING_SEPARATORS, ''),
  )
  return String.isNonEmpty(cleaned) ? cleaned : title.trim()
}

/** A music video as a song, with its title cleaned. */
const withVideoTitle = (song: Song): Song => ({
  ...song,
  title: cleanVideoTitle(song.title, song.artists),
})

/**
 * The words to search songs for to find a music video's song: its first
 * artist and its title without brackets. "Taylor Swift - Anti-Hero (Official
 * Music Video)" by Taylor Swift searches "Taylor Swift Anti-Hero".
 */
export const audioTrackQuery = (video: MusicVideo): string => {
  const title = titleWithoutArtist(video.title, video.artists)
  const bare = title.replace(ANY_BRACKET, '').trim()
  const words = String.isNonEmpty(bare) ? bare : title
  return Array.match(video.artists, {
    onEmpty: () => words,
    onNonEmpty: ([first]) => `${first.name} ${words}`,
  })
}

/**
 * The audio track of a song that YouTube Music found as its music video: the
 * song among `songs` (a song search for the same words) with the same title
 * by the same artist. The video plays with its intro and skits and shows a
 * cropped frame for its cover, where Apple Music and Spotify would play the
 * song. A video that credits no artist page matches on its title alone, so
 * the song it becomes brings its artists along.
 */
export const audioTrackFor = (
  video: MusicVideo,
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

// SEARCH RANKING

const ACCENT = /\p{M}/gu

/** Lowercase, no accents: "Beyoncé" → "beyonce". */
const plainLetters = (text: string): string =>
  text.normalize('NFKD').replace(ACCENT, '').toLowerCase()

/** Letters and digits only: "AC/DC" → "acdc", "Daft Punk" → "daftpunk". */
const compactName = (text: string): string =>
  plainLetters(text).replace(NOT_LETTER_OR_DIGIT, '')

/** The words, padded with a space each side: " daft punk ". */
const paddedWords = (text: string): string =>
  ` ${plainLetters(text).replace(NOT_LETTER_OR_DIGIT, ' ').trim()} `

/**
 * Whether a search names this artist: the whole search is their name
 * ("radiohead", "acdc" for AC/DC), or it starts or ends with their name
 * beside other words ("daft punk get lucky", "get lucky daft punk").
 */
export const searchNamesArtist = (
  query: string,
  artist: ArtistLink,
): boolean => {
  const name = compactName(artist.name)
  if (String.isEmpty(name)) {
    return false
  }
  const words = paddedWords(query)
  const nameWords = paddedWords(artist.name)
  return (
    compactName(query) === name ||
    words.startsWith(nameWords) ||
    words.endsWith(nameWords)
  )
}

/** 2 when `isWanted` picks a song's main artist, 1 another credit, else 0. */
const creditRank = (
  song: Song,
  isWanted: (artist: ArtistLink) => boolean,
): number =>
  Array.match(song.artists, {
    onEmpty: () => 0,
    onNonEmpty: ([first, ...others]) =>
      isWanted(first) ? 2 : Array.some(others, isWanted) ? 1 : 0,
  })

/**
 * Words that mark another take on a song rather than the song: a remix, a
 * cover, karaoke, or a slowed, sped up, 8D, or nightcore edit. Albums of
 * covers and karaoke say so in their names too.
 */
const VERSION_OF_SONG =
  /\b(remix(es|ed)?|rmx|covers?|karaoke|tribute|slowed|sped[\s-]?up|8d|nightcore|reverb|bass[\s-]?boosted|mashup|bootleg|instrumental|originally performed|in the style of|made famous)\b/i

/**
 * A bracket that names a version: "(Metal Version)", "(Jive 43BPM)", "(Afro
 * House)". Only another artist's version counts: the artist's own "(Taylor's
 * Version)" or "(Single Version)" is the song.
 */
const VERSION_BRACKET =
  /[([][^)\]]*\b(version|edition|bpm|vocal|house)\b[^)\]]*[)\]]/i

/** Words that ask for a version: "blinding lights metal version". */
const ASKS_FOR_VERSION =
  /\b(version|edition|bpm|vocal|house|live|acoustic|piano|metal|lo-?fi)\b/i

/** Whether a song is a remix, a cover, karaoke, or an edit of a song. */
const isVersion = (song: Song): boolean =>
  VERSION_OF_SONG.test(song.title) ||
  Option.exists(song.maybeAlbum, ({ name }) => VERSION_OF_SONG.test(name))

const asksForVersion = (query: string): boolean =>
  VERSION_OF_SONG.test(query) || ASKS_FOR_VERSION.test(query)

/** The song YouTube Music picked as its top result, with its artist's hits. */
export type TopSong = Readonly<{
  song: Song
  artistSongs: ReadonlyArray<Song>
}>

/** Where a title's own name ends: " | Emotional Deep", " - Slowed". */
const TITLE_TAIL = /\s[|–—-]\s.*$/

/**
 * A title without brackets or a tail after a separator, for telling covers
 * of a song apart: "Blinding Lights | Emotional Deep" and "Blinding Lights
 * (Afro House)" are both "blindinglights".
 */
const bareTitle = (title: string): string =>
  compactName(title.replace(ANY_BRACKET, '').replace(TITLE_TAIL, ''))

/** The same song: the same video, or the same title by the same artist. */
const isSameSong = (left: Song, right: Song): boolean =>
  left.videoId === right.videoId ||
  (comparableTitle(left.title, left.artists) ===
    comparableTitle(right.title, right.artists) &&
    Array.some(left.artists, artist =>
      Array.some(right.artists, other => isSameArtist(artist, other)),
    ))

type Candidate = Readonly<{ song: Song; isArtistHit: boolean }>

/**
 * How high a song goes in a search, highest first. The songs by the artist
 * searched for or of the top result come first, then their hits, then songs
 * they are featured on, then other songs. Remixes, covers, karaoke, and
 * slowed or 8D edits go last, unless the search asks for one, and so do
 * other artists' songs with the top result's title.
 */
const searchRank = (
  query: string,
  maybeTop: Option.Option<TopSong>,
  { song, isArtistHit }: Candidate,
): number => {
  const rank = Math.max(
    creditRank(song, artist => searchNamesArtist(query, artist)),
    Option.match(maybeTop, {
      onNone: () => 0,
      onSome: top =>
        creditRank(song, artist =>
          Array.some(top.song.artists, other => isSameArtist(artist, other)),
        ),
    }),
  )
  const isCoverOfTop =
    rank === 0 &&
    Option.exists(
      maybeTop,
      top => bareTitle(top.song.title) === bareTitle(song.title),
    )
  const isUnasked =
    !asksForVersion(query) &&
    (isVersion(song) ||
      (rank === 0 && VERSION_BRACKET.test(song.title)) ||
      isCoverOfTop)
  if (isUnasked) {
    return rank
  }
  if (isArtistHit) {
    return 15
  }
  return rank === 2 ? 20 : 10 + rank
}

// SEARCH FILTERS

/** A track longer than this is a compilation or a whole album, not a song. */
export const LONGEST_SONG_SECONDS = 15 * 60

/**
 * Words in a title that mark an upload of many songs as one: "(Full
 * Album)", "3 Hours of Chill Lofi", "(1 Hour)", "Non-Stop Mix".
 */
const MANY_SONGS =
  /\b(full[\s-]+(album|ep|mixtape|lp)|complete album|compilation|\d+\s*(hours?|hrs?)|(an?|one)\s+hours?|non-?stop|megamix|continuous mix)\b/i

/** Words that ask for long uploads: "gybe full album", "lofi 1 hour". */
const ASKS_FOR_LONG =
  /\b(full|album|lp|hours?|hrs?|compilation|mix|megamix|non-?stop|continuous|set|medley)\b/i

/** Whether the search has a track's whole title in it: "dopesmoker sleep". */
const queryNamesTitle = (query: string, title: string): boolean => {
  const words = paddedWords(title.replace(ANY_BRACKET, ''))
  return words.trim().length >= 4 && paddedWords(query).includes(words)
}

/** Whether a track is a compilation or a whole album rather than a song. */
export const isManySongs = (song: Song): boolean =>
  MANY_SONGS.test(song.title) ||
  Option.exists(
    song.maybeDurationSeconds,
    seconds => seconds > LONGEST_SONG_SECONDS,
  )

/**
 * Whether a search lists a song: anything but an hours-long upload or a
 * whole album as one track, unless the search asks for one ("lofi 1 hour",
 * "full album") or names its title ("dopesmoker").
 */
export const isSongForQuery =
  (query: string) =>
  (song: Song): boolean =>
    !isManySongs(song) ||
    ASKS_FOR_LONG.test(query) ||
    queryNamesTitle(query, song.title)

// ARTIST SEARCH

const COUNT_WITH_UNIT = /^([\d.,]+)\s*([KMB])?\b/i

const UNIT_SIZE: Record.ReadonlyRecord<string, number> = {
  k: 1e3,
  m: 1e6,
  b: 1e9,
}

/** "66.1M monthly audience" → 66,100,000; "2 subscribers" → 2. */
export const countFromText = (text: string): Option.Option<number> =>
  pipe(
    Option.fromNullishOr(COUNT_WITH_UNIT.exec(text.trim())),
    Option.flatMap(([, digits = '', unit = '']) => {
      const value = Number(digits.replaceAll(',', ''))
      return Number.isFinite(value)
        ? Option.some(Math.round(value * (UNIT_SIZE[unit.toLowerCase()] ?? 1)))
        : Option.none()
    }),
  )

/** An artist with fewer listeners or subscribers than this is unknown. */
export const KNOWN_ARTIST_AUDIENCE = 1000

/** Whether an artist has an audience, not "Daft · 2 subscribers". */
const isKnownArtist = (artist: ArtistSummary): boolean =>
  Option.exists(
    Option.flatMap(artist.maybeAudience, countFromText),
    count => count >= KNOWN_ARTIST_AUDIENCE,
  )

/** Whether the search is exactly this name, past case and punctuation. */
const isExactName = (query: string, name: string): boolean => {
  const compactQuery = compactName(query)
  return String.isNonEmpty(compactQuery) && compactName(name) === compactQuery
}

/** Whether an artist's name has the search in it, or the search theirs. */
const nameMatches = (query: string, artist: ArtistSummary): boolean =>
  compactName(artist.name).includes(compactName(query)) ||
  searchNamesArtist(query, { maybeId: Option.none(), name: artist.name })

/**
 * An artist search as people mean it: the artist whose name is the search
 * first, past case, accents, and punctuation ("ac dc", "beyonce"), and no
 * artists with almost no audience once one with an audience matches the
 * name: "daft" lists Daft Punk, not "Daft · 2 subscribers". With no known
 * artist by that name, the unknown ones stay.
 */
export const rankArtistsForQuery = (
  query: string,
  artists: ReadonlyArray<ArtistSummary>,
): ReadonlyArray<ArtistSummary> => {
  const hasKnownMatch = Array.some(
    artists,
    artist => isKnownArtist(artist) && nameMatches(query, artist),
  )
  const kept = hasKnownMatch ? Array.filter(artists, isKnownArtist) : artists
  return Array.sort(
    kept,
    Order.mapInput(Order.Number, (artist: ArtistSummary) =>
      isExactName(query, artist.name) && isKnownArtist(artist) ? 0 : 1,
    ),
  )
}

// TOP RESULT CHOICE

/** The top result card, and whether it is a video anyone uploaded. */
export type TopCard = Readonly<{ topResult: TopResult; isUpload: boolean }>

const UPLOADED_VIDEO = 'MUSIC_VIDEO_TYPE_UGC'

/**
 * The card above the search results (see `topResultFromCard`), noting a
 * video someone other than the artist uploaded, such as a fan's upload of
 * a whole album.
 */
export const topCardFrom = (card: TopResultCard): Option.Option<TopCard> =>
  Option.map(topResultFromCard(card), topResult => ({
    topResult,
    isUpload: pipe(
      decodeMusicVideoTypePayload((card.title.endpoint ?? card.on_tap).payload),
      Option.exists(
        payload =>
          payload.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig
            .musicVideoType === UPLOADED_VIDEO,
      ),
    ),
  }))

/**
 * The card's song, when it is one a song search should rank by: not a
 * video anyone uploaded, and not hours of music or a whole album as one
 * video unless the search asks for that.
 */
export const topCardSong = (
  query: string,
  card: TopCard,
): Option.Option<Song> =>
  card.topResult._tag === 'Song' &&
  !card.isUpload &&
  isSongForQuery(query)(card.topResult.song)
    ? Option.some(card.topResult.song)
    : Option.none()

/** The card as search shows it, or none when it is not worth showing. */
const shownCard = (
  query: string,
  card: TopCard,
  songs: ReadonlyArray<Song>,
): Option.Option<TopResult> => {
  const { topResult } = card
  if (topResult._tag !== 'Song') {
    return Option.some(topResult)
  }
  return pipe(
    audioTrackFor(topResult.song, songs),
    Option.orElse(() =>
      card.isUpload ? Option.none() : Option.some(topResult.song),
    ),
    Option.filter(isSongForQuery(query)),
    Option.map(song => ({ ...topResult, song })),
  )
}

/** The name or title a top result goes by. */
const topResultName = (topResult: TopResult): string =>
  Match.valueTags(topResult, {
    Artist: ({ artist }) => artist.name,
    Album: ({ album }) => album.title,
    Song: ({ song }) => song.title,
    Playlist: ({ playlist }) => playlist.title,
  })

/**
 * What search shows first. YouTube Music's card, with a music video swapped
 * for its song (`audioTrackFor`, from `songs`, a song search for the same
 * words); never a video someone uploaded that is no song, or a whole album
 * or hours of music as one video (unless asked for). When the search is
 * exactly the name of an artist with an audience (`artists`, ranked by
 * `rankArtistsForQuery`), that artist comes first instead, unless the card
 * itself is named exactly what was searched for: "humble" stays a song.
 */
export const chooseTopResult = (
  query: string,
  maybeCard: Option.Option<TopCard>,
  songs: ReadonlyArray<Song>,
  artists: ReadonlyArray<ArtistSummary>,
): Option.Option<TopResult> => {
  const maybeShown = Option.flatMap(maybeCard, card =>
    shownCard(query, card, songs),
  )
  const isNamedExactly = Option.exists(maybeShown, topResult =>
    isExactName(query, topResultName(topResult)),
  )
  const maybeNamedArtist = Array.findFirst(
    artists,
    artist => isExactName(query, artist.name) && isKnownArtist(artist),
  )
  return isNamedExactly
    ? maybeShown
    : Option.match(maybeNamedArtist, {
        onNone: () => maybeShown,
        onSome: (artist): Option.Option<TopResult> =>
          Option.some({ _tag: 'Artist', artist, topSongs: [] }),
      })
}

// ALBUM AND PLAYLIST SEARCH

/**
 * Words that mark a release or playlist made of other people's takes on an
 * artist: karaoke, tributes, covers, lullaby, 8-bit, or string quartet
 * versions ("Vitamin String Quartet Performs Daft Punk"), instrumentals.
 */
const TRIBUTE =
  /\b(karaoke|tribute|homage|covers?|originally performed|in the style of|made famous|as performed by|reimagined|lullab(y|ies)|8-?bit|versions of|instrumentals?|sing-?along|backing tracks?|performs|plays the music of|string quartet)\b/i

/** Whether an album is someone's karaoke, tribute, or covers of others. */
const isTributeAlbum = (album: AlbumSummary): boolean =>
  TRIBUTE.test(album.title) ||
  Array.some(album.artists, ({ name }) => TRIBUTE.test(name))

const isCreditedTo = (
  credits: ReadonlyArray<ArtistLink>,
  artist: ArtistLink,
): boolean => Array.some(credits, credit => isSameArtist(credit, artist))

/**
 * A bare title without a plural "s", so a search typed partway, "blinding
 * lig", which YouTube Music reads as "blinding light", still knows the
 * singles named "Blinding Light" for other takes on "Blinding Lights".
 */
const singularTitle = (title: string): string =>
  bareTitle(title).replace(/s$/, '')

/**
 * Releases from a search, without what only rides on the artist or song
 * searched for: karaoke, tributes, and covers ("HUMBLE. (Karaoke Version)",
 * "Lullaby Versions of Kendrick Lamar"); releases named after the artist
 * searched for but not theirs ("THE KENDRICK LAMAR SUITE"); and other
 * artists' singles named like the top result's song (`maybeTopSong`):
 * "blinding lights" lists no one else's "Blinding Light(s)" single. A search
 * that asks for a version ("humble karaoke") keeps them all.
 */
export const filterAlbumsForQuery = (
  query: string,
  albums: ReadonlyArray<AlbumSummary>,
  maybeTopSong: Option.Option<Song> = Option.none(),
): ReadonlyArray<AlbumSummary> => {
  if (asksForVersion(query)) {
    return albums
  }
  const searchedArtists = pipe(
    albums,
    Array.flatMap(({ artists }) => artists),
    Array.filter(artist => searchNamesArtist(query, artist)),
  )
  const isAboutSearchedArtist = (album: AlbumSummary): boolean =>
    Array.some(
      searchedArtists,
      artist =>
        paddedWords(album.title).includes(paddedWords(artist.name)) &&
        !isCreditedTo(album.artists, artist),
    )
  const isOtherTakeOnTopSong = (album: AlbumSummary): boolean =>
    Option.exists(
      maybeTopSong,
      song =>
        !Option.contains(album.maybeKind, 'Album') &&
        singularTitle(album.title) === singularTitle(song.title) &&
        !Array.some(song.artists, artist =>
          isCreditedTo(album.artists, artist),
        ),
    )
  return Array.filter(
    albums,
    album =>
      !isTributeAlbum(album) &&
      !isAboutSearchedArtist(album) &&
      !isOtherTakeOnTopSong(album),
  )
}

const VIEW_COUNT = /([\d.,]+\s*[KMB]?)\s+views?\b/i

/** How often a playlist was viewed, from "Candie Schane · 1.9K views". */
export const playlistViews = (
  playlist: PlaylistSummary,
): Option.Option<number> =>
  pipe(
    playlist.maybeSubtitle,
    Option.flatMap(subtitle =>
      Option.fromNullishOr(VIEW_COUNT.exec(subtitle)?.[1]),
    ),
    Option.flatMap(countFromText),
  )

/** A playlist seen fewer times than this is someone's own, not a find. */
export const FEWEST_PLAYLIST_VIEWS = 1000

/**
 * Playlists from a search, without the ones hardly anyone played ("Kendrick
 * lamar · 6 views") or of karaoke and tributes, unless the search asks for
 * those. A playlist that shows no count, such as YouTube Music's own, stays.
 */
export const filterPlaylistsForQuery = (
  query: string,
  playlists: ReadonlyArray<PlaylistSummary>,
): ReadonlyArray<PlaylistSummary> =>
  Array.filter(
    playlists,
    playlist =>
      !Option.exists(
        playlistViews(playlist),
        views => views < FEWEST_PLAYLIST_VIEWS,
      ) &&
      (asksForVersion(query) || !TRIBUTE.test(playlist.title)),
  )

// SUGGESTIONS

/** The most suggestions shown under the search box. */
export const MAX_SEARCH_SUGGESTIONS = 8

/**
 * What YouTube Music suggests searching for, from its suggestions: the
 * words, each once. Its rows of songs and artists are left out.
 */
export const suggestionsFrom = (
  nodes: ReadonlyArray<Helpers.YTNode>,
): ReadonlyArray<string> =>
  pipe(
    filterSome(nodes, node =>
      node.is(YTNodes.SearchSuggestion)
        ? textToOption(node.as(YTNodes.SearchSuggestion).suggestion)
        : Option.none(),
    ),
    Array.dedupeWith(
      (left, right) => left.toLowerCase() === right.toLowerCase(),
    ),
    Array.take(MAX_SEARCH_SUGGESTIONS),
  )

/**
 * A song search, ranked as Apple Music and Spotify would: "daft punk" lists
 * Daft Punk's songs, then songs they are featured on, then the remixes and
 * covers that only mention them. When YouTube Music's top result is a song,
 * its artist's songs come first and their hits after them, and covers of it
 * go last: "blinding lights" lists The Weeknd, not a metal cover. Remixes,
 * karaoke, and slowed or 8D edits go last unless the search asks for one.
 * Hours-long uploads and whole albums are left out (see `isSongForQuery`).
 * Otherwise YouTube's order stays.
 */
export const rankSongsForQuery = (
  query: string,
  songs: ReadonlyArray<Song>,
  maybeTop: Option.Option<TopSong> = Option.none(),
): ReadonlyArray<Song> => {
  const hits = Option.match(maybeTop, {
    onNone: (): ReadonlyArray<Song> => [],
    onSome: ({ song: top, artistSongs }) =>
      Array.filter(
        artistSongs,
        hit => !Array.some([top, ...songs], song => isSameSong(song, hit)),
      ),
  })
  const isWanted = isSongForQuery(query)
  const candidates: ReadonlyArray<Candidate> = [
    ...Array.map(Array.filter(songs, isWanted), song => ({
      song,
      isArtistHit: false,
    })),
    ...Array.map(Array.filter(hits, isWanted), song => ({
      song,
      isArtistHit: true,
    })),
  ]
  return Array.map(
    Array.sort(
      candidates,
      Order.mapInput(Order.flip(Order.Number), (candidate: Candidate) =>
        searchRank(query, maybeTop, candidate),
      ),
    ),
    ({ song }) => song,
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
