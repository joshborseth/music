import { Option, Result } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { fromString } from 'foldkit/url'
import { describe, expect, test } from 'vitest'

import { LIKED_PLAYLIST_ID, Session, type Song } from '@music/shared'

import {
  BlurSearchInput,
  FocusSearchInput,
  LockScroll,
  NavigateBack,
  NavigateBackTo,
  NavigateInternal,
  ReplaceSearchUrl,
  SaveRecentSearches,
  SaveRecentlyViewed,
  ScrollSearchResultsToTop,
  ScrollToTop,
  ShuffleSongs,
  UnlockScroll,
  WaitBeforeRetryLyrics,
  WaitBeforeSearch,
} from './command'
import { MAX_RECENT_SEARCHES } from './constant'
import { Message } from './message'
import { type Model } from './model'
import { SendToSession, UnlockPhoneAudio } from './playback/command'
import { toQueueTrack } from './playback/queueTrack'
import {
  albumQuery,
  albumSearchQuery,
  artistSearchQuery,
  homeQuery,
  myLibraryQuery,
  myPlaylistQuery,
  newReleasesQuery,
  playlistSearchQuery,
  songQuery,
  songRadioQuery,
  songSearchQuery,
  topResultSearchQuery,
} from './query'
import { AppRoute, searchUrl } from './route'
import { initialModel, restoredScrollTop, update } from './update'
import { viewTransition } from './viewTransition'

const FIRST_REQUEST_GENERATION = 1

const resolveLikedSongs = Command.resolve(
  myPlaylistQuery.Fetch,
  myPlaylistQuery.Message.CompletedFetch({
    args: { playlistId: LIKED_PLAYLIST_ID },
    generation: FIRST_REQUEST_GENERATION,
    result: Result.fail('NotFound'),
  }),
)

/** Nothing has played on any device yet. */
const resolveHistory = Command.resolve(
  homeQuery.Fetch,
  homeQuery.Message.CompletedFetch({
    generation: FIRST_REQUEST_GENERATION,
    result: Result.succeed({
      jumpBackIn: [],
      recentlyPlayed: [],
      maybeLastPlayed: Option.none(),
      mixes: [],
    }),
  }),
)

/** The artists I follow have released nothing lately. */
const resolveNewReleases = Command.resolve(
  newReleasesQuery.Fetch,
  newReleasesQuery.Message.CompletedFetch({
    generation: FIRST_REQUEST_GENERATION,
    result: Result.succeed([]),
  }),
)

/**
 * Home loads the play history, my playlists, and Liked songs. With nothing
 * played, it asks YouTube for nothing.
 */
const resolveHome = [
  resolveHistory,
  resolveNewReleases,
  Command.resolve(
    myLibraryQuery.Fetch,
    myLibraryQuery.Message.CompletedFetch({
      generation: FIRST_REQUEST_GENERATION,
      result: Result.succeed({
        playlists: [],
        likedVideoIds: [],
        albums: [],
        artists: [],
        albumPlayedAt: {},
        artistPlayedAt: {},
      }),
    }),
  ),
  resolveLikedSongs,
]

const urlOrThrow = (raw: string) =>
  Option.getOrThrowWith(
    fromString(raw),
    () => new Error(`Failed to parse url: ${raw}`),
  )

/**
 * Top asks every catalog. These answer the artist, album, and playlist
 * searches with nothing, for stories about songs.
 */
const resolveOtherCatalogs = (query: string) => [
  Command.resolve(
    artistSearchQuery.Fetch,
    artistSearchQuery.Message.CompletedFetch({
      args: { query },
      generation: FIRST_REQUEST_GENERATION,
      result: Result.succeed([]),
    }),
  ),
  Command.resolve(
    albumSearchQuery.Fetch,
    albumSearchQuery.Message.CompletedFetch({
      args: { query },
      generation: FIRST_REQUEST_GENERATION,
      result: Result.succeed([]),
    }),
  ),
  Command.resolve(
    playlistSearchQuery.Fetch,
    playlistSearchQuery.Message.CompletedFetch({
      args: { query },
      generation: FIRST_REQUEST_GENERATION,
      result: Result.succeed([]),
    }),
  ),
]

const emptySearchModel: Model = initialModel(
  AppRoute.Search({ q: Option.none(), kind: Option.none() }),
  '/search',
)

const theChain: Song = {
  videoId: 'FhgFtXESdPk',
  title: 'The Chain',
  artists: [
    { maybeId: Option.some('UCCzULu3prrEaPvM2ZtkJlYQ'), name: 'Fleetwood Mac' },
  ],
  maybeAlbum: Option.some({ id: 'MPREb_1SbgcDGdrT4', name: 'Rumours' }),
  maybeDurationSeconds: Option.some(270),
  artwork: [],
}

describe('search route', () => {
  test('omits the default kind and an empty query from the URL', () => {
    expect(searchUrl('', 'Top')).toBe('/search')
    expect(searchUrl('the chain', 'Artists')).toBe(
      '/search?q=the+chain&kind=Artists',
    )
  })

  test('an unknown kind falls back to Top and still searches', () => {
    story(
      update,
      given(emptySearchModel),
      message(
        Message.ChangedUrl({
          url: urlOrThrow('http://localhost/search?q=rumours&kind=Podcasts'),
        }),
      ),
      model(model => {
        expect(model.searchInput).toBe('rumours')
        expect(
          songSearchQuery.read(model.songSearch, { query: 'rumours' })._tag,
        ).toBe('Loading')
      }),
      Command.resolve(
        songSearchQuery.Fetch,
        songSearchQuery.Message.CompletedFetch({
          args: { query: 'rumours' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed([theChain]),
        }),
      ),
      model(model => {
        expect(
          songSearchQuery.read(model.songSearch, { query: 'rumours' })._tag,
        ).toBe('Success')
      }),
      Command.resolve(
        topResultSearchQuery.Fetch,
        topResultSearchQuery.Message.CompletedFetch({
          args: { query: 'rumours' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(Option.none()),
        }),
      ),
      ...resolveOtherCatalogs('rumours'),
    )
  })
})

describe('typing a search', () => {
  test('waits for a pause before searching', () => {
    story(
      update,
      given(emptySearchModel),
      message(Message.UpdatedSearchInput({ value: 'fleetwood' })),
      model(model => {
        expect(model.searchInput).toBe('fleetwood')
      }),
      Command.expectExact(WaitBeforeSearch({ query: 'fleetwood' })),
      Command.resolve(
        WaitBeforeSearch,
        Message.CompletedWaitBeforeSearch({ query: 'fleetwood' }),
      ),
      Command.expectExact(
        ReplaceSearchUrl({ url: '/search?q=fleetwood' }),
        ScrollSearchResultsToTop(),
      ),
      Command.resolve(ReplaceSearchUrl, Message.CompletedReplaceSearchUrl()),
      Command.resolve(
        ScrollSearchResultsToTop,
        Message.CompletedScrollSearchResultsToTop(),
      ),
    )
  })

  test('ignores a pause for text the person has since changed', () => {
    story(
      update,
      given(
        modifyFields(emptySearchModel, { searchInput: () => 'fleetwood mac' }),
      ),
      message(Message.CompletedWaitBeforeSearch({ query: 'fleetwood' })),
      Command.expectNone(),
    )
  })

  test('keeps a trailing space the URL has already trimmed', () => {
    story(
      update,
      given(
        modifyFields(emptySearchModel, { searchInput: () => 'fleetwood ' }),
      ),
      message(
        Message.ChangedUrl({
          url: urlOrThrow('http://localhost/search?q=fleetwood'),
        }),
      ),
      model(model => {
        expect(model.searchInput).toBe('fleetwood ')
      }),
      Command.resolve(
        songSearchQuery.Fetch,
        songSearchQuery.Message.CompletedFetch({
          args: { query: 'fleetwood' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed([]),
        }),
      ),
      Command.resolve(
        topResultSearchQuery.Fetch,
        topResultSearchQuery.Message.CompletedFetch({
          args: { query: 'fleetwood' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(Option.none()),
        }),
      ),
      ...resolveOtherCatalogs('fleetwood'),
    )
  })
})

describe('recent searches', () => {
  test('submitting moves the query to the front without duplicates', () => {
    story(
      update,
      given(
        modifyFields(emptySearchModel, {
          searchInput: () => '  rumours ',
          recentSearches: () => ['tusk', 'rumours'],
        }),
      ),
      message(Message.SubmittedSearch()),
      model(model => {
        expect(model.recentSearches).toStrictEqual(['rumours', 'tusk'])
      }),
      Command.expectExact(
        ReplaceSearchUrl({ url: '/search?q=rumours' }),
        ScrollSearchResultsToTop(),
        SaveRecentSearches({ recentSearches: ['rumours', 'tusk'] }),
        BlurSearchInput(),
      ),
      Command.resolve(ReplaceSearchUrl, Message.CompletedReplaceSearchUrl()),
      Command.resolve(
        ScrollSearchResultsToTop,
        Message.CompletedScrollSearchResultsToTop(),
      ),
      Command.resolve(
        SaveRecentSearches,
        Message.CompletedSaveRecentSearches(),
      ),
      Command.resolve(BlurSearchInput, Message.CompletedBlurSearchInput()),
    )
  })

  test(`keeps only the ${MAX_RECENT_SEARCHES} most recent`, () => {
    const olderSearches = Array.from(
      { length: MAX_RECENT_SEARCHES },
      (_, index) => `search ${index}`,
    )
    story(
      update,
      given(
        modifyFields(emptySearchModel, {
          searchInput: () => 'newest',
          recentSearches: () => olderSearches,
        }),
      ),
      message(Message.SubmittedSearch()),
      model(model => {
        expect(model.recentSearches).toHaveLength(MAX_RECENT_SEARCHES)
        expect(model.recentSearches[0]).toBe('newest')
      }),
      Command.resolve(ReplaceSearchUrl, Message.CompletedReplaceSearchUrl()),
      Command.resolve(
        ScrollSearchResultsToTop,
        Message.CompletedScrollSearchResultsToTop(),
      ),
      Command.resolve(
        SaveRecentSearches,
        Message.CompletedSaveRecentSearches(),
      ),
      Command.resolve(BlurSearchInput, Message.CompletedBlurSearchInput()),
    )
  })

  test('clearing the search box empties the URL and refocuses the box', () => {
    story(
      update,
      given(modifyFields(emptySearchModel, { searchInput: () => 'tusk' })),
      message(Message.ClickedClearSearch()),
      model(model => {
        expect(model.searchInput).toBe('')
      }),
      Command.expectExact(
        ReplaceSearchUrl({ url: '/search' }),
        ScrollSearchResultsToTop(),
        FocusSearchInput(),
      ),
      Command.resolve(ReplaceSearchUrl, Message.CompletedReplaceSearchUrl()),
      Command.resolve(
        ScrollSearchResultsToTop,
        Message.CompletedScrollSearchResultsToTop(),
      ),
      Command.resolve(FocusSearchInput, Message.CompletedFocusSearchInput()),
    )
  })
})

describe('detail pages', () => {
  test('opening a song page loads that song once', () => {
    const songUrl = urlOrThrow('http://localhost/song/FhgFtXESdPk')
    story(
      update,
      given(emptySearchModel),
      message(Message.ChangedUrl({ url: songUrl })),
      Command.resolve(
        songQuery.Fetch,
        songQuery.Message.CompletedFetch({
          args: { videoId: 'FhgFtXESdPk' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.fail('NotFound'),
        }),
      ),
      model(model => {
        expect(
          songQuery.read(model.songs, { videoId: 'FhgFtXESdPk' })._tag,
        ).toBe('Failure')
      }),
      message(Message.ClickedRetry()),
      model(model => {
        expect(
          songQuery.read(model.songs, { videoId: 'FhgFtXESdPk' })._tag,
        ).toBe('Loading')
      }),
      Command.resolve(
        songQuery.Fetch,
        songQuery.Message.CompletedFetch({
          args: { videoId: 'FhgFtXESdPk' },
          generation: FIRST_REQUEST_GENERATION + 1,
          result: Result.succeed({
            song: theChain,
            maybeViewCount: Option.some(168_000_000),
            maybeLyrics: Option.none(),
          }),
        }),
      ),
      model(model => {
        expect(
          songQuery.read(model.songs, { videoId: 'FhgFtXESdPk' })._tag,
        ).toBe('Success')
      }),
    )
  })
})

const homeModel: Model = initialModel(AppRoute.Home(), '/')

describe('moving between pages', () => {
  test('a tapped link slides in, and going back slides it away', () => {
    story(
      update,
      given(homeModel),
      message(
        Message.ClickedLink({
          request: {
            _tag: 'Internal',
            url: urlOrThrow('http://localhost/album/MPREb_1SbgcDGdrT4'),
          },
        }),
      ),
      Command.expectExact(
        NavigateInternal({ url: 'http://localhost/album/MPREb_1SbgcDGdrT4' }),
      ),
      Command.resolve(
        NavigateInternal,
        Message.CompletedNavigateInternal({ fromUrl: '/', scrollTop: 640 }),
      ),
      message(
        Message.ChangedUrl({
          url: urlOrThrow('http://localhost/album/MPREb_1SbgcDGdrT4'),
        }),
      ),
      model(model => {
        expect(model.navigation.lastNavigation).toBe('Push')
        expect(model.navigation.scrollPositions['/']).toBe(640)
        expect(
          viewTransition({
            previousModel: homeModel,
            model,
            message: Message.ClickedBack(),
          }),
        ).toStrictEqual({ types: ['push'] })
      }),
      Command.resolve(
        albumQuery.Fetch,
        albumQuery.Message.CompletedFetch({
          args: { albumId: 'MPREb_1SbgcDGdrT4' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.fail('NotFound'),
        }),
      ),
    )
  })

  test('the browser going back is a pop that restores the scroll position', () => {
    const albumModel = modifyFields(
      initialModel(AppRoute.Album({ albumId: 'x' }), '/album/x'),
      {
        navigation: navigation =>
          modifyFields(navigation, { scrollPositions: () => ({ '/': 640 }) }),
      },
    )
    story(
      update,
      given(albumModel),
      message(Message.ChangedUrl({ url: urlOrThrow('http://localhost/') })),
      ...resolveHome,
      model(model => {
        expect(model.navigation.lastNavigation).toBe('Pop')
        expect(restoredScrollTop(model)).toBe(640)
        expect(
          viewTransition({
            previousModel: albumModel,
            model,
            message: Message.ClickedBack(),
          }),
        ).toStrictEqual({ types: ['pop'] })
      }),
    )
  })

  test('typing a search never animates the page', () => {
    const typed = update(
      emptySearchModel,
      Message.ChangedUrl({ url: urlOrThrow('http://localhost/search?q=a') }),
    )
    expect(
      viewTransition({
        previousModel: emptySearchModel,
        model: typed.model,
        message: Message.ClickedBack(),
      }),
    ).toBe(false)
  })
})

describe('back button', () => {
  const albumUrl = 'http://localhost/album/MPREb_1SbgcDGdrT4'

  const goTo = (from: Model, trigger: Message, url: string): Model =>
    update(
      update(from, trigger).model,
      Message.ChangedUrl({ url: urlOrThrow(url) }),
    ).model

  const onAlbum = goTo(
    homeModel,
    Message.ClickedLink({
      request: { _tag: 'Internal', url: urlOrThrow(albumUrl) },
    }),
    albumUrl,
  )

  test('right after opening a page, steps back through history', () => {
    story(
      update,
      given(onAlbum),
      message(Message.ClickedBack()),
      Command.expectExact(NavigateBack()),
      Command.resolve(NavigateBack, Message.CompletedNavigateBack()),
    )
  })

  test('after visiting another tab, returns to the page under this one', () => {
    const backOnAlbum = goTo(
      goTo(
        onAlbum,
        Message.ClickedTab({ tab: 'Library' }),
        'http://localhost/library',
      ),
      Message.ClickedTab({ tab: 'Home' }),
      albumUrl,
    )
    story(
      update,
      given(backOnAlbum),
      model(model => {
        expect(model.navigation.backStacks.Home).toStrictEqual(['/'])
      }),
      message(Message.ClickedBack()),
      Command.expectExact(NavigateBackTo({ url: '/' })),
      Command.resolve(NavigateBackTo, Message.CompletedNavigateBackTo()),
      message(Message.ChangedUrl({ url: urlOrThrow('http://localhost/') })),
      // The Library tab already asked for my playlists; the history, new
      // releases, and Liked songs are new.
      resolveHistory,
      resolveNewReleases,
      resolveLikedSongs,
      model(model => {
        expect(model.route._tag).toBe('Home')
        expect(model.navigation.activeTab).toBe('Home')
        expect(model.navigation.lastNavigation).toBe('Pop')
        expect(model.navigation.backStacks.Home).toStrictEqual([])
      }),
    )
  })

  test('on a page opened directly, returns to the top of its tab', () => {
    story(
      update,
      given(initialModel(AppRoute.Album({ albumId: 'x' }), '/album/x')),
      message(Message.ClickedBack()),
      Command.expectExact(NavigateBackTo({ url: '/search' })),
      Command.resolve(NavigateBackTo, Message.CompletedNavigateBackTo()),
    )
    story(
      update,
      given(
        initialModel(
          AppRoute.MyPlaylist({ playlistId: 'p1' }),
          '/library/playlist/p1',
        ),
      ),
      message(Message.ClickedBack()),
      Command.expectExact(NavigateBackTo({ url: '/library' })),
      Command.resolve(NavigateBackTo, Message.CompletedNavigateBackTo()),
    )
  })
})

describe('a page opened straight from a link', () => {
  test("is under the tab that finds it: YouTube Music's pages under Search", () => {
    const artist = initialModel(
      AppRoute.Artist({ artistId: 'abc' }),
      '/artist/abc',
    )
    expect(artist.navigation.activeTab).toBe('Search')
    expect(artist.navigation.tabUrls.Search).toBe('/artist/abc')
    expect(artist.navigation.tabUrls.Home).toBe('/')
    expect(
      initialModel(
        AppRoute.ArtistAlbums({ artistId: 'abc' }),
        '/artist/abc/albums',
      ).navigation.activeTab,
    ).toBe('Search')
    expect(
      initialModel(AppRoute.Mood({ params: 'm' }), '/browse/m').navigation
        .activeTab,
    ).toBe('Search')
  })

  test('is under Library for one of my playlists, and Home for a page not found', () => {
    expect(
      initialModel(
        AppRoute.MyPlaylist({ playlistId: 'p1' }),
        '/library/playlist/p1',
      ).navigation.activeTab,
    ).toBe('Library')
    expect(
      initialModel(AppRoute.NotFound({ path: '/x' }), '/x').navigation
        .activeTab,
    ).toBe('Home')
  })
})

describe('tab bar', () => {
  test('switching tabs returns to where that tab was left', () => {
    const searchWasOnArtist = modifyFields(homeModel, {
      navigation: navigation =>
        modifyFields(navigation, {
          tabUrls: tabUrls =>
            modifyFields(tabUrls, { Search: () => '/artist/abc' }),
        }),
    })
    story(
      update,
      given(searchWasOnArtist),
      message(Message.ClickedTab({ tab: 'Search' })),
      model(model => {
        expect(model.navigation.activeTab).toBe('Search')
      }),
      Command.expectExact(NavigateInternal({ url: '/artist/abc' })),
      Command.resolve(
        NavigateInternal,
        Message.CompletedNavigateInternal({ fromUrl: '/', scrollTop: 0 }),
      ),
    )
  })

  test('tapping the tab already open scrolls back to the top', () => {
    story(
      update,
      given(homeModel),
      message(Message.ClickedTab({ tab: 'Home' })),
      Command.expectExact(ScrollToTop()),
      Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
    )
  })
})

describe('shuffle', () => {
  test('turns shuffle on and plays the list from a random song, in its order', () => {
    // The server shuffles the rest and remembers this order for later.
    const dreams: Song = {
      ...theChain,
      videoId: 'mrZRURcb1cM',
      title: 'Dreams',
    }
    const songs = [theChain, dreams]
    story(
      update,
      given(homeModel),
      message(Message.ClickedShuffleSongs({ songs })),
      Command.expectExact(UnlockPhoneAudio(), ShuffleSongs({ songs })),
      Command.resolve(UnlockPhoneAudio, Message.CompletedUnlockPhoneAudio()),
      Command.resolve(
        ShuffleSongs,
        Message.CompletedShuffleSongs({ songs, startIndex: 1 }),
      ),
      Command.expectExact(
        SendToSession({ message: { _tag: 'SetShuffle', enabled: true } }),
        SendToSession({
          message: {
            _tag: 'PlayQueue',
            tracks: songs.map(toQueueTrack),
            startIndex: 1,
          },
        }),
      ),
      Command.resolveAll(
        [SendToSession, Message.CompletedSendToSession()],
        [SendToSession, Message.CompletedSendToSession()],
      ),
    )
  })
})

describe('top result', () => {
  test('a song search also asks for the top result, and keeps it', () => {
    story(
      update,
      given(emptySearchModel),
      message(
        Message.ChangedUrl({
          url: urlOrThrow('http://localhost/search?q=the+chain'),
        }),
      ),
      Command.resolve(
        songSearchQuery.Fetch,
        songSearchQuery.Message.CompletedFetch({
          args: { query: 'the chain' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed([theChain]),
        }),
      ),
      Command.resolve(
        topResultSearchQuery.Fetch,
        topResultSearchQuery.Message.CompletedFetch({
          args: { query: 'the chain' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(
            Option.some({ _tag: 'Song' as const, song: theChain }),
          ),
        }),
      ),
      ...resolveOtherCatalogs('the chain'),
      model(model => {
        expect(
          topResultSearchQuery.read(model.topResultSearch, {
            query: 'the chain',
          })._tag,
        ).toBe('Success')
      }),
    )
  })
})

const playedTrack: Session.QueueTrack = toQueueTrack(theChain)

const viewedAlbum = {
  kind: 'Album' as const,
  id: 'MPREb_1SbgcDGdrT4',
  title: 'Rumours',
  subtitle: 'Album · Fleetwood Mac',
  maybeArtworkUrl: Option.none(),
}

describe('clearing recently viewed', () => {
  const libraryModel: Model = modifyFields(
    initialModel(AppRoute.Library(), '/library'),
    { recentlyViewed: () => [viewedAlbum] },
  )

  test('asks first, and keeps everything if cancelled', () => {
    story(
      update,
      given(libraryModel),
      message(Message.ClickedClearRecentlyViewed()),
      model(model => {
        expect(model.actionSheet).toStrictEqual({
          _tag: 'Shown',
          content: { _tag: 'ConfirmClearRecentlyViewed' },
        })
        expect(model.recentlyViewed).toStrictEqual([viewedAlbum])
      }),
      Command.expectExact(LockScroll()),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      message(Message.ClickedCloseSheet()),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      model(model => {
        expect(model.recentlyViewed).toStrictEqual([viewedAlbum])
      }),
    )
  })

  test('clears once confirmed', () => {
    story(
      update,
      given(libraryModel),
      message(Message.ClickedClearRecentlyViewed()),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      message(Message.ConfirmedClearRecentlyViewed()),
      model(model => {
        expect(model.recentlyViewed).toStrictEqual([])
        expect(model.actionSheet._tag).toBe('Dismissed')
      }),
      Command.expectExact(
        UnlockScroll(),
        SaveRecentlyViewed({ recentlyViewed: [] }),
      ),
      Command.resolveAll(
        [UnlockScroll, Message.CompletedUnlockScroll()],
        [SaveRecentlyViewed, Message.CompletedSaveRecentlyViewed()],
      ),
    )
  })
})

describe('home', () => {
  test('asks YouTube for more like the song played last, once the history has loaded', () => {
    const dreams: Song = {
      ...theChain,
      videoId: 'mrZRURcb1cM',
      title: 'Dreams',
    }
    story(
      update,
      given(initialModel(AppRoute.Library(), '/library')),
      message(Message.ChangedUrl({ url: urlOrThrow('http://localhost/') })),
      Command.resolve(
        homeQuery.Fetch,
        homeQuery.Message.CompletedFetch({
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed({
            jumpBackIn: [],
            recentlyPlayed: [theChain, dreams],
            maybeLastPlayed: Option.some(theChain),
            mixes: [],
          }),
        }),
      ),
      resolveNewReleases,
      Command.resolve(
        myLibraryQuery.Fetch,
        myLibraryQuery.Message.CompletedFetch({
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed({
            playlists: [],
            likedVideoIds: [],
            albums: [],
            artists: [],
            albumPlayedAt: {},
            artistPlayedAt: {},
          }),
        }),
      ),
      resolveLikedSongs,
      Command.resolve(
        songRadioQuery.Fetch,
        songRadioQuery.Message.CompletedFetch({
          args: { videoId: theChain.videoId },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed([dreams]),
        }),
      ),
      model(model => {
        expect(
          AsyncData.getData(
            songRadioQuery.read(model.songRadios, {
              videoId: theChain.videoId,
            }),
          ),
        ).toStrictEqual(Option.some([dreams]))
      }),
    )
  })
})

describe('lyrics that fail to load', () => {
  const nowPlayingModel: Model = modifyFields(homeModel, {
    maybeSession: () =>
      Option.some({
        state: {
          devices: [],
          activeDeviceId: 'tv',
          queue: [{ entryId: 'e0', track: playedTrack, autoplay: false }],
          currentEntryId: 'e0',
          playing: true,
          positionSeconds: 0,
          autoplay: true,
          repeat: 'Off',
          shuffle: false,
          sleepTimer: null,
          positionAt: 0,
          seekSeq: 0,
        },
        clockOffsetMs: 0,
      }),
  })

  const lyricsFailed = (generation: number) =>
    Command.resolve(
      songQuery.Fetch,
      songQuery.Message.CompletedFetch({
        args: { videoId: theChain.videoId },
        generation,
        result: Result.fail('YouTubeUnavailable'),
      }),
    )

  test('are tried again once by themselves, then on a tap', () => {
    story(
      update,
      given(nowPlayingModel),
      message(Message.SelectedPlayerPanel({ panel: 'Lyrics' })),
      lyricsFailed(FIRST_REQUEST_GENERATION),
      Command.expectExact(WaitBeforeRetryLyrics({ videoId: theChain.videoId })),
      Command.resolve(
        WaitBeforeRetryLyrics,
        Message.CompletedWaitBeforeRetryLyrics({ videoId: theChain.videoId }),
      ),
      model(model => {
        expect(
          songQuery.read(model.songs, { videoId: theChain.videoId })._tag,
        ).toBe('Loading')
      }),
      lyricsFailed(FIRST_REQUEST_GENERATION + 1),
      Command.expectNone(),
      message(Message.ClickedRetryLyrics()),
      model(model => {
        expect(
          songQuery.read(model.songs, { videoId: theChain.videoId })._tag,
        ).toBe('Loading')
      }),
      lyricsFailed(FIRST_REQUEST_GENERATION + 2),
    )
  })

  test('a retry that comes due for another song does nothing', () => {
    story(
      update,
      given(nowPlayingModel),
      message(Message.SelectedPlayerPanel({ panel: 'Lyrics' })),
      lyricsFailed(FIRST_REQUEST_GENERATION),
      Command.resolve(
        WaitBeforeRetryLyrics,
        Message.CompletedWaitBeforeRetryLyrics({ videoId: 'another' }),
      ),
      model(model => {
        expect(
          songQuery.read(model.songs, { videoId: theChain.videoId })._tag,
        ).toBe('Failure')
      }),
    )
  })
})
