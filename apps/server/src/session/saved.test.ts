import { describe, expect, test } from 'bun:test'
import { Schema } from 'effect'

import type { Session } from '@music/shared'

import {
  type Context,
  type Model,
  currentPosition,
  initialModel,
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
