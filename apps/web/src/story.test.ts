import { Option, Result } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { fromString } from 'foldkit/url'
import { describe, expect, test } from 'vitest'

import { type Song } from '@music/shared'

import {
  FocusSearchInput,
  ReplaceSearchUrl,
  SaveRecentSearches,
  WaitBeforeSearch,
} from './command'
import { MAX_RECENT_SEARCHES } from './constant'
import { Message } from './message'
import { type Model } from './model'
import { initialPlaybackModel } from './playback/domain'
import {
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  songQuery,
  songSearchQuery,
} from './query'
import { AppRoute, searchUrl } from './route'
import { update } from './update'

const FIRST_REQUEST_GENERATION = 1

const urlOrThrow = (raw: string) =>
  Option.getOrThrowWith(
    fromString(raw),
    () => new Error(`Failed to parse url: ${raw}`),
  )

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

describe('search route', () => {
  test('omits the default kind and an empty query from the URL', () => {
    expect(searchUrl('', 'Songs')).toBe('/')
    expect(searchUrl('the chain', 'Artists')).toBe('/?q=the+chain&kind=Artists')
  })

  test('an unknown kind falls back to songs and still searches', () => {
    story(
      update,
      given(emptySearchModel),
      message(
        Message.ChangedUrl({
          url: urlOrThrow('http://localhost/?q=rumours&kind=Podcasts'),
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
      Command.expectExact(ReplaceSearchUrl({ url: '/?q=fleetwood' })),
      Command.resolve(ReplaceSearchUrl, Message.CompletedReplaceSearchUrl()),
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
          url: urlOrThrow('http://localhost/?q=fleetwood'),
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
        ReplaceSearchUrl({ url: '/?q=rumours' }),
        SaveRecentSearches({ recentSearches: ['rumours', 'tusk'] }),
      ),
      Command.resolve(ReplaceSearchUrl, Message.CompletedReplaceSearchUrl()),
      Command.resolve(
        SaveRecentSearches,
        Message.CompletedSaveRecentSearches(),
      ),
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
        SaveRecentSearches,
        Message.CompletedSaveRecentSearches(),
      ),
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
      Command.expectExact(ReplaceSearchUrl({ url: '/' }), FocusSearchInput()),
      Command.resolve(ReplaceSearchUrl, Message.CompletedReplaceSearchUrl()),
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
            relatedSongs: [],
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
