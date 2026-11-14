import type { LyricLine } from '@music/shared'

import { syllables } from './syllables.ts'

/*
 * When each sung word comes. LRCLIB times lines, not words, so each word is
 * placed within its line from what the analysis heard of the singing: the
 * lead melody's notes (`SungTrack`, read off the song's score). A line's
 * words first get a place by their syllables, spread over the stretch the
 * lead sings, the line's last syllable held longest; then each moves to the
 * note start near its place that fits best, keeping their order (a Viterbi
 * path over the note starts). Where the melody is unclear (rap, a quiet
 * voice under loud music), the words keep their places by syllable, nudged
 * onto the beat's eighth notes.
 *
 * Hooks: a line whose words come again elsewhere in the song is a hook (the
 * chorus), and the song's most repeated short phrase (one to four words,
 * not just "the" or "I") is marked word by word, for the visuals to draw
 * biggest.
 */

/** How a lead sings each row of the score, as `track.ts` reads it. */
export interface SungTrack {
  /** Rows a second. */
  readonly rate: number
  /** How clearly a lead sings each row, 0 to 1 (0: none). */
  readonly voicing: Float32Array
  /** How clearly a note starts at each row, 0 to 1: only at peaks. */
  readonly onsets: Float32Array
}

export interface TimedWord {
  readonly startSeconds: number
  readonly endSeconds: number
  /** As sung, without the punctuation around it. */
  readonly text: string
  /** Its sung line's index in `TimedWords.lines`. */
  readonly line: number
  readonly hook: boolean
  readonly phrase: boolean
}

export interface TimedLine {
  readonly startSeconds: number
  readonly endSeconds: number
  readonly hook: boolean
}

export interface TimedWords {
  readonly lines: ReadonlyArray<TimedLine>
  readonly words: ReadonlyArray<TimedWord>
  /** The most repeated short phrase, as sung; null when none stands out. */
  readonly phrase: string | null
}

/** A row sings when its lead stands out at least this much. */
export const VOICED = 0.12
/** A line is sung for at most this long, whatever comes after it. */
const MAX_LINE_SECONDS = 10
/** Where too little of a line's time is sung, the melody can't time it. */
const CLEAR_MELODY = 0.25
/** Seconds a syllable takes when the melody can't say. */
const SYLLABLE_SECONDS = 0.26
/** A line's first word may come this early or late against its time. */
const FIRST_EARLY = 0.25
const FIRST_LATE = 0.45
/** The last syllable of a line is held this many times as long. */
const LINE_END_HOLD = 1.8
/** How much a note start is worth against straying from a word's place. */
const ONSET_WEIGHT = 2
const PLACE_WEIGHT = 0.5

// WORDS

/** A sung word as drawn: no punctuation around it, curly quotes straight. */
export const wordText = (token: string): string =>
  token
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')

/** A word as compared for repeats: lowercase letters and digits only. */
const wordKey = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')

/** The words of a line, as sung: tokens with a letter or digit in them. */
export const wordsOf = (text: string): ReadonlyArray<string> =>
  text
    .split(/\s+/)
    .map(wordText)
    .filter(word => /[\p{L}\p{N}]/u.test(word))

// HOOKS

/** Words too common to make a phrase on their own. */
const STOPWORDS = new Set(
  (
    'a an the and or but so to of in on at for with by from as is are was were be been am ' +
    'i me my mine you your yours he him his she her it its we us our they them their ' +
    "this that these those there here what when where who how not no do does did don't " +
    'im youre its thats dont cant wont aint ill id ive just like oh yeah'
  )
    .split(' ')
    .map(wordKey),
)

const lineKey = (words: ReadonlyArray<string>): string =>
  words.map(wordKey).join(' ')

interface Phrase {
  readonly keys: ReadonlyArray<string>
  readonly count: number
}

/**
 * The most repeated phrase of one to four words across `lines`, counted
 * every time it is sung; at least three times, and more than stopwords.
 * Longer phrases count for more, so "never gonna give" beats "gonna".
 */
export const findPhrase = (
  lines: ReadonlyArray<ReadonlyArray<string>>,
): Phrase | null => {
  const counts = new Map<string, number>()
  for (const words of lines) {
    const keys = words.map(wordKey)
    for (let n = 1; n <= 4; n++) {
      for (let at = 0; at + n <= keys.length; at++) {
        const gram = keys.slice(at, at + n)
        if (gram.every(key => STOPWORDS.has(key) || key === '')) continue
        if (n === 1 && (gram[0] ?? '').length < 3) continue
        const key = gram.join(' ')
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  let best: Phrase | null = null
  let bestScore = 0
  for (const [key, count] of counts) {
    if (count < 3) continue
    const keys = key.split(' ')
    const score = count * (1 + 0.6 * (keys.length - 1))
    if (
      score > bestScore ||
      (score === bestScore && keys.length > (best?.keys.length ?? 0))
    ) {
      best = { keys, count }
      bestScore = score
    }
  }
  return best
}

/** Which of `words` are part of a sung `phrase`. */
const phraseMarks = (
  words: ReadonlyArray<string>,
  phrase: Phrase | null,
): ReadonlyArray<boolean> => {
  const marks = words.map(() => false)
  if (phrase === null) return marks
  const keys = words.map(wordKey)
  const n = phrase.keys.length
  for (let at = 0; at + n <= keys.length; at++) {
    if (phrase.keys.every((key, i) => keys[at + i] === key)) {
      for (let i = 0; i < n; i++) marks[at + i] = true
    }
  }
  return marks
}

// PLACING WORDS IN A LINE

interface Candidate {
  readonly time: number
  readonly strength: number
}

/** The note starts of `track` between `from` and `to` seconds. */
const onsetsBetween = (
  track: SungTrack,
  from: number,
  to: number,
): ReadonlyArray<Candidate> => {
  const out: Array<Candidate> = []
  const first = Math.max(0, Math.ceil(from * track.rate))
  const last = Math.min(track.onsets.length - 1, Math.floor(to * track.rate))
  for (let row = first; row <= last; row++) {
    const strength = track.onsets[row] ?? 0
    if (strength > 0) out.push({ time: row / track.rate, strength })
  }
  return out
}

/** How much of `from` to `to` the lead sings, and where it last does. */
const singing = (
  track: SungTrack,
  from: number,
  to: number,
): { readonly sung: number; readonly lastSung: number | null } => {
  const first = Math.max(0, Math.ceil(from * track.rate))
  const last = Math.min(track.voicing.length - 1, Math.floor(to * track.rate))
  let voiced = 0
  let lastSung: number | null = null
  for (let row = first; row <= last; row++) {
    if ((track.voicing[row] ?? 0) > VOICED) {
      voiced++
      lastSung = row
    }
  }
  const rows = Math.max(1, last - first + 1)
  return {
    sung: voiced / rows,
    lastSung: lastSung === null ? null : (lastSung + 1) / track.rate,
  }
}

/** The beat's eighth notes between `from` and `to`. */
const eighthsBetween = (
  beats: ReadonlyArray<number>,
  from: number,
  to: number,
): ReadonlyArray<number> => {
  const out: Array<number> = []
  beats.forEach((beat, i) => {
    const next = beats[i + 1]
    for (const time of next === undefined ? [beat] : [beat, (beat + next) / 2])
      if (time >= from && time <= to) out.push(time)
  })
  return out
}

export interface LinePlan {
  readonly start: number
  /** Where the next line starts (or the song ends). */
  readonly next: number
  readonly syllables: ReadonlyArray<number>
}

/**
 * Each word's start in a line of words with `syllables` each, and where its
 * singing ends.
 */
export const placeLine = (
  plan: LinePlan,
  track: SungTrack | null,
  beats: ReadonlyArray<number>,
): { readonly starts: ReadonlyArray<number>; readonly end: number } => {
  const { start } = plan
  const count = plan.syllables.length
  const total = plan.syllables.reduce((sum, n) => sum + n, 0)
  const limit = Math.max(
    start + 0.3,
    Math.min(plan.next, start + MAX_LINE_SECONDS),
  )
  const heard = track === null ? null : singing(track, start, limit)
  const clear = heard !== null && heard.sung >= CLEAR_MELODY
  const guess = Math.min(limit - 0.1, start + total * SYLLABLE_SECONDS + 0.35)
  const end = Math.max(
    start + 0.3,
    clear && heard.lastSung !== null
      ? Math.min(
          limit,
          Math.max(heard.lastSung + 0.05, start + total * 0.12 + 0.2),
        )
      : guess,
  )

  // Each syllable a share of the line, the last one held.
  const weights = plan.syllables.map((n, i) =>
    i === count - 1 ? n - 1 + LINE_END_HOLD : n,
  )
  const weightTotal = weights.reduce((sum, w) => sum + w, 0)
  const span = end - start
  let before = 0
  const places = weights.map(weight => {
    const place = start + (before / weightTotal) * span
    before += weight
    return place
  })
  const slots = weights.map(weight => (weight / weightTotal) * span)

  // Each word may move to a note start near its place: within a few of
  // its own lengths, the first word within its line's leeway.
  const spread = (k: number): number =>
    k === 0 ? 0.18 : Math.max(0.08, 0.45 * (slots[k] ?? 0))
  const reach = (k: number) =>
    k === 0
      ? ([start - FIRST_EARLY, start + FIRST_LATE] as const)
      : ([
          (places[k] ?? start) - 2.5 * spread(k),
          (places[k] ?? start) + 2.5 * spread(k),
        ] as const)
  const grid = clear ? 0.1 : 0.3
  const candidates = places.map((place, k) => {
    const [from, to] = reach(k)
    const near: Array<Candidate> = [{ time: place, strength: 0 }]
    if (track !== null && clear) near.push(...onsetsBetween(track, from, to))
    for (const time of eighthsBetween(beats, from, to))
      near.push({ time, strength: grid })
    return near.filter(c => c.time < end - 0.05 || k === 0)
  })
  const cost = (k: number, c: Candidate) =>
    -ONSET_WEIGHT * c.strength +
    PLACE_WEIGHT * ((c.time - (places[k] ?? start)) / spread(k)) ** 2
  // A word lasts at least a little, and a word of several syllables longer.
  const gapAfter = (k: number) =>
    Math.min(0.06 + 0.06 * (plan.syllables[k] ?? 1), 0.6 * (slots[k] ?? 0))

  // Viterbi: the cheapest path through the candidates, in order.
  const best: Array<Array<number>> = []
  const back: Array<Array<number>> = []
  candidates.forEach((list, k) => {
    const row: Array<number> = []
    const links: Array<number> = []
    list.forEach(candidate => {
      if (k === 0) {
        row.push(cost(0, candidate))
        links.push(-1)
        return
      }
      let bestBefore = Infinity
      let link = -1
      ;(candidates[k - 1] ?? []).forEach((previous, j) => {
        const value = best[k - 1]?.[j] ?? Infinity
        if (
          previous.time + gapAfter(k - 1) <= candidate.time + 1e-9 &&
          value < bestBefore
        ) {
          bestBefore = value
          link = j
        }
      })
      row.push(bestBefore + cost(k, candidate))
      links.push(link)
    })
    best.push(row)
    back.push(links)
  })
  const lastRow = best[count - 1] ?? []
  let at = lastRow.indexOf(Math.min(...lastRow))
  const starts = new Array<number>(count)
  for (let k = count - 1; k >= 0; k--) {
    const chosen = candidates[k]?.[at]
    // No path at all (cannot happen: the places themselves make one).
    starts[k] = chosen?.time ?? places[k] ?? start
    at = back[k]?.[at] ?? -1
  }
  return {
    starts: starts.map(time => Math.round(time * 1000) / 1000),
    end:
      Math.round(Math.max(end, (starts[count - 1] ?? start) + 0.15) * 1000) /
      1000,
  }
}

// THE SONG

/**
 * Every sung word of `lines` with its time, its line's, and the hooks.
 * Lines LRC timed word by word keep their own times.
 */
export const timeWords = (
  lines: ReadonlyArray<LyricLine>,
  track: SungTrack | null,
  beats: ReadonlyArray<number>,
  durationSeconds: number,
): TimedWords => {
  const sung = lines
    .map((line, index) => ({ line, index, words: wordsOf(line.text) }))
    .filter(({ words }) => words.length > 0)
  const repeats = new Map<string, number>()
  for (const { words } of sung) {
    const key = lineKey(words)
    repeats.set(key, (repeats.get(key) ?? 0) + 1)
  }
  const phrase = findPhrase(sung.map(({ words }) => words))

  const outLines: Array<TimedLine> = []
  const outWords: Array<TimedWord> = []
  sung.forEach(({ line, index, words }) => {
    const next =
      lines[index + 1]?.startSeconds ??
      Math.max(line.startSeconds + 1, durationSeconds || line.startSeconds + 8)
    const hook = (repeats.get(lineKey(words)) ?? 0) >= 2
    const marks = phraseMarks(words, phrase)
    const own = line.words
      .map(word => ({ start: word.startSeconds, words: wordsOf(word.text) }))
      .filter(word => word.words.length > 0)
    let starts: ReadonlyArray<number>
    let end: number
    if (
      own.length > 0 &&
      own.flatMap(word => word.words).length === words.length
    ) {
      // Timed word by word already: each LRC word's words share its time.
      starts = own.flatMap(word => word.words.map(() => word.start))
      end = Math.min(
        next,
        (starts[starts.length - 1] ?? line.startSeconds) +
          SYLLABLE_SECONDS * (syllables(words[words.length - 1] ?? '') + 1),
      )
    } else {
      ;({ starts, end } = placeLine(
        {
          start: line.startSeconds,
          next,
          syllables: words.map(syllables),
        },
        track,
        beats,
      ))
    }
    const lineIndex = outLines.length
    outLines.push({
      startSeconds: starts[0] ?? line.startSeconds,
      endSeconds: end,
      hook,
    })
    words.forEach((text, k) => {
      const startSeconds = starts[k] ?? line.startSeconds
      outWords.push({
        startSeconds,
        endSeconds: Math.max(startSeconds + 0.05, starts[k + 1] ?? end),
        text,
        line: lineIndex,
        hook,
        phrase: marks[k] ?? false,
      })
    })
  })
  const phraseText =
    phrase === null
      ? null
      : (() => {
          // As first sung.
          const first = outWords.findIndex(
            (word, i) =>
              word.phrase &&
              (i === 0 ||
                !(outWords[i - 1]?.phrase ?? false) ||
                outWords[i - 1]?.line !== word.line),
          )
          return first < 0
            ? phrase.keys.join(' ')
            : outWords
                .slice(first, first + phrase.keys.length)
                .map(word => word.text)
                .join(' ')
        })()
  return { lines: outLines, words: outWords, phrase: phraseText }
}
