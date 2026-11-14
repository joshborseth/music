import { Option, Result } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import {
  type AlbumSummary,
  type ArtistSummary,
  LIKED_PLAYLIST_ID,
  type MyLibrary,
  type MyPlaylistDetails,
  type MyPlaylistSummary,
  type Song,
} from '@music/shared'

import {
  EditPlaylists,
  FocusAddSongsInput,
  FocusPlaylistTitleInput,
  LockScroll,
  NavigateBack,
  NavigateInternal,
  SaveLibraryPrefs,
  UnlockScroll,
  WaitBeforeAddSongsSearch,
} from './command'
import { DEFAULT_LIBRARY_PREFS, type LibraryPrefs } from './library'
import { Message } from './message'
import { type Model } from './model'
import { WaitBeforeHideNotice } from './playback/command'
import { PlaylistEditor } from './playlistEditor'
import {
  homeQuery,
  myLibraryQuery,
  myPlaylistQuery,
  songSearchQuery,
} from './query'
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
  createdAt: 1,
  maybePlayedAt: Option.none(),
  maybeDescription: Option.none(),
  maybeCoverVideoId: Option.none(),
})

const liked = summary(LIKED_PLAYLIST_ID, 'Liked Songs', 0)
const roadTrip = summary('road-trip', 'Road trip', 1)

const libraryOf = (
  playlists: ReadonlyArray<MyPlaylistSummary>,
  likedIds: ReadonlyArray<string> = [],
): MyLibrary => ({
  playlists,
  likedVideoIds: likedIds,
  albums: [],
  artists: [],
  albumPlayedAt: {},
  artistPlayedAt: {},
})

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
            alreadyHeldVideoIds: [],
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
            alreadyHeldVideoIds: [],
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
            alreadyHeldVideoIds: [],
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
            alreadyHeldVideoIds: [],
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

  test('adding a song the playlist already holds says so', () => {
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
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit,
          result: Result.succeed({
            library: libraryOf([liked, roadTrip]),
            alreadyHeldVideoIds: [theChain.videoId],
            maybePlaylist: Option.some({
              playlist: roadTrip,
              songs: [theChain],
            }),
          }),
        }),
      ),
      model(current => {
        expect(current.maybeNotice).toStrictEqual(
          Option.some('Already in “Road trip”'),
        )
      }),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({
          message: 'Already in “Road trip”',
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
            alreadyHeldVideoIds: [],
            maybePlaylist: Option.none(),
          }),
        }),
      ),
    )
  })
})

const rumours: AlbumSummary = {
  id: 'MPREb_1SbgcDGdrT4',
  title: 'Rumours',
  artists: [{ maybeId: Option.some('UCfleetwood'), name: 'Fleetwood Mac' }],
  maybeKind: Option.some('Album'),
  maybeYear: Option.some('1977'),
  artwork: [],
}

const fleetwoodMac: ArtistSummary = {
  id: 'UCfleetwood',
  name: 'Fleetwood Mac',
  maybeAudience: Option.none(),
  artwork: [],
}

const savedAlbumIds = (current: Model): Option.Option<ReadonlyArray<string>> =>
  Option.map(
    AsyncData.getData(myLibraryQuery.read(current.myLibrary)),
    ({ albums }) => albums.map(({ id }) => id),
  )

const followedArtistIds = (
  current: Model,
): Option.Option<ReadonlyArray<string>> =>
  Option.map(
    AsyncData.getData(myLibraryQuery.read(current.myLibrary)),
    ({ artists }) => artists.map(({ id }) => id),
  )

describe('saving an album', () => {
  test('shows it saved at once, and says where it went once the server has it', () => {
    const edit = {
      _tag: 'SetAlbumSaved' as const,
      album: rumours,
      isSaved: true,
    }
    story(
      update,
      given(libraryModel),
      message(Message.ClickedToggleAlbumSaved({ album: rumours })),
      model(current => {
        expect(savedAlbumIds(current)).toStrictEqual(Option.some([rumours.id]))
      }),
      Command.expectExact(EditPlaylists({ edit })),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit,
          result: Result.succeed({
            library: { ...libraryOf([liked, roadTrip]), albums: [rumours] },
            alreadyHeldVideoIds: [],
            maybePlaylist: Option.none(),
          }),
        }),
      ),
      model(current => {
        expect(current.maybeNotice).toStrictEqual(
          Option.some('Saved to your Library'),
        )
      }),
      Command.expectExact(
        WaitBeforeHideNotice({ message: 'Saved to your Library' }),
      ),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({
          message: 'Saved to your Library',
        }),
      ),
    )
  })

  test('tapping it again removes the album', () => {
    const edit = {
      _tag: 'SetAlbumSaved' as const,
      album: rumours,
      isSaved: false,
    }
    story(
      update,
      given(
        withLibrary(libraryModel, {
          ...libraryOf([liked]),
          albums: [rumours],
        }),
      ),
      message(Message.ClickedToggleAlbumSaved({ album: rumours })),
      model(current => {
        expect(savedAlbumIds(current)).toStrictEqual(Option.some([]))
      }),
      Command.expectExact(EditPlaylists({ edit })),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit,
          result: Result.succeed({
            library: libraryOf([liked]),
            alreadyHeldVideoIds: [],
            maybePlaylist: Option.none(),
          }),
        }),
      ),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({
          message: 'Removed from your Library',
        }),
      ),
    )
  })
})

describe('following an artist', () => {
  test('follows at once, newest first, and unfollows on a second tap', () => {
    const follow = {
      _tag: 'SetArtistFollowed' as const,
      artist: fleetwoodMac,
      isFollowed: true,
    }
    const unfollow = { ...follow, isFollowed: false }
    const otherArtist = { ...fleetwoodMac, id: 'UCother', name: 'Other' }
    story(
      update,
      given(
        withLibrary(libraryModel, {
          ...libraryOf([liked]),
          artists: [otherArtist],
        }),
      ),
      message(Message.ClickedToggleArtistFollowed({ artist: fleetwoodMac })),
      model(current => {
        expect(followedArtistIds(current)).toStrictEqual(
          Option.some([fleetwoodMac.id, otherArtist.id]),
        )
      }),
      Command.expectExact(EditPlaylists({ edit: follow })),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit: follow,
          result: Result.succeed({
            library: {
              ...libraryOf([liked]),
              artists: [fleetwoodMac, otherArtist],
            },
            alreadyHeldVideoIds: [],
            maybePlaylist: Option.none(),
          }),
        }),
      ),
      model(current => {
        expect(current.maybeNotice).toStrictEqual(Option.none())
      }),
      message(Message.ClickedToggleArtistFollowed({ artist: fleetwoodMac })),
      model(current => {
        expect(followedArtistIds(current)).toStrictEqual(
          Option.some([otherArtist.id]),
        )
      }),
      Command.expectExact(EditPlaylists({ edit: unfollow })),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit: unfollow,
          result: Result.succeed({
            library: { ...libraryOf([liked]), artists: [otherArtist] },
            alreadyHeldVideoIds: [],
            maybePlaylist: Option.none(),
          }),
        }),
      ),
    )
  })
})

describe('editing my playlist', () => {
  const landslide: Song = {
    ...theChain,
    videoId: 'WM7-PYtXtJM',
    title: 'Landslide',
    maybeAlbum: Option.some({ id: 'MPREb_fm1975', name: 'Fleetwood Mac' }),
    artwork: [
      { url: 'https://lh3.googleusercontent.com/l', width: 60, height: 60 },
    ],
  }
  const page = () =>
    playlistPageModel({
      playlist: { ...roadTrip, songCount: 3 },
      songs: [dreams, theChain, landslide],
    })
  const editing = () =>
    update(page(), Message.ClickedEditPlaylist({ playlistId: roadTrip.id }))
      .model
  const savedNothing = {
    library: libraryOf([liked, roadTrip]),
    alreadyHeldVideoIds: [],
    maybePlaylist: Option.none(),
  }

  test('Done saves a new title and description, and leaves the rest', () => {
    const rename = {
      _tag: 'Rename',
      playlistId: roadTrip.id,
      title: 'Coast road',
    } as const
    const setDescription = {
      _tag: 'SetDescription',
      playlistId: roadTrip.id,
      description: 'Windows down.',
    } as const
    story(
      update,
      given(page()),
      message(Message.ClickedEditPlaylist({ playlistId: roadTrip.id })),
      model(current => {
        expect(current.playlistEditor).toStrictEqual(
          PlaylistEditor.Editing({
            playlistId: roadTrip.id,
            titleInput: 'Road trip',
            descriptionInput: '',
          }),
        )
      }),
      message(Message.UpdatedPlaylistEditorTitle({ value: '  Coast road ' })),
      message(
        Message.UpdatedPlaylistEditorDescription({ value: 'Windows down. ' }),
      ),
      message(Message.ClickedDoneEditingPlaylist()),
      model(current => {
        expect(current.playlistEditor._tag).toBe('Closed')
        expect(
          Option.map(
            AsyncData.getData(
              myPlaylistQuery.read(current.myPlaylists, {
                playlistId: roadTrip.id,
              }),
            ),
            ({ playlist }) => [playlist.title, playlist.maybeDescription],
          ),
        ).toStrictEqual(
          Option.some(['Coast road', Option.some('Windows down.')]),
        )
      }),
      Command.expectExact(
        EditPlaylists({ edit: rename }),
        EditPlaylists({ edit: setDescription }),
      ),
      Command.resolveAll(
        [
          EditPlaylists,
          Message.CompletedEditPlaylists({
            edit: rename,
            result: Result.succeed(savedNothing),
          }),
        ],
        [
          EditPlaylists,
          Message.CompletedEditPlaylists({
            edit: setDescription,
            result: Result.succeed(savedNothing),
          }),
        ],
      ),
    )
  })

  test('Done after emptying the title sends nothing', () => {
    story(
      update,
      given(editing()),
      message(Message.UpdatedPlaylistEditorTitle({ value: '   ' })),
      message(Message.ClickedDoneEditingPlaylist()),
      model(current => {
        expect(current.playlistEditor._tag).toBe('Closed')
      }),
      Command.expectNone(),
    )
  })

  test('a dragged song moves at once and the server is told', () => {
    const edit = {
      _tag: 'MoveSong',
      playlistId: roadTrip.id,
      videoId: landslide.videoId,
      maybeBeforeVideoId: Option.some(dreams.videoId),
    } as const
    story(
      update,
      given(editing()),
      message(
        Message.DraggedPlaylistSong({
          playlistId: roadTrip.id,
          videoId: landslide.videoId,
          maybeBeforeVideoId: Option.some(dreams.videoId),
        }),
      ),
      model(current => {
        expect(shownSongs(current, roadTrip.id)).toStrictEqual([
          landslide.videoId,
          dreams.videoId,
          theChain.videoId,
        ])
      }),
      Command.expectExact(EditPlaylists({ edit })),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit,
          result: Result.succeed(savedNothing),
        }),
      ),
    )
  })

  test('Add Songs searches, adds a song with a check, and says nothing else', () => {
    const rhiannon: Song = { ...theChain, videoId: 'rh1', title: 'Rhiannon' }
    const add = {
      _tag: 'AddSongs',
      playlistId: roadTrip.id,
      songs: [rhiannon],
    } as const
    const remove = {
      _tag: 'RemoveSong',
      playlistId: roadTrip.id,
      videoId: rhiannon.videoId,
    } as const
    story(
      update,
      given(editing()),
      message(Message.ClickedAddSongs({ playlistId: roadTrip.id })),
      model(current => {
        expect(current.actionSheet).toStrictEqual(
          ActionSheet.Shown({
            content: { _tag: 'AddSongs', playlistId: roadTrip.id },
          }),
        )
      }),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      Command.resolve(
        FocusAddSongsInput,
        Message.CompletedFocusAddSongsInput(),
      ),
      Command.resolve(
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
      ),
      message(Message.UpdatedAddSongsInput({ value: 'rhiannon' })),
      Command.resolve(
        WaitBeforeAddSongsSearch,
        Message.CompletedWaitBeforeAddSongsSearch({ query: 'rhiannon' }),
      ),
      model(current => {
        expect(current.addSongsSearch).toStrictEqual({
          input: 'rhiannon',
          query: 'rhiannon',
        })
      }),
      Command.resolve(
        songSearchQuery.Fetch,
        songSearchQuery.Message.CompletedFetch({
          args: { query: 'rhiannon' },
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed([rhiannon]),
        }),
      ),
      message(
        Message.ClickedToggleSongInPlaylist({
          playlistId: roadTrip.id,
          song: rhiannon,
        }),
      ),
      model(current => {
        expect(shownSongs(current, roadTrip.id)).toStrictEqual([
          dreams.videoId,
          theChain.videoId,
          landslide.videoId,
          rhiannon.videoId,
        ])
      }),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit: add,
          result: Result.succeed({
            library: libraryOf([liked, { ...roadTrip, songCount: 4 }]),
            alreadyHeldVideoIds: [],
            maybePlaylist: Option.some({
              playlist: { ...roadTrip, songCount: 4 },
              songs: [dreams, theChain, landslide, rhiannon],
            }),
          }),
        }),
      ),
      model(current => {
        expect(current.maybeNotice).toStrictEqual(Option.none())
      }),
      message(
        Message.ClickedToggleSongInPlaylist({
          playlistId: roadTrip.id,
          song: rhiannon,
        }),
      ),
      Command.expectExact(EditPlaylists({ edit: remove })),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit: remove,
          result: Result.succeed(savedNothing),
        }),
      ),
    )
  })

  test("picking a song's cover shows it at once", () => {
    const edit = {
      _tag: 'SetCover',
      playlistId: roadTrip.id,
      maybeVideoId: Option.some(landslide.videoId),
    } as const
    story(
      update,
      given(editing()),
      message(Message.ClickedChoosePlaylistCover({ playlistId: roadTrip.id })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      message(
        Message.SelectedPlaylistCover({
          playlistId: roadTrip.id,
          maybeVideoId: Option.some(landslide.videoId),
        }),
      ),
      model(current => {
        expect(current.actionSheet._tag).toBe('Dismissed')
        expect(
          Option.map(
            AsyncData.getData(
              myPlaylistQuery.read(current.myPlaylists, {
                playlistId: roadTrip.id,
              }),
            ),
            ({ playlist }) => [playlist.maybeCoverVideoId, playlist.covers],
          ),
        ).toStrictEqual(
          Option.some([Option.some(landslide.videoId), [landslide.artwork]]),
        )
      }),
      Command.expectExact(UnlockScroll(), EditPlaylists({ edit })),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Command.resolve(
        EditPlaylists,
        Message.CompletedEditPlaylists({
          edit,
          result: Result.succeed(savedNothing),
        }),
      ),
    )
  })
})

describe('library order and layout', () => {
  test('are saved on this device as they change', () => {
    const sorted: LibraryPrefs = {
      ...DEFAULT_LIBRARY_PREFS,
      sorts: { ...DEFAULT_LIBRARY_PREFS.sorts, Albums: 'Artist' },
    }
    const listed: LibraryPrefs = {
      ...sorted,
      layouts: { ...sorted.layouts, Albums: 'List' },
    }
    story(
      update,
      given(libraryModel),
      message(Message.ClickedLibrarySort({ kind: 'Albums' })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      message(Message.SelectedLibrarySort({ kind: 'Albums', sort: 'Artist' })),
      Command.expectExact(UnlockScroll(), SaveLibraryPrefs({ prefs: sorted })),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Command.resolve(SaveLibraryPrefs, Message.CompletedSaveLibraryPrefs()),
      message(Message.ClickedToggleLibraryLayout({ kind: 'Albums' })),
      model(current => {
        expect(current.libraryPrefs).toStrictEqual(listed)
      }),
      Command.resolve(SaveLibraryPrefs, Message.CompletedSaveLibraryPrefs()),
    )
  })

  test('come back from the device when the app opens', () => {
    const stored: LibraryPrefs = {
      ...DEFAULT_LIBRARY_PREFS,
      layouts: { Playlists: 'Grid', Albums: 'List' },
    }
    story(
      update,
      given(libraryModel),
      message(
        Message.CompletedLoadLibrary({
          recentlyViewed: [],
          maybePrefs: Option.some(stored),
        }),
      ),
      model(current => {
        expect(current.libraryPrefs).toStrictEqual(stored)
      }),
    )
  })
})
