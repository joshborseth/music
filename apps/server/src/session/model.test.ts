import { describe, expect, test } from 'bun:test'
import { Option, Schema } from 'effect'

import { Session } from '@music/shared'

import {
  type Context,
  type Model,
  currentPosition,
  initialModel,
  playerLost,
  upcomingVideoIds,
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
    expect(upcomingVideoIds(model)).toEqual(['a', 'b', 'c'])
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
})

describe('protocol fixtures shared with the TV app', () => {
  const read = (name: string) => Bun.file(new URL(name, FIXTURES)).text()

  test.each(['server-state.json', 'server-notice.json'])(
    '%s decodes as a server message',
    async name => {
      const decoded = Schema.decodeExit(Session.ServerMessageJson)(
        await read(name),
      )
      expect(decoded._tag).toBe('Success')
    },
  )

  test.each([
    'client-hello.json',
    'client-progress.json',
    'client-advanced.json',
    'client-pause.json',
  ])('%s decodes as a client message', async name => {
    const decoded = Schema.decodeExit(Session.ClientMessageJson)(
      await read(name),
    )
    expect(decoded._tag).toBe('Success')
  })
})
