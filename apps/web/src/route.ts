import { Option, Schema, SchemaTransformation, pipe } from 'effect'
import { Route, type Url } from 'foldkit'
import { defineRouteUnion, literal, slash, string } from 'foldkit/route'

/**
 * Which catalog a search looks through. `Top` mixes them: the best match,
 * the first songs, then artists, albums, and playlists.
 */
export const SearchKind = Schema.Literals([
  'Top',
  'Songs',
  'Artists',
  'Albums',
  'Playlists',
])
export type SearchKind = typeof SearchKind.Type

export const SEARCH_KINDS: ReadonlyArray<SearchKind> = SearchKind.literals

export const DEFAULT_SEARCH_KIND: SearchKind = 'Top'

const decodeSearchKind = Schema.decodeUnknownOption(SearchKind)

const searchKindParam = Schema.OptionFromOptional(Schema.String).pipe(
  Schema.decodeTo(
    Schema.Option(SearchKind),
    SchemaTransformation.transform({
      decode: (maybeRaw: Option.Option<string>): Option.Option<SearchKind> =>
        Option.flatMap(maybeRaw, raw => decodeSearchKind(raw)),
      encode: (maybeKind: Option.Option<SearchKind>): Option.Option<string> =>
        maybeKind,
    }),
  ),
)

export const AppRoute = defineRouteUnion({
  Home: {},
  Search: {
    q: Schema.Option(Schema.String),
    kind: Schema.Option(SearchKind),
  },
  Library: {},
  Song: { videoId: Schema.String },
  Artist: { artistId: Schema.String },
  /** Every album by an artist. */
  ArtistAlbums: { artistId: Schema.String },
  /** Every single and EP by an artist. */
  ArtistSingles: { artistId: Schema.String },
  Album: { albumId: Schema.String },
  Playlist: { playlistId: Schema.String },
  /** One of the playlists made in the app. */
  MyPlaylist: { playlistId: Schema.String },
  /** One of YouTube Music's moods or genres. */
  Mood: { params: Schema.String },
  /** Who is signed in, their password, and for admins, people and invites. */
  Account: {},
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type
export type SearchRoute = typeof AppRoute.Search.Type

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home))

export const searchRouter = pipe(
  literal('search'),
  Route.query(
    Schema.Struct({
      q: Schema.OptionFromOptional(Schema.String),
      kind: searchKindParam,
    }),
  ),
  Route.mapTo(AppRoute.Search),
)

export const libraryRouter = pipe(
  literal('library'),
  Route.mapTo(AppRoute.Library),
)

export const songRouter = pipe(
  literal('song'),
  slash(string('videoId')),
  Route.mapTo(AppRoute.Song),
)

export const artistRouter = pipe(
  literal('artist'),
  slash(string('artistId')),
  Route.mapTo(AppRoute.Artist),
)

export const artistAlbumsRouter = pipe(
  literal('artist'),
  slash(string('artistId')),
  slash(literal('albums')),
  Route.mapTo(AppRoute.ArtistAlbums),
)

export const artistSinglesRouter = pipe(
  literal('artist'),
  slash(string('artistId')),
  slash(literal('singles')),
  Route.mapTo(AppRoute.ArtistSingles),
)

export const albumRouter = pipe(
  literal('album'),
  slash(string('albumId')),
  Route.mapTo(AppRoute.Album),
)

export const playlistRouter = pipe(
  literal('playlist'),
  slash(string('playlistId')),
  Route.mapTo(AppRoute.Playlist),
)

export const myPlaylistRouter = pipe(
  literal('library'),
  slash(literal('playlist')),
  slash(string('playlistId')),
  Route.mapTo(AppRoute.MyPlaylist),
)

export const moodRouter = pipe(
  literal('browse'),
  slash(string('params')),
  Route.mapTo(AppRoute.Mood),
)

export const accountRouter = pipe(
  literal('account'),
  Route.mapTo(AppRoute.Account),
)

const routeParser = Route.oneOf(
  accountRouter,
  myPlaylistRouter,
  moodRouter,
  songRouter,
  artistAlbumsRouter,
  artistSinglesRouter,
  artistRouter,
  albumRouter,
  playlistRouter,
  searchRouter,
  libraryRouter,
  homeRouter,
)

export const urlToAppRoute = Route.parseUrlWithFallback(
  routeParser,
  AppRoute.NotFound,
)

/** The URL for a search, omitting empty parameters. */
export const searchUrl = (query: string, kind: SearchKind): string =>
  searchRouter({
    q: Option.liftPredicate(query, value => value.length > 0),
    kind: Option.liftPredicate(kind, value => value !== DEFAULT_SEARCH_KIND),
  })

/** The path and query of a URL, which is how the app tells pages apart. */
export const urlPath = (url: Url.Url): string =>
  Option.match(url.search, {
    onNone: () => url.pathname,
    onSome: search => `${url.pathname}?${search}`,
  })

// TABS

/** The sections of the app the tab bar switches between. */
export const Tab = Schema.Literals(['Home', 'Search', 'Library'])
export type Tab = typeof Tab.Type

export const TABS: ReadonlyArray<Tab> = Tab.literals

/** The page each tab opens when nothing in it has been visited yet. */
export const TAB_ROOT_URLS: Readonly<Record<Tab, string>> = {
  Home: homeRouter(),
  Search: searchRouter({ q: Option.none(), kind: Option.none() }),
  Library: libraryRouter(),
}

/** The tab a route is the top of, if it is one. Detail pages belong to none. */
export const routeTab = (route: AppRoute): Option.Option<Tab> =>
  AppRoute.match(route, {
    Home: () => Option.some<Tab>('Home'),
    Search: () => Option.some<Tab>('Search'),
    Library: () => Option.some<Tab>('Library'),
    Song: () => Option.none(),
    Artist: () => Option.none(),
    ArtistAlbums: () => Option.none(),
    ArtistSingles: () => Option.none(),
    Album: () => Option.none(),
    Playlist: () => Option.none(),
    MyPlaylist: () => Option.none(),
    Mood: () => Option.none(),
    Account: () => Option.none(),
    NotFound: () => Option.none(),
  })

/**
 * The tab a page opened straight from a link belongs under, since nothing
 * in the app led there: the top of a tab is its own, one of my playlists
 * and the Account page are in the Library, and YouTube Music's songs,
 * artists, albums, playlists, and moods are what Search finds.
 */
export const openingTab = (route: AppRoute): Tab =>
  AppRoute.match(route, {
    Home: (): Tab => 'Home',
    Search: (): Tab => 'Search',
    Library: (): Tab => 'Library',
    Song: (): Tab => 'Search',
    Artist: (): Tab => 'Search',
    ArtistAlbums: (): Tab => 'Search',
    ArtistSingles: (): Tab => 'Search',
    Album: (): Tab => 'Search',
    Playlist: (): Tab => 'Search',
    MyPlaylist: (): Tab => 'Library',
    Mood: (): Tab => 'Search',
    Account: (): Tab => 'Library',
    NotFound: (): Tab => 'Home',
  })

/**
 * Identifies a page for the DOM. Typing a search keeps the same page, so the
 * search box keeps focus; opening another album replaces the page.
 */
export const pageKey = (route: AppRoute): string =>
  AppRoute.match(route, {
    Home: () => 'home',
    Search: () => 'search',
    Library: () => 'library',
    Song: ({ videoId }) => `song/${videoId}`,
    Artist: ({ artistId }) => `artist/${artistId}`,
    ArtistAlbums: ({ artistId }) => `artist/${artistId}/albums`,
    ArtistSingles: ({ artistId }) => `artist/${artistId}/singles`,
    Album: ({ albumId }) => `album/${albumId}`,
    Playlist: ({ playlistId }) => `playlist/${playlistId}`,
    MyPlaylist: ({ playlistId }) => `my-playlist/${playlistId}`,
    Mood: ({ params }) => `mood/${params}`,
    Account: () => 'account',
    NotFound: ({ path }) => `not-found/${path}`,
  })
