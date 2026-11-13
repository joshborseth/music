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

import { type AlbumSummary, type ArtistSummary, type Song } from '@music/shared'

import {
  LockScroll,
  ReplaceSearchUrl,
  SaveRecentSearches,
  ScrollSearchResultsToTop,
  UnlockScroll,
} from './command'
import { Message } from './message'
import { type Model } from './model'
import { DragToDismiss, RestoreScroll, SyncTitleBarReveal } from './mount'
import { SendToSession, UnlockPhoneAudio } from './playback/command'
import { toQueueTrack } from './playback/queueTrack'
import {
  type RequestError,
  albumQuery,
  albumSearchQuery,
  artistSearchQuery,
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

  test('with no results yet, keeps what the page showed until they arrive', () => {
    const typed = update(
      modifyFields(emptySearchModel, { recentSearches: () => ['rumours'] }),
      searchUrlChange('the chain', 'Top'),
    ).model
    scene(
      { update, view },
      given(typed),
      pageScrolled,
      expect(role('status', { name: 'Searching' })).toExist(),
      expect(role('heading', { name: 'Recently Searched' })).toExist(),
      expect(role('heading', { name: 'Songs' })).toBeAbsent(),
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
      expect(role('button', { name: 'Play next' })).toExist(),
      expect(role('link', { name: 'Go to album' })).toHaveAttr(
        'href',
        '/album/MPREb_1SbgcDGdrT4',
      ),
      expect(role('link', { name: 'Go to artist' })).toHaveAttr(
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
      click(role('button', { name: 'Start radio' })),
      Command.expectExact(
        UnlockScroll(),
        UnlockPhoneAudio(),
        SendToSession({
          message: {
            _tag: 'PlayQueue',
            tracks: [toQueueTrack(theChain)],
            startIndex: 0,
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

describe('album page', () => {
  test('a song listed twice keeps both rows, each playing the album from its own place', () => {
    // YouTube sometimes gives two tracks of an album the same video.
    const interlude: Song = { ...theChain, title: 'The Chain (Interlude)' }
    const tracks = [theChain, interlude]
    const albumId = 'MPREb_1SbgcDGdrT4'
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
          }),
        }),
      }),
    ).model
    scene(
      { update, view },
      given(albumModel),
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
          },
        }),
      ),
      Command.resolveAll(
        [UnlockPhoneAudio, Message.CompletedUnlockPhoneAudio()],
        [SendToSession, Message.CompletedSendToSession()],
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
                  title: 'Liked songs',
                  isLiked: true,
                  songCount: 1,
                  totalSeconds: 270,
                  covers: [],
                  updatedAt: 2,
                },
                {
                  id: 'road-trip',
                  title: 'Road trip',
                  isLiked: false,
                  songCount: 12,
                  totalSeconds: 3_900,
                  covers: [],
                  updatedAt: 1,
                },
              ],
              likedVideoIds: ['FhgFtXESdPk'],
            }),
        }),
    })
    scene(
      { update, view },
      given(model),
      pageScrolled,
      expect(role('link', { name: /Liked songs/ })).toHaveAttr(
        'href',
        '/library/playlist/liked',
      ),
      expect(text('12 songs · 1 hr 5 min')).toExist(),
    )
  })
})
