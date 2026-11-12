import { Array, Number, Option, Order, String, pipe } from 'effect'

import type { LyricLine, LyricWord } from '@music/shared'

/*
 * Reads LRC, the plain-text format timed lyrics come in:
 *
 *   [00:18.89] We're no strangers to love
 *   [00:22.82] <00:22.82>You <00:23.23>know <00:23.48>the rules
 *   [01:02.00]
 *
 * A line may carry several times (`[00:12.00][01:30.00] Chorus`). Times in
 * angle brackets time single words ("enhanced" LRC). A time with no text
 * after it marks where an instrumental break starts. Tags such as `[ar:…]`
 * are skipped.
 */

const LINE_TIME = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g
const WORD_TIME = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g

/** Two lines closer than this are one moment; the later one is dropped. */
const SAME_MOMENT_SECONDS = 0.05

const toSeconds = (minutes: string, seconds: string): Option.Option<number> =>
  pipe(
    Number.parse(seconds.replace(':', '.')),
    Option.flatMap(secs =>
      Option.map(Number.parse(minutes), mins => mins * 60 + secs),
    ),
    Option.filter(total => total >= 0),
  )

/** Words of an enhanced line, each keeping the space after it. */
const wordsOf = (body: string): ReadonlyArray<LyricWord> => {
  const times = Array.fromIterable(body.matchAll(WORD_TIME))
  return Array.getSomes(
    Array.map(times, (match, index) => {
      const textStart = match.index + match[0].length
      const textEnd = times[index + 1]?.index ?? body.length
      const text = body.slice(textStart, textEnd)
      return String.isEmpty(text.trim())
        ? Option.none()
        : Option.map(
            toSeconds(match[1] ?? '', match[2] ?? ''),
            startSeconds => ({
              startSeconds,
              text,
            }),
          )
    }),
  )
}

const linesOfRow = (row: string): ReadonlyArray<LyricLine> => {
  const times = Array.fromIterable(row.matchAll(LINE_TIME))
  const last = Array.last(times)
  if (Option.isNone(last)) {
    return []
  }
  const body = row.slice(last.value.index + last.value[0].length)
  const words = wordsOf(body)
  const text = Array.isReadonlyArrayNonEmpty(words)
    ? Array.map(words, word => word.text)
        .join('')
        .trim()
    : body.replace(WORD_TIME, '').trim()
  return Array.getSomes(
    Array.map(times, match =>
      Option.map(toSeconds(match[1] ?? '', match[2] ?? ''), startSeconds => ({
        startSeconds,
        text,
        words,
      })),
    ),
  )
}

const byStart = Order.mapInput(
  Number.Order,
  (line: LyricLine) => line.startSeconds,
)

/**
 * The timed lines of an LRC text, in time order. Breaks that follow another
 * break, or open the song, are dropped: only a break after a sung line says
 * the singing stopped; a break at the end marks the outro. Returns none
 * when no line has words.
 */
export const parseLrc = (
  lrc: string,
): Option.Option<ReadonlyArray<LyricLine>> => {
  const sorted = Array.sort(
    Array.flatMap(lrc.split(/\r?\n/), linesOfRow),
    byStart,
  )
  const none: ReadonlyArray<LyricLine> = []
  const lines = Array.reduce(sorted, none, (kept, line) => {
    const maybePrevious = Array.last(kept)
    if (Option.isNone(maybePrevious)) {
      return line.text === '' ? kept : [line]
    }
    const previous = maybePrevious.value
    if (line.startSeconds - previous.startSeconds < SAME_MOMENT_SECONDS) {
      return kept
    }
    if (line.text === '' && previous.text === '') {
      return kept
    }
    return [...kept, line]
  })
  return Array.some(lines, line => line.text !== '')
    ? Option.some(lines)
    : Option.none()
}
