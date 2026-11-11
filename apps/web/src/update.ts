import { Array, Match, Option, String, pipe } from 'effect'
import { Runtime, Update, Url } from 'foldkit'
import { UrlRequest } from 'foldkit/navigation'
import { modifyFields } from 'foldkit/struct'

import {
  FocusSearchInput,
  LoadExternal,
  LoadRecentSearches,
  NavigateBack,
  NavigateInternal,
  ReplaceSearchUrl,
  SaveRecentSearches,
  ScrollToTop,
  WaitBeforeSearch,
} from './command'
import { MAX_RECENT_SEARCHES } from './constant'
import { Message } from './message'
import { Model } from './model'
import {
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  songQuery,
  songSearchQuery,
} from './query'
import {
  AppRoute,
  DEFAULT_SEARCH_KIND,
  type SearchKind,
  searchUrl,
  urlToAppRoute,
} from './route'
import { type MusicClient } from './rpc'

type UpdateReturn = Update.Return<Model, Message, MusicClient>
type UpdateStep = Update.Step<Model, Message, MusicClient>

// QUERIES

const songSearch = songSearchQuery.lift<Model, Message>({
  parentField: 'songSearch',
  toParentMessage: message => Message.GotSongSearchMessage({ message }),
})

const artistSearch = artistSearchQuery.lift<Model, Message>({
  parentField: 'artistSearch',
  toParentMessage: message => Message.GotArtistSearchMessage({ message }),
})

const albumSearch = albumSearchQuery.lift<Model, Message>({
  parentField: 'albumSearch',
  toParentMessage: message => Message.GotAlbumSearchMessage({ message }),
})

const songs = songQuery.lift<Model, Message>({
  parentField: 'songs',
  toParentMessage: message => Message.GotSongMessage({ message }),
})

const artists = artistQuery.lift<Model, Message>({
  parentField: 'artists',
  toParentMessage: message => Message.GotArtistMessage({ message }),
})

const albums = albumQuery.lift<Model, Message>({
  parentField: 'albums',
  toParentMessage: message => Message.GotAlbumMessage({ message }),
})

// SEARCH

/** The trimmed query a Search route asks for, if any. */
export const routeQuery = (route: AppRoute): Option.Option<string> =>
  AppRoute.matchOrElse(
    route,
    {
      Search: ({ q }) =>
        pipe(q, Option.map(String.trim), Option.filter(String.isNonEmpty)),
    },
    () => Option.none(),
  )

/** The catalog a Search route looks through. */
export const routeSearchKind = (route: AppRoute): SearchKind =>
  AppRoute.matchOrElse(
    route,
    { Search: ({ kind }) => Option.getOrElse(kind, () => DEFAULT_SEARCH_KIND) },
    () => DEFAULT_SEARCH_KIND,
  )

const replaceSearch =
  (query: string, kind: SearchKind): UpdateStep =>
  model => ({
    model,
    commands: [ReplaceSearchUrl({ url: searchUrl(query, kind) })],
  })

const rememberSearch =
  (query: string): UpdateStep =>
  model => {
    const recentSearches = pipe(
      model.recentSearches,
      Array.filter(recentSearch => recentSearch !== query),
      Array.prepend(query),
      Array.take(MAX_RECENT_SEARCHES),
    )
    return {
      model: modifyFields(model, { recentSearches: () => recentSearches }),
      commands: [SaveRecentSearches({ recentSearches })],
    }
  }

const rememberRouteSearch: UpdateStep = model =>
  Option.match(routeQuery(model.route), {
    onNone: () => ({ model }),
    onSome: query => rememberSearch(query)(model),
  })

const syncSearchInput = (model: Model): Model =>
  Option.match(routeQuery(model.route), {
    onNone: () => model,
    onSome: query =>
      query === model.searchInput.trim()
        ? model
        : modifyFields(model, { searchInput: () => query }),
  })

// ROUTE LOADING

const loadSearch = (query: string, kind: SearchKind): UpdateStep =>
  Match.value(kind).pipe(
    Match.withReturnType<UpdateStep>(),
    Match.when(
      'Songs',
      () => model => songSearch.loadIfMissing(model, { query }),
    ),
    Match.when(
      'Artists',
      () => model => artistSearch.loadIfMissing(model, { query }),
    ),
    Match.when(
      'Albums',
      () => model => albumSearch.loadIfMissing(model, { query }),
    ),
    Match.exhaustive,
  )

const revalidateSearch = (query: string, kind: SearchKind): UpdateStep =>
  Match.value(kind).pipe(
    Match.withReturnType<UpdateStep>(),
    Match.when(
      'Songs',
      () => model => songSearch.revalidateOrLoad(model, { query }),
    ),
    Match.when(
      'Artists',
      () => model => artistSearch.revalidateOrLoad(model, { query }),
    ),
    Match.when(
      'Albums',
      () => model => albumSearch.revalidateOrLoad(model, { query }),
    ),
    Match.exhaustive,
  )

const loadRoute = (route: AppRoute): UpdateStep =>
  AppRoute.match<UpdateStep>(route, {
    Search: () =>
      Option.match(routeQuery(route), {
        onNone: () => model => ({ model }),
        onSome: query => loadSearch(query, routeSearchKind(route)),
      }),
    Song:
      ({ videoId }) =>
      model =>
        songs.loadIfMissing(model, { videoId }),
    Artist:
      ({ artistId }) =>
      model =>
        artists.loadIfMissing(model, { artistId }),
    Album:
      ({ albumId }) =>
      model =>
        albums.loadIfMissing(model, { albumId }),
    NotFound: () => model => ({ model }),
  })

const retryRoute = (route: AppRoute): UpdateStep =>
  AppRoute.match<UpdateStep>(route, {
    Search: () =>
      Option.match(routeQuery(route), {
        onNone: () => model => ({ model }),
        onSome: query => revalidateSearch(query, routeSearchKind(route)),
      }),
    Song:
      ({ videoId }) =>
      model =>
        songs.revalidateOrLoad(model, { videoId }),
    Artist:
      ({ artistId }) =>
      model =>
        artists.revalidateOrLoad(model, { artistId }),
    Album:
      ({ albumId }) =>
      model =>
        albums.revalidateOrLoad(model, { albumId }),
    NotFound: () => model => ({ model }),
  })

// INIT

const loadRecentSearches: UpdateStep = model => ({
  model,
  commands: [LoadRecentSearches()],
})

export const init: Runtime.RoutingApplicationInit<
  Model,
  Message,
  void,
  MusicClient
> = (url: Url.Url) => {
  const route = urlToAppRoute(url)
  const model = syncSearchInput({
    route,
    searchInput: '',
    recentSearches: [],
    songSearch: songSearchQuery.init(),
    artistSearch: artistSearchQuery.init(),
    albumSearch: albumSearchQuery.init(),
    songs: songQuery.init(),
    artists: artistQuery.init(),
    albums: albumQuery.init(),
  })

  return Update.combine([loadRoute(route), loadRecentSearches])(model)
}

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) =>
          Update.combine([
            rememberRouteSearch,
            stepModel => ({
              model: stepModel,
              commands: [
                NavigateInternal({ url: Url.toString(url) }),
                ScrollToTop(),
              ],
            }),
          ])(model),
        External: ({ href }) => ({
          model,
          commands: [LoadExternal({ href })],
        }),
      }),

    ChangedUrl: ({ url }) => {
      const route = urlToAppRoute(url)
      return loadRoute(route)(
        syncSearchInput(modifyFields(model, { route: () => route })),
      )
    },

    UpdatedSearchInput: ({ value }) => ({
      model: modifyFields(model, { searchInput: () => value }),
      commands: [WaitBeforeSearch({ query: value })],
    }),

    CompletedWaitBeforeSearch: ({ query }) => {
      const trimmedQuery = query.trim()
      const isLatestInput = query === model.searchInput
      const isNewQuery = !Option.contains(routeQuery(model.route), trimmedQuery)
      return isLatestInput && isNewQuery
        ? replaceSearch(trimmedQuery, routeSearchKind(model.route))(model)
        : { model }
    },

    SubmittedSearch: () => {
      const trimmedQuery = model.searchInput.trim()
      return String.isNonEmpty(trimmedQuery)
        ? Update.combine([
            replaceSearch(trimmedQuery, routeSearchKind(model.route)),
            rememberSearch(trimmedQuery),
          ])(model)
        : { model }
    },

    ClickedClearSearch: () =>
      Update.combine([
        replaceSearch('', routeSearchKind(model.route)),
        stepModel => ({
          model: modifyFields(stepModel, { searchInput: () => '' }),
          commands: [FocusSearchInput()],
        }),
      ])(model),

    SelectedSearchKind: ({ kind }) =>
      replaceSearch(model.searchInput.trim(), kind)(model),

    ClickedRecentSearch: ({ query }) =>
      Update.combine([
        replaceSearch(query, routeSearchKind(model.route)),
        rememberSearch(query),
      ])(modifyFields(model, { searchInput: () => query })),

    ClickedClearRecentSearches: () => ({
      model: modifyFields(model, { recentSearches: () => [] }),
      commands: [SaveRecentSearches({ recentSearches: [] })],
    }),

    ClickedBack: () => ({ model, commands: [NavigateBack()] }),

    ClickedRetry: () => retryRoute(model.route)(model),

    CompletedLoadRecentSearches: ({ recentSearches }) => ({
      model: modifyFields(model, { recentSearches: () => recentSearches }),
    }),

    GotSongSearchMessage: ({ message }) => songSearch.fold(model, message),
    GotArtistSearchMessage: ({ message }) => artistSearch.fold(model, message),
    GotAlbumSearchMessage: ({ message }) => albumSearch.fold(model, message),
    GotSongMessage: ({ message }) => songs.fold(model, message),
    GotArtistMessage: ({ message }) => artists.fold(model, message),
    GotAlbumMessage: ({ message }) => albums.fold(model, message),

    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    CompletedNavigateBack: () => ({ model }),
    CompletedReplaceSearchUrl: () => ({ model }),
    CompletedScrollToTop: () => ({ model }),
    CompletedFocusSearchInput: () => ({ model }),
    CompletedSaveRecentSearches: () => ({ model }),
  })
