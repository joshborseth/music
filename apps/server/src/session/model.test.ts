import { describe, expect, test } from 'bun:test'
import { Option, Schema } from 'effect'

import { Session } from '@music/shared'

import {
  type Context,
  type Model,
  type SessionMessage,
  currentPosition,
  fillDuration,
  initialModel,
  lookahead,
  missingDurations,
  playerLost,
  update,
  wakeTimedOut,
} from './model.ts'

const FIXTURES = new URL('../../../../fixtures/session/', import.meta.url)

const track = (videoId: string): Session.QueueTrack => ({
  videoId,
  title: videoId,
  artists: 'Artist',
  album: null,
  durationSeconds: 200,
  artworkUrl: null,
})

const makeContext = (
  senderId: string,
  now: number,
  online: ReadonlyArray<string> = ['phone', 'tv'],
): Context => {
  let counter = 0
  return {
    now,
    senderId,
    isOnline: id => online.includes(id),
    isWakeable: id => id === 'tv',
    makeEntryId: () => `e${counter++}`,
  }
}

const playing = (sender = 'phone'): Model =>
  update(
    initialModel,
    {
      _tag: 'PlayQueue',
      tracks: [track('a'), track('b'), track('c')],
      startIndex: 0,
    },
    makeContext(sender, 1_000),
  ).model

describe('session model', () => {
  test('playing a queue makes the sender the player', () => {
    const model = playing()
    expect(model.activeDeviceId).toBe('phone')
    expect(model.currentEntryId).toBe('e0')
    expect(model.playing).toBe(true)
    expect(lookahead(model)).toEqual({
      download: ['a', 'b', 'c'],
      resolve: [],
    })
  })

  test('lookahead downloads five ahead, resolves five more, then nothing once finished', () => {
    const ids = Array.from({ length: 14 }, (_, index) => `s${index}`)
    const model = update(
      initialModel,
      { _tag: 'PlayQueue', tracks: ids.map(track), startIndex: 1 },
      makeContext('phone', 1_000),
    ).model
    expect(lookahead(model)).toEqual({
      download: ['s1', 's2', 's3', 's4', 's5', 's6'],
      resolve: ['s7', 's8', 's9', 's10', 's11'],
    })
    expect(lookahead({ ...model, currentEntryId: null })).toEqual({
      download: [],
      resolve: [],
    })
  })

  test('transfer keeps the position and asks to wake an offline TV', () => {
    const outcome = update(
      playing(),
      { _tag: 'Transfer', deviceId: 'tv' },
      makeContext('phone', 31_000, ['phone']),
    )
    expect(outcome.model.activeDeviceId).toBe('tv')
    expect(outcome.model.positionSeconds).toBe(30)
    expect(outcome.model.waking).toEqual(['tv'])
    expect(outcome.maybeWake).toEqual(Option.some('tv'))
    expect(outcome.model.seekSeq).toBeGreaterThan(playing().seekSeq)
  })

  test('a gapless advance moves on without asking players to reload', () => {
    const model = playing()
    const outcome = update(
      model,
      { _tag: 'Advanced', fromEntryId: 'e0' },
      makeContext('phone', 5_000),
    )
    expect(outcome.model.currentEntryId).toBe('e1')
    expect(outcome.model.seekSeq).toBe(model.seekSeq)
  })

  test('only the player may report progress', () => {
    const outcome = update(
      playing(),
      {
        _tag: 'Progress',
        entryId: 'e0',
        positionSeconds: 99,
        playing: true,
      },
      makeContext('tv', 2_000),
    )
    expect(outcome.model.positionSeconds).toBe(0)
    expect(outcome.broadcast).toBe(false)
  })

  test('the queue stops after its last song', () => {
    const last = update(
      playing(),
      { _tag: 'SkipTo', entryId: 'e2' },
      makeContext('phone', 2_000),
    ).model
    const ended = update(
      last,
      { _tag: 'TrackEnded', entryId: 'e2' },
      makeContext('phone', 3_000),
    ).model
    expect(ended.currentEntryId).toBe('e2')
    expect(ended.playing).toBe(false)
    expect(currentPosition(ended, 10_000)).toBe(0)
  })

  test('previous restarts the song once it is past three seconds', () => {
    const second = update(
      playing(),
      { _tag: 'Next' },
      makeContext('phone', 1_000),
    ).model
    const restarted = update(
      second,
      { _tag: 'Previous' },
      makeContext('phone', 6_000),
    ).model
    expect(restarted.currentEntryId).toBe('e1')
    const back = update(
      second,
      { _tag: 'Previous' },
      makeContext('phone', 2_000),
    ).model
    expect(back.currentEntryId).toBe('e0')
  })

  test('removing the current entry plays the one after it', () => {
    const outcome = update(
      playing(),
      { _tag: 'RemoveEntry', entryId: 'e0' },
      makeContext('phone', 2_000),
    )
    expect(outcome.model.queue.map(entry => entry.entryId)).toEqual([
      'e1',
      'e2',
    ])
    expect(outcome.model.currentEntryId).toBe('e1')
  })

  test('losing the player pauses where it was', () => {
    const lost = playerLost(playing(), 'phone', 11_000).model
    expect(lost.playing).toBe(false)
    expect(lost.positionSeconds).toBe(10)
  })

  test('resuming while already playing keeps the position moving', () => {
    const resumed = update(
      playing(),
      { _tag: 'Resume' },
      makeContext('phone', 21_000),
    ).model
    expect(resumed.playing).toBe(true)
    expect(currentPosition(resumed, 21_000)).toBe(20)
  })

  type Report = Omit<Session.PlayerReport, 'playingSetHere'> & {
    readonly playingSetHere?: boolean
  }

  const hello = (
    player: Report | null,
    deviceId = 'phone',
  ): SessionMessage => ({
    _tag: 'Hello',
    deviceId,
    name: deviceId,
    kind: deviceId === 'tv' ? 'Tv' : 'Web',
    player: player === null ? null : { playingSetHere: false, ...player },
  })

  test('a player that reconnects mid-song is followed, without a reload', () => {
    const lost = playerLost(playing(), 'phone', 16_000).model
    const advanced = update(
      lost,
      hello({
        entryId: 'e1',
        positionSeconds: 42,
        playing: true,
        seekSeq: lost.seekSeq,
      }),
      makeContext('phone', 60_000),
    ).model
    expect(advanced.currentEntryId).toBe('e1')
    expect(advanced.playing).toBe(true)
    expect(currentPosition(advanced, 61_000)).toBe(43)
    expect(advanced.seekSeq).toBe(lost.seekSeq)

    const paused = update(
      playing(),
      hello({
        entryId: 'e0',
        positionSeconds: 12,
        playing: false,
        playingSetHere: true,
        seekSeq: playing().seekSeq,
      }),
      makeContext('phone', 60_000),
    ).model
    expect(paused.playing).toBe(false)
    expect(currentPosition(paused, 90_000)).toBe(12)
  })

  test('a reconnecting player reloads when the session jumped meanwhile', () => {
    const skipped = update(
      playing(),
      { _tag: 'Next' },
      makeContext('tv', 5_000),
    ).model
    const outcome = update(
      skipped,
      hello({
        entryId: 'e0',
        positionSeconds: 42,
        playing: true,
        seekSeq: playing().seekSeq,
      }),
      makeContext('phone', 6_000),
    ).model
    expect(outcome.currentEntryId).toBe('e1')
    expect(outcome.seekSeq).toBe(skipped.seekSeq + 1)
  })

  test('a reconnecting player is followed after jumps it made itself', () => {
    const model = playing()
    // The phone sought and skipped, but the answers were lost with the
    // connection, so it still knows the first seekSeq.
    const sought = update(
      model,
      { _tag: 'Seek', positionSeconds: 100 },
      makeContext('phone', 2_000),
    ).model
    const skipped = update(
      sought,
      { _tag: 'Next' },
      makeContext('phone', 3_000),
    ).model
    const outcome = update(
      skipped,
      hello({
        entryId: 'e2',
        positionSeconds: 5,
        playing: true,
        seekSeq: model.seekSeq,
      }),
      makeContext('phone', 10_000),
    ).model
    expect(outcome.currentEntryId).toBe('e2')
    expect(outcome.seekSeq).toBe(skipped.seekSeq)
  })

  test('a failed song moves on even if the player reports it after reconnecting', () => {
    const model = playing()
    const failed = update(
      model,
      { _tag: 'TrackFailed', entryId: 'e0', message: 'gone' },
      makeContext('phone', 2_000),
    ).model
    const outcome = update(
      failed,
      hello({
        entryId: 'e0',
        positionSeconds: 1,
        playing: true,
        seekSeq: model.seekSeq,
      }),
      makeContext('phone', 3_000),
    ).model
    expect(outcome.currentEntryId).toBe('e1')
  })

  test('a pause from another device that the player missed stands', () => {
    const paused = update(
      playing(),
      { _tag: 'Pause' },
      makeContext('laptop', 5_000, ['phone', 'laptop']),
    ).model
    const report = {
      entryId: 'e0',
      positionSeconds: 30,
      playing: true,
      seekSeq: paused.seekSeq,
    }
    const followed = update(
      paused,
      hello(report),
      makeContext('phone', 30_000),
    ).model
    expect(followed.playing).toBe(false)
    expect(followed.positionSeconds).toBe(30)
    // A play the phone made itself, after it missed the pause, wins.
    const resumedHere = update(
      paused,
      hello({ ...report, playingSetHere: true }),
      makeContext('phone', 30_000),
    ).model
    expect(resumedHere.playing).toBe(true)
  })

  test('a pause for a lost player ends once anyone plays or pauses', () => {
    const lost = playerLost(playing(), 'phone', 16_000).model
    expect(lost.pausedForLostPlayer).toBe(true)
    const resumed = update(
      lost,
      { _tag: 'Resume' },
      makeContext('laptop', 20_000, ['laptop']),
    ).model
    expect(resumed.pausedForLostPlayer).toBe(false)
  })

  test('the player pausing says where it stopped; others leave it to the server', () => {
    const paused = update(
      playing(),
      {
        _tag: 'Pause',
        at: { entryId: 'e0', positionSeconds: 12.5, seekSeq: 1 },
      },
      makeContext('phone', 15_000),
    ).model
    expect(paused.playing).toBe(false)
    expect(paused.positionSeconds).toBe(12.5)
    const fromRemote = update(
      playing(),
      {
        _tag: 'Pause',
        at: { entryId: 'e0', positionSeconds: 99, seekSeq: 1 },
      },
      makeContext('tv', 15_000),
    ).model
    expect(fromRemote.positionSeconds).toBe(14)
  })

  test('a player reloaded after a jump it missed keeps its own pause', () => {
    const sought = update(
      playing(),
      { _tag: 'Seek', positionSeconds: 100 },
      makeContext('tv', 5_000),
    ).model
    const outcome = update(
      sought,
      hello({
        entryId: 'e0',
        positionSeconds: 30,
        playing: false,
        playingSetHere: true,
        seekSeq: playing().seekSeq,
      }),
      makeContext('phone', 10_000),
    ).model
    expect(outcome.seekSeq).toBe(sought.seekSeq + 1)
    expect(outcome.playing).toBe(false)
    expect(outcome.positionSeconds).toBe(105)
  })

  test('a pause position for a song that is no longer current is ignored', () => {
    const skipped = update(
      playing(),
      { _tag: 'Next' },
      makeContext('tv', 5_000),
    ).model
    const paused = update(
      skipped,
      {
        _tag: 'Pause',
        at: { entryId: 'e0', positionSeconds: 95, seekSeq: 1 },
      },
      makeContext('phone', 6_000),
    ).model
    expect(paused.currentEntryId).toBe('e1')
    expect(paused.positionSeconds).toBe(1)
  })

  test('a player that kept playing past a lost-player pause resumes even when reloaded', () => {
    const lost = playerLost(playing(), 'phone', 16_000).model
    const skipped = update(
      lost,
      { _tag: 'Next' },
      makeContext('laptop', 20_000, ['laptop']),
    ).model
    const outcome = update(
      skipped,
      hello({
        entryId: 'e0',
        positionSeconds: 50,
        playing: true,
        seekSeq: playing().seekSeq,
      }),
      makeContext('phone', 30_000),
    ).model
    expect(outcome.currentEntryId).toBe('e1')
    expect(outcome.seekSeq).toBe(skipped.seekSeq + 1)
    expect(outcome.playing).toBe(true)
    expect(outcome.pausedForLostPlayer).toBe(false)
  })

  test('a pause position counts after the player seeked by itself', () => {
    const sought = update(
      playing(),
      { _tag: 'Seek', positionSeconds: 100 },
      makeContext('phone', 5_000),
    ).model
    const paused = update(
      sought,
      {
        _tag: 'Pause',
        at: {
          entryId: 'e0',
          positionSeconds: 100.4,
          seekSeq: playing().seekSeq,
        },
      },
      makeContext('phone', 5_500),
    ).model
    expect(paused.positionSeconds).toBe(100.4)
  })

  test("a pause position never undoes another device's seek it crossed", () => {
    const sought = update(
      playing(),
      { _tag: 'Seek', positionSeconds: 100 },
      makeContext('tv', 5_000),
    ).model
    const paused = update(
      sought,
      {
        _tag: 'Pause',
        at: { entryId: 'e0', positionSeconds: 4, seekSeq: playing().seekSeq },
      },
      makeContext('phone', 5_500),
    ).model
    expect(paused.positionSeconds).toBe(100.5)
  })

  test('only the player is followed, and only to a queued entry', () => {
    const model = playing()
    const report = {
      entryId: 'e1',
      positionSeconds: 42,
      playing: true,
      seekSeq: model.seekSeq,
    }
    const fromTv = update(
      model,
      hello(report, 'tv'),
      makeContext('tv', 6_000),
    ).model
    expect(fromTv.currentEntryId).toBe('e0')
    const unknown = update(
      model,
      hello({ ...report, entryId: 'gone' }),
      makeContext('phone', 6_000),
    ).model
    expect(unknown.currentEntryId).toBe('e0')
    expect(unknown.seekSeq).toBe(model.seekSeq + 1)
  })

  test('a TV app that sends no report still reloads where it left off', () => {
    const model = playing('tv')
    const outcome = update(
      model,
      { _tag: 'Hello', deviceId: 'tv', name: 'TV', kind: 'Tv' },
      makeContext('tv', 11_000),
    ).model
    expect(outcome.seekSeq).toBe(model.seekSeq + 1)
    expect(outcome.positionSeconds).toBe(10)
  })

  test('a TV that never wakes stops playback with a notice', () => {
    const waking = update(
      playing(),
      { _tag: 'Transfer', deviceId: 'tv' },
      makeContext('phone', 1_000, ['phone']),
    ).model
    const outcome = wakeTimedOut(waking, 'tv', 61_000)
    expect(outcome.model.waking).toEqual([])
    expect(outcome.model.playing).toBe(false)
    expect(Option.isSome(outcome.maybeNotice)).toBe(true)
  })

  test('a song queued without a length gets one, and players do not reload', () => {
    const model = update(
      initialModel,
      {
        _tag: 'PlayQueue',
        tracks: [
          { ...track('a'), durationSeconds: null },
          track('b'),
          { ...track('a'), durationSeconds: null },
        ],
        startIndex: 0,
      },
      makeContext('phone', 1_000),
    ).model
    expect(missingDurations(model, ['a', 'b'])).toEqual(['a'])

    const outcome = fillDuration(model, 'a', 245)
    expect(outcome.broadcast).toBe(true)
    expect(
      outcome.model.queue.map(entry => entry.track.durationSeconds),
    ).toEqual([245, 200, 245])
    expect(outcome.model.currentEntryId).toBe(model.currentEntryId)
    expect(outcome.model.seekSeq).toBe(model.seekSeq)
    expect(missingDurations(outcome.model, ['a', 'b'])).toEqual([])
  })

  test('a length already known is kept', () => {
    const model = playing()
    const outcome = fillDuration(model, 'a', 999)
    expect(outcome.broadcast).toBe(false)
    expect(outcome.model).toBe(model)
  })
})

describe('protocol fixtures shared with the TV app', () => {
  const read = (name: string) => Bun.file(new URL(name, FIXTURES)).text()

  test.each([
    'server-state.json',
    'server-notice.json',
    'server-set-volume.json',
  ])('%s decodes as a server message', async name => {
    const decoded = Schema.decodeExit(Session.ServerMessageJson)(
      await read(name),
    )
    expect(decoded._tag).toBe('Success')
  })

  test.each([
    'client-hello.json',
    'client-hello-player.json',
    'client-progress.json',
    'client-advanced.json',
    'client-pause.json',
    'client-pause-at.json',
    'client-play-queue.json',
    'client-enqueue.json',
    'client-skip-to.json',
    'client-remove-entry.json',
    'client-transfer.json',
    'client-volume.json',
    'client-volume-fixed.json',
    'client-set-device-volume.json',
  ])('%s decodes as a client message', async name => {
    const decoded = Schema.decodeExit(Session.ClientMessageJson)(
      await read(name),
    )
    expect(decoded._tag).toBe('Success')
  })

  test.each([
    '{ "_tag": "Hello", "deviceId": "tv", "name": "TV", "kind": "Tv" }',
    '{ "_tag": "Pause" }',
  ])('%s from a TV app built before the optional fields decodes', text => {
    const decoded = Schema.decodeExit(Session.ClientMessageJson)(text)
    expect(decoded._tag).toBe('Success')
  })
})
