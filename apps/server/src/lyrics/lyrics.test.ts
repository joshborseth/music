import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { Effect, Option } from 'effect'

import type { LyricLine, Song, SongDetails } from '@music/shared'

import { isUnsung, parseLrc } from './lrc.ts'
import { bestMatch, plainTitle, queryOf } from './lrclib.ts'
import { makeLyricsCache, makeTimedLyrics } from './service.ts'

const line = (startSeconds: number, text: string): LyricLine => ({
  startSeconds,
  text,
  words: [],
})

describe('parseLrc', () => {
  test('reads timed lines in order and skips tags', () => {
    expect(
      parseLrc(
        [
          '[ar:Rick Astley]',
          '[00:22.82] You know the rules',
          '[00:18.89] We are no strangers',
          '[1:02.5]Last line',
        ].join('\n'),
      ),
    ).toEqual(
      Option.some([
        line(18.89, 'We are no strangers'),
        line(22.82, 'You know the rules'),
        line(62.5, 'Last line'),
      ]),
    )
  })

  test('a line with several times repeats', () => {
    expect(parseLrc('[00:10.00][00:30.00] Chorus\n[00:20.00] Verse')).toEqual(
      Option.some([line(10, 'Chorus'), line(20, 'Verse'), line(30, 'Chorus')]),
    )
  })

  test('words keep their spacing', () => {
    expect(
      parseLrc('[00:18.89] <00:18.89>We are <00:19.53>no <00:20.07>strangers'),
    ).toEqual(
      Option.some([
        {
          startSeconds: 18.89,
          text: 'We are no strangers',
          words: [
            { startSeconds: 18.89, text: 'We are ' },
            { startSeconds: 19.53, text: 'no ' },
            { startSeconds: 20.07, text: 'strangers' },
          ],
        },
      ]),
    )
  })

  test('keeps one break after singing, and the outro', () => {
    expect(
      parseLrc(
        [
          '[00:01.00]',
          '[00:05.00] One',
          '[00:09.00]',
          '[00:10.00]',
          '[00:20.00] Two',
          '[00:30.00]',
        ].join('\n'),
      ),
    ).toEqual(
      Option.some([line(5, 'One'), line(9, ''), line(20, 'Two'), line(30, '')]),
    )
  })

  test('turns credits and instrumental markers into breaks', () => {
    expect(
      parseLrc(
        [
          '[00:00.00] 作词 : Thomas Bangalter',
          '[00:00.50] 作曲 : Guy-Manuel de Homem-Christo',
          '[00:01.00] Lyrics by: Daft Punk',
          '[00:05.00] One',
          '[00:09.00] Instrumentals',
          '[00:15.00] Two',
          '[00:20.00] ♪',
          '[00:25.00] Three',
          '[00:30.00] (Instrumental break)',
          '[00:31.00] [Chorus]',
          '[00:35.00] Four',
          '[00:40.00] Produced by Pharrell Williams',
        ].join('\n'),
      ),
    ).toEqual(
      Option.some([
        line(5, 'One'),
        line(9, ''),
        line(15, 'Two'),
        line(20, ''),
        line(25, 'Three'),
        line(30, ''),
        line(35, 'Four'),
        line(40, ''),
      ]),
    )
  })

  test('keeps sung lines that only look like credits', () => {
    const sung = [
      'Music is my life',
      'Written in the stars',
      'Written by a fool in love',
      'Music by the river',
      'Instrumental to my heart',
      'Lyrics on my mind',
      'Produce something new',
      '(Hoo!)',
      '(I love my father)',
      'Words: they never mean a thing',
    ]
    expect(sung.filter(isUnsung)).toEqual([])
  })

  test('none when nothing is sung', () => {
    expect(parseLrc('[00:01.00]\n[ti:Song]\nplain text')).toEqual(Option.none())
  })
})

describe('matching', () => {
  const query = { title: 'Song', artist: 'Artist', durationSeconds: 200 }
  const record = (
    duration: number | null,
    syncedLyrics: string | null,
    instrumental = false,
  ) => ({
    trackName: 'Song',
    artistName: 'Artist',
    duration,
    instrumental,
    syncedLyrics,
  })

  test('the closest length within two seconds wins', () => {
    expect(
      bestMatch(
        [
          record(205, '[00:01.00] Too long'),
          record(201.5, '[00:01.00] Close'),
          record(200.4, '[00:01.00] Closest'),
          record(200, null),
        ],
        query,
      ),
    ).toEqual(Option.some([line(1, 'Closest')]))
  })

  test('nothing when only other lengths or instrumentals match', () => {
    expect(
      bestMatch(
        [record(230, '[00:01.00] Video'), record(200, '[00:01.00] x', true)],
        query,
      ),
    ).toEqual(Option.none())
  })

  test('plain titles drop what YouTube adds', () => {
    expect(plainTitle('Bohemian Rhapsody (Remastered 2011)')).toBe(
      'Bohemian Rhapsody',
    )
    expect(plainTitle('Song (feat. Someone) [Official Video]')).toBe('Song')
    expect(plainTitle('Song - 2009 Remaster')).toBe('Song')
    expect(plainTitle('(Sittin’ On) The Dock of the Bay')).toBe(
      '(Sittin’ On) The Dock of the Bay',
    )
  })

  test('a song without a length is not looked up', () => {
    expect(
      queryOf({ ...song('a'), maybeDurationSeconds: Option.none() }),
    ).toEqual(Option.none())
  })
})

const song = (videoId: string): Song => ({
  videoId,
  title: 'Song',
  artists: [{ maybeId: Option.none(), name: 'Artist' }],
  maybeAlbum: Option.none(),
  maybeDurationSeconds: Option.some(200),
  artwork: [],
})

const details = (videoId: string): SongDetails => ({
  song: song(videoId),
  maybeViewCount: Option.none(),
  maybeLyrics: Option.some({
    text: 'Plain',
    maybeSource: Option.some('Source: Musixmatch'),
    maybeLines: Option.none(),
  }),
})

describe('timed lyrics', () => {
  const run = <A>(
    effect: (
      service: Effect.Success<ReturnType<typeof makeTimedLyrics>>,
      calls: Array<string>,
      setNow: (now: number) => void,
    ) => Effect.Effect<A>,
    answer: Option.Option<ReadonlyArray<LyricLine>> = Option.some([
      line(1, 'Timed'),
    ]),
  ) => {
    const calls: Array<string> = []
    let now = 0
    const cache = makeLyricsCache(new Database(':memory:', { strict: true }))
    return Effect.runPromise(
      Effect.scoped(
        makeTimedLyrics(
          cache,
          query =>
            Effect.sync(() => {
              calls.push(query.title)
              return answer
            }),
          () => now,
        ).pipe(
          Effect.flatMap(service =>
            effect(service, calls, value => {
              now = value
            }),
          ),
        ),
      ),
    )
  }

  test('replaces plain lyrics with timed ones, looked up once', async () => {
    const [first, second, calls] = await run((service, calls) =>
      Effect.gen(function* () {
        const first = yield* service.withTimedLines(details('a'))
        const second = yield* service.withTimedLines(details('a'))
        return [first, second, calls] as const
      }),
    )
    expect(first.maybeLyrics).toEqual(
      Option.some({
        text: 'Timed',
        maybeSource: Option.some('LRCLIB'),
        maybeLines: Option.some([line(1, 'Timed')]),
      }),
    )
    expect(second).toEqual(first)
    expect(calls).toEqual(['Song'])
  })

  test('takes credits out of copies kept before they were filtered', () => {
    const cache = makeLyricsCache(new Database(':memory:', { strict: true }))
    cache.put(
      'a',
      Option.some([
        line(0, 'Instrumentals'),
        line(5, 'One'),
        line(9, 'Instrumentals'),
        line(15, 'Two'),
      ]),
      0,
    )
    expect(cache.get('a', 1)).toEqual(
      Option.some(Option.some([line(5, 'One'), line(9, ''), line(15, 'Two')])),
    )
  })

  test('keeps plain lyrics on a miss, and asks again a week later', async () => {
    const [result, calls] = await run(
      (service, calls, setNow) =>
        Effect.gen(function* () {
          const result = yield* service.withTimedLines(details('a'))
          yield* service.withTimedLines(details('a'))
          setNow(8 * 24 * 60 * 60 * 1000)
          yield* service.withTimedLines(details('a'))
          return [result, calls] as const
        }),
      Option.none(),
    )
    expect(result).toEqual(details('a'))
    expect(calls).toEqual(['Song', 'Song'])
  })
})
