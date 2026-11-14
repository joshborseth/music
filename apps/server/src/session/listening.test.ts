import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'

import {
  type HeardReport,
  type Listening,
  hear,
  playThreshold,
} from './listening.ts'

const START = 1_000_000

/** Feed reports one after another, and say after which ones a play counted. */
const play = (
  reports: ReadonlyArray<Partial<HeardReport> & { positionSeconds: number }>,
  durationSeconds: number | null = 240,
): ReadonlyArray<number> => {
  let maybeListening = Option.none<Listening>()
  const counted: Array<number> = []
  reports.forEach((report, index) => {
    const heard = hear(maybeListening, {
      entryId: 'e1',
      playing: true,
      durationSeconds,
      at: START + index * 1000,
      ...report,
    })
    maybeListening = Option.some(heard.listening)
    if (heard.isNewPlay) counted.push(index)
  })
  return counted
}

/** One report a second from `from`, `count` of them. */
const steady = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    positionSeconds: from + index,
  }))

describe('playThreshold', () => {
  test('is 30 seconds, or half of a shorter song', () => {
    expect(playThreshold(240)).toBe(30)
    expect(playThreshold(40)).toBe(20)
    expect(playThreshold(null)).toBe(30)
    expect(playThreshold(0)).toBe(30)
  })
})

describe('hear', () => {
  test('counts a song once after 30 seconds of play', () => {
    expect(play(steady(1, 60))).toEqual([29])
  })

  test('counts nothing for a song skipped after a few seconds', () => {
    expect(play(steady(1, 8))).toEqual([])
  })

  test('counts half of a short song', () => {
    expect(play(steady(1, 30), 30)).toEqual([14])
  })

  test('does not count a seek toward the end', () => {
    expect(
      play([
        { positionSeconds: 1 },
        { positionSeconds: 2 },
        { positionSeconds: 200 },
        { positionSeconds: 201 },
        { positionSeconds: 202 },
      ]),
    ).toEqual([])
  })

  test('counts only time played, not time paused', () => {
    const reports = [
      ...steady(1, 10),
      ...Array.from({ length: 30 }, () => ({
        positionSeconds: 10,
        playing: false,
      })),
    ]
    expect(play(reports)).toEqual([])
  })

  test('counts late reports when the clock moved as far', () => {
    let maybeListening = Option.none<Listening>()
    const results = [1, 9, 17, 25, 33].map((positionSeconds, index) => {
      const heard = hear(maybeListening, {
        entryId: 'e1',
        positionSeconds,
        playing: true,
        durationSeconds: 240,
        at: START + index * 8_000,
      })
      maybeListening = Option.some(heard.listening)
      return heard.isNewPlay
    })
    expect(results).toEqual([false, false, false, false, true])
  })

  test('does not count a long silence between reports', () => {
    let maybeListening = Option.none<Listening>()
    const results = [1, 2, 3, 40, 41].map((positionSeconds, index) => {
      const heard = hear(maybeListening, {
        entryId: 'e1',
        positionSeconds,
        playing: true,
        durationSeconds: 240,
        at: START + (index < 3 ? index * 1000 : 40_000 + index * 1000),
      })
      maybeListening = Option.some(heard.listening)
      return heard.listening.heardSeconds
    })
    expect(results).toEqual([1, 2, 3, 3, 4])
  })

  test('starts over for another entry', () => {
    let maybeListening = Option.none<Listening>()
    for (let second = 1; second <= 20; second++) {
      maybeListening = Option.some(
        hear(maybeListening, {
          entryId: 'e1',
          positionSeconds: second,
          playing: true,
          durationSeconds: 240,
          at: START + second * 1000,
        }).listening,
      )
    }
    const next = hear(maybeListening, {
      entryId: 'e2',
      positionSeconds: 1,
      playing: true,
      durationSeconds: 240,
      at: START + 21_000,
    })
    expect(next.listening.heardSeconds).toBe(1)
    expect(next.isNewPlay).toBe(false)
  })

  test('does not count a song picked up far into it at once', () => {
    expect(play([{ positionSeconds: 100 }])).toEqual([])
    expect(play(steady(100, 31))).toEqual([30])
  })
})
