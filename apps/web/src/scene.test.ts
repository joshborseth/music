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

import { type Song } from '@music/shared'

import {
  LockScroll,
  ReplaceSearchUrl,
  SaveRecentSearches,
  ScrollSearchResultsToTop,
} from './command'
import { Message } from './message'
import { type Model } from './model'
import { DragToDismiss, RestoreScroll } from './mount'
import { SendToSession, UnlockPhoneAudio } from './playback/command'
import { toQueueTrack } from './playback/queueTrack'
import {
  type RequestError,
  songSearchQuery,
  topResultSearchQuery,
} from './query'
import { AppRoute, searchUrl } from './route'
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

const urlOrThrow = (raw: string) =>
  Option.getOrThrowWith(
    fromString(raw),
    () => new Error(`Failed to parse url: ${raw}`),
  )

const searchResultModel = (
  query: string,
  result: Result.Result<ReadonlyArray<Song>, RequestError>,
): Model => {
  const searchOpen = update(
    emptySearchModel,
    Message.ChangedUrl({
      url: urlOrThrow(`http://localhost${searchUrl(query, 'Songs')}`),
    }),
  )
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
    )
    const withTopResult = update(
      searched,
      Message.GotTopResultSearchMessage({
        message: topResultSearchQuery.Message.CompletedFetch({
          args: { query: 'fleetwood mac' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(
            Option.some({
              _tag: 'Artist' as const,
              artist: {
                id: 'UCCzULu3prrEaPvM2ZtkJlYQ',
                name: 'Fleetwood Mac',
                maybeAudience: Option.some('20M monthly audience'),
                artwork: [],
              },
            }),
          ),
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

  test('lists songs with their credits once results arrive', () => {
    scene(
      { update, view },
      given(searchResultModel('the chain', Result.succeed([theChain]))),
      pageScrolled,
      expect(role('button', { name: /The Chain/ })).toExist(),
      expect(text('Fleetwood Mac · Rumours')).toExist(),
    )
  })

  test('tapping a song plays it', () => {
    scene(
      { update, view },
      given(searchResultModel('the chain', Result.succeed([theChain]))),
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
