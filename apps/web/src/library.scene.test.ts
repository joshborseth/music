import { Option, Result } from 'effect'
import { AsyncData } from 'foldkit'
import {
  Command,
  Mount,
  all,
  click,
  expect,
  first,
  given,
  label,
  nth,
  role,
  scene,
  text,
  type,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import {
  type AlbumSummary,
  type MyLibrary,
  type MyPlaylistDetails,
  type MyPlaylistSummary,
  type Song,
} from '@music/shared'

import { LockScroll, SaveLibraryPrefs, UnlockScroll } from './command'
import { Message } from './message'
import { type Model } from './model'
import {
  DragToDismiss,
  FollowPlaylistDrags,
  RestoreScroll,
  SyncTitleBarReveal,
} from './mount'
import { myPlaylistQuery } from './query'
import { AppRoute } from './route'
import { initialModel, update } from './update'
import { view } from './view'

const pageScrolled = Mount.resolve(
  RestoreScroll,
  Message.CompletedRestoreScroll(),
)

const titleBarFollowsScroll = Mount.resolve(
  SyncTitleBarReveal,
  Message.CompletedSyncTitleBarReveal(),
)

const sheetFollowsDrags = Mount.resolve(
  DragToDismiss,
  Message.CompletedFollowSheetDrags(),
)

const playlist = (
  id: string,
  title: string,
  overrides: Partial<MyPlaylistSummary> = {},
): MyPlaylistSummary => ({
  id,
  title,
  isLiked: id === 'liked',
  songCount: 1,
  totalSeconds: 270,
  covers: [],
  updatedAt: 1,
  createdAt: 1,
  maybePlayedAt: Option.none(),
  maybeDescription: Option.none(),
  maybeCoverVideoId: Option.none(),
  ...overrides,
})

const album = (id: string, title: string, artist: string): AlbumSummary => ({
  id,
  title,
  artists: [{ maybeId: Option.none(), name: artist }],
  maybeKind: Option.some('Album'),
  maybeYear: Option.some('1977'),
  artwork: [],
})

const library: MyLibrary = {
  playlists: [
    playlist('liked', 'Liked Songs'),
    playlist('road-trip', 'Road trip', { createdAt: 1 }),
    playlist('beach', 'Beach day', { createdAt: 3 }),
    playlist('work', 'Focus', { createdAt: 2 }),
  ],
  likedVideoIds: [],
  albums: [
    album('rumours', 'Rumours', 'Fleetwood Mac'),
    album('abbey', 'Abbey Road', 'The Beatles'),
  ],
  artists: [],
  albumPlayedAt: {},
  artistPlayedAt: {},
}

const libraryModel = (overrides: Partial<Pick<Model, 'libraryFilter'>> = {}) =>
  modifyFields(initialModel(AppRoute.Library(), '/library'), {
    myLibrary: query =>
      modifyFields(query, { data: () => AsyncData.succeed(library) }),
    libraryFilter: filter => overrides.libraryFilter ?? filter,
  })

const playlistLinks = all.role('link', { name: /Road trip|Beach day|Focus/ })

describe('library search', () => {
  test('narrows the Library to what matches, and says when nothing does', () => {
    scene(
      { update, view },
      given(libraryModel()),
      pageScrolled,
      type(label('Search your Library'), 'beach'),
      expect(role('link', { name: /Beach day/ })).toExist(),
      expect(role('link', { name: /Road trip/ })).toBeAbsent(),
      expect(role('link', { name: /Rumours/ })).toBeAbsent(),
      expect(role('button', { name: /New Playlist/ })).toBeAbsent(),
      type(label('Search your Library'), 'fleetwood'),
      expect(role('link', { name: /Rumours/ })).toExist(),
      expect(role('heading', { name: 'Playlists' })).toBeAbsent(),
      type(label('Search your Library'), 'zzz'),
      expect(text('No matches')).toExist(),
      click(role('button', { name: 'Clear search' })),
      expect(role('link', { name: /Road trip/ })).toExist(),
    )
  })
})

describe('library sorting and layout', () => {
  test('sorts playlists from a sheet, Liked Songs still first', () => {
    const sorted = {
      sorts: {
        Playlists: 'RecentlyAdded' as const,
        Albums: 'RecentlyAdded' as const,
        Artists: 'RecentlyAdded' as const,
      },
      layouts: { Playlists: 'List' as const, Albums: 'Grid' as const },
    }
    scene(
      { update, view },
      given(libraryModel({ libraryFilter: 'Playlists' })),
      pageScrolled,
      expect(first(playlistLinks)).toHaveText(/Road trip/),
      click(role('button', { name: 'Sort Playlists: Recently Updated' })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      expect(role('dialog', { name: 'Sort Playlists By' })).toExist(),
      expect(role('button', { name: 'Recently Updated' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expect(role('button', { name: 'Artist' })).toBeAbsent(),
      click(role('button', { name: 'Recently Added' })),
      Command.expectExact(UnlockScroll(), SaveLibraryPrefs({ prefs: sorted })),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Command.resolve(SaveLibraryPrefs, Message.CompletedSaveLibraryPrefs()),
      expect(first(all.role('link', { name: /Liked Songs/ }))).toExist(),
      expect(first(playlistLinks)).toHaveText(/Beach day/),
      expect(nth(playlistLinks, 1)).toHaveText(/Focus/),
      expect(
        role('button', { name: 'Sort Playlists: Recently Added' }),
      ).toExist(),
    )
  })

  test('albums switch between a grid and a list', () => {
    scene(
      { update, view },
      given(libraryModel({ libraryFilter: 'Albums' })),
      pageScrolled,
      expect(role('link', { name: /Rumours/ })).toHaveText(/Fleetwood Mac/),
      click(role('button', { name: 'Show as List' })),
      Command.resolve(SaveLibraryPrefs, Message.CompletedSaveLibraryPrefs()),
      expect(role('link', { name: /Rumours/ })).toHaveText(
        /Album · Fleetwood Mac · 1977/,
      ),
      expect(role('button', { name: 'Show as Grid' })).toExist(),
    )
  })
})

const theChain: Song = {
  videoId: 'FhgFtXESdPk',
  title: 'The Chain',
  artists: [{ maybeId: Option.none(), name: 'Fleetwood Mac' }],
  maybeAlbum: Option.some({ id: 'MPREb_rumours', name: 'Rumours' }),
  maybeDurationSeconds: Option.some(270),
  artwork: [
    { url: 'https://lh3.googleusercontent.com/c', width: 60, height: 60 },
  ],
}

const dreams: Song = {
  ...theChain,
  videoId: 'mrZRURcb1cM',
  title: 'Dreams',
  maybeAlbum: Option.some({ id: 'MPREb_other', name: 'Other' }),
}

const playlistPage = (details: MyPlaylistDetails): Model => {
  const playlistId = details.playlist.id
  const base = initialModel(
    AppRoute.MyPlaylist({ playlistId }),
    `/library/playlist/${playlistId}`,
  )
  const loading = myPlaylistQuery.loadIfMissing(base.myPlaylists, {
    playlistId,
  }).model
  const loaded = myPlaylistQuery.update(
    loading,
    myPlaylistQuery.Message.CompletedFetch({
      args: { playlistId },
      generation: 1,
      result: Result.succeed(details),
    }),
  ).model
  return modifyFields(base, { myPlaylists: () => loaded })
}

describe('editing my playlist', () => {
  const roadTrip = playlist('road-trip', 'Road trip', {
    songCount: 2,
    maybeDescription: Option.some('Windows down.'),
  })
  const page = playlistPage({ playlist: roadTrip, songs: [theChain, dreams] })

  test('shows the description, and Edit turns the page into fields', () => {
    scene(
      { update, view },
      given(page),
      pageScrolled,
      titleBarFollowsScroll,
      expect(text('Windows down.')).toExist(),
      click(role('button', { name: 'Playlist Options' })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      click(role('button', { name: 'Edit Playlist' })),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Mount.resolve(
        FollowPlaylistDrags,
        Message.CompletedFollowPlaylistDrags(),
      ),
      expect(label('Playlist name')).toHaveValue('Road trip'),
      expect(label('Description')).toHaveValue('Windows down.'),
      expect(role('button', { name: 'Done' })).toExist(),
      expect(role('button', { name: 'Change Cover' })).toExist(),
      expect(role('button', { name: 'Add Songs' })).toExist(),
      expect(role('button', { name: 'Remove The Chain' })).toExist(),
      expect(role('button', { name: 'Play' })).toBeAbsent(),
    )
  })

  test('the cover choice offers the mosaic and each song’s cover', () => {
    const editing = update(
      page,
      Message.ClickedEditPlaylist({ playlistId: roadTrip.id }),
    ).model
    scene(
      { update, view },
      given(editing),
      pageScrolled,
      titleBarFollowsScroll,
      Mount.resolve(
        FollowPlaylistDrags,
        Message.CompletedFollowPlaylistDrags(),
      ),
      click(role('button', { name: 'Change Cover' })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      expect(role('button', { name: 'Mosaic' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expect(role('button', { name: 'Cover of The Chain' })).toExist(),
      expect(role('button', { name: 'Cover of Dreams' })).toExist(),
    )
  })
})
