import { describe, expect, test } from 'bun:test'
import { Schema } from 'effect'

import type { Session } from '@music/shared'

import {
  type Context,
  type Model,
  currentPosition,
  initialModel,
  playerLost,
  update,
} from './model.ts'
import {
  SavedSessionJson,
  fromSaved,
  nextEntryNumber,
  toSaved,
} from './saved.ts'

const track = (videoId: string): Session.QueueTrack => ({
  videoId,
  title: videoId,
  artists: 'Artist',
  album: null,
  durationSeconds: 200,
  artworkUrl: null,
})

const context = (senderId: string, now: number): Context => {
  let counter = 0
  return {
    now,
    senderId,
    isOnline: id => id === senderId,
    isWakeable: () => false,
    makeEntryId: () => `e${(counter++).toString(36)}`,
    random: () => 0,
  }
}

/** The phone playing a three-song queue since `1_000`. */
const playing = (): Model =>
  update(
    initialModel,
    {
      _tag: 'PlayQueue',
      tracks: [track('a'), track('b'), track('c')],
      startIndex: 0,
    },
    context('phone', 1_000),
  ).model

/** Saved at `savedAt`, then read back as JSON at `now`. */
const restart = (model: Model, savedAt: number, now: number): Model => {
  const json = Schema.encodeSync(SavedSessionJson)(toSaved(model, savedAt))
  return fromSaved(Schema.decodeSync(SavedSessionJson)(json), now)
}

describe('saved session', () => {
  test('a restart keeps the queue and the song, paused where it had got to', () => {
    const before = playing()
    const after = restart(before, 31_000, 40_000)
    expect(after.queue).toEqual(before.queue)
    expect(after.currentEntryId).toBe(before.currentEntryId)
    expect(after.activeDeviceId).toBe('phone')
    expect(after.seekSeq).toBe(before.seekSeq)
    expect(after.playing).toBe(false)
    expect(after.pausedForLostPlayer).toBe(true)
    expect(currentPosition(after, 50_000)).toBe(30)
  })

  test('a paused session stays paused and is not resumed by its player', () => {
    const paused = update(
      playing(),
      { _tag: 'Pause', at: null },
      context('phone', 11_000),
    ).model
    const after = restart(paused, 20_000, 25_000)
    expect(after.playing).toBe(false)
    expect(after.pausedForLostPlayer).toBe(false)
    expect(currentPosition(after, 25_000)).toBe(10)
  })

  test('a phone that kept playing through the restart takes the session back', () => {
    const after = restart(playing(), 31_000, 40_000)
    const resumed = update(
      after,
      {
        _tag: 'Hello',
        deviceId: 'phone',
        name: 'phone',
        kind: 'Web',
        player: {
          entryId: 'e1',
          positionSeconds: 12,
          playing: true,
          seekSeq: after.seekSeq,
          playingSetHere: false,
        },
      },
      context('phone', 41_000),
    ).model
    expect(resumed.playing).toBe(true)
    expect(resumed.currentEntryId).toBe('e1')
    expect(resumed.positionSeconds).toBe(12)
  })

  test('a player that played on still takes the session back when its grace ran out during the shutdown', () => {
    // The phone's socket closes as the server stops, and the server takes
    // longer than the grace to exit, so it writes the pause for the lost
    // player.
    const lost = playerLost(playing(), 'phone', 20_000).model
    expect(lost.playing).toBe(false)
    const after = restart(lost, 21_000, 25_000)
    expect(after.pausedForLostPlayer).toBe(true)
    const resumed = update(
      after,
      {
        _tag: 'Hello',
        deviceId: 'phone',
        name: 'phone',
        kind: 'Web',
        player: {
          entryId: 'e0',
          positionSeconds: 24,
          playing: true,
          seekSeq: after.seekSeq,
          playingSetHere: false,
        },
      },
      context('phone', 26_000),
    ).model
    expect(resumed.playing).toBe(true)
    expect(resumed.positionSeconds).toBe(24)
  })

  test('an older file without the field reads the lost-player pause from playing', () => {
    const { pausedForLostPlayer: _paused, ...older } = toSaved(
      playerLost(playing(), 'phone', 20_000).model,
      21_000,
    )
    expect(fromSaved(older, 22_000).pausedForLostPlayer).toBe(false)
    const { pausedForLostPlayer: _alsoPaused, ...olderPlaying } = toSaved(
      playing(),
      21_000,
    )
    expect(fromSaved(olderPlaying, 22_000).pausedForLostPlayer).toBe(true)
  })

  test('a sleep timer still to come survives a restart, and a passed one does not', () => {
    const timed: Model = {
      ...playing(),
      sleepTimer: { _tag: 'At', endsAt: 60_000 },
    }
    expect(restart(timed, 20_000, 30_000).sleepTimer).toEqual({
      _tag: 'At',
      endsAt: 60_000,
    })
    expect(restart(timed, 20_000, 60_000).sleepTimer).toBeNull()
    const endOfSong: Model = { ...playing(), sleepTimer: { _tag: 'EndOfSong' } }
    expect(restart(endOfSong, 20_000, 90_000).sleepTimer).toEqual({
      _tag: 'EndOfSong',
    })
  })

  test('a file saved before the sleep timer reads as none', () => {
    const { sleepTimer: _sleepTimer, ...older } = toSaved(playing(), 2_000)
    expect(fromSaved(older, 3_000).sleepTimer).toBeNull()
  })

  test('what the queue plays from survives a restart, and an older file has none', () => {
    const fromAlbum: Model = {
      ...playing(),
      playingFrom: { kind: 'Album', title: 'Kid A', id: 'MPREb_kida' },
    }
    expect(restart(fromAlbum, 20_000, 30_000).playingFrom).toEqual(
      fromAlbum.playingFrom,
    )
    const { playingFrom: _playingFrom, ...older } = toSaved(fromAlbum, 2_000)
    expect(fromSaved(older, 3_000).playingFrom).toBeNull()
  })

  test('the position never runs past the song', () => {
    const after = restart(playing(), 900_000, 900_000)
    expect(currentPosition(after, 900_000)).toBe(200)
  })

  test('a saved song missing from the queue starts an empty session', () => {
    const saved = { ...toSaved(playing(), 2_000), currentEntryId: 'gone' }
    const after = fromSaved(saved, 3_000)
    expect(after.queue).toEqual([])
    expect(after.currentEntryId).toBeNull()
  })

  test('new entries never reuse a restored id', () => {
    const queue = playing().queue
    expect(queue.map(entry => entry.entryId)).toEqual(['e0', 'e1', 'e2'])
    expect(nextEntryNumber(queue)).toBe(3)
    expect(
      nextEntryNumber([
        ...queue,
        { ...queue[0]!, entryId: 'ez' },
        { ...queue[0]!, entryId: 'x9' },
      ]),
    ).toBe(36)
    expect(nextEntryNumber([])).toBe(0)
  })
})
