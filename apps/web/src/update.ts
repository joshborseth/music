import {
  Array,
  HashMap,
  Match,
  Option,
  Record,
  Result,
  String,
  pipe,
} from 'effect'
import { AsyncData, Runtime, Update, Url } from 'foldkit'
import { UrlRequest } from 'foldkit/navigation'
import { modifyFields } from 'foldkit/struct'

import {
  LIKED_PLAYLIST_ID,
  type MyLibrary,
  type MyPlaylistDetails,
  type PlaylistEdit,
  type PlaylistEditResult,
  type Song,
} from '@music/shared'

import {
  BlurSearchInput,
  EditPlaylists,
  FocusPlaylistTitleInput,
  FocusSearchInput,
  LoadExternal,
  LoadLibrary,
  LoadRecentSearches,
  LockScroll,
  NavigateBack,
  NavigateBackTo,
  NavigateInternal,
  ReplaceSearchUrl,
  SaveRecentSearches,
  SaveRecentlyPlayed,
  SaveRecentlyViewed,
  ScrollSearchResultsToTop,
  ScrollToTop,
  ShuffleSongs,
  TakeOverScrollRestoration,
  UnlockScroll,
  WaitBeforeSearch,
} from './command'
import { MAX_RECENT_SEARCHES } from './constant'
import {
  LIBRARY_ARTWORK_WIDTH,
  type LibraryItem,
  MAX_RECENTLY_PLAYED,
  MAX_RECENTLY_VIEWED,
  albumLibraryItem,
  artistLibraryItem,
  isSameLibraryItem,
  isSameTrack,
  playlistLibraryItem,
  rememberFirst,
} from './library'
import { Message } from './message'
import { Model } from './model'
import {
  type BackStacks,
  type NavigationKind,
  type NavigationModel,
  type TabUrls,
  initialNavigationModel,
} from './navigation'
import { LoadDeviceIdentity } from './playback/command'
import { currentEntry, initialPlaybackModel } from './playback/domain'
import type { PlaybackServices } from './playback/resource'
import * as Playback from './playback/update'
import {
  type RequestError,
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  artworkBackdropQuery,
  homeQuery,
  myLibraryQuery,
  myPlaylistQuery,
  playlistQuery,
  playlistSearchQuery,
  songQuery,
  songSearchQuery,
} from './query'
import {
  AppRoute,
  DEFAULT_SEARCH_KIND,
  type SearchKind,
  TAB_ROOT_URLS,
  type Tab,
  routeTab,
  searchUrl,
  urlPath,
  urlToAppRoute,
} from './route'
import { type MusicClient } from './rpc'
import { ActionSheet, type PlayerPanel, type SheetContent } from './sheet'
import {
  artistNames,
  artworkUrl,
  joinDetails,
  myPlaylistHref,
} from './view/shared'

type UpdateReturn = Update.Return<
  Model,
  Message,
  MusicClient | PlaybackServices
>
type UpdateStep = Update.Step<Model, Message, MusicClient | PlaybackServices>

// QUERIES

const home = homeQuery.lift<Model, Message>({
  parentField: 'home',
  toParentMessage: message => Message.GotHomeMessage({ message }),
})

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

const playlistSearch = playlistSearchQuery.lift<Model, Message>({
  parentField: 'playlistSearch',
  toParentMessage: message => Message.GotPlaylistSearchMessage({ message }),
})

const myLibrary = myLibraryQuery.lift<Model, Message>({
  parentField: 'myLibrary',
  toParentMessage: message => Message.GotMyLibraryMessage({ message }),
})

const myPlaylists = myPlaylistQuery.lift<Model, Message>({
  parentField: 'myPlaylists',
  toParentMessage: message => Message.GotMyPlaylistMessage({ message }),
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

const artworkBackdrops = artworkBackdropQuery.lift<Model, Message>({
  parentField: 'artworkBackdrops',
  toParentMessage: message => Message.GotArtworkBackdropMessage({ message }),
})

const playlists = playlistQuery.lift<Model, Message>({
  parentField: 'playlists',
  toParentMessage: message => Message.GotPlaylistMessage({ message }),
})

// NAVIGATION

const withPendingNavigation = (model: Model, kind: NavigationKind): Model =>
  modifyFields(model, {
    navigation: navigation =>
      modifyFields(navigation, {
        maybePendingNavigation: () => Option.some(kind),
      }),
  })

const navigateTo =
  (url: string, kind: NavigationKind): UpdateStep =>
  model => ({
    model: withPendingNavigation(model, kind),
    commands: [NavigateInternal({ url })],
  })

const withTabUrl = (tabUrls: TabUrls, tab: Tab, url: string): TabUrls =>
  Match.value(tab).pipe(
    Match.withReturnType<TabUrls>(),
    Match.when('Home', () => modifyFields(tabUrls, { Home: () => url })),
    Match.when('Search', () => modifyFields(tabUrls, { Search: () => url })),
    Match.when('Library', () => modifyFields(tabUrls, { Library: () => url })),
    Match.exhaustive,
  )

const withBackStack = (
  backStacks: BackStacks,
  tab: Tab,
  stack: ReadonlyArray<string>,
): BackStacks =>
  Match.value(tab).pipe(
    Match.withReturnType<BackStacks>(),
    Match.when('Home', () => modifyFields(backStacks, { Home: () => stack })),
    Match.when('Search', () =>
      modifyFields(backStacks, { Search: () => stack }),
    ),
    Match.when('Library', () =>
      modifyFields(backStacks, { Library: () => stack }),
    ),
    Match.exhaustive,
  )

type BackHistory = Readonly<{
  stack: ReadonlyArray<string>
  historyBackDepth: number
}>

const EMPTY_BACK_HISTORY: BackHistory = { stack: [], historyBackDepth: 0 }

/**
 * The pages under the new one in its tab after a navigation, and how many of
 * them the browser's history holds directly beneath it. A tab's top page has
 * nothing under it. Pushing stacks the page being left. Going back unstacks
 * the page returned to; an unrecognized browser step stacks the page left.
 */
const nextBackHistory = (
  navigation: NavigationModel,
  kind: NavigationKind,
  activeTab: Tab,
  isTabRoot: boolean,
  path: string,
): BackHistory => {
  const stack = navigation.backStacks[activeTab]
  const fromPath = navigation.tabUrls[navigation.activeTab]
  const historyBackDepth = navigation.historyBackDepth

  if (isTabRoot) {
    return EMPTY_BACK_HISTORY
  }

  return Match.value(kind).pipe(
    Match.withReturnType<BackHistory>(),
    Match.when('Push', () =>
      activeTab === navigation.activeTab
        ? {
            stack: Array.append(stack, fromPath),
            historyBackDepth: historyBackDepth + 1,
          }
        : EMPTY_BACK_HISTORY,
    ),
    Match.when('Pop', () =>
      Option.match(
        Array.findLastIndex(stack, url => url === path),
        {
          onSome: index => ({
            stack: Array.take(stack, index),
            historyBackDepth:
              index === stack.length - 1
                ? Math.max(0, historyBackDepth - 1)
                : 0,
          }),
          onNone: () => ({
            stack: fromPath === path ? stack : Array.append(stack, fromPath),
            historyBackDepth: 0,
          }),
        },
      ),
    ),
    Match.when('SwitchTab', () => ({ stack, historyBackDepth: 0 })),
    Match.orElse(() => ({ stack, historyBackDepth })),
  )
}

/**
 * Returns to the page under this one in its tab: through the browser's
 * history when that page is the entry right behind, otherwise by replacing
 * this entry with it. A page opened directly returns to its tab's top.
 */
const goBack: UpdateStep = model => {
  const { activeTab, backStacks, historyBackDepth } = model.navigation
  const isAtTabRoot = Option.contains(routeTab(model.route), activeTab)
  return Option.match(Array.last(backStacks[activeTab]), {
    onSome: parentUrl =>
      historyBackDepth > 0
        ? {
            model: withPendingNavigation(model, 'Pop'),
            commands: [NavigateBack()],
          }
        : {
            model: withPendingNavigation(model, 'Pop'),
            commands: [NavigateBackTo({ url: parentUrl })],
          },
    onNone: () =>
      isAtTabRoot
        ? { model }
        : {
            model: withPendingNavigation(model, 'Pop'),
            commands: [NavigateBackTo({ url: TAB_ROOT_URLS[activeTab] })],
          },
  })
}

const switchTab =
  (tab: Tab): UpdateStep =>
  model =>
    navigateTo(
      model.navigation.tabUrls[tab],
      'SwitchTab',
    )(
      modifyFields(model, {
        navigation: navigation =>
          modifyFields(navigation, { activeTab: () => tab }),
      }),
    )

/** The path of the page on screen, which is where its tab now points. */
const currentPath = (model: Model): string =>
  model.navigation.tabUrls[model.navigation.activeTab]

/** Where to put a page when it appears: back where it was, or at the top. */
export const restoredScrollTop = (model: Model): number =>
  Match.value(model.navigation.lastNavigation).pipe(
    Match.withReturnType<number>(),
    Match.whenOr('Pop', 'SwitchTab', 'Initial', () =>
      Option.getOrElse(
        Record.get(model.navigation.scrollPositions, currentPath(model)),
        () => 0,
      ),
    ),
    Match.orElse(() => 0),
  )

// OVERLAYS

const showSheet =
  (content: SheetContent): UpdateStep =>
  model =>
    model.actionSheet._tag === 'Shown'
      ? {
          model: modifyFields(model, {
            actionSheet: () => ActionSheet.Shown({ content }),
          }),
        }
      : {
          model: modifyFields(model, {
            actionSheet: () => ActionSheet.Shown({ content }),
          }),
          commands: [LockScroll()],
        }

const dismissSheet: UpdateStep = model =>
  ActionSheet.match(model.actionSheet, {
    Hidden: (): UpdateReturn => ({ model }),
    Dismissed: (): UpdateReturn => ({ model }),
    Shown: ({ content }): UpdateReturn => ({
      model: modifyFields(model, {
        actionSheet: () => ActionSheet.Dismissed({ content }),
      }),
      commands: [UnlockScroll()],
    }),
  })

const closePlayer: UpdateStep = model => Playback.closePlayer(model)

const selectPlayerPanel =
  (panel: PlayerPanel): UpdateStep =>
  model => {
    const nextPanel = model.playerPanel === panel ? 'Artwork' : panel
    return loadLyricsIfShown(
      modifyFields(model, { playerPanel: () => nextPanel }),
    )
  }

/** The full player shows the current song's lyrics, loaded on demand. */
const loadLyricsIfShown: UpdateStep = model =>
  pipe(
    Option.liftPredicate(model, ({ playerPanel }) => playerPanel === 'Lyrics'),
    Option.flatMap(({ maybeSession }) => maybeSession),
    Option.flatMap(({ state }) => currentEntry(state)),
    Option.match({
      onNone: () => ({ model }),
      onSome: entry =>
        songs.loadIfMissing(model, { videoId: entry.track.videoId }),
    }),
  )

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
    model: withPendingNavigation(model, 'Replace'),
    commands: [
      ReplaceSearchUrl({ url: searchUrl(query, kind) }),
      ScrollSearchResultsToTop(),
    ],
  })

const rememberSearch =
  (query: string): UpdateStep =>
  model => {
    const recentSearches = rememberFirst(
      model.recentSearches,
      query,
      (left, right) => left === right,
      MAX_RECENT_SEARCHES,
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

// LIBRARY

const libraryArtworkUrl = (artwork: Parameters<typeof artworkUrl>[0]) =>
  artworkUrl(artwork, LIBRARY_ARTWORK_WIDTH)

/** The album, artist, or playlist the current page shows, once loaded. */
const viewedItem = (model: Model): Option.Option<LibraryItem> =>
  AppRoute.matchOrElse(
    model.route,
    {
      Album: ({ albumId }) =>
        Option.map(
          AsyncData.getData(albumQuery.read(model.albums, { albumId })),
          ({ album }) =>
            albumLibraryItem(
              album,
              joinDetails([
                Option.getOrElse(album.maybeKind, () => 'Album'),
                artistNames(album.artists),
              ]),
              libraryArtworkUrl,
            ),
        ),
      Artist: ({ artistId }) =>
        Option.map(
          AsyncData.getData(artistQuery.read(model.artists, { artistId })),
          ({ artist }) => artistLibraryItem(artist, libraryArtworkUrl),
        ),
      Playlist: ({ playlistId }) =>
        Option.map(
          AsyncData.getData(
            playlistQuery.read(model.playlists, { playlistId }),
          ),
          ({ playlist }) => playlistLibraryItem(playlist, libraryArtworkUrl),
        ),
    },
    () => Option.none(),
  )

const rememberViewed: UpdateStep = model =>
  Option.match(viewedItem(model), {
    onNone: () => ({ model }),
    onSome: item => {
      const isAlreadyFirst = Option.exists(
        Array.head(model.recentlyViewed),
        first => isSameLibraryItem(first, item),
      )
      if (isAlreadyFirst) {
        return { model }
      }
      const recentlyViewed = rememberFirst(
        model.recentlyViewed,
        item,
        isSameLibraryItem,
        MAX_RECENTLY_VIEWED,
      )
      return {
        model: modifyFields(model, { recentlyViewed: () => recentlyViewed }),
        commands: [SaveRecentlyViewed({ recentlyViewed })],
      }
    },
  })

const currentVideoId = (model: Model): Option.Option<string> =>
  pipe(
    model.maybeSession,
    Option.flatMap(({ state }) => currentEntry(state)),
    Option.map(({ track }) => track.videoId),
  )

/**
 * Run a step that may change the current song, then remember the new song
 * and load its lyrics if they are showing. The phone moves to the next song
 * itself, so this is not only for the server's state.
 */
const followingCurrentSong =
  (step: UpdateStep): UpdateStep =>
  model =>
    Update.combine([
      step,
      rememberPlayed(currentVideoId(model)),
      loadLyricsIfShown,
    ])(model)

/** Adds the song now playing to Recently Played when it changes. */
const rememberPlayed =
  (maybePreviousVideoId: Option.Option<string>): UpdateStep =>
  model =>
    pipe(
      model.maybeSession,
      Option.flatMap(({ state }) => currentEntry(state)),
      Option.filter(
        ({ track }) => !Option.contains(maybePreviousVideoId, track.videoId),
      ),
      Option.match({
        onNone: () => ({ model }),
        onSome: ({ track }) => {
          const recentlyPlayed = rememberFirst(
            model.recentlyPlayed,
            track,
            isSameTrack,
            MAX_RECENTLY_PLAYED,
          )
          return {
            model: modifyFields(model, {
              recentlyPlayed: () => recentlyPlayed,
            }),
            commands: [SaveRecentlyPlayed({ recentlyPlayed })],
          }
        },
      }),
    )

/** Keeps anything remembered before the saved Library finished loading. */
const mergeRemembered = <A>(
  newer: ReadonlyArray<A>,
  stored: ReadonlyArray<A>,
  isSame: (left: A, right: A) => boolean,
  max: number,
): ReadonlyArray<A> =>
  Array.reduceRight(newer, stored, (items, item) =>
    rememberFirst(items, item, isSame, max),
  )

// MY PLAYLISTS

/** The ids of the songs I like, as far as this device knows. */
export const likedVideoIds = (model: Model): ReadonlyArray<string> =>
  Option.match(AsyncData.getData(myLibraryQuery.read(model.myLibrary)), {
    onNone: () => [],
    onSome: ({ likedVideoIds: ids }) => ids,
  })

const mapMyLibrary = (
  model: Model,
  change: (library: MyLibrary) => MyLibrary,
): Model =>
  modifyFields(model, {
    myLibrary: query =>
      modifyFields(query, {
        data: data => AsyncData.map(data, change),
      }),
  })

/** Takes my playlists as the server now has them, over any load in flight. */
const withMyLibrary = (model: Model, library: MyLibrary): Model =>
  modifyFields(model, {
    myLibrary: query =>
      modifyFields(query, { data: () => AsyncData.succeed(library) }),
  })

/** Changes the loaded copy of one of my playlists, if this device has one. */
const mapMyPlaylist = (
  model: Model,
  playlistId: string,
  change: (details: MyPlaylistDetails) => MyPlaylistDetails,
): Model =>
  modifyFields(model, {
    myPlaylists: query =>
      modifyFields(query, {
        entries: entries =>
          HashMap.map(entries, entry =>
            entry.args.playlistId === playlistId
              ? { ...entry, data: AsyncData.map(entry.data, change) }
              : entry,
          ),
      }),
  })

const withMyPlaylist = (model: Model, details: MyPlaylistDetails): Model =>
  mapMyPlaylist(model, details.playlist.id, () => details)

const withoutSong =
  (videoId: string) =>
  (details: MyPlaylistDetails): MyPlaylistDetails => ({
    ...details,
    songs: Array.filter(details.songs, song => song.videoId !== videoId),
  })

const withSongFirst =
  (song: Song) =>
  (details: MyPlaylistDetails): MyPlaylistDetails => ({
    ...details,
    songs: Array.prepend(withoutSong(song.videoId)(details).songs, song),
  })

/**
 * Shows a change before the server confirms it, so hearts fill and rows
 * leave at once. The server's answer replaces this either way.
 */
const showEditEarly = (model: Model, edit: PlaylistEdit): Model =>
  Match.valueTags(edit, {
    Create: () => model,
    Rename: () => model,
    AddSongs: () => model,
    Delete: ({ playlistId }) =>
      mapMyLibrary(model, library => ({
        ...library,
        playlists: Array.filter(
          library.playlists,
          ({ id }) => id !== playlistId,
        ),
      })),
    RemoveSong: ({ playlistId, videoId }) =>
      mapMyPlaylist(model, playlistId, withoutSong(videoId)),
    SetLiked: ({ song, isLiked }) =>
      mapMyPlaylist(
        mapMyLibrary(model, library => ({
          ...library,
          likedVideoIds: isLiked
            ? Array.prepend(
                Array.filter(library.likedVideoIds, id => id !== song.videoId),
                song.videoId,
              )
            : Array.filter(library.likedVideoIds, id => id !== song.videoId),
        })),
        LIKED_PLAYLIST_ID,
        isLiked ? withSongFirst(song) : withoutSong(song.videoId),
      ),
  })

const editPlaylists =
  (edit: PlaylistEdit): UpdateStep =>
  model => ({
    model: showEditEarly(model, edit),
    commands: [EditPlaylists({ edit })],
  })

/** The playlist an edit changes, when it names one that already exists. */
const editedPlaylistId = (edit: PlaylistEdit): Option.Option<string> =>
  Match.valueTags(edit, {
    Create: () => Option.none(),
    Rename: ({ playlistId }) => Option.some(playlistId),
    Delete: () => Option.none(),
    AddSongs: ({ playlistId }) => Option.some(playlistId),
    RemoveSong: ({ playlistId }) => Option.some(playlistId),
    SetLiked: () => Option.some(LIKED_PLAYLIST_ID),
  })

const showNotice =
  (notice: string): UpdateStep =>
  model =>
    Playback.receiveNotice(model, notice)

const addedNotice = (title: string): string => `Added to “${title}”`

const stay: UpdateStep = model => ({ model })

/** What follows a saved edit: a new empty playlist opens, adding says so. */
const followEdit = (
  edit: PlaylistEdit,
  result: PlaylistEditResult,
): UpdateStep =>
  Option.match(result.maybePlaylist, {
    onNone: () => stay,
    onSome: ({ playlist }) =>
      Match.valueTags(edit, {
        Create: ({ songs: createdWith }) =>
          Array.isReadonlyArrayEmpty(createdWith)
            ? navigateTo(myPlaylistHref(playlist.id), 'Push')
            : showNotice(addedNotice(playlist.title)),
        AddSongs: () => showNotice(addedNotice(playlist.title)),
        Rename: () => stay,
        Delete: () => stay,
        RemoveSong: () => stay,
        SetLiked: () => stay,
      }),
  })

const completeEditPlaylists = (
  edit: PlaylistEdit,
  result: Result.Result<PlaylistEditResult, RequestError>,
): UpdateStep =>
  Result.match(result, {
    onSuccess:
      (saved): UpdateStep =>
      model =>
        followEdit(
          edit,
          saved,
        )(
          Option.match(saved.maybePlaylist, {
            onNone: () => withMyLibrary(model, saved.library),
            onSome: details =>
              withMyPlaylist(withMyLibrary(model, saved.library), details),
          }),
        ),
    onFailure: (): UpdateStep =>
      Update.combine([
        showNotice('Could not save that change. Try again.'),
        model => myLibrary.revalidateOrLoad(model),
        model =>
          Option.match(editedPlaylistId(edit), {
            onNone: () => ({ model }),
            onSome: playlistId => myPlaylists.revalidate(model, { playlistId }),
          }),
      ]),
  })

const showPlaylistTitleSheet =
  (title: string, content: SheetContent): UpdateStep =>
  model =>
    Update.combine([
      showSheet(content),
      stepModel => ({
        model: stepModel,
        commands: [FocusPlaylistTitleInput()],
      }),
    ])(modifyFields(model, { playlistTitleInput: () => title }))

/** Leaves the page of a playlist that was just deleted. */
const leaveDeletedPlaylist =
  (playlistId: string): UpdateStep =>
  model =>
    AppRoute.matchOrElse(
      model.route,
      {
        MyPlaylist: route =>
          route.playlistId === playlistId
            ? { model, commands: [NavigateBack()] }
            : { model },
      },
      () => ({ model }),
    )

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
    Match.when(
      'Playlists',
      () => model => playlistSearch.loadIfMissing(model, { query }),
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
    Match.when(
      'Playlists',
      () => model => playlistSearch.revalidateOrLoad(model, { query }),
    ),
    Match.exhaustive,
  )

const loadRoute = (route: AppRoute): UpdateStep =>
  AppRoute.match<UpdateStep>(route, {
    Home: () => model => home.loadIfMissing(model),
    Search: () =>
      Option.match(routeQuery(route), {
        onNone: () => model => ({ model }),
        onSome: query => loadSearch(query, routeSearchKind(route)),
      }),
    Library: () => model => myLibrary.revalidateOrLoad(model),
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
    Playlist:
      ({ playlistId }) =>
      model =>
        playlists.loadIfMissing(model, { playlistId }),
    MyPlaylist:
      ({ playlistId }) =>
      model =>
        myPlaylists.revalidateOrLoad(model, { playlistId }),
    NotFound: () => model => ({ model }),
  })

const retryRoute = (route: AppRoute): UpdateStep =>
  AppRoute.match<UpdateStep>(route, {
    Home: () => model => home.revalidateOrLoad(model),
    Search: () =>
      Option.match(routeQuery(route), {
        onNone: () => model => ({ model }),
        onSome: query => revalidateSearch(query, routeSearchKind(route)),
      }),
    Library: () => model => myLibrary.revalidateOrLoad(model),
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
    Playlist:
      ({ playlistId }) =>
      model =>
        playlists.revalidateOrLoad(model, { playlistId }),
    MyPlaylist:
      ({ playlistId }) =>
      model =>
        myPlaylists.revalidateOrLoad(model, { playlistId }),
    NotFound: () => model => ({ model }),
  })

// INIT

/** The Model for a first visit to `route`, before anything has loaded. */
export const initialModel = (route: AppRoute, path: string): Model => {
  const activeTab = Option.getOrElse(routeTab(route), (): Tab => 'Home')
  const navigation = initialNavigationModel(activeTab)
  return syncSearchInput({
    route,
    navigation: modifyFields(navigation, {
      tabUrls: tabUrls => withTabUrl(tabUrls, activeTab, path),
    }),
    searchInput: '',
    recentSearches: [],
    recentlyPlayed: [],
    recentlyViewed: [],
    home: homeQuery.init(),
    songSearch: songSearchQuery.init(),
    artistSearch: artistSearchQuery.init(),
    albumSearch: albumSearchQuery.init(),
    playlistSearch: playlistSearchQuery.init(),
    songs: songQuery.init(),
    artists: artistQuery.init(),
    albums: albumQuery.init(),
    playlists: playlistQuery.init(),
    myLibrary: myLibraryQuery.init(),
    myPlaylists: myPlaylistQuery.init(),
    artworkBackdrops: artworkBackdropQuery.init(),
    playlistTitleInput: '',
    actionSheet: ActionSheet.Hidden(),
    playerPanel: 'Artwork',
    ...initialPlaybackModel,
  })
}

const loadStoredState: UpdateStep = model => ({
  model,
  commands: [
    TakeOverScrollRestoration(),
    LoadRecentSearches(),
    LoadLibrary(),
    LoadDeviceIdentity(),
  ],
})

export const init: Runtime.RoutingApplicationInit<
  Model,
  Message,
  void,
  MusicClient | PlaybackServices
> = (url: Url.Url) => {
  const route = urlToAppRoute(url)
  return Update.combine([
    loadRoute(route),
    loadStoredState,
    model => myLibrary.loadIfMissing(model),
  ])(initialModel(route, urlPath(url)))
}

// UPDATE

const changeUrl =
  (url: Url.Url): UpdateStep =>
  model => {
    const route = urlToAppRoute(url)
    const path = urlPath(url)
    const kind = Option.getOrElse(
      model.navigation.maybePendingNavigation,
      (): NavigationKind => 'Pop',
    )
    const maybeRouteTab = routeTab(route)
    const activeTab = Option.getOrElse(
      maybeRouteTab,
      () => model.navigation.activeTab,
    )
    const backHistory = nextBackHistory(
      model.navigation,
      kind,
      activeTab,
      Option.isSome(maybeRouteTab),
      path,
    )
    const navigation = modifyFields(model.navigation, {
      activeTab: () => activeTab,
      tabUrls: tabUrls => withTabUrl(tabUrls, activeTab, path),
      backStacks: backStacks =>
        withBackStack(backStacks, activeTab, backHistory.stack),
      historyBackDepth: () => backHistory.historyBackDepth,
      scrollPositions: positions =>
        kind === 'Push' ? Record.remove(positions, path) : positions,
      maybePendingNavigation: () => Option.none(),
      lastNavigation: () => kind,
    })
    return Update.combine([loadRoute(route), rememberViewed])(
      syncSearchInput(
        modifyFields(model, {
          route: () => route,
          navigation: () => navigation,
        }),
      ),
    )
  }

const updateMessage = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) =>
          Update.combine([
            rememberRouteSearch,
            dismissSheet,
            closePlayer,
            navigateTo(Url.toString(url), 'Push'),
          ])(model),
        External: ({ href }) => ({
          model,
          commands: [LoadExternal({ href })],
        }),
      }),

    ChangedUrl: ({ url }) => changeUrl(url)(model),

    CompletedNavigateInternal: ({ fromUrl, scrollTop }) => ({
      model: modifyFields(model, {
        navigation: navigation =>
          modifyFields(navigation, {
            scrollPositions: positions =>
              Record.set(positions, fromUrl, scrollTop),
          }),
      }),
    }),

    ClickedTab: ({ tab }) => {
      const isActiveTab = tab === model.navigation.activeTab
      const isAtTabRoot = Option.contains(routeTab(model.route), tab)
      if (!isActiveTab) {
        return Update.combine([
          rememberRouteSearch,
          dismissSheet,
          switchTab(tab),
        ])(model)
      } else if (!isAtTabRoot) {
        return navigateTo(TAB_ROOT_URLS[tab], 'Pop')(model)
      } else if (tab === 'Search') {
        return { model, commands: [ScrollToTop(), FocusSearchInput()] }
      } else {
        return { model, commands: [ScrollToTop()] }
      }
    },

    UpdatedSearchInput: ({ value }) => ({
      model: modifyFields(model, { searchInput: () => value }),
      commands: [WaitBeforeSearch({ query: value })],
    }),

    CompletedWaitBeforeSearch: ({ query }) => {
      const trimmedQuery = query.trim()
      const isLatestInput = query === model.searchInput
      const isNewQuery = !Option.contains(routeQuery(model.route), trimmedQuery)
      const isOnSearchPage = model.route._tag === 'Search'
      return isLatestInput && isNewQuery && isOnSearchPage
        ? replaceSearch(trimmedQuery, routeSearchKind(model.route))(model)
        : { model }
    },

    SubmittedSearch: () => {
      const trimmedQuery = model.searchInput.trim()
      return String.isNonEmpty(trimmedQuery)
        ? Update.combine([
            replaceSearch(trimmedQuery, routeSearchKind(model.route)),
            rememberSearch(trimmedQuery),
            stepModel => ({ model: stepModel, commands: [BlurSearchInput()] }),
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

    ClickedBack: () => goBack(model),

    ClickedRetry: () => retryRoute(model.route)(model),

    CompletedLoadRecentSearches: ({ recentSearches }) => ({
      model: modifyFields(model, { recentSearches: () => recentSearches }),
    }),

    CompletedLoadLibrary: ({ recentlyPlayed, recentlyViewed }) => ({
      model: modifyFields(model, {
        recentlyPlayed: newer =>
          mergeRemembered(
            newer,
            recentlyPlayed,
            isSameTrack,
            MAX_RECENTLY_PLAYED,
          ),
        recentlyViewed: newer =>
          mergeRemembered(
            newer,
            recentlyViewed,
            isSameLibraryItem,
            MAX_RECENTLY_VIEWED,
          ),
      }),
    }),

    ClickedClearLibrary: () => ({
      model: modifyFields(model, {
        recentlyPlayed: () => [],
        recentlyViewed: () => [],
      }),
      commands: [
        SaveRecentlyPlayed({ recentlyPlayed: [] }),
        SaveRecentlyViewed({ recentlyViewed: [] }),
      ],
    }),

    GotHomeMessage: ({ message }) => home.fold(model, message),
    GotSongSearchMessage: ({ message }) => songSearch.fold(model, message),
    GotArtistSearchMessage: ({ message }) => artistSearch.fold(model, message),
    GotAlbumSearchMessage: ({ message }) => albumSearch.fold(model, message),
    GotSongMessage: ({ message }) => songs.fold(model, message),
    GotArtworkBackdropMessage: ({ message }) =>
      artworkBackdrops.fold(model, message),
    GotArtistMessage: ({ message }) =>
      Update.combine([
        stepModel => artists.fold(stepModel, message),
        rememberViewed,
      ])(model),
    GotAlbumMessage: ({ message }) =>
      Update.combine([
        stepModel => albums.fold(stepModel, message),
        rememberViewed,
      ])(model),
    GotPlaylistMessage: ({ message }) =>
      Update.combine([
        stepModel => playlists.fold(stepModel, message),
        rememberViewed,
      ])(model),
    GotPlaylistSearchMessage: ({ message }) =>
      playlistSearch.fold(model, message),
    GotMyLibraryMessage: ({ message }) => myLibrary.fold(model, message),
    GotMyPlaylistMessage: ({ message }) => myPlaylists.fold(model, message),

    ClickedAddToPlaylist: ({ songs: songsToAdd, suggestedTitle }) =>
      Update.combine([
        showSheet({
          _tag: 'AddToPlaylist',
          songs: songsToAdd,
          suggestedTitle,
        }),
        stepModel => myLibrary.revalidateOrLoad(stepModel),
      ])(model),
    ClickedNewPlaylist: ({ songs: songsToAdd, suggestedTitle }) =>
      showPlaylistTitleSheet(suggestedTitle, {
        _tag: 'NewPlaylist',
        songs: songsToAdd,
      })(model),
    UpdatedPlaylistTitleInput: ({ value }) => ({
      model: modifyFields(model, { playlistTitleInput: () => value }),
    }),
    SubmittedNewPlaylist: ({ songs: songsToAdd }) =>
      Update.combine([
        dismissSheet,
        editPlaylists({
          _tag: 'Create',
          title: model.playlistTitleInput,
          songs: songsToAdd,
        }),
      ])(model),
    ClickedPlaylistOption: ({ playlistId, songs: songsToAdd }) =>
      Update.combine([
        dismissSheet,
        editPlaylists({ _tag: 'AddSongs', playlistId, songs: songsToAdd }),
      ])(model),
    ClickedToggleLiked: ({ song }) =>
      Update.combine([
        dismissSheet,
        editPlaylists({
          _tag: 'SetLiked',
          song,
          isLiked: !Array.contains(likedVideoIds(model), song.videoId),
        }),
      ])(model),
    ClickedRemoveFromPlaylist: ({ playlistId, videoId }) =>
      Update.combine([
        dismissSheet,
        editPlaylists({ _tag: 'RemoveSong', playlistId, videoId }),
      ])(model),
    ClickedPlaylistActions: ({ playlistId, title }) =>
      showSheet({ _tag: 'PlaylistActions', playlistId, title })(model),
    ClickedRenamePlaylist: ({ playlistId, title }) =>
      showPlaylistTitleSheet(title, { _tag: 'RenamePlaylist', playlistId })(
        model,
      ),
    SubmittedRenamePlaylist: ({ playlistId }) =>
      Update.combine([
        dismissSheet,
        editPlaylists({
          _tag: 'Rename',
          playlistId,
          title: model.playlistTitleInput,
        }),
      ])(model),
    ClickedDeletePlaylist: ({ playlistId, title }) =>
      showSheet({ _tag: 'ConfirmDeletePlaylist', playlistId, title })(model),
    ConfirmedDeletePlaylist: ({ playlistId }) =>
      Update.combine([
        dismissSheet,
        leaveDeletedPlaylist(playlistId),
        editPlaylists({ _tag: 'Delete', playlistId }),
      ])(model),
    CompletedFocusPlaylistTitleInput: () => ({ model }),
    CompletedEditPlaylists: ({ edit, result }) =>
      completeEditPlaylists(edit, result)(model),

    CompletedLoadExternal: () => ({ model }),
    CompletedNavigateBack: () => ({ model }),
    CompletedNavigateBackTo: () => ({ model }),
    CompletedReplaceSearchUrl: () => ({ model }),
    CompletedScrollToTop: () => ({ model }),
    CompletedScrollSearchResultsToTop: () => ({ model }),
    CompletedSyncTitleBarReveal: () => ({ model }),
    CompletedRestoreScroll: () => ({ model }),
    CompletedFollowSheetDrags: () => ({ model }),
    CompletedTakeOverScrollRestoration: () => ({ model }),
    CompletedFocusSearchInput: () => ({ model }),
    CompletedBlurSearchInput: () => ({ model }),
    CompletedLockScroll: () => ({ model }),
    CompletedUnlockScroll: () => ({ model }),
    CompletedSaveRecentSearches: () => ({ model }),
    CompletedSaveRecentlyPlayed: () => ({ model }),
    CompletedSaveRecentlyViewed: () => ({ model }),

    ClickedSongActions: ({ song }) =>
      showSheet({ _tag: 'SongActions', song })(model),
    ClickedDevices: () => showSheet({ _tag: 'Devices' })(model),
    ClickedCloseSheet: () => dismissSheet(model),
    SwipedDownSheet: () => dismissSheet(model),
    SwipedDownPlayer: () => closePlayer(model),
    SelectedPlayerPanel: ({ panel }) => selectPlayerPanel(panel)(model),

    ClickedShuffleSongs: ({ songs: songsToShuffle }) => ({
      model,
      commands: [
        ...Playback.unlockIfIdle(model),
        ShuffleSongs({ songs: songsToShuffle }),
      ],
    }),
    CompletedShuffleSongs: ({ songs: shuffledSongs }) =>
      Playback.playSongs(model, shuffledSongs, 0),

    CompletedLoadDeviceIdentity: ({ deviceId, deviceName }) =>
      Playback.completeLoadDeviceIdentity(model, deviceId, deviceName),
    AcquiredSessionSocket: () => Playback.acquireSessionSocket(model),
    ReleasedSessionSocket: () => ({ model }),
    FailedConnectSessionSocket: () => Playback.loseSessionSocket(model),
    ClosedSessionSocket: () => Playback.loseSessionSocket(model),
    CompletedWaitBeforeReconnect: () =>
      Playback.completeWaitBeforeReconnect(model),
    ReceivedSessionState: ({ state, serverNow, ack, receivedAt }) =>
      followingCurrentSong(stepModel =>
        Playback.receiveSessionState(
          stepModel,
          state,
          serverNow,
          ack,
          receivedAt,
        ),
      )(model),
    ReceivedSessionNotice: ({ message }) =>
      Playback.receiveNotice(model, message),
    CompletedSendToSession: () => ({ model }),
    SentLocalChange: ({ maybeSeq }) =>
      Playback.completeSendLocalChange(model, maybeSeq),
    CompletedWaitBeforeHideNotice: ({ message }) =>
      Playback.completeWaitBeforeHideNotice(model, message),
    ClickedDismissNotice: () => ({
      model: modifyFields(model, { maybeNotice: () => Option.none() }),
    }),
    TickedClock: ({ now }) => ({
      model: modifyFields(model, { now: () => now }),
    }),

    AcquiredPhoneAudio: () => Playback.acquirePhoneAudio(model),
    ReleasedPhoneAudio: () => Playback.releasePhoneAudio(model),
    FailedAcquirePhoneAudio: () => Playback.releasePhoneAudio(model),
    CompletedUnlockPhoneAudio: () => ({ model }),
    CompletedLoadPhoneAudio: ({ entryId, isBlocked }) =>
      Playback.completeLoadPhoneAudio(model, entryId, isBlocked),
    CompletedSetPhoneAudioPlaying: ({ isBlocked }) =>
      Playback.completeStartPhoneAudio(model, isBlocked),
    CompletedStopPhoneAudio: () => ({ model }),
    CompletedUpdateMediaSession: () => ({ model }),
    UpdatedPhoneAudioTime: ({ entryId, seconds, at }) =>
      Playback.updatePhoneAudioTime(model, entryId, seconds, at),
    EndedPhoneAudio: ({ entryId }) =>
      followingCurrentSong(stepModel =>
        Playback.endPhoneAudio(stepModel, entryId),
      )(model),
    FailedPhoneAudio: ({ entryId, error }) =>
      Playback.failPhoneAudio(model, entryId, error),
    PausedPhoneAudio: ({ entryId }) =>
      Playback.followPhoneAudio(model, entryId, false),
    ResumedPhoneAudio: ({ entryId }) =>
      Playback.followPhoneAudio(model, entryId, true),
    PressedMediaKey: ({ key }) =>
      followingCurrentSong(stepModel => Playback.pressMediaKey(stepModel, key))(
        model,
      ),

    ClickedPlaySongs: ({ songs: songsToPlay, startIndex }) =>
      Playback.clickPlaySongs(model, songsToPlay, startIndex),
    ClickedEnqueueSongs: ({ songs: songsToEnqueue, placement }) =>
      Update.combine([
        dismissSheet,
        stepModel =>
          Playback.clickEnqueueSongs(stepModel, songsToEnqueue, placement),
      ])(model),
    ClickedTogglePlayback: () => Playback.clickTogglePlayback(model),
    ClickedNextTrack: () => followingCurrentSong(Playback.skipToNext)(model),
    ClickedPreviousTrack: () =>
      followingCurrentSong(Playback.skipToPrevious)(model),
    ChangedSeekPosition: ({ seconds }) => Playback.seekTo(model, seconds),
    UpdatedScrubPosition: ({ seconds }) => Playback.scrub(model, seconds),
    CancelledScrub: () => Playback.cancelScrub(model),
    CompletedFollowSeekBarDrags: () => ({ model }),
    ClickedSkipBy: ({ seconds }) => Playback.skipBy(model, seconds),
    ChangedPhoneAudioBuffering: ({ entryId, isBuffering }) =>
      Playback.changePhoneAudioBuffering(model, entryId, isBuffering),
    CompletedSeekPhoneAudio: () => ({ model }),
    CompletedPrefetchSongs: () => ({ model }),
    ClickedDevice: ({ deviceId }) =>
      Update.combine([
        dismissSheet,
        stepModel => Playback.clickDevice(stepModel, deviceId),
      ])(model),
    ClickedQueueEntry: ({ entryId }) =>
      followingCurrentSong(stepModel =>
        Playback.clickQueueEntry(stepModel, entryId),
      )(model),
    ClickedRemoveQueueEntry: ({ entryId }) =>
      Playback.sendCommand(model, { _tag: 'RemoveEntry', entryId }),
    ClickedOpenPlayer: () => Playback.openPlayer(model),
    ClickedClosePlayer: () => closePlayer(model),
    ClickedStartBlockedAudio: () => Playback.startBlockedAudio(model),

    PressedSwipeable: ({ target, pointerId, clientX, clientY, timeStamp }) =>
      Playback.pressSwipeable(
        model,
        target,
        pointerId,
        clientX,
        clientY,
        timeStamp,
      ),
    MovedSwipePointer: ({ pointerId, clientX, clientY, timeStamp }) =>
      Playback.moveSwipePointer(model, pointerId, clientX, clientY, timeStamp),
    ReleasedSwipePointer: ({ pointerId, timeStamp }) =>
      followingCurrentSong(stepModel =>
        Playback.releaseSwipePointer(stepModel, pointerId, timeStamp),
      )(model),
    CancelledSwipePointer: ({ pointerId }) =>
      Playback.cancelSwipePointer(model, pointerId),
  })

// PLAYER BACKDROP

const currentArtworkUrl = (model: Model): string | undefined =>
  pipe(
    model.maybeSession,
    Option.flatMap(({ state }) => currentEntry(state)),
    Option.flatMap(({ track }) => Option.fromNullishOr(track.artworkUrl)),
    Option.getOrUndefined,
  )

/**
 * Gets the full player's background color for the current song's artwork
 * when the song changes or the player opens, so it is there as the sheet
 * slides up. Only then, so a failed load waits for the next chance instead
 * of retrying at once.
 */
const loadArtworkBackdrop =
  (before: Model): UpdateStep =>
  model => {
    const artworkUrl = currentArtworkUrl(model)
    const playerOpened =
      model.playerSheet._tag === 'Open' && before.playerSheet._tag !== 'Open'
    return artworkUrl === undefined ||
      (artworkUrl === currentArtworkUrl(before) && !playerOpened)
      ? { model }
      : artworkBackdrops.loadIfMissing(model, { artworkUrl })
  }

export const update = (model: Model, message: Message): UpdateReturn =>
  Update.combine(model, [
    stepModel => updateMessage(stepModel, message),
    loadArtworkBackdrop(model),
  ])
