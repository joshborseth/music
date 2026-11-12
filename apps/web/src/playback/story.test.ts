import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { type Session, type Song } from '@music/shared'

import { SaveRecentlyPlayed, UnlockScroll } from '../command'
import { Message } from '../message'
import { type Model } from '../model'
import { AppRoute } from '../route'
import { initialModel, update } from '../update'
import {
  LoadPhoneAudio,
  PrefetchSongs,
  SeekPhoneAudio,
  SendToSession,
  SetPhoneAudioPlaying,
  StopPhoneAudio,
  UnlockPhoneAudio,
  UpdateMediaSession,
  WaitBeforeHideNotice,
} from './command'
import { Connection, PhoneAudio, PlayerSheet, loadedEntry } from './domain'
import { toQueueTrack } from './queueTrack'
import { SwipeTarget } from './swipe'

const PHONE_ID = 'phone-1'
const SERVER_NOW = 1_000_000

const connectedModel: Model = {
  ...initialModel(AppRoute.Home(), '/'),
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
          entryId: 'e0',
          videoId: 'dQw4w9WgXcQ',
          startSeconds: 32,
          isPlaying: true,
        }),
        mediaSession,
        PrefetchSongs({ videoIds: ['dQw4w9WgXcQ'] }),
        SaveRecentlyPlayed({ recentlyPlayed: [entry.track] }),
      ),
      model(model => {
        expect(model.recentlyPlayed).toStrictEqual([entry.track])
      }),
      Command.resolve(
        SaveRecentlyPlayed,
        Message.CompletedSaveRecentlyPlayed(),
      ),
      Command.resolve(
        LoadPhoneAudio,
        Message.CompletedLoadPhoneAudio({ entryId: 'e0', isBlocked: false }),
      ),
      Command.resolve(
        UpdateMediaSession,
        Message.CompletedUpdateMediaSession(),
      ),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
    )
  })

  test('stops when the session moves to the TV', () => {
    story(
      update,
      given(
        modifyFields(connectedModel, {
          phoneAudio: () =>
            PhoneAudio.Loaded({
              entry: {
                entryId: 'e0',
                seekSeq: 1,
                isPlaying: true,
                isBuffering: false,
              },
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
      Command.expectExact(
        StopPhoneAudio(),
        SaveRecentlyPlayed({ recentlyPlayed: [entry.track] }),
      ),
      Command.resolve(StopPhoneAudio, Message.CompletedStopPhoneAudio()),
      Command.resolve(
        SaveRecentlyPlayed,
        Message.CompletedSaveRecentlyPlayed(),
      ),
    )
  })

  test('tells the server when the last song ends', () => {
    story(
      update,
      given(
        modifyFields(connectedModel, {
          phoneAudio: () =>
            PhoneAudio.Loaded({
              entry: {
                entryId: 'e0',
                seekSeq: 1,
                isPlaying: true,
                isBuffering: false,
              },
            }),
        }),
      ),
      message(Message.EndedPhoneAudio({ entryId: 'e0' })),
      Command.expectExact(
        SendToSession({ message: { _tag: 'TrackEnded', entryId: 'e0' } }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })
})

const playingHere = (seekSeq: number): Model =>
  modifyFields(connectedModel, {
    maybeSession: () =>
      Option.some({ state: sessionState(PHONE_ID, seekSeq), clockOffsetMs: 0 }),
    phoneAudio: () =>
      PhoneAudio.Loaded({
        entry: { entryId: 'e0', seekSeq, isPlaying: true, isBuffering: false },
      }),
    phoneAudioSeconds: () => 40,
    now: () => SERVER_NOW,
  })

describe('controlling playback on this phone', () => {
  test('a seek jumps within the loaded song instead of reloading it', () => {
    story(
      update,
      given(playingHere(1)),
      message(Message.ChangedSeekPosition({ seconds: 90 })),
      model(model => {
        expect(model.phoneAudioSeconds).toBe(90)
      }),
      Command.expectExact(
        SeekPhoneAudio({ seconds: 90 }),
        SendToSession({ message: { _tag: 'Seek', positionSeconds: 90 } }),
      ),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
      message(
        Message.ReceivedSessionState({
          state: { ...sessionState(PHONE_ID, 2), positionSeconds: 90 },
          serverNow: SERVER_NOW,
          receivedAt: SERVER_NOW,
        }),
      ),
      Command.expectExact(PrefetchSongs({ videoIds: ['dQw4w9WgXcQ'] })),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
    )
  })

  test('dragging the seek bar shows where it is, and letting go seeks there', () => {
    story(
      update,
      given(playingHere(1)),
      message(Message.UpdatedScrubPosition({ seconds: 120 })),
      model(model => {
        expect(model.maybeScrubSeconds).toEqual(Option.some(120))
      }),
      message(Message.ChangedSeekPosition({ seconds: 120 })),
      model(model => {
        expect(model.maybeScrubSeconds).toEqual(Option.none())
        expect(model.phoneAudioSeconds).toBe(120)
      }),
      Command.expectExact(
        SeekPhoneAudio({ seconds: 120 }),
        SendToSession({ message: { _tag: 'Seek', positionSeconds: 120 } }),
      ),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('a cancelled drag on the seek bar leaves playback where it was', () => {
    story(
      update,
      given(playingHere(1)),
      message(Message.UpdatedScrubPosition({ seconds: 120 })),
      message(Message.CancelledScrub()),
      model(model => {
        expect(model.maybeScrubSeconds).toEqual(Option.none())
        expect(model.phoneAudioSeconds).toBe(40)
      }),
    )
  })

  test('adding songs to the queue caches the next five on the phone', () => {
    const queued = (videoId: string): Session.QueueEntry => ({
      entryId: `q-${videoId}`,
      track: { ...entry.track, videoId },
    })
    const added = ['s1', 's2', 's3', 's4', 's5', 's6'].map(queued)
    story(
      update,
      given(playingHere(1)),
      message(
        Message.ReceivedSessionState({
          state: { ...sessionState(PHONE_ID, 1), queue: [entry, ...added] },
          serverNow: SERVER_NOW,
          receivedAt: SERVER_NOW,
        }),
      ),
      Command.expectExact(
        PrefetchSongs({
          videoIds: ['dQw4w9WgXcQ', 's1', 's2', 's3', 's4', 's5'],
        }),
      ),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
    )
  })

  test('pausing stops the audio before the server answers', () => {
    story(
      update,
      given(playingHere(1)),
      message(Message.ClickedTogglePlayback()),
      model(model => {
        expect(
          Option.exists(model.maybeSession, ({ state }) => !state.playing),
        ).toBe(true)
      }),
      Command.expectExact(
        SetPhoneAudioPlaying({ isPlaying: false }),
        SendToSession({ message: { _tag: 'Pause' } }),
      ),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })
})

describe('swiping', () => {
  const FINGER = 7
  const START_X = 200
  const START_Y = 600

  const press = (target: SwipeTarget) =>
    message(
      Message.PressedSwipeable({
        target,
        pointerId: FINGER,
        clientX: START_X,
        clientY: START_Y,
        timeStamp: 0,
      }),
    )

  const moveBy = (deltaX: number, deltaY: number, timeStamp: number) =>
    message(
      Message.MovedSwipePointer({
        pointerId: FINGER,
        clientX: START_X + deltaX,
        clientY: START_Y + deltaY,
        timeStamp,
      }),
    )

  const release = (timeStamp: number) =>
    message(Message.ReleasedSwipePointer({ pointerId: FINGER, timeStamp }))

  const song: Song = {
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    artists: [{ maybeId: Option.none(), name: 'Rick Astley' }],
    maybeAlbum: Option.none(),
    maybeDurationSeconds: Option.some(213),
    artwork: [],
  }

  test('a quick flick left on the mini player skips to the next song', () => {
    story(
      update,
      given(connectedModel),
      press(SwipeTarget.MiniPlayer()),
      moveBy(-20, 2, 16),
      moveBy(-45, 3, 32),
      release(40),
      model(model => {
        expect(model.swipe._tag).toBe('Idle')
      }),
      Command.expectExact(SendToSession({ message: { _tag: 'Next' } })),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('a long slow drag right on the mini player goes back', () => {
    story(
      update,
      given(connectedModel),
      press(SwipeTarget.MiniPlayer()),
      moveBy(40, 0, 200),
      moveBy(90, 0, 600),
      release(1_200),
      Command.expectExact(SendToSession({ message: { _tag: 'Previous' } })),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('a short drag that stops before lifting does nothing', () => {
    story(
      update,
      given(connectedModel),
      press(SwipeTarget.MiniPlayer()),
      moveBy(-40, 0, 16),
      moveBy(-50, 0, 32),
      release(500),
      model(model => {
        expect(model.swipe._tag).toBe('Idle')
      }),
      Command.expectNone(),
    )
  })

  test('a vertical drag on a song row lets the page scroll', () => {
    story(
      update,
      given(connectedModel),
      press(SwipeTarget.SongRow({ song })),
      moveBy(3, 40, 16),
      model(model => {
        expect(model.swipe._tag).toBe('Idle')
      }),
      release(32),
      Command.expectNone(),
    )
  })

  test('swiping a song row right adds it to the end of the queue', () => {
    story(
      update,
      given(connectedModel),
      press(SwipeTarget.SongRow({ song })),
      moveBy(30, 0, 16),
      moveBy(100, 0, 64),
      release(80),
      model(model => {
        expect(model.maybeNotice).toEqual(Option.some('Added to queue'))
      }),
      Command.expectHas(
        SendToSession({
          message: {
            _tag: 'Enqueue',
            tracks: [toQueueTrack(song)],
            placement: 'Last',
          },
        }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
      Command.resolve(UnlockPhoneAudio, Message.CompletedUnlockPhoneAudio()),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({ message: 'Added to queue' }),
      ),
    )
  })

  test('swiping a queue entry left removes it, and swiping right does not', () => {
    story(
      update,
      given(connectedModel),
      press(SwipeTarget.QueueEntry({ entryId: 'e1' })),
      moveBy(150, 0, 100),
      release(110),
      Command.expectNone(),
      press(SwipeTarget.QueueEntry({ entryId: 'e1' })),
      moveBy(-150, 0, 100),
      release(110),
      Command.expectExact(
        SendToSession({ message: { _tag: 'RemoveEntry', entryId: 'e1' } }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('pulling the artwork down closes the player', () => {
    story(
      update,
      given(
        modifyFields(connectedModel, { playerSheet: () => PlayerSheet.Open() }),
      ),
      press(SwipeTarget.PlayerArtwork()),
      moveBy(0, 40, 16),
      moveBy(4, 130, 64),
      release(70),
      model(model => {
        expect(model.playerSheet._tag).toBe('Closed')
      }),
      Command.expectExact(UnlockScroll()),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
    )
  })

  test('a second finger and a cancelled pointer leave the first swipe alone', () => {
    story(
      update,
      given(connectedModel),
      press(SwipeTarget.MiniPlayer()),
      message(
        Message.PressedSwipeable({
          target: SwipeTarget.PlayerArtwork(),
          pointerId: FINGER + 1,
          clientX: 0,
          clientY: 0,
          timeStamp: 5,
        }),
      ),
      message(Message.CancelledSwipePointer({ pointerId: FINGER + 1 })),
      model(model => {
        expect(model.swipe._tag).toBe('Tracking')
        expect(model.swipe._tag === 'Tracking' && model.swipe.target._tag).toBe(
          'MiniPlayer',
        )
      }),
      message(Message.CancelledSwipePointer({ pointerId: FINGER })),
      model(model => {
        expect(model.swipe._tag).toBe('Idle')
      }),
    )
  })
})

describe('on the lock screen', () => {
  const queued = (index: number): Session.QueueEntry => ({
    entryId: `e${index}`,
    track: { ...entry.track, videoId: `song-${index}`, title: `Song ${index}` },
  })
  const queue = [queued(0), queued(1), queued(2)]

  /** Playing `entryId` of a three-song queue on this phone, 40s in. */
  const playingQueue = (entryId: string, isPlaying = true): Model =>
    modifyFields(connectedModel, {
      maybeSession: () =>
        Option.some({
          state: {
            ...sessionState(PHONE_ID, 4),
            queue,
            currentEntryId: entryId,
            playing: isPlaying,
            positionSeconds: 40,
          },
          clockOffsetMs: 0,
        }),
      phoneAudio: () =>
        PhoneAudio.Loaded({
          entry: { entryId, seekSeq: 4, isPlaying, isBuffering: false },
        }),
      phoneAudioSeconds: () => 40,
      now: () => SERVER_NOW,
    })

  const currentEntryId = (model: Model) =>
    Option.map(model.maybeSession, ({ state }) => state.currentEntryId)

  const mediaSessionFor = (index: number) =>
    UpdateMediaSession({
      title: `Song ${index}`,
      artist: entry.track.artists,
      album: '',
      maybeArtworkUrl: Option.none(),
    })

  const loads = (index: number, isPlaying = true) =>
    LoadPhoneAudio({
      entryId: `e${index}`,
      videoId: `song-${index}`,
      startSeconds: 0,
      isPlaying,
    })

  const prefetchFrom = (index: number) =>
    PrefetchSongs({
      videoIds: queue.slice(index).map(({ track }) => track.videoId),
    })

  const resolveLoad = (index: number) => [
    Command.resolve(
      LoadPhoneAudio,
      Message.CompletedLoadPhoneAudio({
        entryId: `e${index}`,
        isBlocked: false,
      }),
    ),
    Command.resolve(UpdateMediaSession, Message.CompletedUpdateMediaSession()),
    Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
    Command.resolve(SendToSession, Message.CompletedSendToSession()),
    Command.resolve(SaveRecentlyPlayed, Message.CompletedSaveRecentlyPlayed()),
  ]

  test('a song that ends starts the next one without waiting for the server', () => {
    story(
      update,
      given(playingQueue('e0')),
      message(Message.EndedPhoneAudio({ entryId: 'e0' })),
      model(model => {
        expect(currentEntryId(model)).toEqual(Option.some('e1'))
        expect(model.phoneAudio).toEqual(
          PhoneAudio.Loaded({
            entry: {
              entryId: 'e1',
              seekSeq: 4,
              isPlaying: true,
              isBuffering: true,
            },
          }),
        )
        expect(model.phoneAudioSeconds).toBe(0)
        expect(model.recentlyPlayed).toStrictEqual([queue[1]?.track])
      }),
      Command.expectExact(
        loads(1),
        mediaSessionFor(1),
        prefetchFrom(1),
        SendToSession({ message: { _tag: 'Advanced', fromEntryId: 'e0' } }),
        SaveRecentlyPlayed({ recentlyPlayed: [queue[1]!.track] }),
      ),
      ...resolveLoad(1),
      // The server agrees: nothing reloads.
      message(
        Message.ReceivedSessionState({
          state: {
            ...sessionState(PHONE_ID, 4),
            queue,
            currentEntryId: 'e1',
            positionSeconds: 0,
          },
          serverNow: SERVER_NOW,
          receivedAt: SERVER_NOW,
        }),
      ),
      Command.expectExact(prefetchFrom(1)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
    )
  })

  test('an event from a song the phone already left is ignored', () => {
    story(
      update,
      given(playingQueue('e1')),
      message(Message.EndedPhoneAudio({ entryId: 'e0' })),
      message(
        Message.UpdatedPhoneAudioTime({ entryId: 'e0', seconds: 200, at: 1 }),
      ),
      message(Message.PausedPhoneAudio({ entryId: 'e0' })),
      model(model => {
        expect(model.phoneAudioSeconds).toBe(40)
        expect(currentEntryId(model)).toEqual(Option.some('e1'))
      }),
      Command.expectNone(),
    )
  })

  test('next and previous change the song on the phone at once', () => {
    story(
      update,
      given(playingQueue('e1')),
      message(Message.PressedMediaKey({ key: 'NextTrack' })),
      model(model => {
        expect(currentEntryId(model)).toEqual(Option.some('e2'))
      }),
      Command.expectExact(
        loads(2),
        mediaSessionFor(2),
        prefetchFrom(2),
        SendToSession({ message: { _tag: 'Next' } }),
        SaveRecentlyPlayed({ recentlyPlayed: [queue[2]!.track] }),
      ),
      ...resolveLoad(2),
    )
  })

  test('previous goes back a song in its first seconds', () => {
    story(
      update,
      given(modifyFields(playingQueue('e1'), { phoneAudioSeconds: () => 2 })),
      message(Message.PressedMediaKey({ key: 'PreviousTrack' })),
      model(model => {
        expect(currentEntryId(model)).toEqual(Option.some('e0'))
      }),
      Command.expectExact(
        loads(0),
        mediaSessionFor(0),
        prefetchFrom(0),
        SendToSession({ message: { _tag: 'SkipTo', entryId: 'e0' } }),
        SaveRecentlyPlayed({ recentlyPlayed: [queue[0]!.track] }),
      ),
      ...resolveLoad(0),
    )
  })

  test('previous restarts a song past its first seconds', () => {
    story(
      update,
      given(playingQueue('e1')),
      message(Message.PressedMediaKey({ key: 'PreviousTrack' })),
      model(model => {
        expect(currentEntryId(model)).toEqual(Option.some('e1'))
        expect(model.phoneAudioSeconds).toBe(0)
      }),
      Command.expectExact(
        SeekPhoneAudio({ seconds: 0 }),
        SendToSession({ message: { _tag: 'Seek', positionSeconds: 0 } }),
      ),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('scrubbing on the lock screen seeks the phone and the session', () => {
    story(
      update,
      given(playingQueue('e1')),
      message(Message.ChangedSeekPosition({ seconds: 150 })),
      model(model => {
        expect(model.phoneAudioSeconds).toBe(150)
      }),
      Command.expectExact(
        SeekPhoneAudio({ seconds: 150 }),
        SendToSession({ message: { _tag: 'Seek', positionSeconds: 150 } }),
      ),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('a pause the system made is followed, so play works afterwards', () => {
    story(
      update,
      given(playingQueue('e1')),
      message(Message.PausedPhoneAudio({ entryId: 'e1' })),
      model(model => {
        expect(
          Option.exists(model.maybeSession, ({ state }) => !state.playing),
        ).toBe(true)
        expect(
          Option.exists(
            loadedEntry(model.phoneAudio),
            loaded => !loaded.isPlaying,
          ),
        ).toBe(true)
      }),
      Command.expectExact(SendToSession({ message: { _tag: 'Pause' } })),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
      message(Message.PressedMediaKey({ key: 'Play' })),
      model(model => {
        expect(
          Option.exists(model.maybeSession, ({ state }) => state.playing),
        ).toBe(true)
      }),
      Command.expectExact(
        SetPhoneAudioPlaying({ isPlaying: true }),
        SendToSession({ message: { _tag: 'Resume' } }),
      ),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('the lock screen pauses the phone before the server answers', () => {
    story(
      update,
      given(playingQueue('e1')),
      message(Message.PressedMediaKey({ key: 'Pause' })),
      model(model => {
        expect(
          Option.exists(model.maybeSession, ({ state }) => !state.playing),
        ).toBe(true)
      }),
      Command.expectExact(
        SetPhoneAudioPlaying({ isPlaying: false }),
        SendToSession({ message: { _tag: 'Pause' } }),
      ),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('reconnecting tells the server what the phone kept playing', () => {
    story(
      update,
      given(
        modifyFields(playingQueue('e2', false), {
          connection: () => Connection.Connecting(),
          phoneAudioSeconds: () => 12.5,
        }),
      ),
      message(Message.AcquiredSessionSocket()),
      Command.expectExact(
        SendToSession({
          message: {
            _tag: 'Hello',
            deviceId: PHONE_ID,
            name: 'iPhone',
            kind: 'Web',
            player: {
              entryId: 'e2',
              positionSeconds: 12.5,
              playing: false,
              seekSeq: 4,
            },
          },
        }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('a phone that is only a remote reports nothing', () => {
    story(
      update,
      given(
        modifyFields(connectedModel, {
          connection: () => Connection.Connecting(),
        }),
      ),
      message(Message.AcquiredSessionSocket()),
      Command.expectExact(
        SendToSession({
          message: {
            _tag: 'Hello',
            deviceId: PHONE_ID,
            name: 'iPhone',
            kind: 'Web',
            player: null,
          },
        }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })
})
