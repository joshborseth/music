import { describe, expect, test } from 'bun:test'
import { Option } from 'effect'
import { YTNodes } from 'youtubei.js'

import {
  type AlbumSummary,
  type ArtistLink,
  type ArtistSummary,
  type PlaylistSummary,
  type Song,
  type TopResult,
} from '@music/shared'

import {
  NO_FOCUS,
  albumRadio,
  artistFromTwoRowItem,
  audioTrackFor,
  audioTrackQuery,
  chooseTopResult,
  cleanVideoTitle,
  countFromText,
  filterAlbumsForQuery,
  filterArtistsForQuery,
  filterPlaylistsForQuery,
  filterSome,
  hexFromArgb,
  isExplicit,
  musicVideoIds,
  playlistOwnerFromResponse,
  playsFromListItem,
  radioOf,
  rankArtistsForQuery,
  rankSongsForQuery,
  searchNamesArtist,
  secondsFromClock,
  songFromListItem,
  songFromPlaylistPanelVideo,
  suggestionsFrom,
  toArtwork,
  toMoodGroups,
  topCardFrom,
  topResultFromCard,
  topSongAlbumId,
  withTopSongAlbum,
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

  test('reads past a video bracket YouTube cut short', () => {
    const jid = { maybeId: Option.some('UCjid'), name: 'JID' }
    const video = searchedSong(
      'v1d30',
      'Surround Sound [Official Music ... (feat. 21 Savage & Baby Tate)',
      [jid],
    )
    const track = searchedSong(
      's0ng',
      'Surround Sound (feat. 21 Savage & Baby Tate)',
      [jid],
    )

    expect(audioTrackFor(video, [track])).toEqual(Option.some(track))
  })

  test('matches an artist credited through another page by name', () => {
    const video = searchedSong('v1d30', 'Anti-Hero (Official Video)', [
      { maybeId: Option.some('UCvevo'), name: 'Taylor Swift' },
    ])

    expect(audioTrackFor(video, [song])).toEqual(Option.some(song))
  })

  test('matches a video with no artist page on its title alone', () => {
    const video = searchedSong('v1d30', 'Anti-Hero (Lyrics)', [
      { maybeId: Option.none(), name: 'Lyric Vibes' },
    ])

    expect(audioTrackFor(video, [song])).toEqual(Option.some(song))
  })
})

describe('cleanVideoTitle', () => {
  const by = (...names: ReadonlyArray<string>) =>
    names.map(name => ({ maybeId: Option.none(), name }))

  test.each([
    ['Reptilia (Official HD Video)', by('The Strokes'), 'Reptilia'],
    ['Location (Official Video)', by('Khalid'), 'Location'],
    [
      'Pixies - Where Is My Mind? (Official Lyric Video)',
      by('Pixies'),
      'Where Is My Mind?',
    ],
    [
      'HOTEL UGLY - SHUT UP MY MOMS CALLING (Official Music Video)',
      by('Hotel Ugly'),
      'SHUT UP MY MOMS CALLING',
    ],
    [
      'Radiohead - Weird Fishes -  by Tobias Stretch',
      by('Radiohead'),
      'Weird Fishes',
    ],
    ['Geese - Taxes (Official Music Video)', by('Geese'), 'Taxes'],
    ['Mk.gee - I Want (Official Audio)', by('Mk.gee'), 'I Want'],
    ['Selfless (Official Audio)', by('The Strokes'), 'Selfless'],
    ['1979 (Official Music Video)', by('The Smashing Pumpkins'), '1979'],
    ['Galaxy [Official Audio]', by('JID'), 'Galaxy'],
    ['Midnight City (Visualizer)', by('M83'), 'Midnight City'],
    ['Motion Sickness (Lyric Video)', by('Phoebe Bridgers'), 'Motion Sickness'],
    ['Creep [HD]', by('Radiohead'), 'Creep'],
    ['Stars (Audio) (feat. Yasiin Bey)', by('JID'), 'Stars (feat. Yasiin Bey)'],
    [
      'Surround Sound [Official Music ... (feat. 21 Savage & Baby Tate)',
      by('JID'),
      'Surround Sound (feat. 21 Savage & Baby Tate)',
    ],
    [
      'Half Alive (From The Hunger Games: Sunrise on the Reaping - The Album) (Official Music Video)',
      by('Mckenna Grace', 'The Hunger Games'),
      'Half Alive (From The Hunger Games: Sunrise on the Reaping - The Album)',
    ],
    ['AC/DC - Thunderstruck (Official Video)', by('AC/DC'), 'Thunderstruck'],
    [
      'Daft Punk ft. Pharrell Williams - Get Lucky (Official Audio)',
      by('Daft Punk', 'Pharrell Williams'),
      'Get Lucky',
    ],
    [
      'Tyler, The Creator - EARFQUAKE (Official Video)',
      by('Tyler, The Creator'),
      'EARFQUAKE',
    ],
    ['Bad Guy – Billie Eilish', by('Billie Eilish'), 'Bad Guy'],
    [
      'Blinding Lights | Official Music Video',
      by('The Weeknd'),
      'Blinding Lights',
    ],
  ])('cleans %p', (title, artists, expected) => {
    expect(cleanVideoTitle(title, artists)).toBe(expected)
  })

  test.each([
    ['Hold On - Remastered', by('Alabama Shakes')],
    ['Hold On - Remastered 2011', by('The Beatles')],
    ['Song 2 (feat. X)', by('Blur')],
    ['Live at Wembley', by('Queen')],
    ['Bohemian Rhapsody (Live Aid 1985)', by('Queen')],
    ['Get Lucky (Official Remix)', by('Daft Punk')],
    ['Paranoid Android (Live Audio)', by('Radiohead')],
    ['Wish You Were Here (4K Remaster)', by('Pink Floyd')],
    ['Blinding Lights (8D Audio)', by('8D Labs')],
    ['Video Killed the Radio Star', by('The Buggles')],
    ['Stand by Me', by('Ben E. King')],
    ['Where Is My Mind?', by('Pixies')],
    ['Radio - Edit', by('Some Artist')],
    ['Pixies', by('Pixies')],
    ['Re: Stacks', by('Bon Iver')],
    ['Weird Fishes/Arpeggi', by('Radiohead')],
  ])('leaves %p alone', (title, artists) => {
    expect(cleanVideoTitle(title, artists)).toBe(title)
  })

  test('keeps a title that is all video words', () => {
    expect(cleanVideoTitle('(Official Video)', by('Someone'))).toBe(
      '(Official Video)',
    )
  })

  test('collapses doubled spaces', () => {
    expect(cleanVideoTitle('Weird  Fishes  (Official Video)', by('X'))).toBe(
      'Weird Fishes',
    )
  })
})

describe('audioTrackQuery', () => {
  test('searches the first artist and the title without brackets', () => {
    expect(
      audioTrackQuery(
        searchedSong(
          'v1d30',
          'Taylor Swift - Anti-Hero (Official Music Video)',
          [taylorSwift],
        ),
      ),
    ).toBe('Taylor Swift Anti-Hero')
    expect(
      audioTrackQuery(
        searchedSong('v1d30', 'Surround Sound [Official Music ... (feat. X)', [
          { maybeId: Option.none(), name: 'JID' },
        ]),
      ),
    ).toBe('JID Surround Sound')
  })

  test('keeps a title that is all brackets', () => {
    expect(audioTrackQuery(searchedSong('v1d30', '[untitled]', []))).toBe(
      '[untitled]',
    )
  })
})

describe('musicVideoIds', () => {
  const watchRun = (videoId: string, musicVideoType: string) => ({
    text: videoId,
    navigationEndpoint: {
      watchEndpoint: {
        videoId,
        watchEndpointMusicSupportedConfigs: {
          watchEndpointMusicConfig: { musicVideoType },
        },
      },
    },
  })

  const row = (videoId: string, musicVideoType: string) =>
    new YTNodes.MusicResponsiveListItem({
      playlistItemData: { videoId },
      flexColumns: [
        column([watchRun(videoId, musicVideoType)]),
        column([{ text: 'An Artist' }]),
      ],
    })

  const queued = (videoId: string, musicVideoType: string) =>
    new YTNodes.PlaylistPanelVideo({
      title: { runs: [{ text: videoId }] },
      videoId,
      lengthText: { runs: [{ text: '3:00' }] },
      shortBylineText: { runs: [] },
      longBylineText: { runs: [] },
      thumbnail: { thumbnails: [] },
      navigationEndpoint: watchRun(videoId, musicVideoType).navigationEndpoint,
    })

  test('finds the official and uploaded videos among rows and a queue', () => {
    expect(
      musicVideoIds([
        row('song', 'MUSIC_VIDEO_TYPE_ATV'),
        row('official', 'MUSIC_VIDEO_TYPE_OMV'),
        queued('queuedSong', 'MUSIC_VIDEO_TYPE_ATV'),
        queued('upload', 'MUSIC_VIDEO_TYPE_UGC'),
        queued('podcast', 'MUSIC_VIDEO_TYPE_PODCAST_EPISODE'),
      ]),
    ).toEqual(new Set(['official', 'upload']))
  })
})

describe('rankSongsForQuery', () => {
  const daftPunk = { maybeId: Option.some('UCdp'), name: 'Daft Punk' }
  const remix = searchedSong('r', 'Life Is Sweet (Daft Punk Remix)', [
    { maybeId: Option.some('UCcb'), name: 'The Chemical Brothers' },
  ])
  const theWeeknd = { maybeId: Option.some('UCw'), name: 'The Weeknd' }
  const starboy = searchedSong('s', 'Starboy', [theWeeknd, daftPunk])
  const veridis = searchedSong('v', 'Veridis Quo', [daftPunk])
  const alive = searchedSong('a', 'Alive', [daftPunk])

  test('puts the artist searched for first, then their features, then mentions', () => {
    expect(
      rankSongsForQuery('daft punk', [remix, starboy, veridis, alive]).map(
        ({ videoId }) => videoId,
      ),
    ).toEqual(['v', 'a', 's', 'r'])
  })

  test('keeps YouTube’s order when the search names no artist', () => {
    expect(
      rankSongsForQuery('alive', [starboy, veridis, alive]).map(
        ({ videoId }) => videoId,
      ),
    ).toEqual(['s', 'v', 'a'])
  })

  test('keeps a remix where it is when the search asks for one', () => {
    expect(
      rankSongsForQuery('life is sweet remix', [remix, veridis]).map(
        ({ videoId }) => videoId,
      ),
    ).toEqual(['r', 'v'])
  })

  test('knows an artist by name with a song, and past case and punctuation', () => {
    expect(searchNamesArtist('daft punk get lucky', daftPunk)).toBe(true)
    expect(searchNamesArtist('get lucky daft punk', daftPunk)).toBe(true)
    expect(searchNamesArtist('DAFTPUNK', daftPunk)).toBe(true)
    expect(
      searchNamesArtist('acdc', { maybeId: Option.none(), name: 'AC/DC' }),
    ).toBe(true)
    expect(
      searchNamesArtist('beyonce', { maybeId: Option.none(), name: 'Beyoncé' }),
    ).toBe(true)
    expect(searchNamesArtist('daft punk remix', theWeeknd)).toBe(false)
    expect(searchNamesArtist('daft punks', daftPunk)).toBe(false)
  })
})

describe('rankSongsForQuery with a top song', () => {
  const weeknd = { maybeId: Option.some('UCweeknd'), name: 'The Weeknd' }
  const song = (
    videoId: string,
    title: string,
    artist: string,
    album: string,
  ): Song => ({
    videoId,
    title,
    artists: [{ maybeId: Option.some(`UC${artist}`), name: artist }],
    maybeAlbum: Option.some({ id: `MPREb_${videoId}`, name: album }),
    maybeDurationSeconds: Option.some(200),
    artwork: [],
  })
  const original: Song = {
    ...song('J7p4bzqLvCw', 'Blinding Lights', 'x', 'Blinding Lights'),
    artists: [weeknd],
  }
  // YouTube Music's song search for "blinding lights", in its order.
  const searched: ReadonlyArray<Song> = [
    original,
    song(
      'MomOlmprVO8',
      'Blinded by the Lights (Nero Remix)',
      'The Streets',
      'Remixes & B-Sides Too',
    ),
    song('a4bFefGrMwg', 'Blinding Lights', 'Leo', 'Leo Metal Covers Volume 28'),
    song('_X9NOlZbiKA', 'Blinding Lights', 'EV', 'Blinding Lights'),
    song(
      '70pqakiB2OY',
      'Blinding Lights (Afro House)',
      'Sunrize',
      'Blinding Lights (Afro House)',
    ),
    song(
      'Rzk3x3HZbJI',
      'Blinded By The Light',
      "Manfred Mann's Earth Band",
      'Best Of Vol 1',
    ),
    song(
      'ATiXC08Omw0',
      'Blinding Lights (vocal)',
      'Party Tyme',
      'Pop Male Hits 2019, Vol. 1 (vocal)',
    ),
    song(
      '86nbCFXnDXk',
      'Blinding Lights (8D Audio)',
      '8D Labs',
      'Blinding Lights (8D Audio)',
    ),
    song(
      'Wlk8NoeMfGY',
      'Blinding Lights | Emotional Deep',
      'ELARIS',
      'Blinding Lights | Emotional Deep',
    ),
  ]
  const saveYourTears: Song = {
    ...song('RmYCOm4ehKs', 'Save Your Tears', 'x', 'After Hours'),
    artists: [weeknd],
  }
  const albumCut: Song = { ...original, videoId: 'otherCut' }
  const top = {
    song: { ...original, videoId: '4NRXx6U8ABQ', title: 'Blinding Lights' },
    artistSongs: [albumCut, saveYourTears],
  }

  const ids = (songs: ReadonlyArray<Song>) =>
    songs.map(({ videoId }) => videoId)

  test('lists the artist, their hits, and other songs before covers and remixes', () => {
    expect(
      ids(rankSongsForQuery('blinding lights', searched, Option.some(top))),
    ).toEqual([
      'J7p4bzqLvCw',
      'RmYCOm4ehKs',
      'Rzk3x3HZbJI',
      'MomOlmprVO8',
      'a4bFefGrMwg',
      '_X9NOlZbiKA',
      '70pqakiB2OY',
      'ATiXC08Omw0',
      '86nbCFXnDXk',
      'Wlk8NoeMfGY',
    ])
  })

  test('keeps covers in YouTube’s order when the search asks for one', () => {
    expect(
      ids(
        rankSongsForQuery(
          'blinding lights metal cover',
          searched,
          Option.some({ ...top, artistSongs: [] }),
        ),
      ),
    ).toEqual(ids(searched))
  })

  test("keeps an artist's own version of their song", () => {
    const taylor = { maybeId: Option.some('UCtaylor'), name: 'Taylor Swift' }
    const theirs: Song = {
      ...song(
        'tv',
        'Love Story (Taylor’s Version)',
        'x',
        'Fearless (Taylor’s Version)',
      ),
      artists: [taylor],
    }
    const karaoke = song(
      'k',
      'Love Story (Karaoke Version)',
      'Sing King',
      'Karaoke Hits',
    )
    expect(
      ids(
        rankSongsForQuery(
          'love story',
          [karaoke, theirs],
          Option.some({ song: theirs, artistSongs: [] }),
        ),
      ),
    ).toEqual(['tv', 'k'])
  })
})

describe('songFromPlaylistPanelVideo', () => {
  const panelVideo = (bylineRuns: ReadonlyArray<object>, shortByline: string) =>
    new YTNodes.PlaylistPanelVideo({
      title: { runs: [{ text: 'Instant Crush' }] },
      videoId: 'bkx54KWeP9A',
      lengthText: { runs: [{ text: '2:48' }] },
      shortBylineText: { runs: [{ text: shortByline }] },
      longBylineText: { runs: bylineRuns },
      thumbnail: { thumbnails: [] },
      navigationEndpoint: {},
    })

  const albumRun = {
    text: 'Instant Crush',
    navigationEndpoint: browseTo('MPREb_C3ULAN2cvXy', 'MUSIC_PAGE_TYPE_ALBUM'),
  }

  test('keeps an artist with no artist page, named only in the byline', () => {
    const song = Option.getOrThrow(
      songFromPlaylistPanelVideo(
        panelVideo(
          [
            { text: 'Ruben Dunn' },
            SEPARATOR,
            albumRun,
            SEPARATOR,
            { text: '2022' },
          ],
          'Ruben Dunn',
        ),
      ),
    )

    expect(song.artists).toEqual([
      { maybeId: Option.none(), name: 'Ruben Dunn' },
    ])
    expect(song.maybeAlbum).toEqual(
      Option.some({ id: 'MPREb_C3ULAN2cvXy', name: 'Instant Crush' }),
    )
    expect(song.maybeDurationSeconds).toEqual(Option.some(168))
  })

  test('links the artists that have a page', () => {
    const song = Option.getOrThrow(
      songFromPlaylistPanelVideo(
        panelVideo(
          [
            artistRun('Daft Punk', 'UCdp'),
            { text: ' & ' },
            artistRun('Julian Casablancas', 'UCjc'),
            SEPARATOR,
            albumRun,
          ],
          'Daft Punk & Julian Casablancas',
        ),
      ),
    )

    expect(song.artists).toEqual([
      { maybeId: Option.some('UCdp'), name: 'Daft Punk' },
      { maybeId: Option.some('UCjc'), name: 'Julian Casablancas' },
    ])
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

describe('radios', () => {
  const watch = (payload: object) =>
    new YTNodes.NavigationEndpoint({ watchEndpoint: payload })

  test("an artist's Radio button starts the artist's radio", () => {
    expect(
      radioOf(
        watch({
          videoId: 'r7mN9BLr4jU',
          playlistId: 'RDEMk8jEIzOyB2trfXZrSEVz_Q',
          params: 'wAEB',
        }),
      ),
    ).toEqual(
      Option.some({
        playlistId: 'RDEMk8jEIzOyB2trfXZrSEVz_Q',
        maybeParams: Option.some('wAEB'),
        maybeVideoId: Option.some('r7mN9BLr4jU'),
      }),
    )
  })

  test('playing the songs themselves is no radio', () => {
    expect(radioOf(watch({ playlistId: 'OLAK5uy_album' }))).toEqual(
      Option.none(),
    )
    expect(radioOf(undefined)).toEqual(Option.none())
  })

  const menuItem = (text: string, payload: object) => ({
    menuNavigationItemRenderer: {
      text: { runs: [{ text }] },
      navigationEndpoint: { watchEndpoint: payload },
    },
  })

  test("an album's radio is the Start mix in its menu", () => {
    const menu = new YTNodes.Menu({
      items: [
        menuItem('Shuffle play', {
          playlistId: 'OLAK5uy_album',
          params: 'wAEB8gECKAE%3D',
        }),
        menuItem('Start mix', {
          playlistId: 'RDAMPLOLAK5uy_album',
          params: 'wAEB',
        }),
      ],
    })
    expect(albumRadio([menu])).toEqual(
      Option.some({
        playlistId: 'RDAMPLOLAK5uy_album',
        maybeParams: Option.some('wAEB'),
        maybeVideoId: Option.none(),
      }),
    )
  })

  test('an album with no mix in its menu has no radio', () => {
    const menu = new YTNodes.Menu({
      items: [menuItem('Shuffle play', { playlistId: 'OLAK5uy_album' })],
    })
    expect(albumRadio([menu])).toEqual(Option.none())
    expect(albumRadio([])).toEqual(Option.none())
  })
})

// SEARCH FILTERS
// The examples are what YouTube Music answered for these searches.

const artistNamed = (
  id: string,
  name: string,
  audience: string | undefined,
): ArtistSummary => ({
  id,
  name,
  maybeAudience: Option.fromNullishOr(audience),
  artwork: [],
})

const watchOfType = (videoId: string, musicVideoType: string) => ({
  watchEndpoint: {
    videoId,
    watchEndpointMusicSupportedConfigs: {
      watchEndpointMusicConfig: { musicVideoType },
    },
  },
})

const track = (
  videoId: string,
  title: string,
  artist: string,
  seconds: number,
): Song => ({
  videoId,
  title,
  artists: [{ maybeId: Option.some(`UC${artist}`), name: artist }],
  maybeAlbum: Option.some({ id: `MPREb_${videoId}`, name: title }),
  maybeDurationSeconds: Option.some(seconds),
  artwork: [],
})

const videoIdsOf = (songs: ReadonlyArray<Song>) =>
  songs.map(({ videoId }) => videoId)

describe('counts', () => {
  test('reads audiences, subscribers, and views', () => {
    expect(countFromText('66.1M monthly audience')).toEqual(
      Option.some(66_100_000),
    )
    expect(countFromText('9.93K subscribers')).toEqual(Option.some(9930))
    expect(countFromText('2 subscribers')).toEqual(Option.some(2))
    expect(countFromText('1,234 views')).toEqual(Option.some(1234))
    expect(countFromText('Artist')).toEqual(Option.none())
  })
})

describe('song search filters', () => {
  // "lofi"
  const loveInYourEyes = track('Ib91lUpV7EM', 'Love In Your Eyes', 'Lee', 231)
  const threeHours = track(
    'kAw9xGI8vgk',
    '3 Hours of Chill Lofi Music for DEEP Sleep or Study Session',
    'Lumosound',
    10_800,
  )
  const oneHour: Song = {
    ...track(
      '1N8hOpMqvYs',
      'Lofi Rain Chill Beats for Sleep, Study & Relax (1 Hour)',
      'Zyra Music',
      0,
    ),
    maybeDurationSeconds: Option.none(),
  }
  const twoHours = track(
    'iP3IfBeJ3DA',
    '2 hours - Best of lofi hip hop (beats to chill/relax/study to)',
    'Lofi Noodle',
    7200,
  )
  const longJam = track('dope', 'Dopesmoker', 'Sleep', 3800)
  const searched = [oneHour, loveInYourEyes, threeHours, twoHours, longJam]

  test('leaves out hours-long uploads and tracks over 15 minutes', () => {
    expect(videoIdsOf(rankSongsForQuery('lofi', searched))).toEqual([
      'Ib91lUpV7EM',
    ])
  })

  test('keeps them when the search asks for them or names the track', () => {
    expect(videoIdsOf(rankSongsForQuery('lofi 1 hour', searched))).toEqual(
      videoIdsOf(searched),
    )
    expect(videoIdsOf(rankSongsForQuery('dopesmoker', [longJam]))).toEqual([
      'dope',
    ])
  })
})

describe('chooseTopResult', () => {
  // "godspeed you! black emperor": a fan's upload of a whole album.
  const fullAlbumCard = card(
    'Godspeed You! Black Emperor - F# A# ∞ (Full Album) [1080p]',
    watchOfType('wy4IsC5eb7o', 'MUSIC_VIDEO_TYPE_UGC'),
    [
      { text: 'Video' },
      SEPARATOR,
      { text: 'Risenz' },
      SEPARATOR,
      { text: '2M views' },
      SEPARATOR,
      { text: '1:03:29' },
    ],
  )

  test('never shows a whole album uploaded as one video', () => {
    const topCard = topCardFrom(fullAlbumCard)
    expect(Option.map(topCard, ({ isUpload }) => isUpload)).toEqual(
      Option.some(true),
    )
    const efrim = artistNamed(
      'UCxlD4g6jAzebNzgh9clfONw',
      'Efrim Manuel Menuck',
      '443 subscribers',
    )
    expect(
      chooseTopResult('godspeed you! black emperor', topCard, [], [efrim]),
    ).toEqual(Option.none())
  })

  test('takes off the brackets that name a video quality', () => {
    expect(cleanVideoTitle('Song [1080p] (HQ)', [])).toBe('Song')
  })

  test('keeps an official music video, as its song', () => {
    const humble = card(
      'HUMBLE.',
      watchOfType('tvTRZJ-4EyI', 'MUSIC_VIDEO_TYPE_OMV'),
      [
        { text: 'Video' },
        SEPARATOR,
        artistRun('Kendrick Lamar', 'UCkendrick'),
        SEPARATOR,
        { text: '1.1B views' },
        SEPARATOR,
        { text: '3:04' },
      ],
    )
    const audio: Song = {
      ...track('ox7RsX1Ee34', 'HUMBLE.', 'Kendrick Lamar', 177),
      artists: [{ maybeId: Option.some('UCkendrick'), name: 'Kendrick Lamar' }],
    }
    const result = chooseTopResult(
      'kendrick lamar humble',
      topCardFrom(humble),
      [audio],
      [],
    )
    expect(
      Option.map(result, topResult =>
        topResult._tag === 'Song' ? topResult.song.videoId : topResult._tag,
      ),
    ).toEqual(Option.some('ox7RsX1Ee34'))
  })

  test('puts the artist the search names first, past its punctuation', () => {
    const playlistCard = card(
      'Daft Punk Best Of',
      browseTo('VLPLdaft', 'MUSIC_PAGE_TYPE_PLAYLIST'),
      [{ text: 'Playlist' }, SEPARATOR, { text: 'Someone' }],
    )
    const daftPunk = artistNamed(
      'UCRr1xG_2WIDs18a6cIiCxeA',
      'Daft Punk',
      '66.1M monthly audience',
    )
    expect(
      chooseTopResult('daft-punk', topCardFrom(playlistCard), [], [daftPunk]),
    ).toEqual(Option.some({ _tag: 'Artist', artist: daftPunk, topSongs: [] }))
  })

  test('keeps a card named exactly what was searched for', () => {
    const songCard = card('Humble', watchOfType('h', 'MUSIC_VIDEO_TYPE_ATV'), [
      { text: 'Song' },
      SEPARATOR,
      artistRun('Kendrick Lamar', 'UCk'),
    ])
    const namesake = artistNamed('UCh', 'Humble', '20K monthly audience')
    expect(
      Option.map(
        chooseTopResult('humble', topCardFrom(songCard), [], [namesake]),
        ({ _tag }) => _tag,
      ),
    ).toEqual(Option.some('Song'))
  })

  test('never makes an artist hardly anyone follows the top result', () => {
    const daft = artistNamed(
      'UC13jQSj755i1s6D6MDEt2sw',
      'Daft',
      '2 subscribers',
    )
    expect(chooseTopResult('daft', Option.none(), [], [daft])).toEqual(
      Option.none(),
    )
  })
})

describe('rankArtistsForQuery', () => {
  // "daft", in YouTube Music's order.
  const daftPunk = artistNamed('UCdp', 'Daft Punk', '66.1M monthly audience')
  const weeknd = artistNamed('UCw', 'The Weeknd', '236M monthly audience')
  const echoDaft = artistNamed('UCed', 'Echo Daft', '108K monthly audience')
  const poets = artistNamed('UCps', 'Daft Poets Society', '360 subscribers')
  const daft = artistNamed('UCd', 'Daft', '2 subscribers')
  const daftFunk = artistNamed('UCdf', 'DAFT FUNK', undefined)
  const ids = (artists: ReadonlyArray<ArtistSummary>) =>
    artists.map(({ id }) => id)

  test('hides artists with tiny audiences once a known one matches', () => {
    expect(
      ids(
        rankArtistsForQuery('daft', [
          daftPunk,
          weeknd,
          echoDaft,
          poets,
          daft,
          daftFunk,
        ]),
      ),
    ).toEqual(['UCdp', 'UCw', 'UCed'])
  })

  test('keeps unknown artists when nobody known has the name', () => {
    const efrim = artistNamed('UCe', 'Efrim Manuel Menuck', '443 subscribers')
    expect(
      ids(rankArtistsForQuery('godspeed you! black emperor', [efrim])),
    ).toEqual(['UCe'])
  })

  test('puts the artist named exactly first, past accents and "&"', () => {
    const tribute = artistNamed(
      'UCt',
      'Beyoncé Tribute Band',
      '12K subscribers',
    )
    const beyonce = artistNamed('UCb', 'Beyoncé', '80M monthly audience')
    expect(ids(rankArtistsForQuery('beyonce', [tribute, beyonce]))).toEqual([
      'UCb',
      'UCt',
    ])
    const simon = artistNamed(
      'UCsg',
      'Simon & Garfunkel',
      '10M monthly audience',
    )
    expect(
      ids(rankArtistsForQuery('simon garfunkel', [tribute, simon])),
    ).toEqual(['UCsg', 'UCt'])
  })
})

describe('filterAlbumsForQuery', () => {
  const album = (
    id: string,
    title: string,
    artist: string,
    kind: 'Album' | 'Single' | 'EP',
  ): AlbumSummary => ({
    id,
    title,
    artists: [{ maybeId: Option.some(`UC${artist}`), name: artist }],
    maybeKind: Option.some(kind),
    maybeYear: Option.some('2017'),
    artwork: [],
  })
  const ids = (albums: ReadonlyArray<AlbumSummary>) =>
    albums.map(({ id }) => id)
  // "kendrick lamar humble", in YouTube Music's order.
  const kendrickAlbums: ReadonlyArray<AlbumSummary> = [
    album('MPREb_4bCz6FCRC8M', 'DAMN.', 'Kendrick Lamar', 'Album'),
    album(
      'MPREb_VJRBqB1bxWu',
      'Humble (Homage to Kendrick Lamar)',
      'Barberry Records',
      'Single',
    ),
    album(
      'MPREb_KzByWmaSfph',
      'HUMBLE. - Tribute to Kendrick Lamar',
      '2017 Billboard Masters',
      'Single',
    ),
    {
      ...album(
        'MPREb_cwCbbLs5QCI',
        'HUMBLE. (SKRILLEX REMIX)',
        'Skrillex',
        'Single',
      ),
      artists: [
        { maybeId: Option.some('UCSkrillex'), name: 'Skrillex' },
        { maybeId: Option.some('UCKendrick Lamar'), name: 'Kendrick Lamar' },
      ],
    },
    album(
      'MPREb_GL8G80mHirW',
      'HUMBLE. (Karaoke Version) (Originally Performed by Kendrick Lamar)',
      'Sing2Piano',
      'Single',
    ),
    album(
      'MPREb_0Omhi9wUmdh',
      'Unwrapped Vol. 9: The Songs of Kendrick Lamar Reimagined',
      'Unwrapped',
      'Album',
    ),
    album(
      'MPREb_i8lyuFVxNY6',
      'OMA Kendrick Lamar Instrumentals',
      'OMA',
      'Album',
    ),
    album(
      'MPREb_P5INWF4OW5f',
      'THE KENDRICK LAMAR SUITE',
      'Steve Hackman',
      'EP',
    ),
    album('MPREb_wCND3crJyDP', 'GNX', 'Kendrick Lamar', 'Album'),
    album(
      'MPREb_dqblnNqvoLh',
      'Lullaby Versions of Kendrick Lamar',
      'Twinkle Twinkle Little Rock Star',
      'Album',
    ),
    album(
      'MPREb_2dsvr4H0N9F',
      '8-Bit Versions of Kendrick Lamar',
      '8-Bit Misfits',
      'Album',
    ),
  ]

  test('leaves out karaoke, tributes, and releases only named after the artist', () => {
    expect(
      ids(filterAlbumsForQuery('kendrick lamar humble', kendrickAlbums)),
    ).toEqual(['MPREb_4bCz6FCRC8M', 'MPREb_cwCbbLs5QCI', 'MPREb_wCND3crJyDP'])
  })

  test('keeps them all when the search asks for karaoke', () => {
    expect(filterAlbumsForQuery('humble karaoke', kendrickAlbums)).toHaveLength(
      kendrickAlbums.length,
    )
  })

  test("leaves out other artists' singles of the top result's song", () => {
    const weeknd = { maybeId: Option.some('UCweeknd'), name: 'The Weeknd' }
    const top: Song = {
      ...track('J7p4bzqLvCw', 'Blinding Lights', 'x', 200),
      artists: [weeknd],
    }
    // "blinding lights"
    const albums = [
      album('MPREb_dmpixSPWaXE', 'Blinding Lights', 'From Sky', 'Single'),
      album(
        'MPREb_9A73CR2XTAI',
        'Blinding Lights (Acoustic)',
        'Matt',
        'Single',
      ),
      album('MPREb_fu30JGhLsTj', 'Blinding Light', 'ZERUSH', 'Single'),
      album('MPREb_cl1okiG5fYY', 'City Of Blinding Lights', 'U2', 'EP'),
      album('MPREb_yGYYRy3jZpO', 'Blinding Lights', 'Sky Monkey', 'Album'),
    ]
    expect(
      ids(
        filterAlbumsForQuery('blinding lights', albums, {
          maybeTopResult: Option.some({ _tag: 'Song', song: top }),
          artists: [],
        }),
      ),
    ).toEqual(['MPREb_cl1okiG5fYY', 'MPREb_yGYYRy3jZpO'])
  })
})

describe('filterPlaylistsForQuery', () => {
  const playlist = (
    id: string,
    title: string,
    subtitle: string,
  ): PlaylistSummary => ({
    id,
    title,
    maybeSubtitle: Option.some(subtitle),
    artwork: [],
  })
  // "blinding lig", in YouTube Music's order.
  const playlists = [
    playlist(
      'VLPLa',
      'The weeknd starboy blinding light',
      'Robin Romero · 23 views',
    ),
    playlist('VLPLb', 'Blinding light', 'Candie Schane · 1.9K views'),
    playlist('VLPLc', 'Blinding Light', 'Vanyacha · 3.1K views'),
    playlist('VLPLd', 'blinding light', 'Wayne Martorano · 25 songs'),
    playlist('VLPLe', 'Pop Karaoke Hits', 'Sing King · 2M views'),
  ]

  test('leaves out playlists hardly anyone played, and karaoke', () => {
    // "blinding light · 25 songs" shows its songs where a played playlist
    // shows its views: YouTube shows no views for it.
    expect(
      filterPlaylistsForQuery('blinding lig', playlists).map(({ id }) => id),
    ).toEqual(['VLPLb', 'VLPLc'])
  })
})

// SEARCH QUALITY: real results from YouTube Music, in its order.

const link = (name: string, id = `UC${name}`): ArtistLink => ({
  maybeId: Option.some(id),
  name,
})

const release = (
  id: string,
  title: string,
  artist: string,
  kind: 'Album' | 'Single' | 'EP',
): AlbumSummary => ({
  id,
  title,
  artists: [link(artist)],
  maybeKind: Option.some(kind),
  maybeYear: Option.none(),
  artwork: [],
})

const listedPlaylist = (
  id: string,
  title: string,
  subtitle: string,
): PlaylistSummary => ({
  id,
  title,
  maybeSubtitle: Option.some(subtitle),
  artwork: [],
})

const idsOf = (items: ReadonlyArray<{ readonly id: string }>) =>
  items.map(({ id }) => id)

const artistTop = (artist: ArtistSummary): Option.Option<TopResult> =>
  Option.some({ _tag: 'Artist', artist, topSongs: [] })

const songTop = (song: Song): Option.Option<TopResult> =>
  Option.some({ _tag: 'Song', song })

// "bohemian rhapsody": the top result is Queen's song.
const queenArtist = artistNamed('UCQueen', 'Queen', '119M monthly audience')
const queensRhapsody: Song = {
  ...track('fJ9rUzIMcZQ', 'Bohemian Rhapsody', 'Queen', 355),
  maybeAlbum: Option.some({
    id: 'MPREb_eEpQf8QskKl',
    name: 'A Night At The Opera',
  }),
}
const rhapsodyArtists = [
  queenArtist,
  artistNamed('UCPanic', 'Panic! At The Disco', '211M monthly audience'),
  artistNamed('UCFreddie', 'Freddie Mercury', '8.55M monthly audience'),
  artistNamed('UCBohemian Rhapsody', 'Bohemian Rhapsody', '689 subscribers'),
  artistNamed('UCMarc', 'Marc Martel', '420K monthly audience'),
  artistNamed('UCBrian', 'Brian May', '639K monthly audience'),
  artistNamed('UCAngelina', 'Angelina Jordan', '532K monthly audience'),
  artistNamed('UCThomas', 'Thomas Crane', undefined),
]
const rhapsodyFocus = {
  maybeTopResult: songTop(queensRhapsody),
  artists: rhapsodyArtists,
}

// "kendrick": the top result is Kendrick Lamar.
const kendrickArtist = artistNamed(
  'UCKendrick Lamar',
  'Kendrick Lamar',
  '132M monthly audience',
)
const kendrickArtists = [
  kendrickArtist,
  artistNamed('UCJ. Cole', 'J. Cole', '107M monthly audience'),
  artistNamed('UCSZA', 'SZA', '104M monthly audience'),
  artistNamed('UCKendrick', 'Kendrick', '33 subscribers'),
  artistNamed('UCAnna Kendrick', 'Anna Kendrick', '113K subscribers'),
  artistNamed('UCEl Kendrick', 'El Kendrick', '202 subscribers'),
]
const kendrickFocus = {
  maybeTopResult: artistTop(kendrickArtist),
  artists: kendrickArtists,
}

// "daft": the top result is Daft Punk.
const daftPunkArtist = artistNamed(
  'UCDaft Punk',
  'Daft Punk',
  '66.1M monthly audience',
)
const daftArtists = [
  daftPunkArtist,
  artistNamed('UCThe Weeknd', 'The Weeknd', '236M monthly audience'),
  artistNamed('UCEcho Daft', 'Echo Daft', '108K monthly audience'),
  artistNamed('UCPharrell', 'Pharrell', '82.3M monthly audience'),
  artistNamed('UCDaft', 'Daft', '2 subscribers'),
  artistNamed('UCDaft Funk', 'Daft Funk', '86 subscribers'),
]
const daftFocus = {
  maybeTopResult: artistTop(daftPunkArtist),
  artists: daftArtists,
}

// "geese": the top result is Geese.
const geeseArtist = artistNamed('UCGeese', 'Geese', '416K monthly audience')
const geeseFocus = {
  maybeTopResult: artistTop(geeseArtist),
  artists: [
    geeseArtist,
    artistNamed('UCGoofy Geese', 'Goofy Geese', '1.01K subscribers'),
    artistNamed('UCEmpire of Geese', 'Empire of Geese', '190 subscribers'),
    artistNamed('UCThe Silly Geese', 'The Silly Geese', '4 subscribers'),
  ],
}

// "taylor swift": the top result is Taylor Swift.
const taylorArtist = artistNamed(
  'UCTaylor Swift',
  'Taylor Swift',
  '408M monthly audience',
)
const taylorFocus = {
  maybeTopResult: artistTop(taylorArtist),
  artists: [
    taylorArtist,
    artistNamed('UCSabrina', 'Sabrina Carpenter', '158M monthly audience'),
    artistNamed('UCGracie', 'Gracie Abrams', '75.9M monthly audience'),
  ],
}

describe('mashups in a song search', () => {
  const lso = searchedSong('lso', 'Bohemian Rhapsody', [
    link('London Symphony Orchestra'),
  ])
  const lips = searchedSong('lips', 'Bohemian Rhapsody', [
    link('The Flaming Lips'),
  ])
  const mashup = searchedSong('mash', 'Bohemian Rhapsody x Walk It Talk It', [
    link('nimphia'),
    link('klyron'),
  ])
  const ukulele = searchedSong('uke', 'Bohemian Rhapsody', [
    link('Jake Shimabukuro'),
  ])
  const searched = [queensRhapsody, lso, lips, mashup, ukulele]
  const top = Option.some({ song: queensRhapsody, artistSongs: [] })

  test('puts another artist’s "A x B" mashup after even the covers', () => {
    expect(
      videoIdsOf(rankSongsForQuery('bohemian rhapsody', searched, top)),
    ).toEqual(['fJ9rUzIMcZQ', 'lso', 'lips', 'uke', 'mash'])
  })

  test('keeps it in place when the search asks for it', () => {
    expect(
      videoIdsOf(
        rankSongsForQuery('bohemian rhapsody x walk it talk it', searched),
      ),
    ).toEqual(videoIdsOf(searched))
  })

  test('knows "x" at the end, "vs", and medleys, but not "Malcolm X"', () => {
    const humble = searchedSong('humble', 'HUMBLE.', [link('Kendrick Lamar')])
    const zelda = searchedSong('zelda', 'Did you hear that? Zelda x', [
      link('Unjaps'),
    ])
    const versus = searchedSong('vs', 'Not Like Us vs Family Matters', [
      link('DJ Edit'),
    ])
    const medley = searchedSong('medley', 'Kendrick Medley', [link('Pianist')])
    const malcolm = searchedSong(
      'malcolm',
      'Malcolm X (feat. Kendrick Lamar)',
      [link('EastSide K-Boy')],
    )
    const feature = searchedSong('feat', 'Song (feat. A x B)', [link('C')])
    expect(
      videoIdsOf(
        rankSongsForQuery('kendrick', [
          zelda,
          versus,
          humble,
          medley,
          malcolm,
          feature,
        ]),
      ),
    ).toEqual(['humble', 'malcolm', 'feat', 'zelda', 'vs', 'medley'])
  })

  test('keeps the artist’s own song that has an "x" in it', () => {
    const own = searchedSong('own', 'Song x Song', [link('Kendrick Lamar')])
    const other = searchedSong('other', 'Alright', [link('Someone')])
    expect(
      videoIdsOf(rankSongsForQuery('kendrick lamar', [other, own])),
    ).toEqual(['own', 'other'])
  })
})

describe('an artist card against a small namesake', () => {
  const kendrickCard = topCardFrom(
    card('Kendrick Lamar', browseTo('UCprAF', 'MUSIC_PAGE_TYPE_ARTIST'), [
      { text: 'Artist' },
      SEPARATOR,
      { text: '132M monthly audience' },
    ]),
  )
  const namesake = artistNamed('UCKendrick', 'Kendrick', '1.76K subscribers')

  test('keeps YouTube Music’s artist when it has the bigger audience', () => {
    expect(
      Option.map(
        chooseTopResult('kendrick', kendrickCard, [], [namesake]),
        topResult =>
          topResult._tag === 'Artist' ? topResult.artist.id : topResult._tag,
      ),
    ).toEqual(Option.some('UCprAF'))
  })

  test('lists the top result’s artist before the namesake', () => {
    expect(
      idsOf(
        filterArtistsForQuery(
          'kendrick',
          [namesake, ...kendrickArtists],
          kendrickFocus,
        ),
      ),
    ).toEqual(['UCKendrick Lamar', 'UCKendrick', 'UCAnna Kendrick'])
  })
})

describe('filterArtistsForQuery', () => {
  test('lists the top song’s artist, not artists named like the song', () => {
    expect(
      idsOf(
        filterArtistsForQuery(
          'bohemian rhapsody',
          rhapsodyArtists,
          rhapsodyFocus,
        ),
      ),
    ).toEqual(['UCQueen'])
  })

  test('lists artists whose names fit, not related ones', () => {
    expect(
      idsOf(filterArtistsForQuery('kendrick', kendrickArtists, kendrickFocus)),
    ).toEqual(['UCKendrick Lamar', 'UCAnna Kendrick'])
    expect(
      idsOf(filterArtistsForQuery('daft', daftArtists, daftFocus)),
    ).toEqual(['UCDaft Punk', 'UCEcho Daft'])
    expect(
      idsOf(
        filterArtistsForQuery('taylor swift', taylorFocus.artists, taylorFocus),
      ),
    ).toEqual(['UCTaylor Swift'])
  })

  test('knows a name typed partway, and one with a song after it', () => {
    expect(
      idsOf(filterArtistsForQuery('daft pu', daftArtists, NO_FOCUS)),
    ).toEqual(['UCDaft Punk'])
    expect(
      idsOf(
        filterArtistsForQuery('daft punk get lucky', daftArtists, NO_FOCUS),
      ),
    ).toEqual(['UCDaft Punk'])
  })

  test('keeps an unknown artist when no known one fits', () => {
    const efrim = artistNamed('UCe', 'Efrim Manuel Menuck', '443 subscribers')
    const gybe = artistNamed('UCg', 'Godspeed You! Black Emperor', undefined)
    expect(
      idsOf(
        filterArtistsForQuery(
          'godspeed you! black emperor',
          [efrim, gybe],
          NO_FOCUS,
        ),
      ),
    ).toEqual(['UCg'])
  })
})

describe('albums in a search', () => {
  test('keeps the top song’s soundtrack past an unknown namesake artist', () => {
    const albums = [
      release(
        'MPREb_ost',
        'Bohemian Rhapsody (The Original Soundtrack)',
        'Queen',
        'Album',
      ),
      release('MPREb_bence', 'Bohemian Rhapsody', 'Peter Bence', 'Single'),
      release(
        'MPREb_piano',
        'Bohemian Rhapsody (Piano Version)',
        'Bohemian Rhapsody',
        'Single',
      ),
      release(
        'MPREb_karaoke',
        'Bohemian Rhapsody (In the Style of Queen) [Karaoke Version]',
        'ProSource Karaoke',
        'Single',
      ),
    ]
    expect(
      idsOf(filterAlbumsForQuery('bohemian rhapsody', albums, rhapsodyFocus)),
    ).toEqual(['MPREb_ost'])
  })

  test('puts the top song’s own album first, fetched when missing', () => {
    const opera = release(
      'MPREb_eEpQf8QskKl',
      'A Night At The Opera',
      'Queen',
      'Album',
    )
    const ost = release('MPREb_ost', 'Bohemian Rhapsody OST', 'Queen', 'Album')
    expect(topSongAlbumId(rhapsodyFocus)).toEqual(
      Option.some('MPREb_eEpQf8QskKl'),
    )
    expect(
      idsOf(withTopSongAlbum([ost], 'MPREb_eEpQf8QskKl', Option.some(opera))),
    ).toEqual(['MPREb_eEpQf8QskKl', 'MPREb_ost'])
    expect(
      idsOf(withTopSongAlbum([ost, opera], 'MPREb_eEpQf8QskKl', Option.none())),
    ).toEqual(['MPREb_eEpQf8QskKl', 'MPREb_ost'])
    expect(
      idsOf(withTopSongAlbum([ost], 'MPREb_eEpQf8QskKl', Option.none())),
    ).toEqual(['MPREb_ost'])
    expect(topSongAlbumId(kendrickFocus)).toEqual(Option.none())
  })

  test('leaves out other artists’ releases that only have the words', () => {
    const albums = [
      release('MPREb_gnx', 'GNX', 'Kendrick Lamar', 'Album'),
      release(
        'MPREb_sad',
        'Kendrick? Did You Hear That, Kendrick?',
        'Sad Face Prince',
        'Single',
      ),
      release('MPREb_kings', "King's Dead", 'Jay Rock', 'Single'),
      release(
        'MPREb_malcolm',
        'Malcolm X (feat. Kendrick Lamar)',
        'EastSide K-Boy',
        'Single',
      ),
      release('MPREb_jungle', 'Kendrick of the Jungle', 'Kendrick', 'Single'),
      release('MPREb_c', 'Kendrick Lamar', 'The Letter "C"', 'Single'),
    ]
    expect(
      idsOf(filterAlbumsForQuery('kendrick', albums, kendrickFocus)),
    ).toEqual(['MPREb_gnx', 'MPREb_kings', 'MPREb_malcolm'])
  })

  test('keeps Daft Punk’s albums and drops "Daft Funk" and "Daft"', () => {
    const albums = [
      release('MPREb_ram', 'Random Access Memories', 'Daft Punk', 'Album'),
      release('MPREb_funk', 'Daft Funk', 'Kid Brutal', 'EP'),
      release('MPREb_club', 'Daft Club', 'Daft Punk', 'Album'),
      release('MPREb_aon', 'Daft', 'The Art Of Noise', 'Album'),
      release('MPREb_park', 'SOLVELVET- Daft Park', 'SOLVELVET', 'Single'),
      release(
        'MPREb_inspired',
        'Daft Punk-Inspired Neon Mirage Skyline',
        'Dreamline Records',
        'Album',
      ),
      release('MPREb_echo', 'Interstellar', 'Echo Daft', 'Single'),
      release('MPREb_lilacs', "You're Not That Daft", 'The Lilacs', 'Single'),
    ]
    expect(idsOf(filterAlbumsForQuery('daft', albums, daftFocus))).toEqual([
      'MPREb_ram',
      'MPREb_club',
      'MPREb_echo',
    ])
  })

  test('keeps the albums of the artist searched for exactly', () => {
    const albums = [
      release('MPREb_killed', 'Getting Killed', 'Geese', 'Album'),
      release('MPREb_wild', 'Return of the Wild Geese', 'LINA NEU69', 'Single'),
      release('MPREb_geese', 'Geese', 'Armadillo Petting Zoo', 'Album'),
      release('MPREb_ts', 'Taylor Swift', 'Taylor Swift', 'Album'),
    ]
    expect(idsOf(filterAlbumsForQuery('geese', albums, geeseFocus))).toEqual([
      'MPREb_killed',
      'MPREb_ts',
    ])
    expect(
      idsOf(filterAlbumsForQuery('taylor swift', albums, taylorFocus)),
    ).toEqual(['MPREb_killed', 'MPREb_wild', 'MPREb_geese', 'MPREb_ts'])
  })

  test('keeps other artists’ albums named like a search that is no artist', () => {
    const mariah = searchedSong('mariah', 'All I Want for Christmas Is You', [
      link('Mariah Carey'),
    ])
    const albums = [
      release('MPREb_buble', 'Christmas', 'Michael Bublé', 'Album'),
      release('MPREb_merry', 'Merry Christmas', 'Mariah Carey', 'Album'),
    ]
    expect(
      idsOf(
        filterAlbumsForQuery('christmas', albums, {
          maybeTopResult: songTop(mariah),
          artists: [],
        }),
      ),
    ).toEqual(['MPREb_buble', 'MPREb_merry'])
  })
})

describe('playlists in a search', () => {
  test('puts YouTube Music’s first and leaves out concert videos', () => {
    const playlists = [
      listedPlaylist(
        'VLPLtop50',
        'Top 50 Taylor Swift Songs',
        'Batson · 1.6M views',
      ),
      listedPlaylist(
        'VLPLconcert',
        'Taylor Swift - reputation stadium tour (Full Concert)',
        'Swift Leaks 2.0 · 12M views',
      ),
      listedPlaylist(
        'VLPLown',
        'Taylor’s favorites',
        'Taylor Swift · 40 songs',
      ),
      listedPlaylist(
        'VLPLstream',
        'Taylor Swift Live Stream Archive',
        'Someone · 50K views',
      ),
    ]
    const featured = [
      listedPlaylist(
        'VLRDCLAK5uy_presenting',
        'Presenting Taylor Swift',
        'YouTube Music · 126 songs',
      ),
      listedPlaylist(
        'VLRDCLAK5uy_pop',
        'Pop Hits 2025',
        'YouTube Music · 49 songs',
      ),
    ]
    expect(
      idsOf(
        filterPlaylistsForQuery(
          'taylor swift',
          playlists,
          taylorFocus,
          featured,
        ),
      ),
    ).toEqual(['VLRDCLAK5uy_presenting', 'VLPLown', 'VLPLtop50'])
    expect(
      idsOf(
        filterPlaylistsForQuery(
          'taylor swift full concert',
          playlists,
          NO_FOCUS,
        ),
      ),
    ).toEqual(['VLPLconcert'])
  })

  test('keeps titles with the search as a whole word, not Bee Gees or Goose', () => {
    const playlists = [
      listedPlaylist(
        'VLPLempire',
        'Empire of Geese Перезаливы',
        'user687>_< · 49K views',
      ),
      listedPlaylist(
        'VLPLbee',
        'Bee Gees Greatest Hits',
        'brion ace · 15M views',
      ),
      listedPlaylist(
        'VLPLgoose',
        'goose : 20 guns pointing in your face (2005)',
        'ฟังเพลงไทย · 17K views',
      ),
      listedPlaylist('VLPLfew', 'Geese', 'Roger Johnson · 78 views'),
      listedPlaylist('VLPLnew', 'Geese', 'Dimidim · 9 songs'),
      listedPlaylist(
        'VLPLbasement',
        'Geese - From The Basement',
        'ham · 1.9K views',
      ),
    ]
    const featured = [
      listedPlaylist(
        'VLRDCLAK5uy_rhymes',
        'Nursery Rhymes',
        'YouTube Music · 80 songs',
      ),
    ]
    expect(
      idsOf(filterPlaylistsForQuery('geese', playlists, geeseFocus, featured)),
    ).toEqual(['VLPLbasement'])
  })

  test('asks the start of an artist’s name for the artist, without videos', () => {
    const playlists = [
      listedPlaylist(
        'VLPLevery',
        'EVERY DAFT PUNK MUSIC VIDEO 🤖🤖🎬',
        'GotWub · 199K views',
      ),
      listedPlaylist(
        'VLPLbest',
        'Best Of Daft Punk',
        'misterepicpants · 5.9M views',
      ),
      listedPlaylist(
        'VLPLinorder',
        'All Daft Punk Music Videos In Order',
        'RyanIsCool2010 · 2.2K views',
      ),
      listedPlaylist('VLPLcoins', 'Coins - Daft Science', 'DJ TGS · 56K views'),
      listedPlaylist(
        'VLPLslowed',
        'Daft Punk Slowed Reverb',
        'Omar J. Cabrera · 34K views',
      ),
    ]
    const featured = [
      listedPlaylist(
        'VLRDCLAK5uy_daft',
        'Presenting Daft Punk',
        'YouTube Music · 35 songs',
      ),
      listedPlaylist(
        'VLRDCLAK5uy_party',
        'Summer Party',
        'YouTube Music · 85 songs',
      ),
    ]
    expect(
      idsOf(filterPlaylistsForQuery('daft', playlists, daftFocus, featured)),
    ).toEqual(['VLRDCLAK5uy_daft', 'VLPLbest'])
  })

  test('keeps the search’s own words when it names no artist', () => {
    const playlists = [
      listedPlaylist(
        'VLPLlike',
        'Songs like bohemian rhapsody',
        'Dit Thakkar · 5.7K views',
      ),
      listedPlaylist(
        'VLPLmovie',
        'bohemian rhapsody movie full movie',
        'نسمة خافتة · 59K views',
      ),
      listedPlaylist('VLPLqueen', 'Queen Greatest Hits', 'Someone · 3M views'),
    ]
    expect(
      idsOf(
        filterPlaylistsForQuery('bohemian rhapsody', playlists, rhapsodyFocus),
      ),
    ).toEqual(['VLPLlike'])
  })
})

describe('suggestionsFrom', () => {
  test('reads the words YouTube Music suggests, each once', () => {
    const suggestion = (text: string) =>
      new YTNodes.SearchSuggestion({
        suggestion: { runs: [{ text }] },
        navigationEndpoint: { searchEndpoint: { query: text } },
      })
    expect(
      suggestionsFrom([
        suggestion('blinding lights the weeknd'),
        suggestion('blinding lights'),
        suggestion('Blinding Lights'),
      ]),
    ).toEqual(['blinding lights the weeknd', 'blinding lights'])
  })
})
