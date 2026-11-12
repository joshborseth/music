import { Option, Result } from 'effect'
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
import { type RequestError, songSearchQuery } from './query'
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
      expect(role('heading', { name: 'Recent searches' })).toExist(),
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

  test('with no history, explains what the app does', () => {
    scene(
      { update, view },
      given(emptySearchModel),
      pageScrolled,
      expect(text('Search YouTube Music')).toExist(),
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
      expect(text('Nothing here yet')).toExist(),
    )
  })
})
