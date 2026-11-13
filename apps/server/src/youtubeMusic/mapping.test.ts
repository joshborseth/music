import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'
import { YTNodes } from 'youtubei.js'

import { type Song } from '@music/shared'

import {
  artistFromTwoRowItem,
  audioTrackFor,
  filterSome,
  hexFromArgb,
  isExplicit,
  playlistOwnerFromResponse,
  playsFromListItem,
  secondsFromClock,
  songFromListItem,
  toArtwork,
  toMoodGroups,
  topResultFromCard,
} from './mapping.ts'

const thumbnail = (url: string, size: number) => ({
  url,
  width: size,
  height: size,
})

describe('toArtwork', () => {
  test('sorts sizes smallest first and adds a large Google variant', () => {
    const artwork = toArtwork([
      thumbnail('https://lh3.googleusercontent.com/abc=w120-h120-l90-rj', 120),
      thumbnail('https://lh3.googleusercontent.com/abc=w60-h60-l90-rj', 60),
    ])

    expect(artwork.map(({ width }) => width)).toEqual([60, 120, 544])
    expect(artwork.at(-1)?.url).toBe(
      'https://lh3.googleusercontent.com/abc=w544-h544-l90-rj',
    )
  })

  test('leaves fixed-size video thumbnails alone', () => {
    const artwork = toArtwork([
      {
        url: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
        width: 480,
        height: 360,
      },
    ])

    expect(artwork).toHaveLength(1)
  })

  test('makes protocol-relative URLs absolute', () => {
    const artwork = toArtwork([thumbnail('//yt3.ggpht.com/photo.jpg', 900)])

    expect(artwork[0]?.url).toBe('https://yt3.ggpht.com/photo.jpg')
  })

  test('treats missing thumbnails as no artwork', () => {
    expect(toArtwork(undefined)).toEqual([])
  })
})

describe('filterSome', () => {
  test('keeps only the present results', () => {
    expect(
      filterSome([1, 2, 3, 4], value =>
        value % 2 === 0 ? Option.some(value * 10) : Option.none(),
      ),
    ).toEqual([20, 40])
  })
})

const browseTo = (browseId: string, pageType: string) => ({
  browseEndpoint: {
    browseId,
    browseEndpointContextSupportedConfigs: {
      browseEndpointContextMusicConfig: { pageType },
    },
  },
})

const watch = (videoId: string) => ({ watchEndpoint: { videoId } })

const SEPARATOR = { text: ' • ' }

const card = (
  title: string,
  endpoint: object,
  subtitleRuns: ReadonlyArray<object>,
) =>
  new YTNodes.MusicCardShelf({
    title: { runs: [{ text: title, navigationEndpoint: endpoint }] },
    subtitle: { runs: subtitleRuns },
    onTap: endpoint,
    thumbnail: {
      musicThumbnailRenderer: {
        thumbnail: {
          thumbnails: [
            {
              url: 'https://lh3.googleusercontent.com/a=w120-h120-l90-rj',
              width: 120,
              height: 120,
            },
          ],
        },
      },
    },
  })

const artistRun = (name: string, id: string) => ({
  text: name,
  navigationEndpoint: browseTo(id, 'MUSIC_PAGE_TYPE_ARTIST'),
})

describe('topResultFromCard', () => {
  test('reads an artist with its audience', () => {
    const result = topResultFromCard(
      card('Daft Punk', browseTo('UC1', 'MUSIC_PAGE_TYPE_ARTIST'), [
        { text: 'Artist' },
        SEPARATOR,
        { text: '66.1M monthly audience' },
      ]),
    )

    expect(Option.getOrThrow(result)).toMatchObject({
      _tag: 'Artist',
      artist: {
        id: 'UC1',
        name: 'Daft Punk',
        maybeAudience: Option.some('66.1M monthly audience'),
      },
    })
  })

  test('reads an album with its kind, artists, and year', () => {
    const result = topResultFromCard(
      card(
        'Random Access Memories',
        browseTo('MPREb_1', 'MUSIC_PAGE_TYPE_ALBUM'),
        [
          { text: 'Album' },
          SEPARATOR,
          artistRun('Daft Punk', 'UC1'),
          SEPARATOR,
          { text: '2013' },
        ],
      ),
    )

    expect(Option.getOrThrow(result)).toMatchObject({
      _tag: 'Album',
      album: {
        id: 'MPREb_1',
        title: 'Random Access Memories',
        artists: [{ maybeId: Option.some('UC1'), name: 'Daft Punk' }],
        maybeKind: Option.some('Album'),
        maybeYear: Option.some('2013'),
      },
    })
  })

  test('reads a video as a song with its length', () => {
    const result = topResultFromCard(
      card('Creep', watch('XFkzRNyygfk'), [
        { text: 'Video' },
        SEPARATOR,
        artistRun('Radiohead', 'UC2'),
        SEPARATOR,
        { text: '1.6B views' },
        SEPARATOR,
        { text: '3:57' },
      ]),
    )

    expect(Option.getOrThrow(result)).toMatchObject({
      _tag: 'Song',
      song: {
        videoId: 'XFkzRNyygfk',
        title: 'Creep',
        artists: [{ maybeId: Option.some('UC2'), name: 'Radiohead' }],
        maybeDurationSeconds: Option.some(237),
      },
    })
  })

  test("keeps YouTube Music's own playlists but leaves out radio", () => {
    const curated = topResultFromCard(
      card(
        'Coffee Shop Blend',
        browseTo('VLRDCLAK5uy_x', 'MUSIC_PAGE_TYPE_PLAYLIST'),
        [{ text: 'Playlist' }, SEPARATOR, { text: 'YouTube Music' }],
      ),
    )
    const radio = topResultFromCard(
      card(
        'Radio • Lofi',
        browseTo('VLRDATfcbG9maQ', 'MUSIC_PAGE_TYPE_PLAYLIST'),
        [{ text: 'Saib, Sleepy Fish, and more' }],
      ),
    )

    expect(Option.getOrThrow(curated)).toMatchObject({
      _tag: 'Playlist',
      playlist: {
        id: 'VLRDCLAK5uy_x',
        maybeSubtitle: Option.some('YouTube Music'),
      },
    })
    expect(Option.isNone(radio)).toBe(true)
  })
})

describe('topResultFromCard credits', () => {
  test("keeps a channel's name when it links to no artist page", () => {
    const result = topResultFromCard(
      card('Anti-Hero (Lyrics)', watch('lyr1cs'), [
        { text: 'Video' },
        SEPARATOR,
        { text: 'Lyric Vibes' },
        SEPARATOR,
        { text: '12M views' },
        SEPARATOR,
        { text: '3:21' },
      ]),
    )

    expect(Option.getOrThrow(result)).toMatchObject({
      _tag: 'Song',
      song: { artists: [{ maybeId: Option.none(), name: 'Lyric Vibes' }] },
    })
  })
})

const taylorSwift = {
  maybeId: Option.some('UCPC0L1d253x-KuMNwa05TpA'),
  name: 'Taylor Swift',
}

const searchedSong = (
  videoId: string,
  title: string,
  artists: Song['artists'],
): Song => ({
  videoId,
  title,
  artists,
  maybeAlbum: Option.some({ id: 'MPREb_mid', name: 'Midnights' }),
  maybeDurationSeconds: Option.some(201),
  artwork: [],
})

describe('audioTrackFor', () => {
  const karaoke = searchedSong('k4r40k3', 'Anti-Hero (Karaoke Version)', [
    { maybeId: Option.some('UCkaraoke'), name: 'Sing King' },
  ])
  const song = searchedSong('3YgtjHZyCIQ', 'Anti-Hero', [taylorSwift])

  test('finds the song a music video is of, by title and artist', () => {
    const video = searchedSong(
      'b1kbLwvqugk',
      'Anti-Hero (Official Music Video)',
      [taylorSwift],
    )

    expect(audioTrackFor(video, [karaoke, song])).toEqual(Option.some(song))
  })

  test('reads past the artist in front of the title', () => {
    const video = searchedSong(
      'v1d30',
      'Taylor Swift - Anti-Hero [Official Video]',
      [taylorSwift],
    )

    expect(audioTrackFor(video, [song])).toEqual(Option.some(song))
  })

  test('keeps a version that is part of the title apart', () => {
    const video = searchedSong('v1d30', 'Anti-Hero (feat. Bleachers)', [
      taylorSwift,
    ])

    expect(Option.isNone(audioTrackFor(video, [song]))).toBe(true)
  })

  test('leaves a song by someone else alone', () => {
    const cover = searchedSong('c0v3r', 'Anti-Hero', [
      { maybeId: Option.some('UCcover'), name: 'Some Band' },
    ])
    const video = searchedSong('v1d30', 'Anti-Hero (Official Video)', [
      taylorSwift,
    ])

    expect(audioTrackFor(video, [cover])).toEqual(Option.none())
  })

  test('matches a video with no artist page on its title alone', () => {
    const video = searchedSong('v1d30', 'Anti-Hero (Lyrics)', [
      { maybeId: Option.none(), name: 'Lyric Vibes' },
    ])

    expect(audioTrackFor(video, [song])).toEqual(Option.some(song))
  })
})

describe('secondsFromClock', () => {
  test('reads minutes and hours', () => {
    expect(secondsFromClock('3:57')).toEqual(Option.some(237))
    expect(secondsFromClock('1:02:03')).toEqual(Option.some(3723))
    expect(secondsFromClock('1.6B views')).toEqual(Option.none())
  })
})

const navigationButton = (title: string, color: number, params: string) => ({
  musicNavigationButtonRenderer: {
    buttonText: { runs: [{ text: title }] },
    solid: { leftStripeColor: color },
    clickCommand: { browseEndpoint: { browseId: 'FEmusic_x', params } },
  },
})

const moodsPage = (grids: ReadonlyArray<object>) => ({
  contents: {
    singleColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: { sectionListRenderer: { contents: grids } },
          },
        },
      ],
    },
  },
})

describe('toMoodGroups', () => {
  test('reads each group with its categories and their colors', () => {
    const groups = toMoodGroups(
      moodsPage([
        {
          gridRenderer: {
            header: {
              gridHeaderRenderer: { title: { runs: [{ text: 'Genres' }] } },
            },
            items: [
              navigationButton('Jazz', 0xffa4c5ff, 'jazz'),
              { somethingElse: {} },
            ],
          },
        },
        { musicCarouselShelfRenderer: {} },
      ]),
    )

    expect(Option.getOrThrow(groups)).toEqual([
      {
        title: 'Genres',
        categories: [
          {
            params: 'jazz',
            title: 'Jazz',
            maybeColor: Option.some('#a4c5ff'),
          },
        ],
      },
    ])
  })

  test('is None for a page of another shape', () => {
    expect(Option.isNone(toMoodGroups({ contents: {} }))).toBe(true)
  })
})

describe('hexFromArgb', () => {
  test('drops the alpha and pads', () => {
    expect(hexFromArgb(0xff00a513)).toBe('#00a513')
  })
})

describe('isExplicit', () => {
  const row = (badges: ReadonlyArray<object>) =>
    new YTNodes.MusicResponsiveListItem({
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [{ text: 'King Kunta' }] },
          },
        },
      ],
      badges,
    })

  test('sees the explicit badge', () => {
    expect(
      isExplicit(
        row([
          {
            musicInlineBadgeRenderer: {
              icon: { iconType: 'MUSIC_EXPLICIT_BADGE' },
            },
          },
        ]),
      ),
    ).toBe(true)
    expect(isExplicit(row([]))).toBe(false)
  })
})

const column = (runs: ReadonlyArray<object>) => ({
  musicResponsiveListItemFlexColumnRenderer: { text: { runs } },
})

describe('an artist’s top songs', () => {
  // As the artist page lists them: title, artists, plays, album.
  const topSong = new YTNodes.MusicResponsiveListItem({
    playlistItemData: { videoId: 'crush' },
    flexColumns: [
      column([
        {
          text: 'Instant Crush',
          navigationEndpoint: {
            watchEndpoint: {
              videoId: 'crush',
              watchEndpointMusicSupportedConfigs: {
                watchEndpointMusicConfig: {
                  musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
                },
              },
            },
          },
        },
      ]),
      column([
        artistRun('Daft Punk', 'UC1'),
        { text: ' & ' },
        artistRun('Julian Casablancas', 'UC2'),
      ]),
      column([{ text: '1.2B plays' }]),
      column([
        {
          text: 'Random Access Memories',
          navigationEndpoint: browseTo('MPREb_ram', 'MUSIC_PAGE_TYPE_ALBUM'),
        },
      ]),
    ],
  })

  test('name the album from their last column', () => {
    expect(Option.getOrThrow(songFromListItem(topSong))).toMatchObject({
      videoId: 'crush',
      title: 'Instant Crush',
      maybeAlbum: Option.some({
        id: 'MPREb_ram',
        name: 'Random Access Memories',
      }),
    })
  })

  test('say how often they were played', () => {
    expect(playsFromListItem(topSong)).toEqual(Option.some('1.2B plays'))
  })
})

describe('artistFromTwoRowItem', () => {
  test('reads an artist fans also like, with their audience', () => {
    const card = new YTNodes.MusicTwoRowItem({
      title: {
        runs: [
          {
            text: 'Justice',
            navigationEndpoint: browseTo('UCj', 'MUSIC_PAGE_TYPE_ARTIST'),
          },
        ],
      },
      subtitle: { runs: [{ text: '24.1M monthly audience' }] },
      navigationEndpoint: browseTo('UCj', 'MUSIC_PAGE_TYPE_ARTIST'),
      thumbnailRenderer: {
        musicThumbnailRenderer: { thumbnail: { thumbnails: [] } },
      },
    })
    expect(Option.getOrThrow(artistFromTwoRowItem(card))).toMatchObject({
      id: 'UCj',
      name: 'Justice',
      maybeAudience: Option.some('24.1M monthly audience'),
    })
  })
})

describe('playlistOwnerFromResponse', () => {
  const page = (facepile: object | undefined) => ({
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      musicResponsiveHeaderRenderer:
                        facepile === undefined ? {} : { facepile },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  })
  const facepile = (name: string, onTap: object | undefined) => ({
    avatarStackViewModel: {
      text: { content: name },
      rendererContext:
        onTap === undefined
          ? {}
          : { commandContext: { onTap: { innertubeCommand: onTap } } },
    },
  })

  test('links an artist who made it to their page', () => {
    expect(
      playlistOwnerFromResponse(
        page(facepile('Daft Punk', browseTo('UCd', 'MUSIC_PAGE_TYPE_ARTIST'))),
      ),
    ).toEqual(Option.some({ maybeId: Option.some('UCd'), name: 'Daft Punk' }))
  })

  test('names YouTube Music or a channel without a link', () => {
    expect(
      playlistOwnerFromResponse(page(facepile('YouTube Music', undefined))),
    ).toEqual(Option.some({ maybeId: Option.none(), name: 'YouTube Music' }))
    expect(
      playlistOwnerFromResponse(
        page(
          facepile('Someone', browseTo('UCs', 'MUSIC_PAGE_TYPE_USER_CHANNEL')),
        ),
      ),
    ).toEqual(Option.some({ maybeId: Option.none(), name: 'Someone' }))
  })

  test('is None when the header names nobody', () => {
    expect(playlistOwnerFromResponse(page(undefined))).toEqual(Option.none())
    expect(playlistOwnerFromResponse({})).toEqual(Option.none())
  })
})
