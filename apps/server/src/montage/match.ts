import { Array, Option, Order, pipe } from 'effect'

import type { ArtistLink } from '@music/shared'

/*
 * Finding a song's official music video. The app plays songs, and YouTube
 * Music links a song to its video only for a signed-in listener, so this
 * searches YouTube Music's videos for the song's title and artist and picks
 * the one that is the song's own video: the same title, by the same artist,
 * about as long (a video may run longer, with an intro or a skit), and not
 * another take on it: no lyric video, live version, cover, remix, or
 * "visualizer" over a still picture. A still picture that gets through
 * anyway is caught later, from its frames (`frames.ts`, `isStatic`).
 */

/** A video a YouTube Music video search found, as it came. */
export interface VideoCandidate {
  readonly videoId: string
  /** The video's own title: "Daft Punk - One More Time (Official Video)". */
  readonly title: string
  readonly artists: ReadonlyArray<ArtistLink>
  readonly maybeDurationSeconds: Option.Option<number>
}

/** The song whose video is wanted. */
export interface SongToMatch {
  readonly videoId: string
  readonly title: string
  readonly artists: ReadonlyArray<ArtistLink>
  readonly maybeDurationSeconds: Option.Option<number>
}

/**
 * Words that make a video something other than the song's own video, unless
 * the song's title says them too ("Live Forever" may have "live" in it).
 */
const NOT_THE_VIDEO = [
  'lyric',
  'lyrics',
  'letra',
  'paroles',
  'live',
  'concert',
  'tour',
  'session',
  'sessions',
  'acoustic',
  'unplugged',
  'cover',
  'karaoke',
  'tribute',
  'visualizer',
  'visualiser',
  'visualization',
  'audio',
  'remix',
  'rmx',
  'reaction',
  'reacts',
  'tutorial',
  'lesson',
  'instrumental',
  'slowed',
  'sped',
  'nightcore',
  '8d',
  'reverb',
  'fanmade',
  'teaser',
  'trailer',
  'preview',
  'snippet',
  'behind',
  'making',
  'interview',
  'rehearsal',
  'loop',
  'hour',
  'hours',
  'mashup',
  'parody',
  'amv',
  'edit',
  'shorts',
  'vertical',
  'festival',
  'hz',
  'frequency',
  'legendado',
  'legenda',
  'subtitulado',
  'traducida',
  'traduzione',
  'subtitles',
  'sub',
  'subs',
  'espanol',
  'romanized',
  'backing',
  'drums',
  'free',
  'type',
  'beat',
  'listen',
  'playlist',
  'compilation',
  'mix',
]
/** A title that tunes the song to some frequency: "(432Hz)", "963 Hz". */
const TUNED = /\b\d+\s*hz\b/u
/** Words of scripts the lyric translations use, with no video of their own. */
const TRANSLATED = /(가사|자막|해석|歌詞|和訳|中字|翻译)/u
/** Phrases that mark the official video, ranked first. */
const OFFICIAL =
  /\b(official (music )?video|official mv|music video|\bm\/?v\b)/u
/** "Official ... Video" with words between: "(Official 4K Video)". */
const OFFICIAL_LOOSE = /\bofficial\b[^()[\]]*\bvideo\b/u

/** How much shorter than the song a video may be, at least. */
const SHORTER_SECONDS = 12
/** How much longer than the song a video may be: an intro, a skit, credits. */
const LONGER_SECONDS = 150
const LONGER_SHARE = 0.6

const ACCENT = /\p{M}/gu
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu
const BRACKETED = /[([{【][^)\]}】]*[)\]}】]/gu
/** A song title's tail that only names its edition: " - Remastered 2011". */
const EDITION_TAIL = /\s[-–—]\s.*$/u

/** Lowercase words, no accents or punctuation: "Beyoncé's" → "beyonce s". */
export const plainWords = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(ACCENT, '')
    .toLowerCase()
    .replace(NOT_LETTER_OR_DIGIT, ' ')
    .trim()

/** Letters and digits only: "AC/DC" → "acdc". */
const compact = (text: string): string => plainWords(text).replaceAll(' ', '')

/**
 * The words a song's title is known by: no brackets ("(feat. X)",
 * "(Remastered)") and no edition tail. The whole title if that leaves none.
 */
export const coreTitle = (title: string): string => {
  const bare = plainWords(
    title.replace(BRACKETED, ' ').replace(EDITION_TAIL, ''),
  )
  return bare.length > 0 ? bare : plainWords(title)
}

const words = (text: string): ReadonlySet<string> =>
  new Set(text.split(' ').filter(word => word.length > 0))

/** Whether `haystack` holds `needle`'s words in a row, as whole words. */
const holdsPhrase = (haystack: string, needle: string): boolean =>
  ` ${haystack} `.includes(` ${needle} `)

/** Whether the video credits one of the song's artists. */
const creditsArtist = (
  video: VideoCandidate,
  artists: ReadonlyArray<ArtistLink>,
): boolean =>
  Array.some(artists, artist => {
    const name = compact(artist.name)
    return (
      Array.some(
        video.artists,
        credit =>
          (Option.isSome(credit.maybeId) &&
            Option.isSome(artist.maybeId) &&
            credit.maybeId.value === artist.maybeId.value) ||
          (name.length > 0 &&
            // "DaftPunkVEVO" is Daft Punk's channel.
            compact(credit.name).startsWith(name)),
      ) ||
      (name.length > 0 &&
        holdsPhrase(plainWords(video.title), plainWords(artist.name)))
    )
  })

/** Why a video is not the song's own, or none when it may be. */
export const rejection = (
  song: SongToMatch,
  video: VideoCandidate,
): Option.Option<string> => {
  if (video.videoId === song.videoId) {
    // The song's own upload: an "Art Track", a still cover.
    return Option.some('the song itself')
  }
  const title = plainWords(video.title)
  const songTitle = coreTitle(song.title)
  if (!holdsPhrase(title, songTitle)) return Option.some('another title')
  if (!creditsArtist(video, song.artists)) return Option.some('another artist')
  const songWords = words(plainWords(song.title))
  const artistWords = words(plainWords(song.artists.map(a => a.name).join(' ')))
  const titleWords = words(title)
  const marked = NOT_THE_VIDEO.find(
    word =>
      titleWords.has(word) && !songWords.has(word) && !artistWords.has(word),
  )
  if (marked !== undefined) return Option.some(`a ${marked} video`)
  if (TUNED.test(title)) return Option.some('a retuned copy')
  if (TRANSLATED.test(video.title)) return Option.some('a translation')
  if (
    Option.isSome(song.maybeDurationSeconds) &&
    Option.isSome(video.maybeDurationSeconds)
  ) {
    const songSeconds = song.maybeDurationSeconds.value
    const difference = video.maybeDurationSeconds.value - songSeconds
    if (difference < -SHORTER_SECONDS) return Option.some('too short')
    if (difference > Math.max(LONGER_SECONDS, LONGER_SHARE * songSeconds))
      return Option.some('too long')
  }
  return Option.none()
}

/**
 * How well a video that passed fits, higher first: saying it is the
 * official video, a length close to the song's, and YouTube's own order.
 */
const fit = (
  song: SongToMatch,
  video: VideoCandidate,
  index: number,
): number => {
  const title = plainWords(video.title.replace(/[-–—|]/gu, ' '))
  const raw = video.title.toLowerCase()
  const official = OFFICIAL.test(raw) || OFFICIAL_LOOSE.test(raw) ? 3 : 0
  const length = pipe(
    Option.all([song.maybeDurationSeconds, video.maybeDurationSeconds]),
    Option.match({
      onNone: () => 0,
      onSome: ([songSeconds, videoSeconds]) =>
        2 * Math.exp(-Math.abs(videoSeconds - songSeconds) / 30),
    }),
  )
  // Few words beyond the song's and the artist's: the plainer title.
  const extra = Math.max(
    0,
    title.split(' ').length -
      coreTitle(song.title).split(' ').length -
      plainWords(song.artists[0]?.name ?? '').split(' ').length,
  )
  return official + length - 0.25 * index - 0.1 * extra
}

/**
 * The videos that may be the song's own music video, the likeliest first.
 * More than one, since the first may turn out to be a still picture.
 */
export const rankMusicVideos = (
  song: SongToMatch,
  videos: ReadonlyArray<VideoCandidate>,
): ReadonlyArray<VideoCandidate> =>
  pipe(
    videos,
    Array.map((video, index) => ({ video, index })),
    Array.filter(({ video }) => Option.isNone(rejection(song, video))),
    Array.sort(
      Order.mapInput(
        Order.flip(Order.Number),
        ({ video, index }: { video: VideoCandidate; index: number }) =>
          fit(song, video, index),
      ),
    ),
    Array.map(({ video }) => video),
  )

/** The words to search YouTube Music's videos for. */
export const videoQuery = (song: SongToMatch): string =>
  pipe(
    Array.head(song.artists),
    Option.match({
      onNone: () => coreTitle(song.title),
      onSome: artist => `${artist.name} ${coreTitle(song.title)}`,
    }),
  )
