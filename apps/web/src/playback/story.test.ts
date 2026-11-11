import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { type Session } from '@music/shared'

import { Message } from '../message'
import { type Model } from '../model'
import {
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  songQuery,
  songSearchQuery,
} from '../query'
import { AppRoute } from '../route'
import { update } from '../update'
import {
  LoadPhoneAudio,
  SendToSession,
  StopPhoneAudio,
  UpdateMediaSession,
} from './command'
import { Connection, PhoneAudio, initialPlaybackModel } from './domain'

const PHONE_ID = 'phone-1'
const SERVER_NOW = 1_000_000

const connectedModel: Model = {
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
  maybeIdentity: Option.some({ deviceId: PHONE_ID, deviceName: 'iPhone' }),
  connection: Connection.Connected(),
  phoneAudio: PhoneAudio.Idle(),
}

const entry: Session.QueueEntry = {
  entryId: 'e0',
  track: {
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    artists: 'Rick Astley',
    album: null,
    durationSeconds: 213,
    artworkUrl: null,
  },
}

const sessionState = (
  activeDeviceId: string,
  seekSeq: number,
): Session.SessionState => ({
  devices: [
    { id: PHONE_ID, name: 'iPhone', kind: 'Web', online: true, waking: false },
    { id: 'tv', name: 'TV', kind: 'Tv', online: true, waking: false },
  ],
  activeDeviceId,
  queue: [entry],
  currentEntryId: entry.entryId,
  playing: true,
  positionSeconds: 30,
  positionAt: SERVER_NOW,
  seekSeq,
})

const mediaSession = UpdateMediaSession({
  title: entry.track.title,
  artist: entry.track.artists,
  album: '',
  maybeArtworkUrl: Option.none(),
  isPlaying: true,
})

describe('playing on this phone', () => {
  test('loads the current song at the session position', () => {
    story(
      update,
      given(connectedModel),
      message(
        Message.ReceivedSessionState({
          state: sessionState(PHONE_ID, 1),
          serverNow: SERVER_NOW + 2_000,
          receivedAt: 5_000,
        }),
      ),
      model(model => {
        expect(model.phoneAudio._tag).toBe('Loaded')
      }),
      Command.expectExact(
        LoadPhoneAudio({
          src: '/audio/dQw4w9WgXcQ',
          startSeconds: 32,
          isPlaying: true,
        }),
        mediaSession,
      ),
      Command.resolve(
        LoadPhoneAudio,
        Message.CompletedLoadPhoneAudio({ isBlocked: false }),
      ),
      Command.resolve(
        UpdateMediaSession,
        Message.CompletedUpdateMediaSession(),
      ),
    )
  })

  test('stops when the session moves to the TV', () => {
    story(
      update,
      given(
        modifyFields(connectedModel, {
          phoneAudio: () =>
            PhoneAudio.Loaded({
              entry: { entryId: 'e0', seekSeq: 1, isPlaying: true },
            }),
        }),
      ),
      message(
        Message.ReceivedSessionState({
          state: sessionState('tv', 2),
          serverNow: SERVER_NOW,
          receivedAt: 5_000,
        }),
      ),
      model(model => {
        expect(model.phoneAudio._tag).toBe('Idle')
      }),
      Command.expectExact(StopPhoneAudio()),
      Command.resolve(StopPhoneAudio, Message.CompletedStopPhoneAudio()),
    )
  })

  test('tells the server when the song ends', () => {
    story(
      update,
      given(
        modifyFields(connectedModel, {
          phoneAudio: () =>
            PhoneAudio.Loaded({
              entry: { entryId: 'e0', seekSeq: 1, isPlaying: true },
            }),
        }),
      ),
      message(Message.EndedPhoneAudio()),
      Command.expectExact(
        SendToSession({ message: { _tag: 'TrackEnded', entryId: 'e0' } }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })
})
