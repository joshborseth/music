import { Option, Result } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import {
  LIKED_PLAYLIST_ID,
  type MyLibrary,
  type MyPlaylistDetails,
  type MyPlaylistSummary,
  type Song,
} from '@music/shared'

import {
  EditPlaylists,
  FocusPlaylistTitleInput,
  LockScroll,
  NavigateBack,
  NavigateInternal,
  UnlockScroll,
} from './command'
import { Message } from './message'
import { type Model } from './model'
import { WaitBeforeHideNotice } from './playback/command'
import { myLibraryQuery, myPlaylistQuery } from './query'
import { AppRoute } from './route'
import { ActionSheet } from './sheet'
import { initialModel, likedVideoIds, update } from './update'

const FIRST_REQUEST_GENERATION = 1

const theChain: Song = {
  videoId: 'FhgFtXESdPk',
  title: 'The Chain',
  artists: [{ maybeId: Option.none(), name: 'Fleetwood Mac' }],
  maybeAlbum: Option.some({ id: 'MPREb_1SbgcDGdrT4', name: 'Rumours' }),
  maybeDurationSeconds: Option.some(270),
  artwork: [],
}

const dreams: Song = { ...theChain, videoId: 'mrZRURcb1cM', title: 'Dreams' }

const summary = (
  id: string,
  title: string,
  songCount: number,
): MyPlaylistSummary => ({
  id,
  title,
  isLiked: id === LIKED_PLAYLIST_ID,
  songCount,
  totalSeconds: songCount * 270,
  covers: [],
  updatedAt: 1,
})

const liked = summary(LIKED_PLAYLIST_ID, 'Liked songs', 0)
const roadTrip = summary('road-trip', 'Road trip', 1)

const libraryOf = (
  playlists: ReadonlyArray<MyPlaylistSummary>,
  likedIds: ReadonlyArray<string> = [],
): MyLibrary => ({ playlists, likedVideoIds: likedIds })

const withLibrary = (base: Model, library: MyLibrary): Model =>
  modifyFields(base, {
    myLibrary: query =>
      modifyFields(query, { data: () => AsyncData.succeed(library) }),
  })

const libraryModel = withLibrary(
  initialModel(AppRoute.Library(), '/library'),
  libraryOf([liked, roadTrip]),
)

/** The page of one of my playlists, loaded with `details`. */
const playlistPageModel = (details: MyPlaylistDetails): Model => {
  const route = AppRoute.MyPlaylist({ playlistId: details.playlist.id })
  const base = initialModel(route, `/library/playlist/${details.playlist.id}`)
  const loading = myPlaylistQuery.loadIfMissing(base.myPlaylists, {
    playlistId: details.playlist.id,
  }).model
  const loaded = myPlaylistQuery.update(
    loading,
    myPlaylistQuery.Message.CompletedFetch({
      args: { playlistId: details.playlist.id },
      generation: FIRST_REQUEST_GENERATION,
      result: Result.succeed(details),
    }),
  ).model
  return withLibrary(
    modifyFields(base, { myPlaylists: () => loaded }),
    libraryOf([liked, details.playlist]),
  )
}

const shownSongs = (
  current: Model,
  playlistId: string,
): ReadonlyArray<string> =>
  Option.match(
    AsyncData.getData(
      myPlaylistQuery.read(current.myPlaylists, { playlistId }),
    ),
    {
      onNone: () => [],
      onSome: ({ songs }) => songs.map(({ videoId }) => videoId),
    },
  )

describe('liking a song', () => {
  test('fills the heart at once and keeps what the server says', () => {
    const savedLibrary = libraryOf(
      [{ ...liked, songCount: 1 }, roadTrip],
      [theChain.videoId],
    )
    story(
      update,
      given(libraryModel),
      message(Message.ClickedToggleLiked({ song: theChain })),
      model(current => {
        expect(likedVideoIds(current)).toStrictEqual([theChain.videoId])
      }),
      Command.expectExact(
        EditPlaylists({
          edit: { _tag: 'SetLiked', song: theChain, isLiked: true },
        }),
      ),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit: { _tag: 'SetLiked', song: theChain, isLiked: true },
          result: Result.succeed({
            library: savedLibrary,
            maybePlaylist: Option.some({
              playlist: { ...liked, songCount: 1 },
              songs: [theChain],
            }),
          }),
        }),
      ),
      model(current => {
        expect(
          AsyncData.getData(myLibraryQuery.read(current.myLibrary)),
        ).toStrictEqual(Option.some(savedLibrary))
      }),
    )
  })

  test('tapping the heart again unlikes the song', () => {
    story(
      update,
      given(withLibrary(libraryModel, libraryOf([liked], [theChain.videoId]))),
      message(Message.ClickedToggleLiked({ song: theChain })),
      model(current => {
        expect(likedVideoIds(current)).toStrictEqual([])
      }),
      Command.expectExact(
        EditPlaylists({
          edit: { _tag: 'SetLiked', song: theChain, isLiked: false },
        }),
      ),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit: { _tag: 'SetLiked', song: theChain, isLiked: false },
          result: Result.succeed({
            library: libraryOf([liked]),
            maybePlaylist: Option.none(),
          }),
        }),
      ),
    )
  })
})

describe('making a playlist', () => {
  test('a new empty playlist opens once the server has it', () => {
    const created = summary('new-one', 'Night drive', 0)
    story(
      update,
      given(libraryModel),
      message(Message.ClickedNewPlaylist({ songs: [], suggestedTitle: '' })),
      model(current => {
        expect(current.actionSheet._tag).toBe('Shown')
      }),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      Command.resolve(
        FocusPlaylistTitleInput,
        Message.CompletedFocusPlaylistTitleInput(),
      ),
      message(Message.UpdatedPlaylistTitleInput({ value: 'Night drive' })),
      message(Message.SubmittedNewPlaylist({ songs: [] })),
      Command.expectExact(
        UnlockScroll(),
        EditPlaylists({
          edit: { _tag: 'Create', title: 'Night drive', songs: [] },
        }),
      ),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit: { _tag: 'Create', title: 'Night drive', songs: [] },
          result: Result.succeed({
            library: libraryOf([liked, created, roadTrip]),
            maybePlaylist: Option.some({ playlist: created, songs: [] }),
          }),
        }),
      ),
      Command.expectExact(
        NavigateInternal({ url: '/library/playlist/new-one' }),
      ),
      Command.resolve(
        NavigateInternal,
        Message.CompletedNavigateInternal({
          fromUrl: '/library',
          scrollTop: 0,
        }),
      ),
    )
  })

  test('adding songs to a playlist says where they went', () => {
    const shown = modifyFields(libraryModel, {
      actionSheet: () =>
        ActionSheet.Shown({
          content: {
            _tag: 'AddToPlaylist',
            songs: [theChain],
            suggestedTitle: '',
          },
        }),
    })
    const edit = {
      _tag: 'AddSongs',
      playlistId: roadTrip.id,
      songs: [theChain],
    } as const
    story(
      update,
      given(shown),
      message(
        Message.ClickedPlaylistOption({
          playlistId: roadTrip.id,
          songs: [theChain],
        }),
      ),
      model(current => {
        expect(current.actionSheet._tag).toBe('Dismissed')
      }),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit,
          result: Result.succeed({
            library: libraryOf([liked, { ...roadTrip, songCount: 2 }]),
            maybePlaylist: Option.some({
              playlist: { ...roadTrip, songCount: 2 },
              songs: [dreams, theChain],
            }),
          }),
        }),
      ),
      model(current => {
        expect(current.maybeNotice).toStrictEqual(
          Option.some('Added to “Road trip”'),
        )
      }),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({
          message: 'Added to “Road trip”',
        }),
      ),
    )
  })

  test('a change the server could not save is undone', () => {
    const page = playlistPageModel({
      playlist: { ...roadTrip, songCount: 2 },
      songs: [dreams, theChain],
    })
    const edit = {
      _tag: 'RemoveSong',
      playlistId: roadTrip.id,
      videoId: dreams.videoId,
    } as const
    story(
      update,
      given(page),
      message(
        Message.ClickedRemoveFromPlaylist({
          playlistId: roadTrip.id,
          videoId: dreams.videoId,
        }),
      ),
      model(current => {
        expect(shownSongs(current, roadTrip.id)).toStrictEqual([
          theChain.videoId,
        ])
      }),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit,
          result: Result.fail('ServerUnreachable'),
        }),
      ),
      model(current => {
        expect(current.maybeNotice).toStrictEqual(
          Option.some('Could not save that change. Try again.'),
        )
      }),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({
          message: 'Could not save that change. Try again.',
        }),
      ),
      Command.resolve(
        myLibraryQuery.Fetch,
        myLibraryQuery.Message.CompletedFetch({
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(libraryOf([liked, roadTrip])),
        }),
      ),
      Command.resolve(
        myPlaylistQuery.Fetch,
        myPlaylistQuery.Message.CompletedFetch({
          args: { playlistId: roadTrip.id },
          generation: FIRST_REQUEST_GENERATION + 1,
          result: Result.succeed({
            playlist: { ...roadTrip, songCount: 2 },
            songs: [dreams, theChain],
          }),
        }),
      ),
      model(current => {
        expect(shownSongs(current, roadTrip.id)).toStrictEqual([
          dreams.videoId,
          theChain.videoId,
        ])
      }),
    )
  })

  test('deleting the playlist on screen goes back', () => {
    const page = playlistPageModel({ playlist: roadTrip, songs: [theChain] })
    story(
      update,
      given(page),
      message(Message.ConfirmedDeletePlaylist({ playlistId: roadTrip.id })),
      model(current => {
        expect(
          Option.map(
            AsyncData.getData(myLibraryQuery.read(current.myLibrary)),
            ({ playlists }) => playlists.map(({ id }) => id),
          ),
        ).toStrictEqual(Option.some([LIKED_PLAYLIST_ID]))
      }),
      Command.expectExact(
        NavigateBack(),
        EditPlaylists({ edit: { _tag: 'Delete', playlistId: roadTrip.id } }),
      ),
      Command.resolve(NavigateBack, Message.CompletedNavigateBack()),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit: { _tag: 'Delete', playlistId: roadTrip.id },
          result: Result.succeed({
            library: libraryOf([liked]),
            maybePlaylist: Option.none(),
          }),
        }),
      ),
    )
  })
})
