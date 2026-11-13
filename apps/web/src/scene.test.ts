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
  type MyLibrary,
  type MyPlaylistSummary,
  type Song,
} from '@music/shared'

import {
  EditPlaylists,
  LockScroll,
  ReplaceSearchUrl,
  SaveRecentSearches,
  ScrollSearchResultsToTop,
  UnlockScroll,
} from './command'
import { Message } from './message'
import { type Model } from './model'
import { DragToDismiss, RestoreScroll, SyncTitleBarReveal } from './mount'
import {
  SendToSession,
  UnlockPhoneAudio,
  WaitBeforeHideNotice,
} from './playback/command'
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
        }),
      }),
    }),
  ).model

describe('artist page', () => {
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
              albums: [],
              artists: [],
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
      expect(role('heading', { name: 'Recently viewed' })).toExist(),
      expect(role('link', { name: /Rumours/ })).toHaveAttr(
        'href',
        '/album/MPREb_1SbgcDGdrT4',
      ),
      click(role('button', { name: 'Clear recently viewed' })),
      Command.expectExact(LockScroll()),
      Command.resolveAll([LockScroll, Message.CompletedLockScroll()]),
      sheetFollowsDrags,
      expect(role('dialog', { name: 'Clear recently viewed' })).toContainText(
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
  title: 'Liked songs',
  isLiked: true,
  songCount: 0,
  totalSeconds: 0,
  covers: [],
  updatedAt: 1,
}

const libraryWith = (overrides: Partial<MyLibrary> = {}): MyLibrary => ({
  playlists: [likedSongs],
  likedVideoIds: [],
  albums: [],
  artists: [],
  ...overrides,
})

const withLibrary = (base: Model, library: MyLibrary): Model =>
  modifyFields(base, {
    myLibrary: query =>
      modifyFields(query, { data: () => AsyncData.succeed(library) }),
  })

describe('home', () => {
  const dreams: Song = { ...theChain, videoId: 'mrZRURcb1cM', title: 'Dreams' }

  /** A phone that has played nothing, on a server where the TV has. */
  const freshPhone = (
    radio: Result.Result<ReadonlyArray<Song>, RequestError> = Result.succeed([
      dreams,
    ]),
  ): Model => {
    const base = withLibrary(
      initialModel(AppRoute.Home(), '/'),
      libraryWith({ artists: [fleetwoodMac] }),
    )
    const radioLoading = songRadioQuery.loadIfMissing(base.songRadios, {
      videoId: theChain.videoId,
    }).model
    return modifyFields(base, {
      home: query =>
        modifyFields(query, {
          data: () =>
            AsyncData.succeed({
              jumpBackIn: [{ ...rumours, maybeYear: Option.none() }],
              recentlyPlayed: [theChain],
            }),
        }),
      songRadios: () =>
        songRadioQuery.update(
          radioLoading,
          songRadioQuery.Message.CompletedFetch({
            args: { videoId: theChain.videoId },
            generation: FIRST_REQUEST_GENERATION,
            result: radio,
          }),
        ).model,
    })
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
      expect(role('button', { name: 'Play The Chain' })).toExist(),
      expect(role('heading', { name: 'More like The Chain' })).toExist(),
      expect(role('button', { name: /^Dreams/ })).toExist(),
      expect(role('heading', { name: 'Artists you follow' })).toExist(),
      expect(text('Your music lives here')).toBeAbsent(),
    )
  })

  test('says where music will show once nothing has played anywhere', () => {
    const model = modifyFields(
      withLibrary(initialModel(AppRoute.Home(), '/'), libraryWith()),
      {
        home: query =>
          modifyFields(query, {
            data: () =>
              AsyncData.succeed({ jumpBackIn: [], recentlyPlayed: [] }),
          }),
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
