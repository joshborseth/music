import { beforeEach, describe, expect, test } from 'bun:test'
import { Option, Schema } from 'effect'

import { Session } from '@music/shared'

import {
  AUTOPLAY_BATCH,
  type Context,
  type Model,
  type SessionMessage,
  appendAutoplay,
  currentPosition,
  fillDuration,
  initialModel,
  lookahead,
  missingDurations,
  playerLost,
  quietSinceAfter,
  sleepTimerRang,
  toSessionState,
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
    // A fixed shuffle, so tests can name its order.
    random: () => 0,
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
      maybeAutoplayAfter: Option.some('c'),
    })
    expect(lookahead({ ...model, autoplay: false }).maybeAutoplayAfter).toEqual(
      Option.none(),
    )
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
      maybeAutoplayAfter: Option.none(),
    })
    expect(lookahead({ ...model, currentEntryId: null })).toEqual({
      download: [],
      resolve: [],
      maybeAutoplayAfter: Option.none(),
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

  test('progress close to what every device holds stays quiet', () => {
    const model = playing()
    const outcome = update(
      model,
      { _tag: 'Progress', entryId: 'e0', positionSeconds: 9.9, playing: true },
      makeContext('phone', 11_000),
    )
    expect(outcome.broadcast).toBe(false)
    expect(currentPosition(outcome.model, 11_000)).toBe(10)
  })

  test('small slips add up until every device resyncs', () => {
    // The player stalls a little at a time: each report is only 0.2 s
    // behind the one before, but together they pass the tolerance.
    const first = update(
      playing(),
      { _tag: 'Progress', entryId: 'e0', positionSeconds: 4.8, playing: true },
      makeContext('phone', 6_000),
    )
    expect(first.broadcast).toBe(false)
    const second = update(
      first.model,
      { _tag: 'Progress', entryId: 'e0', positionSeconds: 9.6, playing: true },
      makeContext('phone', 11_000),
    )
    expect(second.broadcast).toBe(true)
    expect(currentPosition(second.model, 11_000)).toBeCloseTo(9.6)
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

  test('a failed song says so in plain words and keeps the error off screen', () => {
    const failed = update(
      playing(),
      {
        _tag: 'TrackFailed',
        entryId: 'e0',
        message: 'MEDIA_ELEMENT_ERROR: Format error',
      },
      makeContext('phone', 2_000),
    )
    expect(failed.maybeNotice).toEqual(
      Option.some("Couldn't play “a”. Skipping to the next one."),
    )
    const atLast = update(
      playing(),
      { _tag: 'SkipTo', entryId: 'e2' },
      makeContext('phone', 2_000),
    ).model
    const lastFailed = update(
      atLast,
      { _tag: 'TrackFailed', entryId: 'e2', message: 'gone' },
      makeContext('phone', 3_000),
    )
    expect(lastFailed.maybeNotice).toEqual(Option.some("Couldn't play “c”."))
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

  test('waking the TV opens it without moving playback', () => {
    const model = playing()
    const outcome = update(
      model,
      { _tag: 'Wake', deviceId: 'tv' },
      makeContext('phone', 2_000, ['phone']),
    )
    expect(outcome.model.activeDeviceId).toBe('phone')
    expect(outcome.model.waking).toEqual(['tv'])
    expect(outcome.model.seekSeq).toBe(model.seekSeq)
    expect(outcome.maybeWake).toEqual(Option.some('tv'))
    expect(outcome.broadcast).toBe(true)
  })

  test('waking a TV that is already open, or one that cannot wake, does nothing', () => {
    const model = playing()
    const open = update(
      model,
      { _tag: 'Wake', deviceId: 'tv' },
      makeContext('phone', 2_000),
    )
    expect(open.model).toEqual(model)
    expect(open.maybeWake).toEqual(Option.none())
    const unknown = update(
      model,
      { _tag: 'Wake', deviceId: 'laptop' },
      makeContext('phone', 2_000, ['phone']),
    )
    expect(unknown.maybeWake).toEqual(Option.none())
    expect(Option.isSome(unknown.maybeNotice)).toBe(true)
  })

  test('a woken TV that is not the player connects without making the player reload', () => {
    const woken = update(
      playing(),
      { _tag: 'Wake', deviceId: 'tv' },
      makeContext('phone', 2_000, ['phone']),
    ).model
    const connected = update(
      woken,
      { _tag: 'Hello', deviceId: 'tv', name: 'TV', kind: 'Tv', player: null },
      makeContext('tv', 5_000),
    ).model
    expect(connected.waking).toEqual([])
    expect(connected.activeDeviceId).toBe('phone')
    expect(connected.seekSeq).toBe(woken.seekSeq)
    expect(connected.foreignSeekSeq).toBe(woken.foreignSeekSeq)
  })

  test('a TV that was moved away from before it opened does not make the player reload', () => {
    const toTv = update(
      playing(),
      { _tag: 'Transfer', deviceId: 'tv' },
      makeContext('phone', 2_000, ['phone']),
    ).model
    const back = update(
      toTv,
      { _tag: 'Transfer', deviceId: 'phone' },
      makeContext('phone', 3_000, ['phone']),
    ).model
    const connected = update(
      back,
      { _tag: 'Hello', deviceId: 'tv', name: 'TV', kind: 'Tv', player: null },
      makeContext('tv', 5_000),
    ).model
    expect(connected.activeDeviceId).toBe('phone')
    expect(connected.seekSeq).toBe(back.seekSeq)
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

describe('repeat and shuffle', () => {
  const ids = (model: Model) => model.queue.map(entry => entry.entryId)
  // Entries added in these tests are x0, x1, …, after playing()'s e0–e2.
  let added = 0
  beforeEach(() => {
    added = 0
  })
  const set = (model: Model, message: SessionMessage, at = 2_000) =>
    update(model, message, {
      ...makeContext('phone', at),
      makeEntryId: () => `x${added++}`,
    }).model
  const atLast = () => set(playing(), { _tag: 'SkipTo', entryId: 'e2' })

  test('repeat all starts over after the last song', () => {
    const repeating = set(atLast(), { _tag: 'SetRepeat', mode: 'All' })
    const ended = set(repeating, { _tag: 'TrackEnded', entryId: 'e2' }, 3_000)
    expect(ended.currentEntryId).toBe('e0')
    expect(ended.playing).toBe(true)
    expect(ended.seekSeq).toBe(repeating.seekSeq + 1)
  })

  test('repeat one plays the same song again, and asks the player to restart it', () => {
    const repeating = set(playing(), { _tag: 'SetRepeat', mode: 'One' })
    const ended = set(repeating, { _tag: 'TrackEnded', entryId: 'e0' }, 3_000)
    expect(ended.currentEntryId).toBe('e0')
    expect(ended.playing).toBe(true)
    expect(ended.seekSeq).toBe(repeating.seekSeq + 1)
    // A player that looped it with no gap only says so: no reload.
    const looped = set(
      repeating,
      { _tag: 'Advanced', fromEntryId: 'e0' },
      3_000,
    )
    expect(looped.currentEntryId).toBe('e0')
    expect(looped.seekSeq).toBe(repeating.seekSeq)
    expect(currentPosition(looped, 3_000)).toBe(0)
  })

  test('next moves on even with repeat one, and wraps with repeat on', () => {
    const one = set(playing(), { _tag: 'SetRepeat', mode: 'One' })
    expect(set(one, { _tag: 'Next' }).currentEntryId).toBe('e1')
    const last = set(atLast(), { _tag: 'SetRepeat', mode: 'One' })
    expect(set(last, { _tag: 'Next' }).currentEntryId).toBe('e0')
    expect(set(atLast(), { _tag: 'Next' }).currentEntryId).toBe('e2')
  })

  test('previous from the first song goes to the last with repeat on', () => {
    const all = set(playing(), { _tag: 'SetRepeat', mode: 'All' })
    expect(set(all, { _tag: 'Previous' }, 1_500).currentEntryId).toBe('e2')
    expect(set(playing(), { _tag: 'Previous' }, 1_500).currentEntryId).toBe(
      'e0',
    )
  })

  test('a song that fails moves on, even with repeat one', () => {
    const one = set(playing(), { _tag: 'SetRepeat', mode: 'One' })
    const failed = set(
      one,
      { _tag: 'TrackFailed', entryId: 'e0', message: 'gone' },
      3_000,
    )
    expect(failed.currentEntryId).toBe('e1')
  })

  test('a repeating queue never asks autoplay for more', () => {
    const last = atLast()
    expect(Option.isSome(lookahead(last).maybeAutoplayAfter)).toBe(true)
    const all = set(last, { _tag: 'SetRepeat', mode: 'All' })
    expect(lookahead(all).maybeAutoplayAfter).toEqual(Option.none())
  })

  test('shuffle reorders only the songs to come, and turning it off puts them back', () => {
    const longer = set(playing(), {
      _tag: 'Enqueue',
      tracks: [track('d'), track('e')],
      placement: 'Last',
    })
    expect(ids(longer)).toEqual(['e0', 'e1', 'e2', 'x0', 'x1'])
    const shuffledModel = set(longer, { _tag: 'SetShuffle', enabled: true })
    expect(shuffledModel.shuffle).toBe(true)
    expect(shuffledModel.currentEntryId).toBe('e0')
    expect(ids(shuffledModel)[0]).toBe('e0')
    expect(ids(shuffledModel)).not.toEqual(ids(longer))
    expect([...ids(shuffledModel)].sort()).toEqual(ids(longer))
    // A song added to play next while shuffled still plays next.
    const added = set(shuffledModel, {
      _tag: 'Enqueue',
      tracks: [track('f')],
      placement: 'Next',
    })
    const back = set(added, { _tag: 'SetShuffle', enabled: false })
    expect(back.shuffle).toBe(false)
    expect(ids(back)).toEqual(['e0', 'x2', 'e1', 'e2', 'x0', 'x1'])
  })

  test('playing a list while shuffled starts with the chosen song', () => {
    const on = set(playing(), { _tag: 'SetShuffle', enabled: true })
    const fresh = set(on, {
      _tag: 'PlayQueue',
      tracks: [track('p'), track('q'), track('r'), track('s')],
      startIndex: 2,
    })
    expect(fresh.queue[0]?.track.videoId).toBe('r')
    expect(fresh.queue[0]?.entryId ?? null).toBe(fresh.currentEntryId)
    expect(fresh.queue.map(entry => entry.track.videoId).sort()).toEqual([
      'p',
      'q',
      'r',
      's',
    ])
    // Back in the album's order: what came before the chosen song counts
    // as played, and the rest plays on.
    const back = set(fresh, { _tag: 'SetShuffle', enabled: false })
    expect(back.queue.map(entry => entry.track.videoId)).toEqual([
      'p',
      'q',
      'r',
      's',
    ])
    expect(back.currentEntryId).toBe(fresh.currentEntryId)
  })

  test('the state says how it repeats and whether it is shuffled', () => {
    const model = set(set(playing(), { _tag: 'SetRepeat', mode: 'All' }), {
      _tag: 'SetShuffle',
      enabled: true,
    })
    const state = toSessionState(model, [])
    expect(state.repeat).toBe('All')
    expect(state.shuffle).toBe(true)
  })
})

describe('autoplay', () => {
  const ids = (model: Model) => model.queue.map(entry => entry.track.videoId)
  const autoplayed = (model: Model) =>
    model.queue
      .filter(entry => entry.autoplay)
      .map(entry => entry.track.videoId)
  let counter = 100
  const makeEntryId = () => `x${counter++}`

  test('is on from the start', () => {
    expect(initialModel.autoplay).toBe(true)
  })

  test('adds similar songs after the last one, skipping songs already queued', () => {
    const outcome = appendAutoplay(
      playing(),
      'c',
      [track('a'), track('d'), track('e'), track('d')],
      makeEntryId,
    )
    expect(outcome.broadcast).toBe(true)
    expect(ids(outcome.model)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(autoplayed(outcome.model)).toEqual(['d', 'e'])
    expect(outcome.model.currentEntryId).toBe('e0')
    expect(outcome.model.seekSeq).toBe(playing().seekSeq)
  })

  test('a song played alone, as from search, gets its radio after it', () => {
    const alone = update(
      { ...initialModel, autoplay: true },
      { _tag: 'PlayQueue', tracks: [track('s')], startIndex: 0 },
      makeContext('phone', 1_000),
    ).model
    expect(lookahead(alone).maybeAutoplayAfter).toEqual(Option.some('s'))
    const radio = appendAutoplay(
      alone,
      's',
      [track('s'), track('r1'), track('r2')],
      makeEntryId,
    ).model
    expect(ids(radio)).toEqual(['s', 'r1', 'r2'])
    expect(autoplayed(radio)).toEqual(['r1', 'r2'])
  })

  test('starting a radio with autoplay off turns it on, then fills the queue', () => {
    const context = makeContext('phone', 1_000)
    const off = { ...initialModel, autoplay: false }
    const played = update(
      off,
      { _tag: 'PlayQueue', tracks: [track('s')], startIndex: 0 },
      context,
    ).model
    expect(lookahead(played).maybeAutoplayAfter).toEqual(Option.none())
    const radio = update(
      played,
      { _tag: 'SetAutoplay', enabled: true },
      context,
    ).model
    expect(lookahead(radio).maybeAutoplayAfter).toEqual(Option.some('s'))
  })

  test(`adds at most ${AUTOPLAY_BATCH} at a time`, () => {
    const songs = Array.from({ length: 25 }, (_, index) => track(`r${index}`))
    const outcome = appendAutoplay(playing(), 'c', songs, makeEntryId)
    expect(autoplayed(outcome.model)).toHaveLength(AUTOPLAY_BATCH)
  })

  test('drops songs found for a queue that changed meanwhile', () => {
    const model = update(
      playing(),
      { _tag: 'Enqueue', tracks: [track('z')], placement: 'Last' },
      makeContext('phone', 2_000),
    ).model
    const outcome = appendAutoplay(model, 'c', [track('d')], makeEntryId)
    expect(outcome.broadcast).toBe(false)
    expect(outcome.model).toBe(model)
  })

  test('adds nothing while turned off, and turning it off drops what is still to come', () => {
    const withRadio = appendAutoplay(
      playing(),
      'c',
      [track('d'), track('e')],
      makeEntryId,
    ).model
    const off = update(
      withRadio,
      { _tag: 'SetAutoplay', enabled: false },
      makeContext('phone', 2_000),
    )
    expect(off.broadcast).toBe(true)
    expect(off.model.autoplay).toBe(false)
    expect(ids(off.model)).toEqual(['a', 'b', 'c'])
    expect(
      appendAutoplay(off.model, 'c', [track('d')], makeEntryId).broadcast,
    ).toBe(false)
    expect(toSessionState(off.model, []).autoplay).toBe(false)
  })

  test('turning it off keeps the autoplay song playing now', () => {
    const withRadio = appendAutoplay(
      playing(),
      'c',
      [track('d'), track('e')],
      makeEntryId,
    ).model
    const onD = update(
      withRadio,
      { _tag: 'SkipTo', entryId: withRadio.queue[3]?.entryId ?? '' },
      makeContext('phone', 2_000),
    ).model
    const off = update(
      onD,
      { _tag: 'SetAutoplay', enabled: false },
      makeContext('phone', 3_000),
    ).model
    expect(ids(off)).toEqual(['a', 'b', 'c', 'd'])
    expect(off.currentEntryId).toBe(onD.currentEntryId)
    expect(off.seekSeq).toBe(onD.seekSeq)
  })

  test('songs someone adds to the queue go before the autoplay songs', () => {
    const withRadio = appendAutoplay(
      playing(),
      'c',
      [track('d'), track('e')],
      makeEntryId,
    ).model
    const added = update(
      withRadio,
      { _tag: 'Enqueue', tracks: [track('y')], placement: 'Last' },
      makeContext('phone', 2_000),
    ).model
    expect(ids(added)).toEqual(['a', 'b', 'c', 'y', 'd', 'e'])
    expect(autoplayed(added)).toEqual(['d', 'e'])
  })

  test('playing a new queue replaces the autoplay songs', () => {
    const withRadio = appendAutoplay(
      playing(),
      'c',
      [track('d')],
      makeEntryId,
    ).model
    const replaced = update(
      withRadio,
      { _tag: 'PlayQueue', tracks: [track('q')], startIndex: 0 },
      makeContext('phone', 2_000),
    ).model
    expect(ids(replaced)).toEqual(['q'])
    expect(autoplayed(replaced)).toEqual([])
  })
})

describe('moving a queued song', () => {
  const ids = (model: Model) => model.queue.map(entry => entry.track.videoId)
  let counter = 0
  beforeEach(() => {
    counter = 0
  })
  const apply = (model: Model, message: SessionMessage) =>
    update(model, message, {
      ...makeContext('phone', 2_000),
      makeEntryId: () => `x${counter++}`,
    })
  const move = (model: Model, entryId: string, beforeEntryId: string | null) =>
    apply(model, { _tag: 'MoveEntry', entryId, beforeEntryId })
  /** a (playing), b, c, d, e: entries e0–e4. */
  const five = () =>
    update(
      initialModel,
      {
        _tag: 'PlayQueue',
        tracks: ['a', 'b', 'c', 'd', 'e'].map(track),
        startIndex: 0,
      },
      makeContext('phone', 1_000),
    ).model
  /** five(), then autoplay's p and q (x0, x1) after it. */
  const withRadio = () =>
    appendAutoplay(five(), 'e', [track('p'), track('q')], () => `x${counter++}`)
      .model

  test('moves a song up or down among the songs to come, without a reload', () => {
    const model = five()
    const up = move(model, 'e3', 'e1')
    expect(up.broadcast).toBe(true)
    expect(ids(up.model)).toEqual(['a', 'd', 'b', 'c', 'e'])
    expect(up.model.currentEntryId).toBe('e0')
    expect(up.model.seekSeq).toBe(model.seekSeq)
    expect(up.model.playing).toBe(true)
    expect(ids(move(model, 'e1', 'e4').model)).toEqual([
      'a',
      'c',
      'd',
      'b',
      'e',
    ])
  })

  test('null moves it to the end of the songs someone queued', () => {
    expect(ids(move(five(), 'e1', null).model)).toEqual([
      'a',
      'c',
      'd',
      'e',
      'b',
    ])
    expect(ids(move(withRadio(), 'e1', null).model)).toEqual([
      'a',
      'c',
      'd',
      'e',
      'b',
      'p',
      'q',
    ])
  })

  test('the current song and the songs before it stay put', () => {
    const third = apply(five(), { _tag: 'SkipTo', entryId: 'e2' }).model
    expect(move(third, 'e2', 'e4').broadcast).toBe(false)
    expect(move(third, 'e0', null).broadcast).toBe(false)
    expect(ids(move(third, 'e0', null).model)).toEqual(ids(third))
  })

  test('a song never moves before the current one', () => {
    const third = apply(five(), { _tag: 'SkipTo', entryId: 'e2' }).model
    expect(ids(move(third, 'e4', 'e0').model)).toEqual([
      'a',
      'b',
      'c',
      'e',
      'd',
    ])
    expect(ids(move(third, 'e4', 'e2').model)).toEqual([
      'a',
      'b',
      'c',
      'e',
      'd',
    ])
  })

  test('autoplay songs stay after the songs someone queued', () => {
    const model = withRadio()
    expect(ids(model)).toEqual(['a', 'b', 'c', 'd', 'e', 'p', 'q'])
    // Someone's song dropped among autoplay's goes last of someone's.
    expect(ids(move(model, 'e1', 'x1').model)).toEqual([
      'a',
      'c',
      'd',
      'e',
      'b',
      'p',
      'q',
    ])
    // An autoplay song dropped among someone's goes first of autoplay's.
    expect(ids(move(model, 'x1', 'e2').model)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'q',
      'p',
    ])
    // Autoplay's songs move among themselves, and null puts one last.
    expect(ids(move(model, 'x0', null).model)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'q',
      'p',
    ])
  })

  test('a move that changes nothing, or names an unknown song, stays quiet', () => {
    const model = five()
    expect(move(model, 'e1', 'e2').broadcast).toBe(false)
    expect(move(model, 'e1', 'e1').broadcast).toBe(false)
    expect(move(model, 'e4', null).broadcast).toBe(false)
    expect(move(model, 'gone', 'e1').broadcast).toBe(false)
    expect(move(model, 'e3', 'gone').broadcast).toBe(false)
    expect(ids(move(model, 'e3', 'gone').model)).toEqual(ids(model))
  })

  test('moving while shuffled stays shuffled, and turning it off still puts the songs back', () => {
    const shuffledModel = apply(five(), {
      _tag: 'SetShuffle',
      enabled: true,
    }).model
    // The fixed shuffle puts b, c, d, e as c, d, e, b.
    expect(ids(shuffledModel)).toEqual(['a', 'c', 'd', 'e', 'b'])
    const moved = move(shuffledModel, 'e4', 'e2').model
    expect(ids(moved)).toEqual(['a', 'e', 'c', 'd', 'b'])
    expect(moved.shuffle).toBe(true)
    expect(moved.unshuffled).toEqual(shuffledModel.unshuffled)
    expect(toSessionState(moved, []).shuffle).toBe(true)
    const back = apply(moved, { _tag: 'SetShuffle', enabled: false }).model
    expect(ids(back)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('clearing the songs to come', () => {
  const ids = (model: Model) => model.queue.map(entry => entry.track.videoId)
  let counter = 0
  beforeEach(() => {
    counter = 0
  })
  const apply = (model: Model, message: SessionMessage) =>
    update(model, message, {
      ...makeContext('phone', 2_000),
      makeEntryId: () => `x${counter++}`,
    })
  const clear = (model: Model) => apply(model, { _tag: 'ClearUpcoming' })
  /** a, b (playing), c, d, e: entries e0–e4. */
  const five = () =>
    update(
      initialModel,
      {
        _tag: 'PlayQueue',
        tracks: ['a', 'b', 'c', 'd', 'e'].map(track),
        startIndex: 1,
      },
      makeContext('phone', 1_000),
    ).model
  /** five(), then autoplay's p and q (x0, x1) after it. */
  const withRadio = () =>
    appendAutoplay(five(), 'e', [track('p'), track('q')], () => `x${counter++}`)
      .model

  test('drops the songs after the current one, which plays on without a reload', () => {
    const model = five()
    const outcome = clear(model)
    expect(outcome.broadcast).toBe(true)
    expect(ids(outcome.model)).toEqual(['a', 'b'])
    expect(outcome.model.currentEntryId).toBe('e1')
    expect(outcome.model.playing).toBe(true)
    expect(outcome.model.seekSeq).toBe(model.seekSeq)
    expect(outcome.model.positionSeconds).toBe(model.positionSeconds)
  })

  test("keeps autoplay's songs, which now follow the current one", () => {
    const outcome = clear(withRadio())
    expect(ids(outcome.model)).toEqual(['a', 'b', 'p', 'q'])
    expect(lookahead(outcome.model).download).toEqual(['b', 'p', 'q'])
  })

  test('does nothing when no song someone queued is still to come', () => {
    const cleared = clear(withRadio()).model
    const again = clear(cleared)
    expect(again.broadcast).toBe(false)
    expect(again.model).toBe(cleared)
  })

  test('lets autoplay top the queue up again', () => {
    const cleared = clear(five()).model
    expect(lookahead(cleared).maybeAutoplayAfter).toEqual(Option.some('b'))
    const refilled = appendAutoplay(cleared, 'b', [track('r')], () => 'y0')
    expect(ids(refilled.model)).toEqual(['a', 'b', 'r'])
  })

  test('while shuffled, stays shuffled, and turning it off brings back none of the cleared songs', () => {
    const shuffledModel = apply(five(), {
      _tag: 'SetShuffle',
      enabled: true,
    }).model
    const added = apply(shuffledModel, {
      _tag: 'Enqueue',
      tracks: [track('z')],
      placement: 'Last',
    }).model
    const cleared = clear(added).model
    expect(ids(cleared)).toEqual(['a', 'b'])
    expect(cleared.shuffle).toBe(true)
    expect(cleared.unshuffled).toEqual(['e0', 'e1'])
    const back = apply(cleared, { _tag: 'SetShuffle', enabled: false }).model
    expect(ids(back)).toEqual(['a', 'b'])
    expect(back.currentEntryId).toBe('e1')
  })
})

describe('sleep timer', () => {
  const set = (
    model: Model,
    message: SessionMessage,
    at = 2_000,
    from = 'phone',
  ) => update(model, message, makeContext(from, at))

  test('minutes become a moment by the server clock, which every device sees', () => {
    const outcome = set(
      playing(),
      { _tag: 'SetSleepTimer', timer: { _tag: 'Minutes', minutes: 15 } },
      2_000,
      'tv',
    )
    expect(outcome.broadcast).toBe(true)
    expect(outcome.model.sleepTimer).toEqual({
      _tag: 'At',
      endsAt: 2_000 + 15 * 60_000,
    })
    expect(toSessionState(outcome.model, []).sleepTimer).toEqual(
      outcome.model.sleepTimer,
    )
  })

  test('a timer set again starts over, and null turns it off', () => {
    const first = set(playing(), {
      _tag: 'SetSleepTimer',
      timer: { _tag: 'Minutes', minutes: 30 },
    }).model
    const again = set(
      first,
      { _tag: 'SetSleepTimer', timer: { _tag: 'Minutes', minutes: 5 } },
      60_000,
    ).model
    expect(again.sleepTimer).toEqual({ _tag: 'At', endsAt: 360_000 })
    const off = set(again, { _tag: 'SetSleepTimer', timer: null })
    expect(off.model.sleepTimer).toBeNull()
    expect(off.broadcast).toBe(true)
    expect(
      set(off.model, { _tag: 'SetSleepTimer', timer: null }).broadcast,
    ).toBe(false)
  })

  test('nonsense minutes set nothing, and a day is the most', () => {
    for (const minutes of [0, -5, Number.NaN]) {
      expect(
        set(playing(), {
          _tag: 'SetSleepTimer',
          timer: { _tag: 'Minutes', minutes },
        }).model.sleepTimer,
      ).toBeNull()
    }
    expect(
      set(playing(), {
        _tag: 'SetSleepTimer',
        timer: { _tag: 'Minutes', minutes: 100_000 },
      }).model.sleepTimer,
    ).toEqual({
      _tag: 'At',
      endsAt: 2_000 + Session.MAX_SLEEP_MINUTES * 60_000,
    })
  })

  test('its time pauses the music where it got to, wherever it plays', () => {
    const onTv = set(playing(), { _tag: 'Transfer', deviceId: 'tv' }).model
    const timed = set(onTv, {
      _tag: 'SetSleepTimer',
      timer: { _tag: 'Minutes', minutes: 1 },
    }).model
    expect(sleepTimerRang(timed, 61_999).broadcast).toBe(false)
    const rang = sleepTimerRang(timed, 62_000)
    expect(rang.broadcast).toBe(true)
    expect(rang.model.playing).toBe(false)
    expect(rang.model.sleepTimer).toBeNull()
    expect(rang.model.activeDeviceId).toBe('tv')
    expect(currentPosition(rang.model, 90_000)).toBe(61)
    // Nobody reloads: the player only pauses.
    expect(rang.model.seekSeq).toBe(timed.seekSeq)
  })

  test('a timer for the end of the song pauses on the next song when it ends', () => {
    const timed = set(playing(), {
      _tag: 'SetSleepTimer',
      timer: { _tag: 'EndOfSong' },
    }).model
    expect(timed.sleepTimer).toEqual({ _tag: 'EndOfSong' })
    expect(sleepTimerRang(timed, 10_000_000).broadcast).toBe(false)
    const ended = set(
      timed,
      { _tag: 'TrackEnded', entryId: 'e0' },
      201_000,
    ).model
    expect(ended.currentEntryId).toBe('e1')
    expect(ended.playing).toBe(false)
    expect(ended.positionSeconds).toBe(0)
    expect(ended.sleepTimer).toBeNull()
    expect(ended.seekSeq).toBe(timed.seekSeq + 1)
  })

  test('a player that moved on anyway goes back to the start of the next song, paused', () => {
    const timed = set(playing(), {
      _tag: 'SetSleepTimer',
      timer: { _tag: 'EndOfSong' },
    }).model
    const advanced = set(
      timed,
      { _tag: 'Advanced', fromEntryId: 'e0' },
      201_000,
    ).model
    expect(advanced.currentEntryId).toBe('e1')
    expect(advanced.playing).toBe(false)
    expect(advanced.sleepTimer).toBeNull()
    // The player already started it, so it reloads it at its start.
    expect(advanced.seekSeq).toBe(timed.seekSeq + 1)
  })

  test('the end of the song stops on the last song too, and repeat one', () => {
    const atLast = set(playing(), { _tag: 'SkipTo', entryId: 'e2' }).model
    const timed = set(atLast, {
      _tag: 'SetSleepTimer',
      timer: { _tag: 'EndOfSong' },
    }).model
    const ended = set(
      timed,
      { _tag: 'TrackEnded', entryId: 'e2' },
      300_000,
    ).model
    expect(ended.currentEntryId).toBe('e2')
    expect(ended.playing).toBe(false)
    const one = set(set(playing(), { _tag: 'SetRepeat', mode: 'One' }).model, {
      _tag: 'SetSleepTimer',
      timer: { _tag: 'EndOfSong' },
    }).model
    const looped = set(
      one,
      { _tag: 'TrackEnded', entryId: 'e0' },
      300_000,
    ).model
    expect(looped.currentEntryId).toBe('e0')
    expect(looped.playing).toBe(false)
    expect(looped.sleepTimer).toBeNull()
  })

  test('the TV and the phone stop after the song by the same rule', () => {
    const state = toSessionState(
      { ...playing(), sleepTimer: { _tag: 'EndOfSong' } },
      [],
    )
    expect(Session.stopsAfterSong(state)).toBe(true)
    expect(Session.stopsAfterSong({ ...state, sleepTimer: null })).toBe(false)
  })
})

describe('protocol fixtures shared with the TV app', () => {
  const read = (name: string) => Bun.file(new URL(name, FIXTURES)).text()

  test.each([
    'server-state.json',
    'server-state-sleep-end-of-song.json',
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
    'client-move-entry.json',
    'client-clear-upcoming.json',
    'client-transfer.json',
    'client-wake.json',
    'client-volume.json',
    'client-volume-fixed.json',
    'client-set-device-volume.json',
    'client-set-autoplay.json',
    'client-set-repeat.json',
    'client-set-shuffle.json',
    'client-set-sleep-timer.json',
    'client-set-sleep-timer-end-of-song.json',
    'client-cancel-sleep-timer.json',
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

describe('quiet', () => {
  test('quiet starts when the music stops and holds through other changes', () => {
    const paused: Model = { ...playing(), playing: false }
    expect(quietSinceAfter(null, playing(), 5_000)).toBeNull()
    expect(quietSinceAfter(null, paused, 5_000)).toBe(5_000)
    expect(quietSinceAfter(5_000, paused, 9_000)).toBe(5_000)
    expect(quietSinceAfter(5_000, playing(), 9_000)).toBeNull()
  })
})
