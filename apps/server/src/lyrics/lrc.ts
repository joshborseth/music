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
 *
 * Some copies also time lines nobody sings: credits ("作词 : …", "Written
 * by: …") and markers such as "Instrumental" or "♪". Those become breaks,
 * so they never show as lyrics and the line before them ends on time.
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

/**
 * A credit: a role, maybe "by", then a colon ("Lyrics by: …", "Composer:
 * …", "作曲 : …"), or a role that is rarely sung followed by "by" ("Produced
 * by …"). "Written by" and "Music by" without a colon can be sung, so they
 * stay.
 */
const CREDIT =
  /^(?:(?:lyrics|lyricist|music|composer|composed|written|writer|songwriters?|arranged|arranger|arrangement|produced|producers?|mixed|mastered|recorded|vocals|作词|作詞|作曲|编曲|編曲|制作人|製作人|词|詞|曲)(?:\s+by)?\s*[:：]|(?:lyrics|composed|produced|arranged|mixed|mastered)\s+by\s)/iu

/** "Instrumental", "(Instrumental break)", "[Instrumentals]". */
const INSTRUMENTAL =
  /^[([]?\s*instrumentals?(?:\s+(?:break|bridge|solo|interlude|intro|outro))?\s*[)\]]?$/iu

/** A section name in square brackets: "[Chorus]", "[Verse 2: Drake]". */
const SECTION =
  /^\[\s*(?:verse|chorus|pre-chorus|post-chorus|hook|bridge|intro|outro|refrain|interlude|break|drop|solo|music)\b[^\]]*\]$/iu

/** Music notes, dots, or dashes and nothing else: "♪", "♫ ♫", "...". */
const NO_WORDS = /^[\s♪♫♬♩🎵🎶~*.…\-–—]+$/u

/** Whether a timed line is something other than a sung line. */
export const isUnsung = (text: string): boolean =>
  CREDIT.test(text) ||
  INSTRUMENTAL.test(text) ||
  SECTION.test(text) ||
  NO_WORDS.test(text)

const asBreak = (line: LyricLine): LyricLine =>
  isUnsung(line.text) ? { ...line, text: '', words: [] } : line

const byStart = Order.mapInput(
  Number.Order,
  (line: LyricLine) => line.startSeconds,
)

/**
 * Timed lines cleaned up, in time order: lines nobody sings become breaks,
 * and breaks that follow another break, or open the song, are dropped. Only
 * a break after a sung line says the singing stopped; a break at the end
 * marks the outro. Returns none when no line has words.
 */
export const tidyLines = (
  lines: ReadonlyArray<LyricLine>,
): Option.Option<ReadonlyArray<LyricLine>> => {
  const sorted = Array.sort(Array.map(lines, asBreak), byStart)
  const none: ReadonlyArray<LyricLine> = []
  const tidied = Array.reduce(sorted, none, (kept, line) => {
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
  return Array.some(tidied, line => line.text !== '')
    ? Option.some(tidied)
    : Option.none()
}

/** The timed lines of an LRC text, tidied by `tidyLines`. */
export const parseLrc = (
  lrc: string,
): Option.Option<ReadonlyArray<LyricLine>> =>
  tidyLines(Array.flatMap(lrc.split(/\r?\n/), linesOfRow))
