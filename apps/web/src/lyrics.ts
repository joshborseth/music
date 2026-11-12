import { Array, Option, pipe } from 'effect'

import type { LyricLine } from '@music/shared'

/*
 * Where the singing is in a song's timed lyrics. The view turns each line
 * into a row: a sung line, or a break where the singer rests (the intro, and
 * the gaps LRC marks with an empty line), drawn as three dots that light up
 * as the break runs out.
 */

/** A line lights up this early, so it is bright by the time it is sung. */
export const LYRICS_LEAD_SECONDS = 0.15

/** Shorter rests than this are part of the singing and show no dots. */
export const MIN_BREAK_SECONDS = 3

/** How many dots a break shows. */
export const BREAK_DOTS = 3

export type LineState = 'Past' | 'Active' | 'Next'

export interface SungWord {
  readonly text: string
  readonly isSung: boolean
}

export type LyricRow =
  | {
      readonly _tag: 'Sung'
      readonly startSeconds: number
      readonly text: string
      readonly state: LineState
      /** Empty unless the line is timed word by word. */
      readonly words: ReadonlyArray<SungWord>
    }
  | {
      readonly _tag: 'Break'
      readonly startSeconds: number
      readonly isActive: boolean
      /** How many of the dots are lit. */
      readonly litDots: number
    }

const stateOf = (
  index: number,
  maybeActiveIndex: Option.Option<number>,
): LineState =>
  Option.match(maybeActiveIndex, {
    onNone: () => 'Next',
    onSome: activeIndex => {
      if (index < activeIndex) {
        return 'Past'
      } else if (index === activeIndex) {
        return 'Active'
      } else {
        return 'Next'
      }
    },
  })

const breakRow = (
  startSeconds: number,
  endSeconds: number,
  at: number,
): LyricRow => {
  const length = endSeconds - startSeconds
  const isActive =
    length >= MIN_BREAK_SECONDS && at >= startSeconds && at < endSeconds
  const progress = isActive ? (at - startSeconds) / length : 0
  return {
    _tag: 'Break',
    startSeconds,
    isActive,
    litDots: isActive
      ? Math.min(BREAK_DOTS, Math.floor(progress * (BREAK_DOTS + 1)))
      : 0,
  }
}

const hasSungLineAfter = (
  lines: ReadonlyArray<LyricLine>,
  index: number,
): boolean => Array.some(Array.drop(lines, index + 1), line => line.text !== '')

/** The index of the line being sung at `positionSeconds`, if one is. */
export const activeLineIndex = (
  lines: ReadonlyArray<LyricLine>,
  positionSeconds: number,
): Option.Option<number> =>
  Array.findLastIndex(
    lines,
    line => line.startSeconds <= positionSeconds + LYRICS_LEAD_SECONDS,
  )

/** Every row of the lyrics as they stand at `positionSeconds`. */
export const lyricRows = (
  lines: ReadonlyArray<LyricLine>,
  positionSeconds: number,
): ReadonlyArray<LyricRow> => {
  const at = positionSeconds + LYRICS_LEAD_SECONDS
  const maybeActiveIndex = activeLineIndex(lines, positionSeconds)
  const intro = pipe(
    Array.head(lines),
    Option.filter(first => first.startSeconds >= MIN_BREAK_SECONDS),
    Option.map(first => breakRow(0, first.startSeconds, at)),
    Option.toArray,
  )
  const rows = Array.map(lines, (line, index): LyricRow => {
    const endSeconds = Option.match(Array.get(lines, index + 1), {
      onNone: () => Infinity,
      onSome: next => next.startSeconds,
    })
    if (line.text === '') {
      return hasSungLineAfter(lines, index)
        ? breakRow(line.startSeconds, endSeconds, at)
        : breakRow(line.startSeconds, line.startSeconds, at)
    }
    const state = stateOf(index, maybeActiveIndex)
    return {
      _tag: 'Sung',
      startSeconds: line.startSeconds,
      text: line.text,
      state,
      words: Array.map(line.words, word => ({
        text: word.text,
        isSung:
          state === 'Past' || (state === 'Active' && word.startSeconds <= at),
      })),
    }
  })
  return [...intro, ...rows]
}
