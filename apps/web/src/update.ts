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
  type HomeFeed,
  LIKED_PLAYLIST_ID,
  type MyLibrary,
  type MyPlaylistDetails,
  type PlaylistEdit,
  type PlaylistEditResult,
  SIGN_IN_PATH,
  type Session,
  type Song,
  mosaicCovers,
} from '@music/shared'

import { initialAccountPage } from './account/domain'
import * as AccountUpdate from './account/update'
import {
  BlurSearchInput,
  EditPlaylists,
  FetchRadio,
  FocusAddSongsInput,
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
  SaveLibraryPrefs,
  SaveRecentSearches,
  SaveRecentlyViewed,
  ScrollSearchResultsToTop,
  ScrollToTop,
  ShareLink,
  ShuffleSongs,
  TakeOverScrollRestoration,
  UnlockScroll,
  WaitBeforeAddSongsSearch,
  WaitBeforeRetryLyrics,
  WaitBeforeSearch,
} from './command'
import { MAX_RECENT_SEARCHES } from './constant'
import { LoadDownloads } from './downloads/command'
import { Downloads } from './downloads/domain'
import * as DownloadsUpdate from './downloads/update'
import { withPlayedFirst } from './home'
import {
  DEFAULT_LIBRARY_PREFS,
  LIBRARY_ARTWORK_WIDTH,
  type LibraryItem,
  type LibraryPrefs,
  MAX_RECENTLY_VIEWED,
  albumLibraryItem,
  artistLibraryItem,
  isAlbumSaved,
  isArtistFollowed,
  isSameLibraryItem,
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
import {
  currentEntry,
  initialPlaybackModel,
  nextRepeatMode,
} from './playback/domain'
import type { PlaybackServices } from './playback/resource'
import * as Playback from './playback/update'
import { PlaylistEditor, moveSong } from './playlistEditor'
import {
  type RequestError,
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  artworkBackdropQuery,
  homeQuery,
  librarySongsQuery,
  moodGroupsQuery,
  moodQuery,
  myLibraryQuery,
  myPlaylistQuery,
  newReleasesQuery,
  peopleQuery,
  playlistQuery,
  playlistSearchQuery,
  searchSuggestionsQuery,
  songQuery,
  songRadioQuery,
  songSearchQuery,
  topResultSearchQuery,
  viewerQuery,
} from './query'
import {
  AppRoute,
  DEFAULT_SEARCH_KIND,
  type SearchKind,
  TAB_ROOT_URLS,
  type Tab,
  openingTab,
  routeTab,
  searchUrl,
  urlPath,
  urlToAppRoute,
} from './route'
import { type MusicClient } from './rpc'
import { ActionSheet, type PlayerPanel, type SheetContent } from './sheet'
import { SuggestionList, listForInput, suggestionQuery } from './suggestions'
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

const topResultSearch = topResultSearchQuery.lift<Model, Message>({
  parentField: 'topResultSearch',
  toParentMessage: message => Message.GotTopResultSearchMessage({ message }),
})

const searchSuggestions = searchSuggestionsQuery.lift<Model, Message>({
  parentField: 'searchSuggestions',
  toParentMessage: message => Message.GotSearchSuggestionsMessage({ message }),
})

const moodGroups = moodGroupsQuery.lift<Model, Message>({
  parentField: 'moodGroups',
  toParentMessage: message => Message.GotMoodGroupsMessage({ message }),
})

const moods = moodQuery.lift<Model, Message>({
  parentField: 'moods',
  toParentMessage: message => Message.GotMoodMessage({ message }),
})

const myLibrary = myLibraryQuery.lift<Model, Message>({
  parentField: 'myLibrary',
  toParentMessage: message => Message.GotMyLibraryMessage({ message }),
})

const librarySongs = librarySongsQuery.lift<Model, Message>({
  parentField: 'librarySongs',
  toParentMessage: message => Message.GotLibrarySongsMessage({ message }),
})

const myPlaylists = myPlaylistQuery.lift<Model, Message>({
  parentField: 'myPlaylists',
  toParentMessage: message => Message.GotMyPlaylistMessage({ message }),
})

const home = homeQuery.lift<Model, Message>({
  parentField: 'home',
  toParentMessage: message => Message.GotHomeMessage({ message }),
})

const newReleases = newReleasesQuery.lift<Model, Message>({
  parentField: 'newReleases',
  toParentMessage: message => Message.GotNewReleasesMessage({ message }),
})

const songRadios = songRadioQuery.lift<Model, Message>({
  parentField: 'songRadios',
  toParentMessage: message => Message.GotSongRadioMessage({ message }),
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

/**
 * Lyrics that failed to load while they show are asked for once more, a
 * moment later, before the player offers Retry.
 */
const retryFailedLyricsOnce: UpdateStep = model =>
  pipe(
    Option.liftPredicate(model, ({ playerPanel }) => playerPanel === 'Lyrics'),
    Option.flatMap(currentVideoId),
    Option.filter(
      videoId =>
        AsyncData.isFailure(songQuery.read(model.songs, { videoId })) &&
        !Option.contains(model.maybeLyricsRetriedVideoId, videoId),
    ),
    Option.match({
      onNone: () => ({ model }),
      onSome: videoId => ({
        model: modifyFields(model, {
          maybeLyricsRetriedVideoId: () => Option.some(videoId),
        }),
        commands: [WaitBeforeRetryLyrics({ videoId })],
      }),
    }),
  )

/** Tries the lyrics again if they are still showing for the same song. */
const completeWaitBeforeRetryLyrics =
  (videoId: string): UpdateStep =>
  model =>
    Option.contains(currentVideoId(model), videoId)
      ? loadLyricsIfShown(model)
      : { model }

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

/** Puts the suggestions away once something is searched for or opened. */
const hideSuggestions: UpdateStep = model => ({
  model: modifyFields(model, {
    suggestionList: () => SuggestionList.Hidden(),
  }),
})

/**
 * Shows the suggestions for what is typed from the first letter, without
 * the pause the search waits for.
 */
const typeInSearch =
  (value: string): UpdateStep =>
  model => {
    const query = suggestionQuery(value)
    const typed = modifyFields(model, {
      searchInput: () => value,
      suggestionList: () => listForInput(model, value),
    })
    return String.isEmpty(query)
      ? { model: typed }
      : searchSuggestions.loadIfMissing(typed, { query })
  }

/**
 * Remembers the search a song was played from, as opening a result does,
 * so playing from the results puts the search in Recently Searched.
 */
const rememberPlayedSearch =
  (maybePlayingFrom: Option.Option<Session.PlayingFrom>): UpdateStep =>
  model =>
    Option.exists(maybePlayingFrom, ({ kind }) => kind === 'Search')
      ? Update.combine([rememberRouteSearch, hideSuggestions])(model)
      : { model }

/** Searches for a recent search or a suggestion, as if it were typed. */
const searchFor =
  (query: string): UpdateStep =>
  model =>
    Update.combine([
      replaceSearch(query, routeSearchKind(model.route)),
      rememberSearch(query),
      hideSuggestions,
    ])(modifyFields(model, { searchInput: () => query }))

const syncSearchInput = (model: Model): Model =>
  Option.match(routeQuery(model.route), {
    onNone: () => model,
    onSome: query =>
      query === model.searchInput.trim()
        ? model
        : modifyFields(model, { searchInput: () => query }),
  })

const isSettled = <A, E>(data: AsyncData.AsyncData<A, E>): boolean =>
  !AsyncData.isIdle(data) && !AsyncData.isLoading(data)

type SearchQueries = Pick<
  Model,
  | 'songSearch'
  | 'topResultSearch'
  | 'artistSearch'
  | 'albumSearch'
  | 'playlistSearch'
>

/**
 * Whether a search has answered enough to replace what the page shows: for
 * Top, its songs and its top result, so the card does not push the songs
 * down after they appear.
 */
export const isSearchSettled = (
  queries: SearchQueries,
  query: string,
  kind: SearchKind,
): boolean =>
  Match.value(kind).pipe(
    Match.withReturnType<boolean>(),
    Match.when(
      'Top',
      () =>
        isSettled(songSearchQuery.read(queries.songSearch, { query })) &&
        isSettled(
          topResultSearchQuery.read(queries.topResultSearch, { query }),
        ),
    ),
    Match.when('Songs', () =>
      isSettled(songSearchQuery.read(queries.songSearch, { query })),
    ),
    Match.when('Artists', () =>
      isSettled(artistSearchQuery.read(queries.artistSearch, { query })),
    ),
    Match.when('Albums', () =>
      isSettled(albumSearchQuery.read(queries.albumSearch, { query })),
    ),
    Match.when('Playlists', () =>
      isSettled(playlistSearchQuery.read(queries.playlistSearch, { query })),
    ),
    Match.exhaustive,
  )

/**
 * Remembers the results that were on screen when the search changes, so
 * they stay there until the new ones arrive instead of a page of
 * placeholders after every pause in typing. Leaving the search forgets them.
 */
const keepEarlierSearch =
  (before: Model): UpdateStep =>
  model => {
    const maybeEarlierSearch = Option.match(routeQuery(model.route), {
      onNone: () => Option.none<string>(),
      onSome: query =>
        Option.match(routeQuery(before.route), {
          onNone: () => before.maybeEarlierSearch,
          onSome: beforeQuery =>
            beforeQuery !== query &&
            isSearchSettled(before, beforeQuery, routeSearchKind(before.route))
              ? Option.some(beforeQuery)
              : before.maybeEarlierSearch,
        }),
    })
    return {
      model: modifyFields(model, {
        maybeEarlierSearch: () => maybeEarlierSearch,
      }),
    }
  }

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
 * Run a step that may change the current song, then show the new song in
 * Home's Recently played and load its lyrics if they are showing. The phone
 * moves to the next song itself, so this is not only for the server's state.
 */
const followingCurrentSong =
  (step: UpdateStep): UpdateStep =>
  model =>
    Update.combine([
      step,
      showPlayedEarly(currentVideoId(model)),
      loadLyricsIfShown,
    ])(model)

const mapHome = (model: Model, change: (feed: HomeFeed) => HomeFeed): Model =>
  modifyFields(model, {
    home: query =>
      modifyFields(query, {
        data: data => AsyncData.map(data, change),
      }),
  })

/**
 * Shows the song now playing first in Home's Recently played when it
 * changes. The server adds it to the play history too, and Home takes the
 * server's list the next time it opens.
 */
const showPlayedEarly =
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
        onSome: ({ track }) => ({
          model: mapHome(model, withPlayedFirst(track)),
        }),
      }),
    )

/** Asks YouTube Music for "More like" the song played last, once per song. */
const loadRadio: UpdateStep = model =>
  pipe(
    AsyncData.getData(homeQuery.read(model.home)),
    Option.flatMap(feed => feed.maybeLastPlayed),
    Option.match({
      onNone: () => ({ model }),
      onSome: ({ videoId }) => songRadios.loadIfMissing(model, { videoId }),
    }),
  )

// MY PLAYLISTS

const loadedLibrary = (model: Model): Option.Option<MyLibrary> =>
  AsyncData.getData(myLibraryQuery.read(model.myLibrary))

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
    Rename: ({ playlistId, title }) =>
      String.isNonEmpty(title.trim())
        ? mapMyPlaylist(model, playlistId, details => ({
            ...details,
            playlist: { ...details.playlist, title: title.trim() },
          }))
        : model,
    AddSongs: ({ playlistId, songs: added }) =>
      mapMyPlaylist(model, playlistId, details => ({
        ...details,
        songs: Array.appendAll(
          details.songs,
          Array.filter(
            added,
            song =>
              !Array.some(
                details.songs,
                ({ videoId }) => videoId === song.videoId,
              ),
          ),
        ),
      })),
    MoveSong: ({ playlistId, videoId, maybeBeforeVideoId }) =>
      mapMyPlaylist(model, playlistId, details => ({
        ...details,
        songs: moveSong(details.songs, videoId, maybeBeforeVideoId),
      })),
    SetDescription: ({ playlistId, description }) =>
      mapMyPlaylist(model, playlistId, details => ({
        ...details,
        playlist: {
          ...details.playlist,
          maybeDescription: Option.liftPredicate(
            description.trim(),
            String.isNonEmpty,
          ),
        },
      })),
    SetCover: ({ playlistId, maybeVideoId }) =>
      mapMyPlaylist(model, playlistId, details => ({
        ...details,
        playlist: {
          ...details.playlist,
          maybeCoverVideoId: maybeVideoId,
          covers: Option.match(maybeVideoId, {
            onNone: () => mosaicCovers(details.songs),
            onSome: videoId =>
              Option.match(
                Array.findFirst(
                  details.songs,
                  song => song.videoId === videoId,
                ),
                {
                  onNone: () => details.playlist.covers,
                  onSome: song => [song.artwork],
                },
              ),
          }),
        },
      })),
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
    SetAlbumSaved: ({ album, isSaved }) =>
      mapMyLibrary(model, library => {
        const others = Array.filter(library.albums, ({ id }) => id !== album.id)
        return {
          ...library,
          albums: isSaved ? Array.prepend(others, album) : others,
        }
      }),
    SetArtistFollowed: ({ artist, isFollowed }) =>
      mapMyLibrary(model, library => {
        const others = Array.filter(
          library.artists,
          ({ id }) => id !== artist.id,
        )
        return {
          ...library,
          artists: isFollowed ? Array.prepend(others, artist) : others,
        }
      }),
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
    MoveSong: ({ playlistId }) => Option.some(playlistId),
    SetDescription: ({ playlistId }) => Option.some(playlistId),
    SetCover: ({ playlistId }) => Option.some(playlistId),
    SetLiked: () => Option.some(LIKED_PLAYLIST_ID),
    SetAlbumSaved: () => Option.none(),
    SetArtistFollowed: () => Option.none(),
  })

/** Add Songs shows each song it adds with a check, so it needs no notice. */
const isAddingSongs = (model: Model): boolean =>
  model.actionSheet._tag === 'Shown' &&
  model.actionSheet.content._tag === 'AddSongs'

const showNotice =
  (notice: string): UpdateStep =>
  model =>
    Playback.receiveNotice(model, notice)

const addedNotice = (title: string): string => `Added to “${title}”`

const alreadyInNotice = (title: string): string => `Already in “${title}”`

/** Every song an edit adds was in the playlist already. */
const isAllAlreadyHeld = (
  songs: ReadonlyArray<Song>,
  result: PlaylistEditResult,
): boolean =>
  Array.isReadonlyArrayNonEmpty(songs) &&
  Array.every(songs, ({ videoId }) =>
    Array.contains(result.alreadyHeldVideoIds, videoId),
  )

const stay: UpdateStep = model => ({ model })

/**
 * What follows a saved edit: a new empty playlist opens, and adding songs or
 * saving an album says so, since nothing else on screen shows where it went.
 */
const followEdit = (
  edit: PlaylistEdit,
  result: PlaylistEditResult,
): UpdateStep => {
  const withChangedPlaylist = (
    follow: (title: string, playlistId: string) => UpdateStep,
  ): UpdateStep =>
    Option.match(result.maybePlaylist, {
      onNone: () => stay,
      onSome: ({ playlist }) => follow(playlist.title, playlist.id),
    })
  return Match.valueTags(edit, {
    Create: ({ songs: createdWith }) =>
      withChangedPlaylist((title, playlistId) =>
        Array.isReadonlyArrayEmpty(createdWith)
          ? navigateTo(myPlaylistHref(playlistId), 'Push')
          : showNotice(addedNotice(title)),
      ),
    AddSongs:
      ({ songs: added }): UpdateStep =>
      model =>
        isAddingSongs(model)
          ? { model }
          : withChangedPlaylist(title =>
              showNotice(
                isAllAlreadyHeld(added, result)
                  ? alreadyInNotice(title)
                  : addedNotice(title),
              ),
            )(model),
    Rename: () => stay,
    Delete: () => stay,
    RemoveSong: () => stay,
    MoveSong: () => stay,
    SetDescription: () => stay,
    SetCover: () => stay,
    SetLiked: () => stay,
    SetAlbumSaved: ({ isSaved }) =>
      showNotice(
        isSaved ? 'Saved to your Library' : 'Removed from your Library',
      ),
    SetArtistFollowed: () => stay,
  })
}

const completeEditPlaylists = (
  edit: PlaylistEdit,
  result: Result.Result<PlaylistEditResult, RequestError>,
): UpdateStep =>
  Result.match(result, {
    onSuccess: (saved): UpdateStep =>
      Update.combine([
        model => ({
          model: Option.match(saved.maybePlaylist, {
            onNone: () => withMyLibrary(model, saved.library),
            onSome: details =>
              withMyPlaylist(withMyLibrary(model, saved.library), details),
          }),
        }),
        model => librarySongs.revalidate(model),
        followEdit(edit, saved),
      ]),
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

// LIBRARY TOOLS

const changeLibraryPrefs =
  (change: (prefs: LibraryPrefs) => LibraryPrefs): UpdateStep =>
  model => {
    const libraryPrefs = change(model.libraryPrefs)
    return {
      model: modifyFields(model, { libraryPrefs: () => libraryPrefs }),
      commands: [SaveLibraryPrefs({ prefs: libraryPrefs })],
    }
  }

// EDITING MY PLAYLISTS

const loadedMyPlaylist = (
  model: Model,
  playlistId: string,
): Option.Option<MyPlaylistDetails> =>
  AsyncData.getData(myPlaylistQuery.read(model.myPlaylists, { playlistId }))

const startEditing =
  (playlistId: string): UpdateStep =>
  model => ({
    model: Option.match(loadedMyPlaylist(model, playlistId), {
      onNone: () => model,
      onSome: ({ playlist }) =>
        modifyFields(model, {
          playlistEditor: () =>
            PlaylistEditor.Editing({
              playlistId,
              titleInput: playlist.title,
              descriptionInput: Option.getOrElse(
                playlist.maybeDescription,
                () => '',
              ),
            }),
        }),
    }),
  })

const mapEditor = (
  model: Model,
  change: (editor: typeof PlaylistEditor.Editing.Type) => PlaylistEditor,
): Model =>
  modifyFields(model, {
    playlistEditor: editor =>
      editor._tag === 'Editing' ? change(editor) : editor,
  })

/** Sends several edits at once, each shown before the server confirms it. */
const editPlaylistsAll =
  (edits: ReadonlyArray<PlaylistEdit>): UpdateStep =>
  model => ({
    model: Array.reduce(edits, model, showEditEarly),
    commands: Array.map(edits, edit => EditPlaylists({ edit })),
  })

/**
 * Done saves a new title, unless it was emptied, and a changed description.
 * Everything else was saved as it happened.
 */
const finishEditing: UpdateStep = model =>
  PlaylistEditor.match(model.playlistEditor, {
    Closed: (): UpdateReturn => ({ model }),
    Editing: ({ playlistId, titleInput, descriptionInput }): UpdateReturn => {
      const edits = Option.match(loadedMyPlaylist(model, playlistId), {
        onNone: (): ReadonlyArray<PlaylistEdit> => [],
        onSome: ({ playlist }): ReadonlyArray<PlaylistEdit> => {
          const title = titleInput.trim()
          const description = descriptionInput.trim()
          const rename: ReadonlyArray<PlaylistEdit> =
            String.isNonEmpty(title) && title !== playlist.title
              ? [{ _tag: 'Rename', playlistId, title }]
              : []
          const describe: ReadonlyArray<PlaylistEdit> =
            description !==
            Option.getOrElse(playlist.maybeDescription, () => '')
              ? [{ _tag: 'SetDescription', playlistId, description }]
              : []
          return [...rename, ...describe]
        },
      })
      return editPlaylistsAll(edits)(
        modifyFields(model, { playlistEditor: () => PlaylistEditor.Closed() }),
      )
    },
  })

/** Leaving the page of the playlist being edited stops editing it. */
const closeEditorOffPage: UpdateStep = model =>
  model.playlistEditor._tag === 'Editing' &&
  !(
    model.route._tag === 'MyPlaylist' &&
    model.route.playlistId === model.playlistEditor.playlistId
  )
    ? {
        model: modifyFields(model, {
          playlistEditor: () => PlaylistEditor.Closed(),
        }),
      }
    : { model }

const isInPlaylist = (
  model: Model,
  playlistId: string,
  videoId: string,
): boolean =>
  Option.exists(loadedMyPlaylist(model, playlistId), ({ songs }) =>
    Array.some(songs, song => song.videoId === videoId),
  )

// ROUTE LOADING

/**
 * Top shows a little of every catalog, so it asks all of them at once, and
 * picking another kind afterwards shows its results at once.
 */
const loadSearch = (query: string, kind: SearchKind): UpdateStep =>
  Match.value(kind).pipe(
    Match.withReturnType<UpdateStep>(),
    Match.when('Top', () =>
      Update.combine([
        model => songSearch.loadIfMissing(model, { query }),
        model => topResultSearch.loadIfMissing(model, { query }),
        model => artistSearch.loadIfMissing(model, { query }),
        model => albumSearch.loadIfMissing(model, { query }),
        model => playlistSearch.loadIfMissing(model, { query }),
      ]),
    ),
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
    Match.when('Top', () =>
      Update.combine([
        model => songSearch.revalidateOrLoad(model, { query }),
        model => topResultSearch.revalidateOrLoad(model, { query }),
        model => artistSearch.revalidateOrLoad(model, { query }),
        model => albumSearch.revalidateOrLoad(model, { query }),
        model => playlistSearch.revalidateOrLoad(model, { query }),
      ]),
    ),
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

/**
 * Home shows the play history, my playlists, Liked songs, and what the
 * artists I follow released lately, so it checks each for changes.
 */
const loadHome: UpdateStep = Update.combine([
  model => home.revalidateOrLoad(model),
  model => newReleases.revalidateOrLoad(model),
  model => myLibrary.revalidateOrLoad(model),
  model =>
    myPlaylists.revalidateOrLoad(model, { playlistId: LIKED_PLAYLIST_ID }),
])

/** The Library lists my playlists, and searches and lists their songs. */
const loadLibrary: UpdateStep = Update.combine([
  model => myLibrary.revalidateOrLoad(model),
  model => librarySongs.revalidateOrLoad(model),
])

/**
 * The artist's playlist of every song, most played first, once their page
 * has loaded, so Play and Shuffle queue all of it and not only the few top
 * songs the page lists.
 */
const loadArtistSongs: UpdateStep = model =>
  AppRoute.matchOrElse(
    model.route,
    {
      Artist: ({ artistId }) =>
        pipe(
          AsyncData.getData(artistQuery.read(model.artists, { artistId })),
          Option.flatMap(details => details.maybeAllSongsPlaylistId),
          Option.match({
            onNone: () => ({ model }),
            onSome: playlistId =>
              playlists.loadIfMissing(model, { playlistId }),
          }),
        ),
    },
    () => ({ model }),
  )

const loadRoute = (route: AppRoute): UpdateStep =>
  AppRoute.match<UpdateStep>(route, {
    Home: () => loadHome,
    Search: () =>
      Option.match(routeQuery(route), {
        onNone: () => model => moodGroups.loadIfMissing(model),
        onSome: query => loadSearch(query, routeSearchKind(route)),
      }),
    Library: () => loadLibrary,
    Song:
      ({ videoId }) =>
      model =>
        songs.loadIfMissing(model, { videoId }),
    Artist: ({ artistId }) =>
      Update.combine([
        model => artists.loadIfMissing(model, { artistId }),
        loadArtistSongs,
      ]),
    ArtistAlbums:
      ({ artistId }) =>
      model =>
        artists.loadIfMissing(model, { artistId }),
    ArtistSingles:
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
    Mood:
      ({ params }) =>
      model =>
        moods.loadIfMissing(model, { params }),
    Account: () => AccountUpdate.loadAccount,
    NotFound: () => model => ({ model }),
  })

const retryRoute = (route: AppRoute): UpdateStep =>
  AppRoute.match<UpdateStep>(route, {
    Home: () => loadHome,
    Search: () =>
      Option.match(routeQuery(route), {
        onNone: () => model => moodGroups.revalidateOrLoad(model),
        onSome: query => revalidateSearch(query, routeSearchKind(route)),
      }),
    Library: () => loadLibrary,
    Song:
      ({ videoId }) =>
      model =>
        songs.revalidateOrLoad(model, { videoId }),
    Artist:
      ({ artistId }) =>
      model =>
        artists.revalidateOrLoad(model, { artistId }),
    ArtistAlbums:
      ({ artistId }) =>
      model =>
        artists.revalidateOrLoad(model, { artistId }),
    ArtistSingles:
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
    Mood:
      ({ params }) =>
      model =>
        moods.revalidateOrLoad(model, { params }),
    Account: () => AccountUpdate.loadAccount,
    NotFound: () => model => ({ model }),
  })

// INIT

/** The Model for a first visit to `route`, before anything has loaded. */
export const initialModel = (route: AppRoute, path: string): Model => {
  const activeTab = openingTab(route)
  const navigation = initialNavigationModel(activeTab)
  return syncSearchInput({
    route,
    navigation: modifyFields(navigation, {
      tabUrls: tabUrls => withTabUrl(tabUrls, activeTab, path),
    }),
    searchInput: '',
    maybeEarlierSearch: Option.none(),
    shownTopShelves: { query: '', count: 0 },
    recentSearches: [],
    suggestionList: SuggestionList.Hidden(),
    searchSuggestions: searchSuggestionsQuery.init(),
    recentlyViewed: [],
    libraryFilter: 'All',
    libraryPrefs: DEFAULT_LIBRARY_PREFS,
    librarySearchInput: '',
    playlistEditor: PlaylistEditor.Closed(),
    addSongsSearch: { input: '', query: '' },
    songSearch: songSearchQuery.init(),
    artistSearch: artistSearchQuery.init(),
    albumSearch: albumSearchQuery.init(),
    playlistSearch: playlistSearchQuery.init(),
    topResultSearch: topResultSearchQuery.init(),
    moodGroups: moodGroupsQuery.init(),
    moods: moodQuery.init(),
    songs: songQuery.init(),
    artists: artistQuery.init(),
    albums: albumQuery.init(),
    playlists: playlistQuery.init(),
    myLibrary: myLibraryQuery.init(),
    librarySongs: librarySongsQuery.init(),
    myPlaylists: myPlaylistQuery.init(),
    home: homeQuery.init(),
    newReleases: newReleasesQuery.init(),
    songRadios: songRadioQuery.init(),
    artworkBackdrops: artworkBackdropQuery.init(),
    playlistTitleInput: '',
    actionSheet: ActionSheet.Hidden(),
    playerPanel: 'Artwork',
    maybeLyricsRetriedVideoId: Option.none(),
    downloads: Downloads.Loading(),
    viewer: viewerQuery.init(),
    people: peopleQuery.init(),
    account: initialAccountPage(),
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
    LoadDownloads(),
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
    return Update.combine([
      loadRoute(route),
      rememberViewed,
      keepEarlierSearch(model),
      closeEditorOffPage,
    ])(
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
            hideSuggestions,
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
          hideSuggestions,
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

    UpdatedSearchInput: ({ value }) =>
      Update.combine([
        stepModel => ({
          model: stepModel,
          commands: [WaitBeforeSearch({ query: value })],
        }),
        typeInSearch(value),
      ])(model),

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
            hideSuggestions,
            stepModel => ({ model: stepModel, commands: [BlurSearchInput()] }),
          ])(model)
        : { model }
    },

    ClickedClearSearch: () =>
      Update.combine([
        replaceSearch('', routeSearchKind(model.route)),
        hideSuggestions,
        stepModel => ({
          model: modifyFields(stepModel, { searchInput: () => '' }),
          commands: [FocusSearchInput()],
        }),
      ])(model),

    SelectedSearchKind: ({ kind }) =>
      Update.combine([
        replaceSearch(model.searchInput.trim(), kind),
        hideSuggestions,
      ])(model),

    ClickedRecentSearch: ({ query }) => searchFor(query)(model),

    ClickedSearchSuggestion: ({ query }) =>
      Update.combine([
        searchFor(query),
        stepModel => ({ model: stepModel, commands: [BlurSearchInput()] }),
      ])(model),

    ClickedClearRecentSearches: () => ({
      model: modifyFields(model, { recentSearches: () => [] }),
      commands: [SaveRecentSearches({ recentSearches: [] })],
    }),

    ClickedBack: () => goBack(model),

    ClickedRetry: () => retryRoute(model.route)(model),

    CompletedLoadRecentSearches: ({ recentSearches }) => ({
      model: modifyFields(model, { recentSearches: () => recentSearches }),
    }),

    CompletedLoadLibrary: ({ recentlyViewed, maybePrefs }) => ({
      model: modifyFields(model, {
        recentlyViewed: newer =>
          Array.reduceRight(newer, recentlyViewed, (items, item) =>
            rememberFirst(items, item, isSameLibraryItem, MAX_RECENTLY_VIEWED),
          ),
        libraryPrefs: prefs => Option.getOrElse(maybePrefs, () => prefs),
      }),
    }),
    CompletedSaveLibraryPrefs: () => ({ model }),

    ClickedClearRecentlyViewed: () =>
      showSheet({ _tag: 'ConfirmClearRecentlyViewed' })(model),

    ConfirmedClearRecentlyViewed: () =>
      Update.combine([
        dismissSheet,
        stepModel => ({
          model: modifyFields(stepModel, { recentlyViewed: () => [] }),
          commands: [SaveRecentlyViewed({ recentlyViewed: [] })],
        }),
      ])(model),

    SelectedLibraryFilter: ({ filter }) => ({
      model: modifyFields(model, { libraryFilter: () => filter }),
    }),
    UpdatedLibrarySearchInput: ({ value }) => ({
      model: modifyFields(model, { librarySearchInput: () => value }),
    }),
    ClickedClearLibrarySearch: () => ({
      model: modifyFields(model, { librarySearchInput: () => '' }),
    }),
    ClickedLibrarySort: ({ kind }) =>
      showSheet({ _tag: 'LibrarySort', kind })(model),
    SelectedLibrarySort: ({ kind, sort }) =>
      Update.combine([
        dismissSheet,
        changeLibraryPrefs(prefs => ({
          ...prefs,
          sorts: { ...prefs.sorts, [kind]: sort },
        })),
      ])(model),
    ClickedToggleLibraryLayout: ({ kind }) =>
      changeLibraryPrefs(prefs => ({
        ...prefs,
        layouts: {
          ...prefs.layouts,
          [kind]: prefs.layouts[kind] === 'List' ? 'Grid' : 'List',
        },
      }))(model),

    GotSongSearchMessage: ({ message }) => songSearch.fold(model, message),
    GotArtistSearchMessage: ({ message }) => artistSearch.fold(model, message),
    GotAlbumSearchMessage: ({ message }) => albumSearch.fold(model, message),
    GotSongMessage: ({ message }) =>
      Update.combine([
        stepModel => songs.fold(stepModel, message),
        retryFailedLyricsOnce,
      ])(model),
    GotTopResultSearchMessage: ({ message }) =>
      topResultSearch.fold(model, message),
    GotSearchSuggestionsMessage: ({ message }) =>
      searchSuggestions.fold(model, message),
    GotMoodGroupsMessage: ({ message }) => moodGroups.fold(model, message),
    GotMoodMessage: ({ message }) => moods.fold(model, message),
    GotArtworkBackdropMessage: ({ message }) =>
      artworkBackdrops.fold(model, message),
    GotArtistMessage: ({ message }) =>
      Update.combine([
        stepModel => artists.fold(stepModel, message),
        rememberViewed,
        loadArtistSongs,
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
    GotLibrarySongsMessage: ({ message }) => librarySongs.fold(model, message),
    GotMyPlaylistMessage: ({ message }) => myPlaylists.fold(model, message),
    GotHomeMessage: ({ message }) =>
      Update.combine([stepModel => home.fold(stepModel, message), loadRadio])(
        model,
      ),
    GotNewReleasesMessage: ({ message }) => newReleases.fold(model, message),
    GotSongRadioMessage: ({ message }) => songRadios.fold(model, message),

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
    ClickedToggleAlbumSaved: ({ album }) =>
      Update.combine([
        dismissSheet,
        editPlaylists({
          _tag: 'SetAlbumSaved',
          album,
          isSaved: !Option.exists(loadedLibrary(model), library =>
            isAlbumSaved(library, album.id),
          ),
        }),
      ])(model),
    ClickedToggleArtistFollowed: ({ artist }) =>
      editPlaylists({
        _tag: 'SetArtistFollowed',
        artist,
        isFollowed: !Option.exists(loadedLibrary(model), library =>
          isArtistFollowed(library, artist.id),
        ),
      })(model),
    ClickedRemoveFromPlaylist: ({ playlistId, videoId }) =>
      Update.combine([
        dismissSheet,
        editPlaylists({ _tag: 'RemoveSong', playlistId, videoId }),
      ])(model),
    ClickedPlaylistActions: ({ playlistId, title }) =>
      showSheet({ _tag: 'PlaylistActions', playlistId, title })(model),
    ClickedCollectionActions: ({ kind, id }) =>
      showSheet({ _tag: 'CollectionActions', kind, id })(model),
    ClickedShare: ({ title, href }) =>
      Update.combine([
        dismissSheet,
        (stepModel: Model) => ({
          model: stepModel,
          commands: [ShareLink({ title, href })],
        }),
      ])(model),
    CompletedShareLink: ({ isCopied }) =>
      isCopied ? Playback.receiveNotice(model, 'Link copied') : { model },
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
    ClickedEditPlaylist: ({ playlistId }) =>
      Update.combine([dismissSheet, startEditing(playlistId)])(model),
    UpdatedPlaylistEditorTitle: ({ value }) => ({
      model: mapEditor(model, editor =>
        PlaylistEditor.Editing({ ...editor, titleInput: value }),
      ),
    }),
    UpdatedPlaylistEditorDescription: ({ value }) => ({
      model: mapEditor(model, editor =>
        PlaylistEditor.Editing({ ...editor, descriptionInput: value }),
      ),
    }),
    ClickedDoneEditingPlaylist: () => finishEditing(model),
    CompletedFollowPlaylistDrags: () => ({ model }),
    DraggedPlaylistSong: ({ playlistId, videoId, maybeBeforeVideoId }) =>
      editPlaylists({
        _tag: 'MoveSong',
        playlistId,
        videoId,
        maybeBeforeVideoId,
      })(model),
    ClickedAddSongs: ({ playlistId }) =>
      Update.combine([
        showSheet({ _tag: 'AddSongs', playlistId }),
        stepModel => ({
          model: modifyFields(stepModel, {
            addSongsSearch: () => ({ input: '', query: '' }),
          }),
          commands: [FocusAddSongsInput()],
        }),
        stepModel => home.loadIfMissing(stepModel),
      ])(model),
    CompletedFocusAddSongsInput: () => ({ model }),
    UpdatedAddSongsInput: ({ value }) => ({
      model: modifyFields(model, {
        addSongsSearch: search => modifyFields(search, { input: () => value }),
      }),
      commands: [WaitBeforeAddSongsSearch({ query: value })],
    }),
    CompletedWaitBeforeAddSongsSearch: ({ query }) => {
      const trimmedQuery = query.trim()
      if (query !== model.addSongsSearch.input) {
        return { model }
      }
      const searched = modifyFields(model, {
        addSongsSearch: search =>
          modifyFields(search, { query: () => trimmedQuery }),
      })
      return String.isNonEmpty(trimmedQuery)
        ? songSearch.loadIfMissing(searched, { query: trimmedQuery })
        : { model: searched }
    },
    ClickedToggleSongInPlaylist: ({ playlistId, song }) =>
      editPlaylists(
        isInPlaylist(model, playlistId, song.videoId)
          ? { _tag: 'RemoveSong', playlistId, videoId: song.videoId }
          : { _tag: 'AddSongs', playlistId, songs: [song] },
      )(model),
    ClickedChoosePlaylistCover: ({ playlistId }) =>
      showSheet({ _tag: 'ChoosePlaylistCover', playlistId })(model),
    SelectedPlaylistCover: ({ playlistId, maybeVideoId }) =>
      Update.combine([
        dismissSheet,
        editPlaylists({ _tag: 'SetCover', playlistId, maybeVideoId }),
      ])(model),
    CompletedEditPlaylists: ({ edit, result }) =>
      completeEditPlaylists(edit, result)(model),

    CompletedLoadExternal: () => ({ model }),
    CompletedNavigateBack: () => ({ model }),
    CompletedNavigateBackTo: () => ({ model }),
    CompletedReplaceSearchUrl: () => ({ model }),
    CompletedScrollToTop: () => ({ model }),
    CompletedScrollSearchResultsToTop: () => ({ model }),
    CompletedSyncTitleBarReveal: () => ({ model }),
    CompletedSyncMarquee: () => ({ model }),
    CompletedRestoreScroll: () => ({ model }),
    CompletedWaitBeforeTopShelves: ({ query, count }) => ({
      model: modifyFields(model, { shownTopShelves: () => ({ query, count }) }),
    }),
    CompletedFollowSheetDrags: () => ({ model }),
    CompletedTakeOverScrollRestoration: () => ({ model }),
    CompletedFocusSearchInput: () => ({ model }),
    CompletedBlurSearchInput: () => ({ model }),
    CompletedLockScroll: () => ({ model }),
    CompletedUnlockScroll: () => ({ model }),
    CompletedSaveRecentSearches: () => ({ model }),
    CompletedSaveRecentlyViewed: () => ({ model }),

    ClickedSongActions: ({ song }) =>
      showSheet({ _tag: 'SongActions', song })(model),
    ClickedDevices: () => showSheet({ _tag: 'Devices' })(model),
    ClickedSleepTimer: () => showSheet({ _tag: 'SleepTimer' })(model),

    ClickedDownload: ({ collection, copy }) =>
      Update.combine([
        dismissSheet,
        stepModel => DownloadsUpdate.startDownload(stepModel, collection, copy),
      ])(model),
    ClickedRemoveDownload: ({ kind, id, title }) =>
      showSheet({ _tag: 'ConfirmRemoveDownload', kind, id, title })(model),
    ConfirmedRemoveDownload: ({ kind, id }) =>
      Update.combine([
        dismissSheet,
        stepModel => DownloadsUpdate.removeDownload(stepModel, kind, id),
      ])(model),
    SucceededLoadDownloads: ({
      collections,
      savedBytes,
      copies,
      maybeStorage,
    }) =>
      DownloadsUpdate.succeedLoadDownloads(
        model,
        collections,
        savedBytes,
        copies,
        maybeStorage,
      ),
    FailedLoadDownloads: () => DownloadsUpdate.failLoadDownloads(model),
    CompletedSaveDownloads: () => ({ model }),
    CompletedSaveOfflineCopy: () => ({ model }),
    SucceededFetchOfflineCopy: ({ copy }) =>
      DownloadsUpdate.succeedFetchOfflineCopy(model, copy),
    FailedFetchOfflineCopy: () => ({ model }),
    CompletedRemoveOfflineCopy: () => ({ model }),
    SucceededDownloadSong: ({ videoId, bytes, maybeStorage }) =>
      DownloadsUpdate.succeedDownloadSong(model, videoId, bytes, maybeStorage),
    FailedDownloadSong: ({ videoId, failure, maybeStorage }) =>
      DownloadsUpdate.failDownloadSong(model, videoId, failure, maybeStorage),
    CompletedRemoveDownloadedSongs: ({ maybeStorage }) =>
      DownloadsUpdate.completeRemoveDownloadedSongs(model, maybeStorage),
    SelectedSleepTimer: ({ timer }) =>
      Update.combine([
        dismissSheet,
        stepModel => Playback.setSleepTimer(stepModel, timer),
      ])(model),
    ClickedCloseSheet: () => dismissSheet(model),
    SwipedDownSheet: () => dismissSheet(model),
    SwipedDownPlayer: () => closePlayer(model),
    SelectedPlayerPanel: ({ panel }) => selectPlayerPanel(panel)(model),

    ClickedShuffleSongs: ({ songs: songsToShuffle, maybePlayingFrom }) => ({
      model,
      commands: [
        ...Playback.unlockIfIdle(model),
        ShuffleSongs({ songs: songsToShuffle, maybePlayingFrom }),
      ],
    }),
    CompletedShuffleSongs: ({ songs, startIndex, maybePlayingFrom }) =>
      Playback.playSongs(
        model,
        songs,
        startIndex,
        maybePlayingFrom,
        'Shuffled',
      ),
    ClickedPlayInOrder: ({ songs: songsToPlay, maybePlayingFrom }) =>
      Playback.clickPlaySongs(
        model,
        songsToPlay,
        0,
        maybePlayingFrom,
        'InOrder',
      ),

    CompletedLoadDeviceIdentity: ({ deviceId, deviceName }) =>
      Playback.completeLoadDeviceIdentity(model, deviceId, deviceName),
    AcquiredSessionSocket: () => Playback.acquireSessionSocket(model),
    ReleasedSessionSocket: () => ({ model }),
    FailedConnectSessionSocket: () => Playback.loseSessionSocket(model),
    ClosedSessionSocket: () => Playback.closeSessionSocket(model),
    CompletedWaitBeforeReconnect: () =>
      Playback.completeWaitBeforeReconnect(model),
    HidPage: ({ at }) => Playback.hidePage(model, at),
    ShowedPage: ({ at }) => Playback.returnToPage(model, at),
    CompletedMarkSocketOpened: ({ at }) => Playback.markSocketOpened(model, at),
    CompletedReportResync: () => ({ model }),
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
    CompletedSendHandOver: () => ({ model }),
    SentLocalChange: ({ maybeSeq }) =>
      Playback.completeSendLocalChange(model, maybeSeq),
    CompletedWaitBeforeHideNotice: ({ message }) =>
      Playback.completeWaitBeforeHideNotice(model, message),
    ClickedDismissNotice: () => ({
      model: modifyFields(model, { maybeNotice: () => Option.none() }),
    }),
    TickedClock: ({ now }) => Playback.tickClock(model, now),

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

    ClickedPlaySongs: ({ songs: songsToPlay, startIndex, maybePlayingFrom }) =>
      Update.combine([
        rememberPlayedSearch(maybePlayingFrom),
        stepModel =>
          Playback.clickPlaySongs(
            stepModel,
            songsToPlay,
            startIndex,
            maybePlayingFrom,
          ),
      ])(model),
    ClickedStartRadio: ({ song }) =>
      Update.combine([
        dismissSheet,
        stepModel => Playback.startRadio(stepModel, song),
      ])(model),
    ClickedStartStationRadio: ({ station, title }) =>
      Update.combine([
        dismissSheet,
        (stepModel: Model) => ({
          model: stepModel,
          commands: [
            ...Playback.unlockIfIdle(stepModel),
            FetchRadio({
              station,
              playingFrom: { kind: 'Radio', title, id: station.playlistId },
            }),
          ],
        }),
      ])(model),
    SucceededFetchRadio: ({ songs: radioSongs, playingFrom }) =>
      Playback.playStationRadio(model, radioSongs, playingFrom),
    FailedFetchRadio: () =>
      Playback.receiveNotice(model, "Couldn't start the radio. Try again."),
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
    CompletedFollowLyrics: () => ({ model }),
    ClickedLyricLine: ({ seconds }) => Playback.seekTo(model, seconds),
    ClickedRetryLyrics: () => loadLyricsIfShown(model),
    CompletedWaitBeforeRetryLyrics: ({ videoId }) =>
      completeWaitBeforeRetryLyrics(videoId)(model),
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
    ClickedWakeDevice: ({ deviceId }) =>
      Playback.sendCommand(model, { _tag: 'Wake', deviceId }),
    ClickedQueueEntry: ({ entryId }) =>
      followingCurrentSong(stepModel =>
        Playback.clickQueueEntry(stepModel, entryId),
      )(model),
    CompletedFollowQueueDrags: () => ({ model }),
    DraggedQueueEntry: ({ entryId, maybeBeforeEntryId }) =>
      Playback.moveQueueEntry(model, entryId, maybeBeforeEntryId),
    SentQueueMove: ({ entryId, maybeSeq }) =>
      Playback.completeSendQueueMove(model, entryId, maybeSeq),
    ClickedClearUpcoming: () => Playback.clearUpcoming(model),
    SentQueueClear: ({ maybeSeq }) =>
      Playback.completeSendQueueClear(model, maybeSeq),
    ClickedToggleAutoplay: () =>
      Option.match(model.maybeSession, {
        onNone: () => ({ model }),
        onSome: ({ state }) =>
          Playback.sendCommand(model, {
            _tag: 'SetAutoplay',
            enabled: !state.autoplay,
          }),
      }),
    // NOTE: the sheet stays open, so the switch shows the server's answer.
    ClickedToggleSoundCheck: () =>
      Option.match(model.maybeSession, {
        onNone: () => ({ model }),
        onSome: ({ state }) =>
          Playback.sendCommand(model, {
            _tag: 'SetSoundCheck',
            enabled: !state.soundCheck,
          }),
      }),
    ClickedToggleShuffle: () =>
      Option.match(model.maybeSession, {
        onNone: () => ({ model }),
        onSome: ({ state }) => Playback.setShuffle(model, !state.shuffle),
      }),
    ClickedCycleRepeat: () =>
      Option.match(model.maybeSession, {
        onNone: () => ({ model }),
        onSome: ({ state }) =>
          Playback.sendCommand(model, {
            _tag: 'SetRepeat',
            mode: nextRepeatMode(state.repeat),
          }),
      }),
    ClickedOpenPlayer: () => Playback.openPlayer(model),
    ClickedClosePlayer: () => closePlayer(model),
    ClickedStartBlockedAudio: () => Playback.startBlockedAudio(model),

    GotViewerMessage: ({ message }) =>
      AccountUpdate.gotViewerMessage(message)(model),
    GotPeopleMessage: ({ message }) =>
      AccountUpdate.people.fold(model, message),
    ClickedSignIn: () => ({
      model,
      commands: [LoadExternal({ href: SIGN_IN_PATH })],
    }),
    UpdatedPasswordField: ({ field, value }) =>
      AccountUpdate.updatePasswordField(model, field, value),
    SubmittedChangePassword: () => AccountUpdate.submitChangePassword(model),
    SucceededChangePassword: () => AccountUpdate.succeedChangePassword(model),
    FailedChangePassword: ({ failure }) =>
      AccountUpdate.failChangePassword(model, failure),
    ClickedInviteSomeone: () =>
      Update.combine([
        showSheet({ _tag: 'NewInvite' }),
        AccountUpdate.startNewInvite,
      ])(model),
    UpdatedInviteName: ({ name }) =>
      AccountUpdate.updateInviteName(model, name),
    SelectedInviteRole: ({ role }) =>
      AccountUpdate.selectInviteRole(model, role),
    SubmittedNewInvite: () => AccountUpdate.createInvite(model),
    SucceededCreateInvite: ({ created }) =>
      Update.combine([
        (stepModel: Model) =>
          AccountUpdate.succeedCreateInvite(stepModel, created),
        showSheet({
          _tag: 'InviteLink',
          inviteId: created.invite.id,
          isNew: true,
        }),
      ])(model),
    FailedCreateInvite: ({ failure }) =>
      AccountUpdate.failCreateInvite(model, failure),
    ClickedPendingInvite: ({ inviteId }) =>
      showSheet({ _tag: 'InviteLink', inviteId, isNew: false })(model),
    ClickedCopyInviteLink: ({ link }) =>
      AccountUpdate.copyInviteLink(model, link),
    CompletedCopyInviteLink: ({ isCopied }) =>
      AccountUpdate.completeCopyInviteLink(model, isCopied),
    ClickedRevokeInvite: ({ inviteId }) =>
      Update.combine([
        dismissSheet,
        stepModel =>
          AccountUpdate.changePeople(stepModel, {
            _tag: 'RevokeInvite',
            inviteId,
          }),
      ])(model),
    ClickedPersonActions: ({ person }) =>
      showSheet({ _tag: 'PersonActions', person })(model),
    ClickedSetRole: ({ userId, role }) =>
      Update.combine([
        dismissSheet,
        stepModel =>
          AccountUpdate.changePeople(stepModel, {
            _tag: 'SetRole',
            userId,
            role,
          }),
      ])(model),
    ClickedResetPassword: ({ userId, username }) =>
      Update.combine([
        showSheet({ _tag: 'ResetPassword', userId, username }),
        AccountUpdate.startResetPassword,
      ])(model),
    UpdatedResetPasswordInput: ({ value }) =>
      AccountUpdate.updateResetPasswordInput(model, value),
    SubmittedResetPassword: ({ userId, username }) =>
      Option.match(AccountUpdate.resetPasswordProblem(model), {
        onSome: problem => AccountUpdate.rejectResetPassword(model, problem),
        onNone: () =>
          Update.combine([
            stepModel =>
              AccountUpdate.resetPassword(stepModel, userId, username),
            dismissSheet,
          ])(model),
      }),
    CompletedFocusResetPasswordInput: () => ({ model }),
    SucceededResetPassword: ({ username }) =>
      AccountUpdate.succeedResetPassword(model, username),
    FailedResetPassword: ({ failure }) =>
      AccountUpdate.failResetPassword(model, failure),
    ClickedRemovePerson: ({ userId, username }) =>
      showSheet({ _tag: 'ConfirmRemovePerson', userId, username })(model),
    ConfirmedRemovePerson: ({ userId }) =>
      Update.combine([
        dismissSheet,
        stepModel =>
          AccountUpdate.changePeople(stepModel, {
            _tag: 'RemovePerson',
            userId,
          }),
      ])(model),
    CompletedChangePeople: ({ result }) =>
      AccountUpdate.completeChangePeople(model, result),

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
