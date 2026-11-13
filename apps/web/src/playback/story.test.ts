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
  SendLocalChange,
  SendQueueMove,
  SendToSession,
  SetPhoneAudioPlaying,
  StopPhoneAudio,
  UnlockPhoneAudio,
  UpdateMediaSession,
  WaitBeforeHideNotice,
  WaitBeforeReconnect,
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
  autoplay: false,
}

const sessionState = (
  activeDeviceId: string,
  seekSeq: number,
): Session.SessionState => ({
  devices: [
    {
      id: PHONE_ID,
      name: 'iPhone',
      kind: 'Web',
      online: true,
      waking: false,
      poweredOn: null,
      volume: null,
    },
    {
      id: 'tv',
      name: 'TV',
      kind: 'Tv',
      online: true,
      waking: false,
      poweredOn: null,
      volume: null,
    },
  ],
  activeDeviceId,
  queue: [entry],
  currentEntryId: entry.entryId,
  playing: true,
  positionSeconds: 30,
  autoplay: true,
  repeat: 'Off',
  shuffle: false,
  positionAt: SERVER_NOW,
  seekSeq,
})

/** The local change's message went out as this connection's `seq`th. */
const sentAs = (seq: number) =>
  Command.resolve(
    SendLocalChange,
    Message.SentLocalChange({ maybeSeq: Option.some(seq) }),
  )

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
          ack: 9,
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
          maybeDurationSeconds: Option.some(213),
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
                isPlayingSetHere: false,
              },
            }),
        }),
      ),
      message(
        Message.ReceivedSessionState({
          state: sessionState('tv', 2),
          serverNow: SERVER_NOW,
          ack: 9,
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
                isPlayingSetHere: false,
              },
            }),
        }),
      ),
      message(Message.EndedPhoneAudio({ entryId: 'e0' })),
      model(model => {
        expect(
          Option.exists(
            loadedEntry(model.phoneAudio),
            loaded => !loaded.isPlaying,
          ),
        ).toBe(true)
        expect(model.phoneAudioSeconds).toBe(0)
      }),
      Command.expectExact(
        SetPhoneAudioPlaying({ isPlaying: false }),
        SeekPhoneAudio({ seconds: 0 }),
        SendLocalChange({ message: { _tag: 'TrackEnded', entryId: 'e0' } }),
      ),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      sentAs(2),
    )
  })
})

const playingHere = (seekSeq: number): Model =>
  modifyFields(connectedModel, {
    maybeSession: () =>
      Option.some({ state: sessionState(PHONE_ID, seekSeq), clockOffsetMs: 0 }),
    phoneAudio: () =>
      PhoneAudio.Loaded({
        entry: {
          entryId: 'e0',
          seekSeq,
          isPlaying: true,
          isBuffering: false,
          isPlayingSetHere: false,
        },
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
        SendLocalChange({ message: { _tag: 'Seek', positionSeconds: 90 } }),
      ),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      sentAs(2),
      message(
        Message.ReceivedSessionState({
          state: { ...sessionState(PHONE_ID, 2), positionSeconds: 90 },
          serverNow: SERVER_NOW,
          ack: 9,
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
        SendLocalChange({ message: { _tag: 'Seek', positionSeconds: 120 } }),
      ),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      sentAs(2),
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
      autoplay: false,
    })
    const added = ['s1', 's2', 's3', 's4', 's5', 's6'].map(queued)
    story(
      update,
      given(playingHere(1)),
      message(
        Message.ReceivedSessionState({
          state: { ...sessionState(PHONE_ID, 1), queue: [entry, ...added] },
          serverNow: SERVER_NOW,
          ack: 9,
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
        SendLocalChange({
          message: {
            _tag: 'Pause',
            at: { entryId: 'e0', positionSeconds: 40, seekSeq: 1 },
          },
        }),
      ),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      sentAs(2),
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

describe('starting a radio', () => {
  const radioSong: Song = {
    videoId: 'XFkzRNyygfk',
    title: 'Creep',
    artists: [{ maybeId: Option.some('UC2'), name: 'Radiohead' }],
    maybeAlbum: Option.none(),
    maybeDurationSeconds: Option.some(237),
    artwork: [],
  }

  const playRadioSong = SendToSession({
    message: {
      _tag: 'PlayQueue',
      tracks: [toQueueTrack(radioSong)],
      startIndex: 0,
    },
  })

  test('plays the song alone, and autoplay fills in after it', () => {
    story(
      update,
      given(playingHere(1)),
      message(Message.ClickedStartRadio({ song: radioSong })),
      Command.expectExact(playRadioSong),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('turns autoplay back on when it was off', () => {
    const autoplayOff = modifyFields(playingHere(1), {
      maybeSession: maybeSession =>
        Option.map(maybeSession, snapshot => ({
          ...snapshot,
          state: { ...snapshot.state, autoplay: false },
        })),
    })
    story(
      update,
      given(autoplayOff),
      message(Message.ClickedStartRadio({ song: radioSong })),
      Command.expectExact(
        playRadioSong,
        SendToSession({ message: { _tag: 'SetAutoplay', enabled: true } }),
      ),
      Command.resolveAll(
        [SendToSession, Message.CompletedSendToSession()],
        [SendToSession, Message.CompletedSendToSession()],
      ),
    )
  })
})

describe('moving a song in the queue', () => {
  const queued = (entryId: string, autoplay = false): Session.QueueEntry => ({
    entryId,
    track: { ...entry.track, videoId: `v-${entryId}` },
    autoplay,
  })
  const queueOf = (...entryIds: ReadonlyArray<string>) =>
    entryIds.map(entryId =>
      entryId === entry.entryId ? entry : queued(entryId, entryId === 'r1'),
    )
  const ORDER = queueOf('e0', 'q1', 'q2', 'q3', 'r1')
  /** The TV plays, so this phone is only the remote. */
  const stateMessage = (
    queue: ReadonlyArray<Session.QueueEntry>,
    ack: number,
  ) =>
    Message.ReceivedSessionState({
      state: { ...sessionState('tv', 1), queue },
      serverNow: SERVER_NOW,
      ack,
      receivedAt: SERVER_NOW,
    })
  const remoteWith = (queue: ReadonlyArray<Session.QueueEntry>): Model =>
    modifyFields(connectedModel, {
      maybeSession: () =>
        Option.some({
          state: { ...sessionState('tv', 1), queue },
          clockOffsetMs: 0,
        }),
    })
  const shownOrder = (model: Model) =>
    Option.match(model.maybeSession, {
      onNone: () => [],
      onSome: ({ state }) => state.queue.map(({ entryId }) => entryId),
    })
  const dragQ3BeforeQ1 = message(
    Message.DraggedQueueEntry({
      entryId: 'q3',
      maybeBeforeEntryId: Option.some('q1'),
    }),
  )
  const sendQ3BeforeQ1 = SendQueueMove({
    message: { _tag: 'MoveEntry', entryId: 'q3', beforeEntryId: 'q1' },
  })
  const sentAsMove = (maybeSeq: Option.Option<number>) =>
    Command.resolve(
      SendQueueMove,
      Message.SentQueueMove({ entryId: 'q3', maybeSeq }),
    )

  test('a dragged row moves at once and asks the server to move it', () => {
    story(
      update,
      given(remoteWith(ORDER)),
      dragQ3BeforeQ1,
      model(model => {
        expect(shownOrder(model)).toEqual(['e0', 'q3', 'q1', 'q2', 'r1'])
      }),
      Command.expectExact(sendQ3BeforeQ1),
      sentAsMove(Option.some(4)),
    )
  })

  test('dropping a row last sends no song to go before', () => {
    story(
      update,
      given(remoteWith(ORDER)),
      message(
        Message.DraggedQueueEntry({
          entryId: 'q1',
          maybeBeforeEntryId: Option.none(),
        }),
      ),
      model(model => {
        // Last among the songs someone queued: autoplay's stay after.
        expect(shownOrder(model)).toEqual(['e0', 'q2', 'q3', 'q1', 'r1'])
      }),
      Command.expectExact(
        SendQueueMove({
          message: { _tag: 'MoveEntry', entryId: 'q1', beforeEntryId: null },
        }),
      ),
      Command.resolve(
        SendQueueMove,
        Message.SentQueueMove({ entryId: 'q1', maybeSeq: Option.some(4) }),
      ),
    )
  })

  test('a state sent before the server heard of the move does not undo it', () => {
    story(
      update,
      given(remoteWith(ORDER)),
      dragQ3BeforeQ1,
      Command.expectExact(sendQ3BeforeQ1),
      sentAsMove(Option.some(4)),
      // The server's state from before the move arrives.
      message(stateMessage(ORDER, 3)),
      model(model => {
        expect(shownOrder(model)).toEqual(['e0', 'q3', 'q1', 'q2', 'r1'])
      }),
      // Autoplay added a song, but the server had not seen the move yet.
      message(stateMessage([...ORDER, queued('r2', true)], 3)),
      model(model => {
        expect(shownOrder(model)).toEqual(['e0', 'q3', 'q1', 'q2', 'r1', 'r2'])
        expect(model.queueMoves).toHaveLength(1)
      }),
      // The server's answer includes it: the phone follows the server again.
      message(stateMessage(queueOf('e0', 'q3', 'q1', 'q2', 'r1'), 4)),
      model(model => {
        expect(shownOrder(model)).toEqual(['e0', 'q3', 'q1', 'q2', 'r1'])
        expect(model.queueMoves).toEqual([])
      }),
      // A later move from another device is followed.
      message(stateMessage(queueOf('e0', 'q2', 'q3', 'q1', 'r1'), 4)),
      model(model => {
        expect(shownOrder(model)).toEqual(['e0', 'q2', 'q3', 'q1', 'r1'])
      }),
    )
  })

  test('a move that never went out is forgotten, and the server order shows again', () => {
    story(
      update,
      given(remoteWith(ORDER)),
      dragQ3BeforeQ1,
      Command.expectExact(sendQ3BeforeQ1),
      sentAsMove(Option.none()),
      model(model => {
        expect(model.queueMoves).toEqual([])
      }),
      message(stateMessage(ORDER, 1)),
      model(model => {
        expect(shownOrder(model)).toEqual(ORDER.map(({ entryId }) => entryId))
      }),
    )
  })

  test('the current song, or a move that changes nothing, sends nothing', () => {
    story(
      update,
      given(remoteWith(ORDER)),
      message(
        Message.DraggedQueueEntry({
          entryId: 'e0',
          maybeBeforeEntryId: Option.none(),
        }),
      ),
      message(
        Message.DraggedQueueEntry({
          entryId: 'q1',
          maybeBeforeEntryId: Option.some('q2'),
        }),
      ),
      Command.expectNone(),
      model(model => {
        expect(shownOrder(model)).toEqual(ORDER.map(({ entryId }) => entryId))
        expect(model.queueMoves).toEqual([])
      }),
    )
  })
})

describe('on the lock screen', () => {
  const queued = (index: number): Session.QueueEntry => ({
    entryId: `e${index}`,
    track: { ...entry.track, videoId: `song-${index}`, title: `Song ${index}` },
    autoplay: false,
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
          entry: {
            entryId,
            seekSeq: 4,
            isPlaying,
            isBuffering: false,
            isPlayingSetHere: false,
          },
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
      maybeDurationSeconds: Option.some(213),
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
    sentAs(2),
    Command.resolve(SaveRecentlyPlayed, Message.CompletedSaveRecentlyPlayed()),
  ]

  test('with repeat on, the last song ending starts the first on its own', () => {
    const repeating = modifyFields(playingQueue('e2'), {
      maybeSession: maybeSession =>
        Option.map(maybeSession, snapshot => ({
          ...snapshot,
          state: { ...snapshot.state, repeat: 'All' as const },
        })),
    })
    story(
      update,
      given(repeating),
      message(Message.EndedPhoneAudio({ entryId: 'e2' })),
      model(model => {
        expect(currentEntryId(model)).toEqual(Option.some('e0'))
        expect(model.phoneAudioSeconds).toBe(0)
      }),
      Command.expectExact(
        loads(0),
        mediaSessionFor(0),
        prefetchFrom(0),
        SendLocalChange({ message: { _tag: 'Advanced', fromEntryId: 'e2' } }),
        SaveRecentlyPlayed({ recentlyPlayed: [queue[0]!.track] }),
      ),
      ...resolveLoad(0),
    )
  })

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
              isPlayingSetHere: false,
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
        SendLocalChange({ message: { _tag: 'Advanced', fromEntryId: 'e0' } }),
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
          ack: 9,
          receivedAt: SERVER_NOW,
        }),
      ),
      Command.expectExact(prefetchFrom(1)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
    )
  })

  test('a server state sent before the server heard of the move does not undo it', () => {
    const staleState = Message.ReceivedSessionState({
      state: { ...sessionState(PHONE_ID, 4), queue, currentEntryId: 'e0' },
      serverNow: SERVER_NOW + 500,
      // The Advanced went out second; this state has only the Hello.
      ack: 1,
      receivedAt: SERVER_NOW + 500,
    })
    story(
      update,
      given(playingQueue('e0')),
      message(Message.EndedPhoneAudio({ entryId: 'e0' })),
      ...resolveLoad(1),
      message(staleState),
      model(model => {
        expect(currentEntryId(model)).toEqual(Option.some('e1'))
        expect(
          Option.exists(
            loadedEntry(model.phoneAudio),
            ({ entryId }) => entryId === 'e1',
          ),
        ).toBe(true)
      }),
      Command.expectExact(prefetchFrom(1)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
      // The server catches up; the wait ends.
      message(
        Message.ReceivedSessionState({
          state: { ...sessionState(PHONE_ID, 4), queue, currentEntryId: 'e1' },
          serverNow: SERVER_NOW + 600,
          ack: 2,
          receivedAt: SERVER_NOW + 600,
        }),
      ),
      model(model => {
        expect(
          Option.exists(
            loadedEntry(model.phoneAudio),
            ({ entryId }) => entryId === 'e1',
          ),
        ).toBe(true)
      }),
      Command.expectExact(prefetchFrom(1)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
    )
  })

  test("another device's jump wins once the server has the phone's move", () => {
    story(
      update,
      given(playingQueue('e0')),
      message(Message.EndedPhoneAudio({ entryId: 'e0' })),
      ...resolveLoad(1),
      message(
        Message.ReceivedSessionState({
          state: {
            ...sessionState(PHONE_ID, 5),
            queue,
            currentEntryId: 'e2',
            positionSeconds: 0,
            positionAt: SERVER_NOW + 6_000,
          },
          serverNow: SERVER_NOW + 6_000,
          // The server took the Advanced after the other device's skip,
          // and ignored it.
          ack: 2,
          receivedAt: SERVER_NOW + 6_000,
        }),
      ),
      model(model => {
        expect(currentEntryId(model)).toEqual(Option.some('e2'))
      }),
      Command.expectHas(
        LoadPhoneAudio({
          entryId: 'e2',
          videoId: 'song-2',
          maybeDurationSeconds: Option.some(213),
          startSeconds: 0,
          isPlaying: true,
        }),
      ),
      Command.resolve(
        LoadPhoneAudio,
        Message.CompletedLoadPhoneAudio({ entryId: 'e2', isBlocked: false }),
      ),
      Command.resolve(
        UpdateMediaSession,
        Message.CompletedUpdateMediaSession(),
      ),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
      Command.resolve(
        SaveRecentlyPlayed,
        Message.CompletedSaveRecentlyPlayed(),
      ),
    )
  })

  test('a tapped queue row plays on the phone at once', () => {
    story(
      update,
      given(playingQueue('e0', false)),
      message(Message.ClickedQueueEntry({ entryId: 'e2' })),
      model(model => {
        expect(currentEntryId(model)).toEqual(Option.some('e2'))
        expect(
          Option.exists(model.maybeSession, ({ state }) => state.playing),
        ).toBe(true)
      }),
      Command.expectExact(
        loads(2),
        mediaSessionFor(2),
        prefetchFrom(2),
        SendLocalChange({ message: { _tag: 'SkipTo', entryId: 'e2' } }),
        SaveRecentlyPlayed({ recentlyPlayed: [queue[2]!.track] }),
      ),
      ...resolveLoad(2),
    )
  })

  test('the last song ending stops the phone, which then reports it stopped', () => {
    story(
      update,
      given(playingQueue('e2')),
      message(Message.EndedPhoneAudio({ entryId: 'e2' })),
      model(model => {
        expect(
          Option.exists(model.maybeSession, ({ state }) => !state.playing),
        ).toBe(true)
      }),
      Command.expectExact(
        SetPhoneAudioPlaying({ isPlaying: false }),
        SeekPhoneAudio({ seconds: 0 }),
        SendLocalChange({ message: { _tag: 'TrackEnded', entryId: 'e2' } }),
      ),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      sentAs(2),
      message(Message.ClosedSessionSocket()),
      Command.resolve(
        WaitBeforeReconnect,
        Message.CompletedWaitBeforeReconnect(),
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
              positionSeconds: 0,
              playing: false,
              playingSetHere: true,
              seekSeq: 4,
            },
          },
        }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
    )
  })

  test('previous while paused decides from the position the server has', () => {
    story(
      update,
      given(
        modifyFields(playingQueue('e1', false), {
          // The phone's element stopped a little earlier than the server's
          // estimate of where a remote pause caught it.
          phoneAudioSeconds: () => 2.5,
        }),
      ),
      message(Message.PressedMediaKey({ key: 'PreviousTrack' })),
      model(model => {
        expect(currentEntryId(model)).toEqual(Option.some('e1'))
      }),
      Command.expectExact(
        SeekPhoneAudio({ seconds: 0 }),
        SendLocalChange({ message: { _tag: 'Seek', positionSeconds: 0 } }),
      ),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      sentAs(2),
    )
  })

  test("the server's answer to next does not undo a pause made right after", () => {
    story(
      update,
      given(playingQueue('e0')),
      message(Message.PressedMediaKey({ key: 'NextTrack' })),
      ...resolveLoad(1),
      message(Message.PressedMediaKey({ key: 'Pause' })),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      sentAs(3),
      // The answer to Next, sent before the server heard of the pause.
      message(
        Message.ReceivedSessionState({
          state: {
            ...sessionState(PHONE_ID, 5),
            queue,
            currentEntryId: 'e1',
            positionSeconds: 0,
          },
          serverNow: SERVER_NOW,
          ack: 2,
          receivedAt: SERVER_NOW,
        }),
      ),
      model(model => {
        expect(
          Option.exists(model.maybeSession, ({ state }) => !state.playing),
        ).toBe(true)
      }),
      Command.expectExact(prefetchFrom(1)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
      // The answer to Pause agrees; another device may play again after.
      message(
        Message.ReceivedSessionState({
          state: {
            ...sessionState(PHONE_ID, 5),
            queue,
            currentEntryId: 'e1',
            playing: false,
            positionSeconds: 0,
          },
          serverNow: SERVER_NOW,
          ack: 3,
          receivedAt: SERVER_NOW,
        }),
      ),
      Command.expectExact(prefetchFrom(1)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
      message(
        Message.ReceivedSessionState({
          state: {
            ...sessionState(PHONE_ID, 5),
            queue,
            currentEntryId: 'e1',
            positionSeconds: 0,
          },
          serverNow: SERVER_NOW,
          ack: 3,
          receivedAt: SERVER_NOW,
        }),
      ),
      Command.expectExact(
        SetPhoneAudioPlaying({ isPlaying: true }),
        prefetchFrom(1),
      ),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
    )
  })

  test('a song that fails leaves nothing loaded, so a reconnect retries it', () => {
    story(
      update,
      given(playingQueue('e1')),
      message(Message.FailedPhoneAudio({ entryId: 'e1', error: 'Network' })),
      model(model => {
        expect(model.phoneAudio._tag).toBe('Idle')
      }),
      Command.expectExact(
        SendToSession({
          message: { _tag: 'TrackFailed', entryId: 'e1', message: 'Network' },
        }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
      message(Message.ClosedSessionSocket()),
      Command.resolve(
        WaitBeforeReconnect,
        Message.CompletedWaitBeforeReconnect(),
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

  test('two quick presses of previous go back a song without replaying the first', () => {
    story(
      update,
      given(playingQueue('e1')),
      // The first press restarts the song, the second goes back a song.
      message(Message.PressedMediaKey({ key: 'PreviousTrack' })),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      sentAs(2),
      message(Message.PressedMediaKey({ key: 'PreviousTrack' })),
      ...resolveLoad(0).map((step, index) => (index === 3 ? sentAs(3) : step)),
      // The answer to the restart, before the server heard of the second.
      message(
        Message.ReceivedSessionState({
          state: {
            ...sessionState(PHONE_ID, 5),
            queue,
            currentEntryId: 'e1',
            positionSeconds: 0,
          },
          serverNow: SERVER_NOW,
          ack: 2,
          receivedAt: SERVER_NOW,
        }),
      ),
      model(model => {
        expect(currentEntryId(model)).toEqual(Option.some('e0'))
      }),
      Command.expectExact(prefetchFrom(0)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
      message(
        Message.ReceivedSessionState({
          state: {
            ...sessionState(PHONE_ID, 6),
            queue,
            currentEntryId: 'e0',
            positionSeconds: 0,
          },
          serverNow: SERVER_NOW,
          ack: 3,
          receivedAt: SERVER_NOW,
        }),
      ),
      model(model => {
        expect(currentEntryId(model)).toEqual(Option.some('e0'))
      }),
      Command.expectExact(prefetchFrom(0)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
    )
  })

  test('quick play, pause, play ends playing, with no pause in between', () => {
    const answer = (playing: boolean, ack: number) =>
      message(
        Message.ReceivedSessionState({
          state: {
            ...sessionState(PHONE_ID, 4),
            queue,
            currentEntryId: 'e1',
            playing,
            positionSeconds: 40,
          },
          serverNow: SERVER_NOW,
          ack,
          receivedAt: SERVER_NOW,
        }),
      )
    const press = (key: 'Play' | 'Pause', seq: number) => [
      message(Message.PressedMediaKey({ key })),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      sentAs(seq),
    ]
    story(
      update,
      given(playingQueue('e1', false)),
      ...press('Play', 2),
      ...press('Pause', 3),
      ...press('Play', 4),
      answer(true, 2),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
      answer(false, 3),
      model(model => {
        expect(
          Option.exists(model.maybeSession, ({ state }) => state.playing),
        ).toBe(true)
      }),
      Command.expectExact(prefetchFrom(1)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
      answer(true, 4),
      Command.expectExact(prefetchFrom(1)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
    )
  })

  test("a late answer to the phone's own next does not seek it back", () => {
    story(
      update,
      given(playingQueue('e0')),
      message(Message.PressedMediaKey({ key: 'NextTrack' })),
      ...resolveLoad(1),
      // Three seconds into e1 before the slow answer lands.
      message(
        Message.UpdatedPhoneAudioTime({
          entryId: 'e1',
          seconds: 3,
          at: SERVER_NOW + 3_000,
        }),
      ),
      Command.resolve(SendToSession, Message.CompletedSendToSession()),
      message(
        Message.ReceivedSessionState({
          state: {
            ...sessionState(PHONE_ID, 5),
            queue,
            currentEntryId: 'e1',
            positionSeconds: 0,
            positionAt: SERVER_NOW + 3_000,
          },
          serverNow: SERVER_NOW + 3_000,
          ack: 2,
          receivedAt: SERVER_NOW + 3_000,
        }),
      ),
      model(model => {
        expect(model.phoneAudioSeconds).toBe(3)
        expect(
          Option.exists(
            loadedEntry(model.phoneAudio),
            ({ seekSeq }) => seekSeq === 5,
          ),
        ).toBe(true)
      }),
      Command.expectExact(prefetchFrom(1)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
    )
  })

  test("another device's seek reaches the phone even while its play is in flight", () => {
    story(
      update,
      given(playingQueue('e1', false)),
      message(Message.PressedMediaKey({ key: 'Play' })),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      sentAs(2),
      // The other device's seek, before the server took the Resume.
      message(
        Message.ReceivedSessionState({
          state: {
            ...sessionState(PHONE_ID, 5),
            queue,
            currentEntryId: 'e1',
            playing: false,
            positionSeconds: 10,
          },
          serverNow: SERVER_NOW,
          ack: 1,
          receivedAt: SERVER_NOW,
        }),
      ),
      Command.expectExact(prefetchFrom(1)),
      Command.resolve(PrefetchSongs, Message.CompletedPrefetchSongs()),
      message(
        Message.ReceivedSessionState({
          state: {
            ...sessionState(PHONE_ID, 5),
            queue,
            currentEntryId: 'e1',
            positionSeconds: 10,
          },
          serverNow: SERVER_NOW,
          ack: 2,
          receivedAt: SERVER_NOW,
        }),
      ),
      Command.expectExact(SeekPhoneAudio({ seconds: 10 }), prefetchFrom(1)),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
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
        SendLocalChange({ message: { _tag: 'Next' } }),
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
        SendLocalChange({ message: { _tag: 'SkipTo', entryId: 'e0' } }),
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
        SendLocalChange({ message: { _tag: 'Seek', positionSeconds: 0 } }),
      ),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      sentAs(2),
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
        SendLocalChange({ message: { _tag: 'Seek', positionSeconds: 150 } }),
      ),
      Command.resolve(SeekPhoneAudio, Message.CompletedSeekPhoneAudio()),
      sentAs(2),
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
      Command.expectExact(
        SendLocalChange({
          message: {
            _tag: 'Pause',
            at: { entryId: 'e1', positionSeconds: 40, seekSeq: 4 },
          },
        }),
      ),
      sentAs(2),
      message(Message.PressedMediaKey({ key: 'Play' })),
      model(model => {
        expect(
          Option.exists(model.maybeSession, ({ state }) => state.playing),
        ).toBe(true)
      }),
      Command.expectExact(
        SetPhoneAudioPlaying({ isPlaying: true }),
        SendLocalChange({ message: { _tag: 'Resume' } }),
      ),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      sentAs(2),
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
        SendLocalChange({
          message: {
            _tag: 'Pause',
            at: { entryId: 'e1', positionSeconds: 40, seekSeq: 4 },
          },
        }),
      ),
      Command.resolve(
        SetPhoneAudioPlaying,
        Message.CompletedSetPhoneAudioPlaying({ isBlocked: false }),
      ),
      sentAs(2),
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
              playingSetHere: false,
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
