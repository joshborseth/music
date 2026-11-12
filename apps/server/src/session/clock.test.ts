import { describe, expect, test } from 'bun:test'

import type { Session } from '@music/shared'

import { nextClock, songClock } from './clock.ts'
import { type Model, initialModel } from './model.ts'

const track: Session.QueueTrack = {
  videoId: 'abc',
  title: 'Song',
  artists: 'Artist',
  album: null,
  durationSeconds: 200,
  artworkUrl: null,
}

const playing: Model = {
  ...initialModel,
  queue: [{ entryId: 'e1', track, autoplay: false }],
  currentEntryId: 'e1',
  playing: true,
  positionSeconds: 30,
  positionAt: 1_000_000,
}

const clock = { videoId: 'abc', positionSeconds: 30, at: 1_000_000 }

describe('songClock', () => {
  test('anchors the current song where the session is', () => {
    expect(songClock(playing)).toEqual(clock)
  })

  test('is null while paused, held, or with nothing current', () => {
    expect(songClock({ ...playing, playing: false })).toBeNull()
    expect(
      songClock({ ...playing, playing: false, waitingToStart: true }),
    ).toBeNull()
    expect(songClock({ ...playing, currentEntryId: null })).toBeNull()
  })
})

describe('nextClock', () => {
  test('keeps the clock listeners have while the player agrees with it', () => {
    const later = { videoId: 'abc', positionSeconds: 31.02, at: 1_001_000 }
    expect(nextClock(clock, later)).toBe(clock)
  })

  test('sends a new clock once the player strays from it', () => {
    const drifted = { videoId: 'abc', positionSeconds: 31.1, at: 1_001_000 }
    expect(nextClock(clock, drifted)).toBe(drifted)
  })

  test('sends a new clock after a seek, a new song, or a pause', () => {
    const seeked = { videoId: 'abc', positionSeconds: 90, at: 1_001_000 }
    const next = { videoId: 'def', positionSeconds: 0, at: 1_001_000 }
    expect(nextClock(clock, seeked)).toBe(seeked)
    expect(nextClock(clock, next)).toBe(next)
    expect(nextClock(clock, null)).toBeNull()
    expect(nextClock(null, clock)).toBe(clock)
  })
})
