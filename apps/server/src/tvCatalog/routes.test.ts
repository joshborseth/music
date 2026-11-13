import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { Effect, Layer, Option, Schema } from 'effect'
import { HttpRouter } from 'effect/http'

import {
  MusicNotFoundError,
  type Song,
  Tv,
  YouTubeMusicError,
} from '@music/shared'

import { AnalysisError, SongAnalysis } from '../analysis/service.ts'
import { TimedLyrics, withLines } from '../lyrics/service.ts'
import { PlaylistStore, makePlaylistStore } from '../playlists/store.ts'
import { type PrefetchJob, Prefetcher } from '../prefetch.ts'
import { YouTubeMusic } from '../youtubeMusic/service.ts'
import { TvCatalogRoutes } from './routes.ts'

const song = (videoId: string): Song => ({
  videoId,
  title: `Song ${videoId}`,
  artists: [{ maybeId: Option.none(), name: 'Artist' }],
  maybeAlbum: Option.none(),
  maybeDurationSeconds: Option.some(200),
  artwork: [],
})

const down = Effect.fail(new YouTubeMusicError({ message: 'down' }))

const plans: Array<ReadonlyArray<PrefetchJob>> = []

const youTubeMusic = YouTubeMusic.of({
  searchSongs: () => Effect.succeed([song('s1'), song('s2')]),
  searchArtists: () => Effect.succeed([]),
  searchAlbums: () => Effect.succeed([]),
  searchPlaylists: () => down,
  searchTopResult: () => down,
  getMoodsAndGenres: () => down,
  getMood: () => down,
  getSong: videoId =>
    videoId === 'missing'
      ? Effect.fail(new MusicNotFoundError({ id: videoId }))
      : Effect.succeed({
          song: song(videoId),
          maybeViewCount: Option.none(),
          maybeLyrics: Option.some({
            text: 'La la',
            maybeSource: Option.some('Source: Musixmatch'),
            maybeLines: Option.none(),
          }),
        }),
  getUpNext: () => down,
  getDurationSeconds: () => down,
  getArtist: () => down,
  getAlbum: albumId =>
    Effect.succeed({
      album: {
        id: albumId,
        title: 'An album',
        artists: [{ maybeId: Option.none(), name: 'Artist' }],
        maybeKind: Option.some('EP'),
        maybeYear: Option.some('2024'),
        artwork: [],
      },
      maybeDescription: Option.none(),
      maybeLengthSummary: Option.none(),
      tracks: [song('t1'), song('t2')],
      explicitVideoIds: [],
      maybeRadio: Option.none(),
    }),
  getPlaylist: () => down,
  getRadio: () => down,
})

const analysisOf = (videoId: string): Tv.TvAnalysis => ({
  videoId,
  durationSeconds: 8.5,
  tempo: 120,
  beats: [0.5, 1, 1.5, 2],
  downbeats: [0.5],
  sections: [
    { startSeconds: 0, endSeconds: 8.5, kind: 'Verse', group: 0, energy: 1 },
  ],
  drops: [],
  accents: [1.25],
  energyStepSeconds: 0.1,
  energy: [0.5, 1],
})

const songAnalysis = SongAnalysis.of({
  analysis: videoId =>
    videoId.startsWith('gone')
      ? Effect.fail(
          new AnalysisError({
            videoId,
            reason: 'AudioUnavailable',
            message: 'yt-dlp failed',
          }),
        )
      : videoId.startsWith('broken')
        ? Effect.fail(
            new AnalysisError({
              videoId,
              reason: 'Failed',
              message: 'ffmpeg failed',
            }),
          )
        : Effect.succeed(analysisOf(videoId)),
  warm: () => Effect.void,
})

const playlistStore = makePlaylistStore(
  new Database(':memory:', { strict: true }),
  { now: () => 1, newId: () => 'playlist-1' },
)

const { handler, dispose } = HttpRouter.toWebHandler(
  TvCatalogRoutes.pipe(
    Layer.provide(Layer.succeed(SongAnalysis)(songAnalysis)),
    Layer.provide(Layer.succeed(YouTubeMusic)(youTubeMusic)),
    Layer.provide(
      Layer.succeed(TimedLyrics)(
        TimedLyrics.of({
          withTimedLines: details =>
            Effect.succeed(
              withLines(
                details,
                details.song.videoId === 'timed'
                  ? Option.some([
                      { startSeconds: 1.5, text: 'La la', words: [] },
                    ])
                  : Option.none(),
              ),
            ),
          warm: () => Effect.void,
        }),
      ),
    ),
    Layer.provide(Layer.succeed(PlaylistStore)(playlistStore)),
    Layer.provide(
      Layer.succeed(Prefetcher)(
        Prefetcher.of({
          plan: (_source, jobs) => Effect.sync(() => void plans.push(jobs)),
        }),
      ),
    ),
  ),
  { disableLogger: true },
)

afterAll(() => dispose())

const get = (path: string) => handler(new Request(`http://tv${path}`))

describe('TV catalog routes', () => {
  test('home lists your own playlists, without asking YouTube Music', async () => {
    const response = await get('/tv/home')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      shelves: [
        {
          title: 'Your playlists',
          cards: [
            {
              kind: 'MyPlaylist',
              id: 'liked',
              title: 'Liked songs',
              subtitle: 'Playlist · 0 songs',
              artworkUrl: null,
              track: null,
            },
          ],
        },
      ],
    })
  })

  test('home leads with what played lately, from any device', async () => {
    Effect.runSync(playlistStore.recordPlay(song('played')))
    const response = await get('/tv/home')
    const body = Schema.decodeUnknownSync(Tv.TvShelves)(await response.json())
    expect(body.shelves.map(({ title }) => title)).toEqual([
      'Recently played',
      'Your playlists',
    ])
    expect(body.shelves[0]?.cards[0]).toMatchObject({
      kind: 'Song',
      id: 'played',
    })
  })

  test('home ends with the songs of a playlist you made', async () => {
    Effect.runSync(
      playlistStore.edit({
        _tag: 'Create',
        title: 'Road trip',
        songs: [song('trip')],
      }),
    )
    const response = await get('/tv/home')
    const body = Schema.decodeUnknownSync(Tv.TvShelves)(await response.json())
    expect(body.shelves.map(({ title }) => title)).toEqual([
      'Recently played',
      'Your playlists',
      'Road trip',
    ])
    expect(body.shelves[2]?.cards[0]).toMatchObject({
      kind: 'Song',
      id: 'trip',
    })
  })

  test('search answers 502 when a search fails, and 400 without q', async () => {
    expect((await get('/tv/search?q=rick')).status).toBe(502)
    const blank = await get('/tv/search?q=%20')
    expect(blank.status).toBe(400)
    expect(await blank.text()).toBe('Search needs q')
  })

  test('an album opens and its first songs get ready', async () => {
    plans.length = 0
    const response = await get('/tv/collection?kind=Album&id=MPREb_x')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      kind: 'Album',
      id: 'MPREb_x',
      subtitle: 'EP · Artist · 2024',
      description: null,
      shelves: [],
    })
    expect(plans.flat().map(({ videoId }) => videoId)).toEqual(['t1', 't2'])
  })

  test('a collection with an unknown kind is a bad request', async () => {
    expect((await get('/tv/collection?kind=Song&id=x')).status).toBe(400)
  })

  test('lyrics, and 404 for a missing song', async () => {
    expect(await (await get('/tv/lyrics?videoId=a')).json()).toEqual({
      text: 'La la',
      source: 'Source: Musixmatch',
      lines: null,
    })
    expect(await (await get('/tv/lyrics?videoId=timed')).json()).toEqual({
      text: 'La la',
      source: 'LRCLIB',
      lines: [{ startSeconds: 1.5, text: 'La la', words: [] }],
    })
    expect((await get('/tv/lyrics?videoId=missing')).status).toBe(404)
  })

  test("a song's analysis, and why it is missing", async () => {
    const response = await get('/tv/analysis?videoId=dQw4w9WgXcQ')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(analysisOf('dQw4w9WgXcQ'))

    const gone = await get('/tv/analysis?videoId=gone12345')
    expect(gone.status).toBe(502)
    expect(await gone.text()).toBe('The song is unavailable')
    expect((await get('/tv/analysis?videoId=broken123')).status).toBe(500)
    expect((await get('/tv/analysis?videoId=../etc')).status).toBe(400)
    expect((await get('/tv/analysis')).status).toBe(400)
  })

  test('liking and unliking a song', async () => {
    const like = (liked: boolean) =>
      handler(
        new Request('http://tv/tv/like', {
          method: 'POST',
          body: JSON.stringify({
            track: {
              videoId: 'v1',
              title: 'Song',
              artists: 'Artist',
              album: null,
              durationSeconds: 200,
              artworkUrl: null,
            },
            liked,
          }),
        }),
      )

    expect(await (await like(true)).json()).toEqual({
      videoId: 'v1',
      liked: true,
    })
    expect(await (await get('/tv/liked?videoId=v1')).json()).toEqual({
      videoId: 'v1',
      liked: true,
    })
    const library = Schema.decodeUnknownSync(Tv.TvShelves)(
      await (await get('/tv/library')).json(),
    )
    expect(library.shelves[0]?.cards[0]?.subtitle).toBe('Playlist · 1 song')
    expect(await (await like(false)).json()).toEqual({
      videoId: 'v1',
      liked: false,
    })
  })

  test('a like without a valid body is a bad request', async () => {
    const response = await handler(
      new Request('http://tv/tv/like', { method: 'POST', body: '{}' }),
    )
    expect(response.status).toBe(400)
  })
})
