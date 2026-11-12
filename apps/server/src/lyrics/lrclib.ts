import { Array, Effect, Option, Order, Schema, pipe } from 'effect'

import type { LyricLine, Song } from '@music/shared'

import { parseLrc } from './lrc.ts'

/*
 * LRCLIB (https://lrclib.net) is a free, open lyrics database that needs no
 * account or key. It is open source and publishes its database, so it can be
 * hosted on our own servers later; `LRCLIB_URL` points at such a copy.
 *
 *   GET /api/get?track_name&artist_name&duration   one record, or 404
 *   GET /api/search?track_name&artist_name         up to 20 records
 */

/** LRCLIB asks every client to name itself. */
const USER_AGENT = 'Joshify (self-hosted music player)'

/**
 * A timed copy is only trusted when its length is this close to the song's:
 * a music video with a longer intro, or a radio edit, would sing out of sync.
 */
export const MAX_DURATION_GAP_SECONDS = 2

export class LrclibError extends Schema.TaggedError<LrclibError>()(
  'LrclibError',
  { message: Schema.String },
) {}

const LrclibRecord = Schema.Struct({
  trackName: Schema.String,
  artistName: Schema.String,
  duration: Schema.NullOr(Schema.Number),
  instrumental: Schema.optional(Schema.Boolean),
  syncedLyrics: Schema.NullOr(Schema.String),
})
type LrclibRecord = typeof LrclibRecord.Type

const decodeRecord = Schema.decodeUnknownOption(LrclibRecord)
const decodeRecords = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))

// MATCHING

/** What LRCLIB is asked for one song. */
export interface LyricsQuery {
  readonly title: string
  readonly artist: string
  readonly durationSeconds: number
}

/**
 * Titles YouTube Music adds to that the lyrics databases usually leave off:
 * "(feat. …)", "(Remastered 2011)", "- Radio Edit", "[Official Video]".
 */
const DECORATION =
  /\s*(?:[([](?:feat\.?|ft\.?|with|remaster(?:ed)?|\d{4} remaster|official|live|radio edit|explicit|clean|mono|stereo|version|bonus)[^)\]]*[)\]]|-\s*(?:remaster(?:ed)?|\d{4} remaster|radio edit|single version|mono|stereo).*$)/gi

export const plainTitle = (title: string): string =>
  title.replace(DECORATION, '').trim()

/** The query for a song, or none when it has no length to check against. */
export const queryOf = (song: Song): Option.Option<LyricsQuery> =>
  Option.flatMap(song.maybeDurationSeconds, durationSeconds =>
    Option.map(Array.head(song.artists), ({ name }) => ({
      title: song.title,
      artist: name,
      durationSeconds,
    })),
  )

const durationGap = (record: LrclibRecord, query: LyricsQuery): number =>
  record.duration === null
    ? Infinity
    : Math.abs(record.duration - query.durationSeconds)

const byGap = (query: LyricsQuery) =>
  Order.mapInput(Order.Number, (record: LrclibRecord) =>
    durationGap(record, query),
  )

/**
 * The best timed record: one that is not instrumental, has timed lyrics that
 * parse, and is as long as the song; the closest length wins.
 */
export const bestMatch = (
  records: ReadonlyArray<LrclibRecord>,
  query: LyricsQuery,
): Option.Option<ReadonlyArray<LyricLine>> =>
  pipe(
    records,
    Array.filter(
      record =>
        record.instrumental !== true &&
        durationGap(record, query) <= MAX_DURATION_GAP_SECONDS,
    ),
    Array.sort(byGap(query)),
    Array.findFirst(record =>
      Option.flatMap(Option.fromNullishOr(record.syncedLyrics), parseLrc),
    ),
  )

// REQUESTS

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : globalThis.String(cause)

/** The JSON body, or none for a 404. */
const getJson = (
  url: URL,
): Effect.Effect<Option.Option<unknown>, LrclibError> =>
  Effect.tryPromise({
    try: async signal => {
      const response = await fetch(url, {
        signal,
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      })
      if (response.status === 404) {
        return Option.none()
      }
      if (!response.ok) {
        throw new Error(`LRCLIB answered ${response.status}`)
      }
      return Option.some<unknown>(await response.json())
    },
    catch: cause => new LrclibError({ message: errorMessage(cause) }),
  })

const urlOf = (
  baseUrl: string,
  path: string,
  params: Record<string, string>,
): URL => {
  const url = new URL(path, baseUrl)
  Object.entries(params).forEach(([key, value]) =>
    url.searchParams.set(key, value),
  )
  return url
}

/**
 * Timed lines for a song: first the exact record LRCLIB keeps for this
 * title, artist, and length, then a search under the plain title.
 */
export const fetchTimedLines = (
  baseUrl: string,
  query: LyricsQuery,
): Effect.Effect<Option.Option<ReadonlyArray<LyricLine>>, LrclibError> =>
  Effect.gen(function* () {
    const exact = yield* getJson(
      urlOf(baseUrl, '/api/get', {
        track_name: query.title,
        artist_name: query.artist,
        duration: globalThis.String(Math.round(query.durationSeconds)),
      }),
    )
    const exactMatch = bestMatch(
      Option.toArray(Option.flatMap(exact, decodeRecord)),
      query,
    )
    if (Option.isSome(exactMatch)) {
      return exactMatch
    }
    const found = yield* getJson(
      urlOf(baseUrl, '/api/search', {
        track_name: plainTitle(query.title),
        artist_name: query.artist,
      }),
    )
    const records = pipe(
      Option.flatMap(found, json => decodeRecords(json)),
      Option.getOrElse((): ReadonlyArray<unknown> => []),
      Array.map(record => decodeRecord(record)),
      Array.getSomes,
    )
    return bestMatch(records, query)
  })
