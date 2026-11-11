import { Option, Schema, SchemaTransformation, pipe } from 'effect'
import { Route } from 'foldkit'
import { defineRouteUnion, literal, slash, string } from 'foldkit/route'

/** Which catalog a search looks through. */
export const SearchKind = Schema.Literals(['Songs', 'Artists', 'Albums'])
export type SearchKind = typeof SearchKind.Type

export const SEARCH_KINDS: ReadonlyArray<SearchKind> = SearchKind.literals

export const DEFAULT_SEARCH_KIND: SearchKind = 'Songs'

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
  Search: {
    q: Schema.Option(Schema.String),
    kind: Schema.Option(SearchKind),
  },
  Song: { videoId: Schema.String },
  Artist: { artistId: Schema.String },
  Album: { albumId: Schema.String },
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type
export type SearchRoute = typeof AppRoute.Search.Type

export const searchRouter = pipe(
  Route.root,
  Route.query(
    Schema.Struct({
      q: Schema.OptionFromOptional(Schema.String),
      kind: searchKindParam,
    }),
  ),
  Route.mapTo(AppRoute.Search),
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

export const albumRouter = pipe(
  literal('album'),
  slash(string('albumId')),
  Route.mapTo(AppRoute.Album),
)

const routeParser = Route.oneOf(
  songRouter,
  artistRouter,
  albumRouter,
  searchRouter,
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
