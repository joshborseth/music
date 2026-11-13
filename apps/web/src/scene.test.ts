import { Option, Result } from 'effect'
import { AsyncData } from 'foldkit'
import {
  Command,
  Mount,
  click,
  expect,
  given,
  label,
  role,
  scene,
  text,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { fromString } from 'foldkit/url'
import { describe, test } from 'vitest'

import {
  type AlbumSummary,
  type ArtistSummary,
  type HomeFeed,
  type MyLibrary,
  type MyPlaylistSummary,
  type RadioStation,
  type Session,
  type Song,
} from '@music/shared'

import {
  EditPlaylists,
  FetchRadio,
  LockScroll,
  ReplaceSearchUrl,
  SaveRecentSearches,
  ScrollSearchResultsToTop,
  ShareLink,
  UnlockScroll,
} from './command'
import { DownloadSong, SaveDownloads } from './downloads/command'
import { type DownloadedCollection, Downloads } from './downloads/domain'
import { Message } from './message'
import { type Model } from './model'
import {
  DragToDismiss,
  FollowSeekBarDrags,
  Marquee,
  RestoreScroll,
  SyncTitleBarReveal,
} from './mount'
import {
  SendToSession,
  UnlockPhoneAudio,
  WaitBeforeHideNotice,
} from './playback/command'
import { PlayerSheet } from './playback/domain'
import { toQueueTrack } from './playback/queueTrack'
import {
  type RequestError,
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  playlistQuery,
  songRadioQuery,
  songSearchQuery,
  topResultSearchQuery,
} from './query'
import { AppRoute, type SearchKind, searchUrl } from './route'
import { initialModel, update } from './update'
import { view } from './view'

const FIRST_REQUEST_GENERATION = 1

const pageScrolled = Mount.resolve(
  RestoreScroll,
  Message.CompletedRestoreScroll(),
)

const sheetFollowsDrags = Mount.resolve(
  DragToDismiss,
  Message.CompletedFollowSheetDrags(),
)

const titleBarFollowsScroll = Mount.resolve(
  SyncTitleBarReveal,
  Message.CompletedSyncTitleBarReveal(),
)

/** The Mounts the mini player and the closed full player start with. */
const playerMounted = [
  sheetFollowsDrags,
  Mount.resolve(Marquee, Message.CompletedSyncMarquee()),
  Mount.resolve(FollowSeekBarDrags, Message.CompletedFollowSeekBarDrags()),
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

const fleetwoodMacResult = {
  _tag: 'Artist' as const,
  artist: {
    id: 'UCCzULu3prrEaPvM2ZtkJlYQ',
    name: 'Fleetwood Mac',
    maybeAudience: Option.some('20M monthly audience'),
    artwork: [],
  },
  topSongs: [],
}

const urlOrThrow = (raw: string) =>
  Option.getOrThrowWith(
    fromString(raw),
    () => new Error(`Failed to parse url: ${raw}`),
  )

const searchUrlChange = (query: string, kind: SearchKind) =>
  Message.ChangedUrl({
    url: urlOrThrow(`http://localhost${searchUrl(query, kind)}`),
  })

const searchResultModel = (
  query: string,
  result: Result.Result<ReadonlyArray<Song>, RequestError>,
  kind: SearchKind = 'Songs',
): Model => {
  const searchOpen = update(emptySearchModel, searchUrlChange(query, kind))
  const searchComplete = update(
    searchOpen.model,
    Message.GotSongSearchMessage({
      message: songSearchQuery.Message.CompletedFetch({
        args: { query },
        generation: FIRST_REQUEST_GENERATION,
        result,
      }),
    }),
  )
  return searchComplete.model
}

describe('search page', () => {
  test('with no query, offers recent searches to repeat', () => {
    scene(
      { update, view },
      given(
        modifyFields(emptySearchModel, { recentSearches: () => ['rumours'] }),
      ),
      pageScrolled,
      expect(role('heading', { name: 'Recently Searched' })).toExist(),
      click(role('button', { name: 'rumours' })),
      Command.expectExact(
        ReplaceSearchUrl({ url: '/search?q=rumours' }),
        ScrollSearchResultsToTop(),
        SaveRecentSearches({ recentSearches: ['rumours'] }),
      ),
      Command.resolveAll(
        [ReplaceSearchUrl, Message.CompletedReplaceSearchUrl()],
        [ScrollSearchResultsToTop, Message.CompletedScrollSearchResultsToTop()],
        [SaveRecentSearches, Message.CompletedSaveRecentSearches()],
      ),
      expect(label('Search music')).toHaveValue('rumours'),
    )
  })

  test('with no query, offers moods and genres to browse', () => {
    const model = modifyFields(emptySearchModel, {
      moodGroups: query =>
        modifyFields(query, {
          data: () =>
            AsyncData.succeed([
              {
                title: 'Moods & moments',
                categories: [
                  {
                    params: 'chill-params',
                    title: 'Chill',
                    maybeColor: Option.some('#a4c5ff'),
                  },
                ],
              },
            ]),
        }),
    })
    scene(
      { update, view },
      given(model),
      pageScrolled,
      expect(role('heading', { name: 'Moods & moments' })).toExist(),
      expect(role('link', { name: 'Chill' })).toHaveAttr(
        'href',
        '/browse/chill-params',
      ),
    )
  })

  test('puts the top result above the songs', () => {
    const searched = searchResultModel(
      'fleetwood mac',
      Result.succeed([theChain]),
      'Top',
    )
    const withTopResult = update(
      searched,
      Message.GotTopResultSearchMessage({
        message: topResultSearchQuery.Message.CompletedFetch({
          args: { query: 'fleetwood mac' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(Option.some(fleetwoodMacResult)),
        }),
      }),
    ).model
    scene(
      { update, view },
      given(withTopResult),
      pageScrolled,
      expect(role('heading', { name: 'Top Result' })).toExist(),
      expect(role('link', { name: /Fleetwood Mac/ })).toHaveAttr(
        'href',
        '/artist/UCCzULu3prrEaPvM2ZtkJlYQ',
      ),
      expect(role('heading', { name: 'Songs' })).toExist(),
      expect(role('button', { name: /The Chain/ })).toExist(),
    )
  })

  test('lists the top artist’s hits, not every song that mentions them', () => {
    const dreams: Song = { ...theChain, videoId: 'dr34ms', title: 'Dreams' }
    const tribute: Song = {
      ...theChain,
      videoId: 'tr1but3',
      title: 'Fleetwood Mac Tribute',
      artists: [{ maybeId: Option.none(), name: 'Cover Band' }],
    }
    const query = 'fleetwood mac'
    const searched = update(
      searchResultModel(query, Result.succeed([tribute]), 'Top'),
      Message.GotTopResultSearchMessage({
        message: topResultSearchQuery.Message.CompletedFetch({
          args: { query },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(
            Option.some({
              ...fleetwoodMacResult,
              topSongs: [dreams, theChain],
            }),
          ),
        }),
      }),
    ).model
    scene(
      { update, view },
      given(searched),
      pageScrolled,
      expect(role('heading', { name: 'Songs' })).toExist(),
      expect(role('button', { name: /^Dreams ·/ })).toExist(),
      expect(role('button', { name: /^The Chain ·/ })).toExist(),
      expect(role('button', { name: /^Fleetwood Mac Tribute/ })).toBeAbsent(),
    )
  })

  test('top mixes in artists and albums, and See All opens their kind', () => {
    const stevieNicks: ArtistSummary = {
      id: 'UCstevie',
      name: 'Stevie Nicks',
      maybeAudience: Option.none(),
      artwork: [],
    }
    const rumours: AlbumSummary = {
      id: 'MPREb_1SbgcDGdrT4',
      title: 'Rumours',
      artists: [{ maybeId: Option.none(), name: 'Fleetwood Mac' }],
      maybeKind: Option.some('Album'),
      maybeYear: Option.some('1977'),
      artwork: [],
    }
    const query = 'fleetwood mac'
    const searched = [
      Message.GotTopResultSearchMessage({
        message: topResultSearchQuery.Message.CompletedFetch({
          args: { query },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(Option.some(fleetwoodMacResult)),
        }),
      }),
      Message.GotArtistSearchMessage({
        message: artistSearchQuery.Message.CompletedFetch({
          args: { query },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed([fleetwoodMacResult.artist, stevieNicks]),
        }),
      }),
      Message.GotAlbumSearchMessage({
        message: albumSearchQuery.Message.CompletedFetch({
          args: { query },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed([rumours]),
        }),
      }),
    ].reduce(
      (model, message) => update(model, message).model,
      searchResultModel(query, Result.succeed([theChain]), 'Top'),
    )
    scene(
      { update, view },
      given(searched),
      pageScrolled,
      expect(role('tab', { name: 'Top' })).toHaveAttr('aria-selected', 'true'),
      expect(role('heading', { name: 'Artists' })).toExist(),
      expect(role('link', { name: 'Stevie Nicks' })).toHaveAttr(
        'href',
        '/artist/UCstevie',
      ),
      expect(role('heading', { name: 'Albums' })).toExist(),
      expect(role('link', { name: /Rumours/ })).toHaveAttr(
        'href',
        '/album/MPREb_1SbgcDGdrT4',
      ),
      click(role('button', { name: 'See all albums' })),
      Command.expectExact(
        ReplaceSearchUrl({ url: '/search?q=fleetwood+mac&kind=Albums' }),
        ScrollSearchResultsToTop(),
      ),
      Command.resolveAll(
        [ReplaceSearchUrl, Message.CompletedReplaceSearchUrl()],
        [ScrollSearchResultsToTop, Message.CompletedScrollSearchResultsToTop()],
      ),
    )
  })

  test('top leaves the top result song, and its other copies, out of the songs', () => {
    const deluxeCopy: Song = { ...theChain, videoId: 'd3lux3' }
    const dreams: Song = { ...theChain, videoId: 'dr34ms', title: 'Dreams' }
    const query = 'the chain'
    const searched = update(
      searchResultModel(
        query,
        Result.succeed([theChain, deluxeCopy, dreams]),
        'Top',
      ),
      Message.GotTopResultSearchMessage({
        message: topResultSearchQuery.Message.CompletedFetch({
          args: { query },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(
            Option.some({ _tag: 'Song' as const, song: theChain }),
          ),
        }),
      }),
    ).model
    scene(
      { update, view },
      given(searched),
      pageScrolled,
      expect(role('button', { name: 'Play The Chain' })).toExist(),
      expect(role('button', { name: /^The Chain ·/ })).toBeAbsent(),
      expect(role('button', { name: /^Dreams ·/ })).toExist(),
    )
  })

  test('lists songs with their credits once results arrive', () => {
    scene(
      { update, view },
      given(searchResultModel('the chain', Result.succeed([theChain]))),
      pageScrolled,
      expect(role('button', { name: /The Chain/ })).toExist(),
      expect(text('Fleetwood Mac · Rumours')).toExist(),
    )
  })

  test('tapping a song plays only that song, for autoplay to follow', () => {
    // Search results are not a list to play through: covers, karaoke, and
    // songs that only share some words.
    const karaoke: Song = {
      ...theChain,
      videoId: 'k4r40k3',
      title: 'The Chain (Karaoke Version)',
    }
    scene(
      { update, view },
      given(
        searchResultModel('the chain', Result.succeed([karaoke, theChain])),
      ),
      pageScrolled,
      click(role('button', { name: 'The Chain · Fleetwood Mac · Rumours' })),
      Command.expectExact(
        UnlockPhoneAudio(),
        SendToSession({
          message: {
            _tag: 'PlayQueue',
            tracks: [toQueueTrack(theChain)],
            startIndex: 0,
            playingFrom: PLAYING_FROM_SEARCH,
          },
        }),
      ),
      Command.resolveAll(
        [UnlockPhoneAudio, Message.CompletedUnlockPhoneAudio()],
        [SendToSession, Message.CompletedSendToSession()],
      ),
    )
  })

  test('keeps the last results on screen while the next search loads', () => {
    const typedOn = update(
      searchResultModel('the chain', Result.succeed([theChain])),
      searchUrlChange('the chain live', 'Songs'),
    ).model
    scene(
      { update, view },
      given(typedOn),
      pageScrolled,
      expect(role('status', { name: 'Searching' })).toExist(),
      expect(role('button', { name: /^The Chain ·/ })).toExist(),
      expect(label('Loading')).toBeAbsent(),
    )
  })

  test('with no results yet, shows placeholder rows until they arrive', () => {
    const typed = update(
      modifyFields(emptySearchModel, { recentSearches: () => ['rumours'] }),
      searchUrlChange('the chain', 'Top'),
    ).model
    scene(
      { update, view },
      given(typed),
      pageScrolled,
      expect(role('status', { name: 'Searching' })).toExist(),
      expect(label('Loading')).toExist(),
      expect(role('heading', { name: 'Recently Searched' })).toBeAbsent(),
      expect(role('heading', { name: 'Songs' })).toBeAbsent(),
    )
  })

  test('the first letter typed swaps the moods for placeholder rows at once', () => {
    const browsing = modifyFields(emptySearchModel, {
      moodGroups: query =>
        modifyFields(query, {
          data: () =>
            AsyncData.succeed([
              {
                title: 'Moods & moments',
                categories: [
                  {
                    params: 'chill-params',
                    title: 'Chill',
                    maybeColor: Option.some('#a4c5ff'),
                  },
                ],
              },
            ]),
        }),
    })
    const typed = update(browsing, Message.UpdatedSearchInput({ value: 'f' }))
    scene(
      { update, view },
      given(typed.model),
      pageScrolled,
      expect(role('status', { name: 'Searching' })).toExist(),
      expect(role('tablist', { name: 'Search in' })).toExist(),
      expect(label('Loading')).toExist(),
      expect(role('heading', { name: 'Moods & moments' })).toBeAbsent(),
    )
  })

  test('a song as the top result shows when it is the one playing', () => {
    const searched = searchResultModel('the chain', Result.succeed([]), 'Top')
    const withTopResult = update(
      searched,
      Message.GotTopResultSearchMessage({
        message: topResultSearchQuery.Message.CompletedFetch({
          args: { query: 'the chain' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(
            Option.some({ _tag: 'Song' as const, song: theChain }),
          ),
        }),
      }),
    ).model
    scene(
      { update, view },
      given(withTopResult),
      pageScrolled,
      expect(role('button', { name: 'Play The Chain' })).toExist(),
    )
    const playingIt = (playing: boolean): Model =>
      modifyFields(withTopResult, {
        maybeSession: () =>
          Option.some({
            state: {
              devices: [],
              activeDeviceId: 'tv',
              queue: [
                {
                  entryId: 'e0',
                  track: toQueueTrack(theChain),
                  autoplay: false,
                },
              ],
              currentEntryId: 'e0',
              playing,
              positionSeconds: 0,
              autoplay: true,
              repeat: 'Off',
              shuffle: false,
              positionAt: 0,
              seekSeq: 0,
              sleepTimer: null,
              playingFrom: null,
            },
            clockOffsetMs: 0,
          }),
      })
    scene(
      { update, view },
      given(playingIt(true)),
      pageScrolled,
      ...playerMounted,
      expect(role('button', { name: 'Pause The Chain' })).toExist(),
      expect(role('button', { name: 'Play The Chain' })).toBeAbsent(),
    )
    scene(
      { update, view },
      given(playingIt(false)),
      pageScrolled,
      ...playerMounted,
      expect(role('button', { name: 'Play The Chain' })).toExist(),
    )
  })
  test('the more button opens a sheet of what else can be done', () => {
    scene(
      { update, view },
      given(searchResultModel('the chain', Result.succeed([theChain]))),
      pageScrolled,
      click(role('button', { name: 'More for The Chain' })),
      Command.expectExact(LockScroll()),
      Command.resolveAll([LockScroll, Message.CompletedLockScroll()]),
      sheetFollowsDrags,
      expect(role('dialog', { name: 'The Chain' })).toExist(),
      expect(role('button', { name: 'Play Next' })).toExist(),
      expect(role('link', { name: 'Go to Album' })).toHaveAttr(
        'href',
        '/album/MPREb_1SbgcDGdrT4',
      ),
      expect(role('link', { name: 'Go to Artist' })).toHaveAttr(
        'href',
        '/artist/UCCzULu3prrEaPvM2ZtkJlYQ',
      ),
    )
  })

  test("the more sheet starts a song's radio", () => {
    scene(
      { update, view },
      given(searchResultModel('the chain', Result.succeed([theChain]))),
      pageScrolled,
      click(role('button', { name: 'More for The Chain' })),
      Command.resolveAll([LockScroll, Message.CompletedLockScroll()]),
      sheetFollowsDrags,
      click(role('button', { name: 'Start Radio' })),
      Command.expectExact(
        UnlockScroll(),
        UnlockPhoneAudio(),
        SendToSession({
          message: {
            _tag: 'PlayQueue',
            tracks: [toQueueTrack(theChain)],
            startIndex: 0,
            playingFrom: {
              kind: 'Radio',
              title: 'The Chain',
              id: `RDAMVM${theChain.videoId}`,
            },
          },
        }),
      ),
      Command.resolveAll(
        [UnlockScroll, Message.CompletedUnlockScroll()],
        [UnlockPhoneAudio, Message.CompletedUnlockPhoneAudio()],
        [SendToSession, Message.CompletedSendToSession()],
      ),
    )
  })

  test('a failed search explains the problem and offers a retry', () => {
    scene(
      { update, view },
      given(searchResultModel('tusk', Result.fail('ServerUnreachable'))),
      pageScrolled,
      expect(role('alert')).toContainText('Could not reach the music server'),
      expect(role('button', { name: 'Retry' })).toExist(),
    )
  })
})

/** The searches above all look for "the chain". */
const PLAYING_FROM_SEARCH: Session.PlayingFrom = {
  kind: 'Search',
  title: 'the chain',
  id: 'the chain',
}

describe('album page', () => {
  const albumId = 'MPREb_1SbgcDGdrT4'
  const albumPageModel = (tracks: ReadonlyArray<Song>): Model => {
    const albumOpen = update(
      emptySearchModel,
      Message.ChangedUrl({
        url: urlOrThrow(`http://localhost/album/${albumId}`),
      }),
    ).model
    const albumModel = update(
      albumOpen,
      Message.GotAlbumMessage({
        message: albumQuery.Message.CompletedFetch({
          args: { albumId },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed({
            album: {
              id: albumId,
              title: 'Rumours',
              artists: theChain.artists,
              maybeKind: Option.some('Album'),
              maybeYear: Option.some('1977'),
              artwork: [],
            },
            maybeDescription: Option.none(),
            maybeLengthSummary: Option.none(),
            tracks,
            explicitVideoIds: [],
            maybeRadio: Option.none(),
          }),
        }),
      }),
    ).model
    return albumModel
  }

  test('a song listed twice keeps both rows, each playing the album from its own place', () => {
    // YouTube sometimes gives two tracks of an album the same video.
    const interlude: Song = { ...theChain, title: 'The Chain (Interlude)' }
    const tracks = [theChain, interlude]
    scene(
      { update, view },
      given(albumPageModel(tracks)),
      pageScrolled,
      Mount.resolve(SyncTitleBarReveal, Message.CompletedSyncTitleBarReveal()),
      expect(role('button', { name: 'The Chain' })).toExist(),
      click(role('button', { name: 'The Chain (Interlude)' })),
      Command.expectExact(
        UnlockPhoneAudio(),
        SendToSession({
          message: {
            _tag: 'PlayQueue',
            tracks: tracks.map(toQueueTrack),
            startIndex: 1,
            playingFrom: { kind: 'Album', title: 'Rumours', id: albumId },
          },
        }),
      ),
      Command.resolveAll(
        [UnlockPhoneAudio, Message.CompletedUnlockPhoneAudio()],
        [SendToSession, Message.CompletedSendToSession()],
      ),
    )
  })

  test('⋯ queues the whole album next in one message, and offers the rest', () => {
    const dreams: Song = { ...theChain, videoId: 'dreams', title: 'Dreams' }
    const tracks = [theChain, dreams]
    scene(
      { update, view },
      given(albumPageModel(tracks)),
      pageScrolled,
      Mount.resolve(SyncTitleBarReveal, Message.CompletedSyncTitleBarReveal()),
      click(role('button', { name: 'Album Options' })),
      Command.expectExact(LockScroll()),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      expect(role('button', { name: 'Add to Queue' })).toExist(),
      expect(role('button', { name: 'Add to a Playlist…' })).toExist(),
      expect(role('button', { name: 'Share' })).toExist(),
      expect(role('link', { name: 'Go to Artist' })).toHaveAttr(
        'href',
        '/artist/UCCzULu3prrEaPvM2ZtkJlYQ',
      ),
      click(role('button', { name: 'Play Next' })),
      Command.expectExact(
        UnlockScroll(),
        UnlockPhoneAudio(),
        SendToSession({
          message: {
            _tag: 'Enqueue',
            tracks: tracks.map(toQueueTrack),
            placement: 'Next',
          },
        }),
        WaitBeforeHideNotice({ message: 'Playing next' }),
      ),
      Command.resolveAll(
        [UnlockScroll, Message.CompletedUnlockScroll()],
        [UnlockPhoneAudio, Message.CompletedUnlockPhoneAudio()],
        [SendToSession, Message.CompletedSendToSession()],
        [
          WaitBeforeHideNotice,
          Message.CompletedWaitBeforeHideNotice({ message: 'Playing next' }),
        ],
      ),
    )
  })

  test('⋯ shares the album page', () => {
    scene(
      { update, view },
      given(albumPageModel([theChain])),
      pageScrolled,
      Mount.resolve(SyncTitleBarReveal, Message.CompletedSyncTitleBarReveal()),
      click(role('button', { name: 'Album Options' })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      click(role('button', { name: 'Share' })),
      Command.expectExact(
        UnlockScroll(),
        ShareLink({ title: 'Rumours', href: `/album/${albumId}` }),
      ),
      Command.resolveAll(
        [UnlockScroll, Message.CompletedUnlockScroll()],
        [ShareLink, Message.CompletedShareLink({ isCopied: true })],
      ),
      expect(text('Link copied')).toExist(),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({ message: 'Link copied' }),
      ),
    )
  })
})

describe('tab bar', () => {
  test('marks the open tab', () => {
    scene(
      { update, view },
      given(initialModel(AppRoute.Library(), '/library')),
      pageScrolled,
      expect(role('tab', { name: 'Library' })).toHaveAttr(
        'aria-selected',
        'true',
      ),
      expect(role('tab', { name: 'Home' })).toHaveAttr(
        'aria-selected',
        'false',
      ),
      expect(role('button', { name: 'New Playlist…' })).toExist(),
    )
  })
})

describe('a page opened straight from a link', () => {
  test('marks Search for an artist, not Home', () => {
    scene(
      { update, view },
      given(initialModel(AppRoute.Artist({ artistId: 'abc' }), '/artist/abc')),
      pageScrolled,
      expect(role('tab', { name: 'Search' })).toHaveAttr(
        'aria-selected',
        'true',
      ),
      expect(role('tab', { name: 'Home' })).toHaveAttr(
        'aria-selected',
        'false',
      ),
    )
  })
})

const release = (index: number, kind: 'Album' | 'Single') => ({
  id: `${kind}-${index}`,
  title: `${kind} ${index}`,
  artists: [{ maybeId: Option.some('abc'), name: 'Daft Punk' }],
  maybeKind: Option.some(kind),
  maybeYear: Option.some(`${2020 - index}`),
  artwork: [],
})

const instantCrush: Song = {
  videoId: 'instant-crush',
  title: 'Instant Crush',
  artists: [
    { maybeId: Option.some('abc'), name: 'Daft Punk' },
    { maybeId: Option.some('jc'), name: 'Julian Casablancas' },
  ],
  maybeAlbum: Option.some({ id: 'ram', name: 'Random Access Memories' }),
  maybeDurationSeconds: Option.some(337),
  artwork: [],
}

const ARTIST_RADIO: RadioStation = {
  playlistId: 'RDEMdaftpunk',
  maybeParams: Option.some('wAEB'),
  maybeVideoId: Option.some('instant-crush'),
}

/** A page opened at `path`, which starts loading what it shows. */
const openedAt = (route: AppRoute, path: string): Model =>
  update(
    initialModel(route, path),
    Message.ChangedUrl({ url: urlOrThrow(`http://localhost${path}`) }),
  ).model

const artistModel = (route: AppRoute, path: string): Model =>
  update(
    openedAt(route, path),
    Message.GotArtistMessage({
      message: artistQuery.Message.CompletedFetch({
        args: { artistId: 'abc' },
        generation: FIRST_REQUEST_GENERATION,
        result: Result.succeed({
          artist: {
            id: 'abc',
            name: 'Daft Punk',
            maybeAudience: Option.none(),
            artwork: [],
          },
          maybeDescription: Option.none(),
          topSongs: [instantCrush],
          topSongPlays: { 'instant-crush': '1.2B plays' },
          maybeAllSongsPlaylistId: Option.some('VLOLAK5uy_top'),
          albums: Array.from({ length: 12 }, (_, index) =>
            release(index, 'Album'),
          ),
          singles: [release(0, 'Single'), release(1, 'Single')],
          relatedArtists: [
            {
              id: 'justice',
              name: 'Justice',
              maybeAudience: Option.some('24.1M monthly audience'),
              artwork: [],
            },
          ],
          maybeRadio: Option.some(ARTIST_RADIO),
        }),
      }),
    }),
  ).model

describe('artist page', () => {
  test("Radio plays the artist's radio, with autoplay after it", () => {
    const radioSongs = [instantCrush, { ...instantCrush, videoId: 'other' }]
    const daftPunkRadio: Session.PlayingFrom = {
      kind: 'Radio',
      title: 'Daft Punk',
      id: ARTIST_RADIO.playlistId,
    }
    scene(
      { update, view },
      given(artistModel(AppRoute.Artist({ artistId: 'abc' }), '/artist/abc')),
      pageScrolled,
      titleBarFollowsScroll,
      click(role('button', { name: 'Start Radio' })),
      Command.expectExact(
        UnlockPhoneAudio(),
        FetchRadio({ station: ARTIST_RADIO, playingFrom: daftPunkRadio }),
      ),
      Command.resolveAll(
        [UnlockPhoneAudio, Message.CompletedUnlockPhoneAudio()],
        [
          FetchRadio,
          Message.SucceededFetchRadio({
            songs: radioSongs,
            playingFrom: daftPunkRadio,
          }),
        ],
      ),
      Command.expectExact(
        SendToSession({
          message: {
            _tag: 'PlayQueue',
            tracks: radioSongs.map(toQueueTrack),
            startIndex: 0,
            playingFrom: daftPunkRadio,
          },
        }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('names each top song’s album and plays, and links to every song', () => {
    scene(
      { update, view },
      given(artistModel(AppRoute.Artist({ artistId: 'abc' }), '/artist/abc')),
      pageScrolled,
      titleBarFollowsScroll,
      expect(text('Random Access Memories · 1.2B plays')).toExist(),
      expect(role('link', { name: 'See all Top Songs' })).toHaveAttr(
        'href',
        '/playlist/VLOLAK5uy_top',
      ),
    )
  })

  test('links a long shelf of releases to all of them, but not a short one', () => {
    scene(
      { update, view },
      given(artistModel(AppRoute.Artist({ artistId: 'abc' }), '/artist/abc')),
      pageScrolled,
      titleBarFollowsScroll,
      expect(role('link', { name: 'See all Albums' })).toHaveAttr(
        'href',
        '/artist/abc/albums',
      ),
      expect(role('link', { name: /Album 9/ })).toExist(),
      expect(role('link', { name: /Album 10/ })).not.toExist(),
      expect(role('heading', { name: 'Singles & EPs' })).toExist(),
      expect(role('link', { name: 'See all Singles & EPs' })).not.toExist(),
    )
  })

  test('shelves the artists their fans also like', () => {
    scene(
      { update, view },
      given(artistModel(AppRoute.Artist({ artistId: 'abc' }), '/artist/abc')),
      pageScrolled,
      titleBarFollowsScroll,
      expect(role('heading', { name: 'Fans Also Like' })).toExist(),
      expect(role('link', { name: /Justice/ })).toHaveAttr(
        'href',
        '/artist/justice',
      ),
    )
  })

  test('See All lists every album with its year and kind', () => {
    scene(
      { update, view },
      given(
        artistModel(
          AppRoute.ArtistAlbums({ artistId: 'abc' }),
          '/artist/abc/albums',
        ),
      ),
      pageScrolled,
      titleBarFollowsScroll,
      expect(role('heading', { name: 'Albums', level: 1 })).toExist(),
      expect(role('link', { name: 'Daft Punk' })).toHaveAttr(
        'href',
        '/artist/abc',
      ),
      expect(role('link', { name: /Album 11/ })).toHaveAttr(
        'href',
        '/album/Album-11',
      ),
      expect(text('2009 · Album')).toExist(),
    )
  })
})

const playlistModel = (
  maybeOwner: Option.Option<{
    maybeId: Option.Option<string>
    name: string
  }>,
): Model =>
  update(
    openedAt(AppRoute.Playlist({ playlistId: 'VLp' }), '/playlist/VLp'),
    Message.GotPlaylistMessage({
      message: playlistQuery.Message.CompletedFetch({
        args: { playlistId: 'VLp' },
        generation: FIRST_REQUEST_GENERATION,
        result: Result.succeed({
          playlist: {
            id: 'VLp',
            title: 'Daft Punk Essentials',
            maybeSubtitle: Option.some('Playlist · 2024'),
            artwork: [],
          },
          maybeOwner,
          maybeDescription: Option.some('The essentials.'),
          maybeLengthSummary: Option.some('30 tracks • 2 hours, 19 minutes'),
          tracks: [theChain],
        }),
      }),
    }),
  ).model

describe('playlist page', () => {
  test('links an artist who made it, and says how many songs and how long', () => {
    scene(
      { update, view },
      given(
        playlistModel(
          Option.some({ maybeId: Option.some('abc'), name: 'Daft Punk' }),
        ),
      ),
      pageScrolled,
      titleBarFollowsScroll,
      expect(role('link', { name: 'Daft Punk' })).toHaveAttr(
        'href',
        '/artist/abc',
      ),
      expect(text('30 tracks · 2 hours, 19 minutes')).toExist(),
      expect(text('The essentials.')).toExist(),
    )
  })

  test('names anyone else, or the kind and year, as plain text', () => {
    scene(
      { update, view },
      given(
        playlistModel(
          Option.some({ maybeId: Option.none(), name: 'YouTube Music' }),
        ),
      ),
      pageScrolled,
      titleBarFollowsScroll,
      expect(text('YouTube Music · 30 tracks · 2 hours, 19 minutes')).toExist(),
      expect(role('link', { name: 'YouTube Music' })).not.toExist(),
    )
    scene(
      { update, view },
      given(playlistModel(Option.none())),
      pageScrolled,
      titleBarFollowsScroll,
      expect(
        text('Playlist · 2024 · 30 tracks · 2 hours, 19 minutes'),
      ).toExist(),
    )
  })
})

describe('library', () => {
  test('lists my playlists, Liked songs first', () => {
    const model = modifyFields(initialModel(AppRoute.Library(), '/library'), {
      myLibrary: query =>
        modifyFields(query, {
          data: () =>
            AsyncData.succeed({
              playlists: [
                {
                  id: 'liked',
                  title: 'Liked Songs',
                  isLiked: true,
                  songCount: 1,
                  totalSeconds: 270,
                  covers: [],
                  updatedAt: 2,
                  createdAt: 2,
                  maybePlayedAt: Option.none(),
                  maybeDescription: Option.none(),
                  maybeCoverVideoId: Option.none(),
                },
                {
                  id: 'road-trip',
                  title: 'Road trip',
                  isLiked: false,
                  songCount: 12,
                  totalSeconds: 3_900,
                  covers: [],
                  updatedAt: 1,
                  createdAt: 1,
                  maybePlayedAt: Option.none(),
                  maybeDescription: Option.none(),
                  maybeCoverVideoId: Option.none(),
                },
              ],
              likedVideoIds: ['FhgFtXESdPk'],
              albums: [],
              artists: [],
              albumPlayedAt: {},
              artistPlayedAt: {},
            }),
        }),
    })
    scene(
      { update, view },
      given(model),
      pageScrolled,
      expect(role('link', { name: /Liked Songs/ })).toHaveAttr(
        'href',
        '/library/playlist/liked',
      ),
      expect(text('12 songs · 1 hr 5 min')).toExist(),
    )
  })

  test('shows saved albums and followed artists, and filters to one kind', () => {
    const model = withLibrary(
      initialModel(AppRoute.Library(), '/library'),
      libraryWith({ albums: [rumours], artists: [fleetwoodMac] }),
    )
    scene(
      { update, view },
      given(model),
      pageScrolled,
      expect(role('heading', { name: 'Playlists' })).toExist(),
      expect(role('heading', { name: 'Albums' })).toExist(),
      expect(role('heading', { name: 'Artists' })).toExist(),
      click(role('button', { name: 'Albums' })),
      expect(role('button', { name: 'Albums' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expect(role('heading', { name: 'Playlists' })).toBeAbsent(),
      expect(role('link', { name: /Rumours/ })).toHaveAttr(
        'href',
        '/album/MPREb_1SbgcDGdrT4',
      ),
      click(role('button', { name: 'Artists' })),
      expect(role('link', { name: /Fleetwood Mac/ })).toHaveAttr(
        'href',
        '/artist/UCCzULu3prrEaPvM2ZtkJlYQ',
      ),
      expect(role('link', { name: /Rumours/ })).toBeAbsent(),
      click(role('button', { name: 'Artists' })),
      expect(role('heading', { name: 'Playlists' })).toExist(),
    )
  })

  test('says how to save an album when there are none', () => {
    const model = modifyFields(
      withLibrary(initialModel(AppRoute.Library(), '/library'), libraryWith()),
      { libraryFilter: () => 'Albums' as const },
    )
    scene(
      { update, view },
      given(model),
      pageScrolled,
      expect(text('No albums yet')).toExist(),
    )
  })

  test('lists recently viewed as rows, and its Clear says what it clears', () => {
    const model = modifyFields(
      withLibrary(initialModel(AppRoute.Library(), '/library'), libraryWith()),
      {
        recentlyViewed: () => [
          {
            kind: 'Album' as const,
            id: 'MPREb_1SbgcDGdrT4',
            title: 'Rumours',
            subtitle: 'Album · Fleetwood Mac',
            maybeArtworkUrl: Option.none(),
          },
        ],
      },
    )
    scene(
      { update, view },
      given(model),
      pageScrolled,
      expect(role('heading', { name: 'Recently Viewed' })).toExist(),
      expect(role('link', { name: /Rumours/ })).toHaveAttr(
        'href',
        '/album/MPREb_1SbgcDGdrT4',
      ),
      click(role('button', { name: 'Clear Recently Viewed' })),
      Command.expectExact(LockScroll()),
      Command.resolveAll([LockScroll, Message.CompletedLockScroll()]),
      sheetFollowsDrags,
      expect(role('dialog', { name: 'Clear Recently Viewed' })).toContainText(
        'Your library stays.',
      ),
    )
  })
})

const rumours: AlbumSummary = {
  id: 'MPREb_1SbgcDGdrT4',
  title: 'Rumours',
  artists: [
    { maybeId: Option.some('UCCzULu3prrEaPvM2ZtkJlYQ'), name: 'Fleetwood Mac' },
  ],
  maybeKind: Option.some('Album'),
  maybeYear: Option.some('1977'),
  artwork: [],
}

const fleetwoodMac: ArtistSummary = {
  id: 'UCCzULu3prrEaPvM2ZtkJlYQ',
  name: 'Fleetwood Mac',
  maybeAudience: Option.some('20M monthly audience'),
  artwork: [],
}

const likedSongs: MyPlaylistSummary = {
  id: 'liked',
  title: 'Liked Songs',
  isLiked: true,
  songCount: 0,
  totalSeconds: 0,
  covers: [],
  updatedAt: 1,
  createdAt: 1,
  maybePlayedAt: Option.none(),
  maybeDescription: Option.none(),
  maybeCoverVideoId: Option.none(),
}

const libraryWith = (overrides: Partial<MyLibrary> = {}): MyLibrary => ({
  playlists: [likedSongs],
  likedVideoIds: [],
  albums: [],
  artists: [],
  albumPlayedAt: {},
  artistPlayedAt: {},
  ...overrides,
})

const withLibrary = (base: Model, library: MyLibrary): Model =>
  modifyFields(base, {
    myLibrary: query =>
      modifyFields(query, { data: () => AsyncData.succeed(library) }),
  })

describe('home', () => {
  const dreams: Song = { ...theChain, videoId: 'mrZRURcb1cM', title: 'Dreams' }
  const landslide: Song = {
    ...theChain,
    videoId: 'WM7-PYtXtJM',
    title: 'Landslide',
    maybeAlbum: Option.some({ id: 'MPREb_fm1975', name: 'Fleetwood Mac' }),
  }
  const fleetwoodMacMix = {
    id: `RDAMVM${theChain.videoId}`,
    title: 'Mix: Fleetwood Mac',
    maybeSubtitle: Option.some('Based on The Chain'),
    artwork: [],
  }
  const tusk: AlbumSummary = {
    ...rumours,
    id: 'MPREb_tusk2026',
    title: 'Tusk (Deluxe)',
    maybeKind: Option.some('Album'),
    maybeYear: Option.some('2026'),
  }
  const roadTrip: MyPlaylistSummary = {
    ...likedSongs,
    id: 'p1',
    title: 'Road trip',
    isLiked: false,
  }

  const withHomeFeed = (base: Model, feed: HomeFeed): Model =>
    modifyFields(base, {
      home: query =>
        modifyFields(query, { data: () => AsyncData.succeed(feed) }),
    })

  /**
   * A phone that has played nothing, on a server where the TV has: The
   * Chain and another song from Rumours, then Landslide on its own.
   */
  const freshPhone = (
    radio: Result.Result<ReadonlyArray<Song>, RequestError> = Result.succeed([
      dreams,
    ]),
  ): Model => {
    const base = withLibrary(
      initialModel(AppRoute.Home(), '/'),
      libraryWith({
        playlists: [likedSongs, roadTrip],
        artists: [fleetwoodMac],
      }),
    )
    const radioLoading = songRadioQuery.loadIfMissing(base.songRadios, {
      videoId: theChain.videoId,
    }).model
    return modifyFields(
      withHomeFeed(base, {
        jumpBackIn: [{ ...rumours, maybeYear: Option.none() }],
        recentlyPlayed: [landslide],
        maybeLastPlayed: Option.some(theChain),
        mixes: [fleetwoodMacMix],
      }),
      {
        newReleases: query =>
          modifyFields(query, { data: () => AsyncData.succeed([tusk]) }),
        songRadios: () =>
          songRadioQuery.update(
            radioLoading,
            songRadioQuery.Message.CompletedFetch({
              args: { videoId: theChain.videoId },
              generation: FIRST_REQUEST_GENERATION,
              result: radio,
            }),
          ).model,
      },
    )
  }

  test('on a fresh phone, shows what played on any device and more like it', () => {
    scene(
      { update, view },
      given(freshPhone()),
      pageScrolled,
      expect(role('heading', { name: 'Jump back in' })).toExist(),
      expect(role('link', { name: /Rumours/ })).toHaveAttr(
        'href',
        '/album/MPREb_1SbgcDGdrT4',
      ),
      expect(role('heading', { name: 'Recently played' })).toExist(),
      expect(role('button', { name: 'Play Landslide' })).toExist(),
      expect(role('heading', { name: 'More like The Chain' })).toExist(),
      expect(role('button', { name: /^Dreams/ })).toExist(),
      expect(role('heading', { name: 'Artists you follow' })).toExist(),
      expect(text('Your music lives here')).toBeAbsent(),
    )
  })

  test('shows a song that played inside its album only once', () => {
    scene(
      { update, view },
      given(freshPhone()),
      pageScrolled,
      expect(role('button', { name: 'Play The Chain' })).toBeAbsent(),
      expect(role('link', { name: /Rumours/ })).toExist(),
    )
  })

  test('offers mixes of what I play most, opening as playlists', () => {
    scene(
      { update, view },
      given(freshPhone()),
      pageScrolled,
      expect(role('heading', { name: 'Your mixes' })).toExist(),
      expect(role('link', { name: /Mix: Fleetwood Mac/ })).toHaveAttr(
        'href',
        `/playlist/RDAMVM${theChain.videoId}`,
      ),
    )
  })

  test('shows what the artists I follow released lately', () => {
    scene(
      { update, view },
      given(freshPhone()),
      pageScrolled,
      expect(
        role('heading', { name: 'New from artists you follow' }),
      ).toExist(),
      expect(role('link', { name: /Tusk \(Deluxe\)/ })).toHaveAttr(
        'href',
        '/album/MPREb_tusk2026',
      ),
    )
  })

  test('shows Liked songs once, as songs, and my other playlists as covers', () => {
    scene(
      { update, view },
      given(freshPhone()),
      pageScrolled,
      expect(role('heading', { name: 'Your playlists' })).toExist(),
      expect(role('link', { name: /Road trip/ })).toExist(),
      expect(role('link', { name: /^Liked songs/ })).toBeAbsent(),
    )
  })

  test('says where music will show once nothing has played anywhere', () => {
    const model = withHomeFeed(
      withLibrary(initialModel(AppRoute.Home(), '/'), libraryWith()),
      {
        jumpBackIn: [],
        recentlyPlayed: [],
        maybeLastPlayed: Option.none(),
        mixes: [],
      },
    )
    scene(
      { update, view },
      given(model),
      pageScrolled,
      expect(text('Your music lives here')).toExist(),
    )
  })

  test('leaves out More like when YouTube does not answer', () => {
    scene(
      { update, view },
      given(freshPhone(Result.fail('YouTubeUnavailable'))),
      pageScrolled,
      expect(role('heading', { name: 'More like The Chain' })).toBeAbsent(),
      expect(role('heading', { name: 'Recently played' })).toExist(),
    )
  })
})

describe('saving to the Library', () => {
  test('an album page saves the album, and says so', () => {
    const route = AppRoute.Album({ albumId: rumours.id })
    const base = withLibrary(
      initialModel(route, `/album/${rumours.id}`),
      libraryWith(),
    )
    const loading = albumQuery.loadIfMissing(base.albums, {
      albumId: rumours.id,
    }).model
    const model = modifyFields(base, {
      albums: () =>
        albumQuery.update(
          loading,
          albumQuery.Message.CompletedFetch({
            args: { albumId: rumours.id },
            generation: FIRST_REQUEST_GENERATION,
            result: Result.succeed({
              album: rumours,
              maybeDescription: Option.none(),
              maybeLengthSummary: Option.none(),
              tracks: [theChain],
              explicitVideoIds: [],
              maybeRadio: Option.none(),
            }),
          }),
        ).model,
    })
    const edit = {
      _tag: 'SetAlbumSaved' as const,
      album: rumours,
      isSaved: true,
    }
    scene(
      { update, view },
      given(model),
      pageScrolled,
      titleBarFollowsScroll,
      click(role('button', { name: 'Save to Library' })),
      expect(role('button', { name: 'Remove from Library' })).toExist(),
      Command.expectExact(EditPlaylists({ edit })),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit,
          result: Result.succeed({
            library: libraryWith({ albums: [rumours] }),
            maybePlaylist: Option.none(),
          }),
        }),
      ),
      expect(text('Saved to your Library')).toExist(),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({
          message: 'Saved to your Library',
        }),
      ),
    )
  })

  test('an artist page follows the artist', () => {
    const route = AppRoute.Artist({ artistId: fleetwoodMac.id })
    const base = withLibrary(
      initialModel(route, `/artist/${fleetwoodMac.id}`),
      libraryWith(),
    )
    const loading = artistQuery.loadIfMissing(base.artists, {
      artistId: fleetwoodMac.id,
    }).model
    const model = modifyFields(base, {
      artists: () =>
        artistQuery.update(
          loading,
          artistQuery.Message.CompletedFetch({
            args: { artistId: fleetwoodMac.id },
            generation: FIRST_REQUEST_GENERATION,
            result: Result.succeed({
              artist: fleetwoodMac,
              maybeDescription: Option.none(),
              topSongs: [theChain],
              topSongPlays: {},
              maybeAllSongsPlaylistId: Option.none(),
              albums: [rumours],
              singles: [],
              relatedArtists: [],
              maybeRadio: Option.none(),
            }),
          }),
        ).model,
    })
    const edit = {
      _tag: 'SetArtistFollowed' as const,
      artist: fleetwoodMac,
      isFollowed: true,
    }
    scene(
      { update, view },
      given(model),
      pageScrolled,
      titleBarFollowsScroll,
      click(role('button', { name: 'Follow Fleetwood Mac' })),
      expect(role('button', { name: 'Unfollow Fleetwood Mac' })).toHaveText(
        'Following',
      ),
      Command.expectExact(EditPlaylists({ edit })),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit,
          result: Result.succeed({
            library: libraryWith({ artists: [fleetwoodMac] }),
            maybePlaylist: Option.none(),
          }),
        }),
      ),
    )
  })
})

describe('downloads', () => {
  const albumId = 'MPREb_1SbgcDGdrT4'
  const rumoursPage = (downloads: Downloads): Model =>
    modifyFields(
      update(
        update(
          emptySearchModel,
          Message.ChangedUrl({
            url: urlOrThrow(`http://localhost/album/${albumId}`),
          }),
        ).model,
        Message.GotAlbumMessage({
          message: albumQuery.Message.CompletedFetch({
            args: { albumId },
            generation: FIRST_REQUEST_GENERATION,
            result: Result.succeed({
              album: {
                id: albumId,
                title: 'Rumours',
                artists: theChain.artists,
                maybeKind: Option.some('Album'),
                maybeYear: Option.some('1977'),
                artwork: [],
              },
              maybeDescription: Option.none(),
              maybeLengthSummary: Option.none(),
              tracks: [theChain],
              explicitVideoIds: [],
              maybeRadio: Option.none(),
            }),
          }),
        }),
      ).model,
      { downloads: () => downloads },
    )

  const ready = (
    collections: ReadonlyArray<DownloadedCollection>,
    savedBytes: Readonly<Record<string, number>>,
  ): Downloads =>
    Downloads.Ready({
      collections,
      savedBytes,
      failedVideoIds: [],
      maybeDownloading: Option.none(),
      maybeStorage: Option.none(),
      isOutOfSpace: false,
    })

  const rumoursDownload: DownloadedCollection = {
    kind: 'Album',
    id: albumId,
    title: 'Rumours',
    subtitle: 'Fleetwood Mac',
    maybeArtworkUrl: Option.none(),
    videoIds: [theChain.videoId],
  }

  test('Download on an album keeps its songs on the phone', () => {
    scene(
      { update, view },
      given(rumoursPage(ready([], {}))),
      pageScrolled,
      titleBarFollowsScroll,
      click(role('button', { name: 'Download' })),
      Command.expectExact(
        SaveDownloads({ collections: [rumoursDownload] }),
        DownloadSong({ videoId: theChain.videoId }),
      ),
      expect(role('button', { name: 'Downloading, 0 of 1 songs' })).toExist(),
      expect(text('Downloading 0 of 1')).toExist(),
      Command.resolveAll(
        [SaveDownloads, Message.CompletedSaveDownloads()],
        [
          DownloadSong,
          Message.SucceededDownloadSong({
            videoId: theChain.videoId,
            bytes: 5 * 1024 * 1024,
            maybeStorage: Option.none(),
          }),
        ],
      ),
      expect(text('Downloaded · 5 MB')).toExist(),
      expect(
        role('button', { name: 'Downloaded. Remove from Downloads' }),
      ).toExist(),
    )
  })

  test('a phone that cannot download shows no Download button', () => {
    scene(
      { update, view },
      given(rumoursPage(Downloads.Unavailable())),
      pageScrolled,
      titleBarFollowsScroll,
      expect(role('button', { name: 'Download' })).not.toExist(),
    )
  })

  test('the Library lists downloads with the room they take', () => {
    scene(
      { update, view },
      given(
        modifyFields(initialModel(AppRoute.Library(), '/library'), {
          libraryFilter: () => 'Downloaded',
          downloads: () =>
            ready([rumoursDownload], { [theChain.videoId]: 5 * 1024 * 1024 }),
        }),
      ),
      pageScrolled,
      expect(text('5 MB downloaded')).toExist(),
      expect(text('1 song · 5 MB')).toExist(),
      expect(role('link', { name: /Rumours/ })).toHaveAttr(
        'href',
        `/album/${albumId}`,
      ),
      click(role('button', { name: 'Remove Rumours from Downloads' })),
      Command.expectExact(LockScroll()),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      expect(
        role('heading', { name: 'Remove “Rumours” from Downloads?' }),
      ).toExist(),
    )
  })
})

describe('sleep timer', () => {
  const SERVER_NOW = 1_000_000
  const playingOnTv = (sleepTimer: Session.SleepTimer | null): Model =>
    modifyFields(initialModel(AppRoute.Library(), '/library'), {
      maybeIdentity: () =>
        Option.some({ deviceId: 'phone-1', deviceName: 'iPhone' }),
      playerSheet: () => PlayerSheet.Open(),
      now: () => SERVER_NOW,
      maybeSession: () =>
        Option.some({
          clockOffsetMs: 0,
          state: {
            devices: [
              {
                id: 'tv',
                name: 'TV',
                kind: 'Tv',
                online: true,
                waking: false,
                poweredOn: true,
                volume: null,
              },
            ],
            activeDeviceId: 'tv',
            queue: [
              {
                entryId: 'e0',
                track: toQueueTrack(theChain),
                autoplay: false,
              },
            ],
            currentEntryId: 'e0',
            playing: true,
            positionSeconds: 10,
            positionAt: SERVER_NOW,
            seekSeq: 1,
            autoplay: true,
            repeat: 'Off',
            shuffle: false,
            sleepTimer,
            playingFrom: null,
          },
        }),
    })

  const playerMounts = Mount.resolveAll(
    [DragToDismiss, Message.CompletedFollowSheetDrags()],
    [Marquee, Message.CompletedSyncMarquee()],
    [FollowSeekBarDrags, Message.CompletedFollowSeekBarDrags()],
  )

  test('the player says what it plays from, and opens it', () => {
    const rumours: Session.PlayingFrom = {
      kind: 'Album',
      title: 'Rumours',
      id: 'MPREb_1SbgcDGdrT4',
    }
    const model = modifyFields(playingOnTv(null), {
      maybeSession: maybeSession =>
        Option.map(maybeSession, session => ({
          ...session,
          state: { ...session.state, playingFrom: rumours },
        })),
    })
    scene(
      { update, view },
      given(model),
      pageScrolled,
      playerMounts,
      expect(text('Playing from Album')).toExist(),
      expect(role('link', { name: 'Playing from album Rumours' })).toHaveAttr(
        'href',
        '/album/MPREb_1SbgcDGdrT4',
      ),
    )
  })

  test('the moon sets a timer on the server, which stops the TV too', () => {
    scene(
      { update, view },
      given(playingOnTv(null)),
      pageScrolled,
      playerMounts,
      click(role('button', { name: 'Sleep Timer' })),
      Command.expectExact(LockScroll()),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      expect(role('heading', { name: 'Sleep Timer' })).toExist(),
      expect(role('button', { name: 'Turn Off Timer' })).not.toExist(),
      click(role('button', { name: '15 minutes' })),
      Command.expectExact(
        UnlockScroll(),
        SendToSession({
          message: {
            _tag: 'SetSleepTimer',
            timer: { _tag: 'Minutes', minutes: 15 },
          },
        }),
      ),
      Command.resolveAll(
        [UnlockScroll, Message.CompletedUnlockScroll()],
        [SendToSession, Message.CompletedSendToSession()],
      ),
    )
  })

  test('a timer shows the time left, and can be turned off', () => {
    scene(
      { update, view },
      given(
        playingOnTv({ _tag: 'At', endsAt: SERVER_NOW + 29 * 60_000 + 30_000 }),
      ),
      pageScrolled,
      playerMounts,
      expect(role('button', { name: 'Sleep Timer: 29:30' })).toExist(),
      click(role('button', { name: 'Sleep Timer: 29:30' })),
      Command.expectExact(LockScroll()),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      expect(text('The music stops in 29:30.')).toExist(),
      click(role('button', { name: 'Turn Off Timer' })),
      Command.expectExact(
        UnlockScroll(),
        SendToSession({ message: { _tag: 'SetSleepTimer', timer: null } }),
      ),
      Command.resolveAll(
        [UnlockScroll, Message.CompletedUnlockScroll()],
        [SendToSession, Message.CompletedSendToSession()],
      ),
    )
  })

  test('a timer for the end of the song says so', () => {
    scene(
      { update, view },
      given(playingOnTv({ _tag: 'EndOfSong' })),
      pageScrolled,
      playerMounts,
      expect(role('button', { name: 'Sleep Timer: End of song' })).toExist(),
    )
  })
})
