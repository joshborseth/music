import { Array, Match, Option, Record, String, pipe } from 'effect'
import { AsyncData, Runtime, Update, Url } from 'foldkit'
import { UrlRequest } from 'foldkit/navigation'
import { modifyFields } from 'foldkit/struct'

import {
  BlurSearchInput,
  FocusSearchInput,
  LoadExternal,
  LoadLibrary,
  LoadRecentSearches,
  LockScroll,
  NavigateBack,
  NavigateInternal,
  ReplaceSearchUrl,
  SaveRecentSearches,
  SaveRecentlyPlayed,
  SaveRecentlyViewed,
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
  type NavigationKind,
  type TabUrls,
  initialNavigationModel,
} from './navigation'
import { LoadDeviceIdentity } from './playback/command'
import { currentEntry, initialPlaybackModel } from './playback/domain'
import type { PlaybackServices } from './playback/resource'
import * as Playback from './playback/update'
import {
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  homeQuery,
  playlistQuery,
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
import { artistNames, artworkUrl, joinDetails } from './view/shared'

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
    commands: [ReplaceSearchUrl({ url: searchUrl(query, kind) })],
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
    Home: () => model => home.loadIfMissing(model),
    Search: () =>
      Option.match(routeQuery(route), {
        onNone: () => model => ({ model }),
        onSome: query => loadSearch(query, routeSearchKind(route)),
      }),
    Library: () => model => ({ model }),
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
    Library: () => model => ({ model }),
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
    songs: songQuery.init(),
    artists: artistQuery.init(),
    albums: albumQuery.init(),
    playlists: playlistQuery.init(),
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
  return Update.combine([loadRoute(route), loadStoredState])(
    initialModel(route, urlPath(url)),
  )
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
    const activeTab = Option.getOrElse(
      routeTab(route),
      () => model.navigation.activeTab,
    )
    const navigation = modifyFields(model.navigation, {
      activeTab: () => activeTab,
      tabUrls: tabUrls => withTabUrl(tabUrls, activeTab, path),
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

export const update = (model: Model, message: Message) =>
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

    ClickedBack: () => ({ model, commands: [NavigateBack()] }),

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

    CompletedLoadExternal: () => ({ model }),
    CompletedNavigateBack: () => ({ model }),
    CompletedReplaceSearchUrl: () => ({ model }),
    CompletedScrollToTop: () => ({ model }),
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
    ReceivedSessionState: ({ state, serverNow, receivedAt }) =>
      Update.combine([
        stepModel =>
          Playback.receiveSessionState(stepModel, state, serverNow, receivedAt),
        rememberPlayed(currentVideoId(model)),
        loadLyricsIfShown,
      ])(model),
    ReceivedSessionNotice: ({ message }) =>
      Playback.receiveNotice(model, message),
    CompletedSendToSession: () => ({ model }),
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
    CompletedLoadPhoneAudio: ({ isBlocked }) =>
      Playback.completeStartPhoneAudio(model, isBlocked),
    CompletedSetPhoneAudioPlaying: ({ isBlocked }) =>
      Playback.completeStartPhoneAudio(model, isBlocked),
    CompletedStopPhoneAudio: () => ({ model }),
    CompletedUpdateMediaSession: () => ({ model }),
    UpdatedPhoneAudioTime: ({ seconds, at }) =>
      Playback.updatePhoneAudioTime(model, seconds, at),
    EndedPhoneAudio: () => Playback.endPhoneAudio(model),
    FailedPhoneAudio: ({ error }) => Playback.failPhoneAudio(model, error),
    PressedMediaKey: ({ key }) => Playback.pressMediaKey(model, key),

    ClickedPlaySongs: ({ songs: songsToPlay, startIndex }) =>
      Playback.clickPlaySongs(model, songsToPlay, startIndex),
    ClickedEnqueueSongs: ({ songs: songsToEnqueue, placement }) =>
      Update.combine([
        dismissSheet,
        stepModel =>
          Playback.clickEnqueueSongs(stepModel, songsToEnqueue, placement),
      ])(model),
    ClickedTogglePlayback: () => Playback.clickTogglePlayback(model),
    ClickedNextTrack: () => Playback.sendCommand(model, { _tag: 'Next' }),
    ClickedPreviousTrack: () =>
      Playback.sendCommand(model, { _tag: 'Previous' }),
    ChangedSeekPosition: ({ seconds }) => Playback.seekTo(model, seconds),
    UpdatedScrubPosition: ({ seconds }) => Playback.scrub(model, seconds),
    CancelledScrub: () => Playback.cancelScrub(model),
    CompletedFollowSeekBarDrags: () => ({ model }),
    ClickedSkipBy: ({ seconds }) => Playback.skipBy(model, seconds),
    ChangedPhoneAudioBuffering: ({ isBuffering }) =>
      Playback.changePhoneAudioBuffering(model, isBuffering),
    CompletedSeekPhoneAudio: () => ({ model }),
    CompletedPrefetchSongs: () => ({ model }),
    ClickedDevice: ({ deviceId }) =>
      Update.combine([
        dismissSheet,
        stepModel => Playback.clickDevice(stepModel, deviceId),
      ])(model),
    ClickedQueueEntry: ({ entryId }) =>
      Playback.sendCommand(model, { _tag: 'SkipTo', entryId }),
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
      Playback.releaseSwipePointer(model, pointerId, timeStamp),
    CancelledSwipePointer: ({ pointerId }) =>
      Playback.cancelSwipePointer(model, pointerId),
  })
