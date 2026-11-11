import { Option, Result } from 'effect'
import {
  Command,
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

import { ReplaceSearchUrl, SaveRecentSearches } from './command'
import { Message } from './message'
import { type Model } from './model'
import { initialPlaybackModel } from './playback/domain'
import {
  type RequestError,
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  songQuery,
  songSearchQuery,
} from './query'
import { AppRoute, searchUrl } from './route'
import { update } from './update'
import { view } from './view'

const FIRST_REQUEST_GENERATION = 1

const emptySearchModel: Model = {
  route: AppRoute.Search({ q: Option.none(), kind: Option.none() }),
  searchInput: '',
  recentSearches: [],
  songSearch: songSearchQuery.init(),
  artistSearch: artistSearchQuery.init(),
  albumSearch: albumSearchQuery.init(),
  songs: songQuery.init(),
  artists: artistQuery.init(),
  albums: albumQuery.init(),
  ...initialPlaybackModel,
}

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
      expect(role('heading', { name: 'Recent searches' })).toExist(),
      click(role('button', { name: 'rumours' })),
      Command.expectExact(
        ReplaceSearchUrl({ url: '/?q=rumours' }),
        SaveRecentSearches({ recentSearches: ['rumours'] }),
      ),
      Command.resolveAll(
        [ReplaceSearchUrl, Message.CompletedReplaceSearchUrl()],
        [SaveRecentSearches, Message.CompletedSaveRecentSearches()],
      ),
      expect(label('Search music')).toHaveValue('rumours'),
    )
  })

  test('with no history, explains what the app does', () => {
    scene(
      { update, view },
      given(emptySearchModel),
      expect(text('Search YouTube Music')).toExist(),
    )
  })

  test('lists songs with credits and length once results arrive', () => {
    scene(
      { update, view },
      given(searchResultModel('the chain', Result.succeed([theChain]))),
      expect(role('link', { name: /The Chain/ })).toHaveAttr(
        'href',
        '/song/FhgFtXESdPk',
      ),
      expect(text('Fleetwood Mac · Rumours')).toExist(),
      expect(text('4:30')).toExist(),
    )
  })

  test('a failed search explains the problem and offers a retry', () => {
    scene(
      { update, view },
      given(searchResultModel('tusk', Result.fail('ServerUnreachable'))),
      expect(role('alert')).toContainText('Could not reach the music server'),
      expect(role('button', { name: 'Retry' })).toExist(),
    )
  })
})
