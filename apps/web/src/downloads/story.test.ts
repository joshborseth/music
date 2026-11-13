import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { LockScroll, UnlockScroll } from '../command'
import { Message } from '../message'
import { type Model } from '../model'
import { WaitBeforeHideNotice } from '../playback/command'
import { AppRoute } from '../route'
import { initialModel, update } from '../update'
import { DownloadSong, RemoveDownloadedSongs, SaveDownloads } from './command'
import {
  DownloadStatus,
  type DownloadedCollection,
  Downloads,
  downloadStatus,
  formatBytes,
  nextToDownload,
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
): Model =>
  modifyFields(initialModel(AppRoute.Library(), '/library'), {
    downloads: () =>
      Downloads.Ready({
        collections,
        savedBytes,
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
      message(Message.ClickedDownload({ collection: album })),
      model(model => {
        expect(model.downloads).toEqual(Downloads.Unavailable())
      }),
    )
  })

  test('Download keeps the album and fetches its songs one at a time, skipping ones already there', () => {
    story(
      update,
      given(loaded([playlist], { c: 4 * MB })),
      message(Message.ClickedDownload({ collection: album })),
      model(model => {
        expect(
          model.downloads._tag === 'Ready' &&
            model.downloads.collections.map(({ id }) => id),
        ).toEqual(['rumours', 'mine'])
      }),
      Command.expectExact(
        SaveDownloads({ collections: [album, playlist] }),
        DownloadSong({ videoId: 'd' }),
      ),
      Command.resolve(SaveDownloads, Message.CompletedSaveDownloads()),
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
      message(Message.ClickedDownload({ collection: album })),
      Command.expectExact(
        SaveDownloads({ collections: [album, playlist] }),
        DownloadSong({ videoId: 'a' }),
      ),
      Command.resolve(SaveDownloads, Message.CompletedSaveDownloads()),
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
      given(loaded([album, playlist], { a: MB, b: MB, c: MB, d: MB })),
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
      Command.expectExact(
        UnlockScroll(),
        SaveDownloads({ collections: [playlist] }),
        RemoveDownloadedSongs({ videoIds: ['a', 'b'] }),
      ),
      Command.resolveAll(
        [UnlockScroll, Message.CompletedUnlockScroll()],
        [SaveDownloads, Message.CompletedSaveDownloads()],
        [
          RemoveDownloadedSongs,
          Message.CompletedRemoveDownloadedSongs({ maybeStorage: ROOMY }),
        ],
      ),
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
