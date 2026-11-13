import { Option, Result } from 'effect'
import {
  Command,
  Mount,
  Subscription,
  click,
  expect,
  given,
  label,
  role,
  scene,
  selector,
  text,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import { type Session, type Song } from '@music/shared'

import { LockScroll, UnlockScroll } from './command'
import { Message } from './message'
import { type Model } from './model'
import {
  DragToDismiss,
  FollowLyrics,
  FollowQueueDrags,
  FollowSeekBarDrags,
  Marquee,
  RestoreScroll,
} from './mount'
import { PlayerSheet } from './playback/domain'
import { toQueueTrack } from './playback/queueTrack'
import { songQuery } from './query'
import { AppRoute } from './route'
import { initialModel, update } from './update'
import { view } from './view'

/*
 * The player keeps each of its parts until what that part shows changes
 * (`src/view/player.ts`, MEMOIZATION). These scenes check that a kept part
 * never goes stale: what changed while the player was closed shows once it
 * opens, and each tick of the clock still moves what it should.
 */

const SERVER_NOW = 1_000_000

const song = (videoId: string, title: string): Song => ({
  videoId,
  title,
  artists: [{ maybeId: Option.none(), name: 'Fleetwood Mac' }],
  maybeAlbum: Option.some({ id: 'MPREb_1SbgcDGdrT4', name: 'Rumours' }),
  maybeDurationSeconds: Option.some(270),
  artwork: [],
})

const theChain = song('FhgFtXESdPk', 'The Chain')
const dreams = song('dr34ms', 'Dreams')
const goYourOwnWay = song('g0y0w', 'Go Your Own Way')

const entry = (entryId: string, track: Song): Session.QueueEntry => ({
  entryId,
  track: toQueueTrack(track),
  autoplay: false,
})

const tv: Session.Device = {
  id: 'tv',
  name: 'TV',
  kind: 'Tv',
  online: true,
  waking: false,
  poweredOn: true,
  volume: null,
}

const sessionState = (
  queue: ReadonlyArray<Session.QueueEntry>,
  sleepTimer: Session.SleepTimer | null = null,
): Session.SessionState => ({
  devices: [tv],
  activeDeviceId: 'tv',
  queue,
  currentEntryId: 'e0',
  playing: true,
  positionSeconds: 10,
  positionAt: SERVER_NOW,
  seekSeq: 1,
  autoplay: true,
  repeat: 'Off',
  shuffle: false,
  sleepTimer,
  playingFrom: null,
  soundCheck: false,
})

/** The Chain playing on the TV, 10 seconds in, with the player open. */
const playingOnTv = (
  queue: ReadonlyArray<Session.QueueEntry>,
  sleepTimer: Session.SleepTimer | null = null,
): Model =>
  modifyFields(initialModel(AppRoute.Library(), '/library'), {
    maybeIdentity: () =>
      Option.some({ deviceId: 'phone-1', deviceName: 'iPhone' }),
    playerSheet: () => PlayerSheet.Open(),
    now: () => SERVER_NOW,
    maybeSession: () =>
      Option.some({
        clockOffsetMs: 0,
        state: sessionState(queue, sleepTimer),
      }),
  })

const pageScrolled = Mount.resolve(
  RestoreScroll,
  Message.CompletedRestoreScroll(),
)

const playerMounts = Mount.resolveAll(
  [DragToDismiss, Message.CompletedFollowSheetDrags()],
  [Marquee, Message.CompletedSyncMarquee()],
  [FollowSeekBarDrags, Message.CompletedFollowSeekBarDrags()],
)

const queueFollowsDrags = Mount.resolve(
  FollowQueueDrags,
  Message.CompletedFollowQueueDrags(),
)

const scrollLocked = Command.resolve(LockScroll, Message.CompletedLockScroll())

const scrollUnlocked = Command.resolve(
  UnlockScroll,
  Message.CompletedUnlockScroll(),
)

const stateArrives = (state: Session.SessionState) =>
  Subscription.emit(
    Message.ReceivedSessionState({
      state,
      serverNow: SERVER_NOW,
      ack: 0,
      receivedAt: SERVER_NOW,
    }),
  )

const clockTicks = (now: number) =>
  Subscription.emit(Message.TickedClock({ now }))

describe('player', () => {
  test('shows a queue that changed while it was closed', () => {
    const before = [entry('e0', theChain), entry('e1', goYourOwnWay)]
    scene(
      { update, view },
      given(playingOnTv(before)),
      pageScrolled,
      playerMounts,
      click(role('button', { name: 'Up next' })),
      queueFollowsDrags,
      expect(text('Go Your Own Way')).toExist(),
      click(role('button', { name: 'Close player' })),
      scrollUnlocked,
      stateArrives(sessionState([entry('e0', theChain), entry('e2', dreams)])),
      click(label('Open player')),
      scrollLocked,
      expect(role('button', { name: 'Up next' })).toHaveAttr(
        'aria-pressed',
        'true',
      ),
      expect(text('Dreams')).toExist(),
      expect(text('Go Your Own Way')).not.toExist(),
    )
  })

  test('each tick moves the time, open or closed', () => {
    scene(
      { update, view },
      given(playingOnTv([entry('e0', theChain)])),
      pageScrolled,
      playerMounts,
      expect(text('0:10')).toExist(),
      expect(text('-4:20')).toExist(),
      clockTicks(SERVER_NOW + 5_000),
      expect(text('0:15')).toExist(),
      expect(text('-4:15')).toExist(),
      click(role('button', { name: 'Close player' })),
      scrollUnlocked,
      clockTicks(SERVER_NOW + 27_000),
      click(label('Open player')),
      scrollLocked,
      expect(text('0:37')).toExist(),
      expect(text('-3:53')).toExist(),
    )
  })

  test('the lyrics follow the song as the clock ticks', () => {
    const lyricsOpen = update(
      playingOnTv([entry('e0', theChain)]),
      Message.SelectedPlayerPanel({ panel: 'Lyrics' }),
    ).model
    const withLyrics = update(
      lyricsOpen,
      Message.GotSongMessage({
        message: songQuery.Message.CompletedFetch({
          args: { videoId: theChain.videoId },
          generation: 1,
          result: Result.succeed({
            song: theChain,
            maybeViewCount: Option.none(),
            maybeLyrics: Option.some({
              text: 'Listen to the wind blow\nWatch the sun rise',
              maybeSource: Option.none(),
              maybeLines: Option.some([
                { startSeconds: 9, text: 'Listen to the wind blow', words: [] },
                { startSeconds: 14, text: 'Watch the sun rise', words: [] },
              ]),
            }),
          }),
        }),
      }),
    ).model
    const activeLine = selector('[data-lyric-row][data-state="active"]')
    scene(
      { update, view },
      given(withLyrics),
      pageScrolled,
      playerMounts,
      Mount.resolve(FollowLyrics, Message.CompletedFollowLyrics()),
      expect(activeLine).toHaveText('Listen to the wind blow'),
      clockTicks(SERVER_NOW + 5_000),
      expect(activeLine).toHaveText('Watch the sun rise'),
    )
  })

  test('the sleep timer sheet counts down while it shows', () => {
    scene(
      { update, view },
      given(
        playingOnTv([entry('e0', theChain)], {
          _tag: 'At',
          endsAt: SERVER_NOW + 29 * 60_000 + 30_000,
        }),
      ),
      pageScrolled,
      playerMounts,
      click(role('button', { name: 'Sleep Timer: 29:30' })),
      scrollLocked,
      Mount.resolve(DragToDismiss, Message.CompletedFollowSheetDrags()),
      expect(text('The music stops in 29:30.')).toExist(),
      clockTicks(SERVER_NOW + 1_000),
      expect(text('The music stops in 29:29.')).toExist(),
      expect(role('button', { name: 'Sleep Timer: 29:29' })).toExist(),
    )
  })
})
