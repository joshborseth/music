import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import type { LyricLine } from '@music/shared'

import { activeLineIndex, lyricRows } from './lyrics'

const line = (startSeconds: number, text: string): LyricLine => ({
  startSeconds,
  text,
  words: [],
})

const lines: ReadonlyArray<LyricLine> = [
  line(10, 'One'),
  line(14, 'Two'),
  line(18, ''),
  line(30, 'Three'),
  line(40, ''),
]

describe('lyrics timing', () => {
  test('no line is active before the first one starts', () => {
    expect(activeLineIndex(lines, 5)).toEqual(Option.none())
    expect(activeLineIndex(lines, 9.9)).toEqual(Option.some(0))
    expect(activeLineIndex(lines, 15)).toEqual(Option.some(1))
  })

  test('the intro is a break whose dots light up as it runs out', () => {
    const [intro] = lyricRows(lines, 6)
    expect(intro).toEqual({
      _tag: 'Break',
      startSeconds: 0,
      isActive: true,
      litDots: 2,
    })
  })

  test('lines before the active one are past, after it next', () => {
    const states = lyricRows(lines, 15).flatMap(row =>
      row._tag === 'Sung' ? [row.state] : [],
    )
    expect(states).toEqual(['Past', 'Active', 'Next'])
  })

  test('a long rest shows its break, and the outro never does', () => {
    const breaks = (seconds: number) =>
      lyricRows(lines, seconds).flatMap(row =>
        row._tag === 'Break' && row.isActive ? [row.startSeconds] : [],
      )
    expect(breaks(20)).toEqual([18])
    expect(breaks(45)).toEqual([])
  })

  test('words light up as they are sung', () => {
    const timed: ReadonlyArray<LyricLine> = [
      {
        startSeconds: 1,
        text: 'We are here',
        words: [
          { startSeconds: 1, text: 'We ' },
          { startSeconds: 2, text: 'are ' },
          { startSeconds: 3, text: 'here' },
        ],
      },
    ]
    const [row] = lyricRows(timed, 2.2)
    expect(row?._tag === 'Sung' && row.words.map(word => word.isSung)).toEqual([
      true,
      true,
      false,
    ])
  })
})
