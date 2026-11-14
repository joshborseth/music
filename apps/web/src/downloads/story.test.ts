import { Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { LockScroll, UnlockScroll } from '../command'
import { Message } from '../message'
import { type Model } from '../model'
import { WaitBeforeHideNotice } from '../playback/command'
import { AppRoute } from '../route'
import { initialModel, update } from '../update'
import {
  DownloadSong,
  FetchOfflineCopy,
  RemoveDownloadedSongs,
  RemoveOfflineCopy,
  SaveDownloads,
  SaveOfflineCopy,
} from './command'
import {
  DownloadStatus,
  type DownloadedCollection,
  Downloads,
  OfflineCopy,
  artworkKey,
  copyKey,
  downloadStatus,
  formatBytes,
  nextToDownload,
  offlineAlbum,
  offlineArtworkUrls,
  orOfflineCopy,
  totalDownloadedBytes,
} from './domain'

const MB = 1024 * 1024

const album: DownloadedCollection = {
  kind: 'Album',
  id: 'rumours',
  title: 'Rumours',
  subtitle: 'Fleetwood Mac',
  maybeArtworkUrl: Option.none(),
  videoIds: ['a', 'b', 'c'],
}

const cover = (id: string) => [
  {
    url: `https://lh3.googleusercontent.com/${id}=w120-h120-l90-rj`,
    width: 120,
    height: 120,
  },
]

const song = (videoId: string, coverId: string) => ({
  videoId,
  title: `Song ${videoId}`,
  artists: [{ maybeId: Option.none(), name: 'Fleetwood Mac' }],
  maybeAlbum: Option.none(),
  maybeDurationSeconds: Option.some(200),
  artwork: cover(coverId),
})

const albumCopy = OfflineCopy.Album({
  details: {
    album: {
      id: 'rumours',
      title: 'Rumours',
      artists: [{ maybeId: Option.none(), name: 'Fleetwood Mac' }],
      maybeKind: Option.some('Album'),
      maybeYear: Option.some('1977'),
      artwork: cover('rumours'),
    },
    maybeDescription: Option.none(),
    maybeLengthSummary: Option.none(),
    tracks: [song('a', 'rumours'), song('b', 'rumours'), song('c', 'rumours')],
    explicitVideoIds: [],
    maybeRadio: Option.none(),
  },
})

const playlistCopy = OfflineCopy.MyPlaylist({
  details: {
    playlist: {
      id: 'mine',
      title: 'Mine',
      maybeDescription: Option.none(),
      isLiked: false,
      songCount: 2,
      totalSeconds: 400,
      covers: [cover('rumours'), cover('other')],
      maybeCoverVideoId: Option.none(),
      updatedAt: 0,
      createdAt: 0,
      maybePlayedAt: Option.none(),
    },
    songs: [song('c', 'rumours'), song('d', 'other')],
  },
})

const playlist: DownloadedCollection = {
  kind: 'MyPlaylist',
  id: 'mine',
  title: 'Mine',
  subtitle: 'Your playlist',
  maybeArtworkUrl: Option.none(),
  videoIds: ['c', 'd'],
}

const loaded = (
  collections: ReadonlyArray<DownloadedCollection>,
  savedBytes: Readonly<Record<string, number>> = {},
  copies: Readonly<Record<string, OfflineCopy>> = {},
): Model =>
  modifyFields(initialModel(AppRoute.Library(), '/library'), {
    downloads: () =>
      Downloads.Ready({
        collections,
        savedBytes,
        copies,
        failedVideoIds: [],
        maybeDownloading: Option.none(),
        maybeStorage: Option.none(),
        isOutOfSpace: false,
      }),
  })

const ROOMY = Option.some({ usageBytes: 100 * MB, quotaBytes: 10_000 * MB })

const status = (model: Model, collection: DownloadedCollection) =>
  downloadStatus(model.downloads, collection.kind, collection.id)

describe('downloads', () => {
  test('the downloads saved on the phone pick up where they left off', () => {
    story(
      update,
      given(initialModel(AppRoute.Library(), '/library')),
      message(
        Message.SucceededLoadDownloads({
          collections: [album],
          savedBytes: { a: 4 * MB },
          copies: { [copyKey('Album', 'rumours')]: albumCopy },
          maybeStorage: ROOMY,
        }),
      ),
      model(model => {
        expect(status(model, album)).toEqual(
          DownloadStatus.Downloading({ saved: 1, total: 3 }),
        )
      }),
      Command.expectExact(DownloadSong({ videoId: 'b' })),
      Command.resolve(
        DownloadSong,
        Message.SucceededDownloadSong({
          videoId: 'b',
          bytes: 5 * MB,
          maybeStorage: ROOMY,
        }),
      ),
      Command.expectExact(DownloadSong({ videoId: 'c' })),
      Command.resolve(
        DownloadSong,
        Message.SucceededDownloadSong({
          videoId: 'c',
          bytes: 3 * MB,
          maybeStorage: ROOMY,
        }),
      ),
      model(model => {
        expect(status(model, album)).toEqual(
          DownloadStatus.Downloaded({ bytes: 12 * MB }),
        )
      }),
    )
  })

  test('a phone without Cache Storage offers no downloads', () => {
    story(
      update,
      given(initialModel(AppRoute.Library(), '/library')),
      message(Message.FailedLoadDownloads()),
      model(model => {
        expect(status(model, album)).toEqual(DownloadStatus.Unavailable())
      }),
      message(Message.ClickedDownload({ collection: album, copy: albumCopy })),
      model(model => {
        expect(model.downloads).toEqual(Downloads.Unavailable())
      }),
    )
  })

  test('Download keeps the album and fetches its songs one at a time, skipping ones already there', () => {
    story(
      update,
      given(loaded([playlist], { c: 4 * MB })),
      message(Message.ClickedDownload({ collection: album, copy: albumCopy })),
      model(model => {
        expect(
          model.downloads._tag === 'Ready' &&
            model.downloads.collections.map(({ id }) => id),
        ).toEqual(['rumours', 'mine'])
      }),
      Command.expectExact(
        SaveDownloads({ collections: [album, playlist] }),
        SaveOfflineCopy({ copy: albumCopy }),
        DownloadSong({ videoId: 'd' }),
      ),
      Command.resolve(SaveDownloads, Message.CompletedSaveDownloads()),
      Command.resolve(SaveOfflineCopy, Message.CompletedSaveOfflineCopy()),
      Command.resolve(
        DownloadSong,
        Message.SucceededDownloadSong({
          videoId: 'd',
          bytes: 4 * MB,
          maybeStorage: ROOMY,
        }),
      ),
      Command.expectExact(DownloadSong({ videoId: 'a' })),
      Command.resolve(
        DownloadSong,
        Message.FailedDownloadSong({
          videoId: 'a',
          failure: 'Failed',
          maybeStorage: Option.none(),
        }),
      ),
      Command.expectExact(DownloadSong({ videoId: 'b' })),
      Command.resolve(
        DownloadSong,
        Message.SucceededDownloadSong({
          videoId: 'b',
          bytes: 4 * MB,
          maybeStorage: ROOMY,
        }),
      ),
      model(model => {
        expect(status(model, album)).toEqual(
          DownloadStatus.Incomplete({ saved: 2, total: 3 }),
        )
        expect(status(model, playlist)).toEqual(
          DownloadStatus.Downloaded({ bytes: 8 * MB }),
        )
      }),
      // Tapping it again tries the song that failed.
      message(Message.ClickedDownload({ collection: album, copy: albumCopy })),
      Command.expectExact(
        SaveDownloads({ collections: [album, playlist] }),
        SaveOfflineCopy({ copy: albumCopy }),
        DownloadSong({ videoId: 'a' }),
      ),
      Command.resolve(SaveDownloads, Message.CompletedSaveDownloads()),
      Command.resolve(SaveOfflineCopy, Message.CompletedSaveOfflineCopy()),
      Command.resolve(
        DownloadSong,
        Message.SucceededDownloadSong({
          videoId: 'a',
          bytes: 4 * MB,
          maybeStorage: ROOMY,
        }),
      ),
    )
  })

  test('a nearly full phone stops downloading and says so', () => {
    const full = Option.some({
      usageBytes: 9_900 * MB,
      quotaBytes: 10_000 * MB,
    })
    story(
      update,
      given(loaded([album])),
      message(
        Message.FailedDownloadSong({
          videoId: 'a',
          failure: 'OutOfSpace',
          maybeStorage: full,
        }),
      ),
      model(model => {
        expect(model.maybeNotice).toEqual(
          Option.some('This phone is nearly full, so downloading stopped.'),
        )
        expect(status(model, album)).toEqual(
          DownloadStatus.Incomplete({ saved: 0, total: 3 }),
        )
      }),
      Command.expectExact(
        WaitBeforeHideNotice({
          message: 'This phone is nearly full, so downloading stopped.',
        }),
      ),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({
          message: 'This phone is nearly full, so downloading stopped.',
        }),
      ),
    )
  })

  test('removing a download frees only the songs no other download holds', () => {
    story(
      update,
      given(
        loaded(
          [album, playlist],
          { a: MB, b: MB, c: MB, d: MB },
          {
            [copyKey('Album', 'rumours')]: albumCopy,
            [copyKey('MyPlaylist', 'mine')]: playlistCopy,
          },
        ),
      ),
      message(
        Message.ClickedRemoveDownload({
          kind: 'Album',
          id: 'rumours',
          title: 'Rumours',
        }),
      ),
      model(model => {
        expect(model.actionSheet._tag).toBe('Shown')
      }),
      Command.expectExact(LockScroll()),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      message(
        Message.ConfirmedRemoveDownload({ kind: 'Album', id: 'rumours' }),
      ),
      model(model => {
        expect(status(model, album)).toEqual(DownloadStatus.NotDownloaded())
        expect(status(model, playlist)).toEqual(
          DownloadStatus.Downloaded({ bytes: 2 * MB }),
        )
      }),
      model(model => {
        expect(offlineAlbum(model.downloads, 'rumours')).toEqual(Option.none())
      }),
      Command.expectExact(
        UnlockScroll(),
        SaveDownloads({ collections: [playlist] }),
        RemoveDownloadedSongs({ videoIds: ['a', 'b'] }),
        // The playlist still shows the album's cover, so it stays.
        RemoveOfflineCopy({
          kind: 'Album',
          id: 'rumours',
          maybeCopy: Option.some(albumCopy),
          keptArtworkUrls: offlineArtworkUrls(playlistCopy),
        }),
      ),
      Command.resolveAll(
        [UnlockScroll, Message.CompletedUnlockScroll()],
        [SaveDownloads, Message.CompletedSaveDownloads()],
        [
          RemoveDownloadedSongs,
          Message.CompletedRemoveDownloadedSongs({ maybeStorage: ROOMY }),
        ],
        [RemoveOfflineCopy, Message.CompletedRemoveOfflineCopy()],
      ),
    )
  })
})

describe('offline copies', () => {
  test('a download made before downloads kept a copy fetches one', () => {
    story(
      update,
      given(initialModel(AppRoute.Library(), '/library')),
      message(
        Message.SucceededLoadDownloads({
          collections: [album],
          savedBytes: { a: MB, b: MB, c: MB },
          copies: {},
          maybeStorage: ROOMY,
        }),
      ),
      model(model => {
        expect(offlineAlbum(model.downloads, 'rumours')).toEqual(Option.none())
      }),
      Command.expectExact(FetchOfflineCopy({ kind: 'Album', id: 'rumours' })),
      Command.resolve(
        FetchOfflineCopy,
        Message.SucceededFetchOfflineCopy({ copy: albumCopy }),
      ),
      model(model => {
        expect(offlineAlbum(model.downloads, 'rumours')).toEqual(
          Option.some(albumCopy.details),
        )
      }),
    )
  })

  test('the page shows the copy until the server answers, and when it cannot', () => {
    const copy = Option.some('saved')
    expect(orOfflineCopy(AsyncData.Loading(), copy)).toEqual(
      AsyncData.succeed('saved'),
    )
    expect(orOfflineCopy(AsyncData.fail('ServerUnreachable'), copy)).toEqual(
      AsyncData.succeed('saved'),
    )
    expect(orOfflineCopy(AsyncData.succeed('fresh'), copy)).toEqual(
      AsyncData.succeed('fresh'),
    )
    expect(
      orOfflineCopy(AsyncData.fail('ServerUnreachable'), Option.none()),
    ).toEqual(AsyncData.fail('ServerUnreachable'))
  })

  test('a download keeps each cover once, the album’s at full size', () => {
    expect(offlineArtworkUrls(albumCopy)).toEqual([
      'https://lh3.googleusercontent.com/rumours=w1080-h1080-l90-rj',
    ])
    expect(offlineArtworkUrls(playlistCopy)).toEqual([
      'https://lh3.googleusercontent.com/rumours=w1080-h1080-l90-rj',
      'https://lh3.googleusercontent.com/other=w1080-h1080-l90-rj',
    ])
  })

  test('a cover is found whatever size the page asks for', () => {
    expect(
      artworkKey('https://lh3.googleusercontent.com/rumours=w544-h544-l90-rj'),
    ).toBe('https://lh3.googleusercontent.com/rumours')
    expect(artworkKey('https://i.ytimg.com/vi/x/hqdefault.jpg?sqp=abc')).toBe(
      'https://i.ytimg.com/vi/x/hqdefault.jpg',
    )
  })
})

describe('download helpers', () => {
  const ready = loaded([album, playlist], { a: 2 * MB, c: 3 * MB }).downloads

  test('the next song is the first missing one of the oldest download', () => {
    expect(ready._tag === 'Ready' && nextToDownload(ready)).toEqual(
      Option.some('d'),
    )
  })

  test('a song two downloads hold counts once', () => {
    expect(ready._tag === 'Ready' && totalDownloadedBytes(ready)).toBe(5 * MB)
  })

  test('sizes read as people say them', () => {
    expect(formatBytes(820 * 1024)).toBe('820 KB')
    expect(formatBytes(48.4 * MB)).toBe('48 MB')
    expect(formatBytes(1.25 * 1024 * MB)).toBe('1.3 GB')
  })
})
