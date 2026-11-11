import { Array, Effect } from 'effect'

import { MusicRpcs, type Song } from '@music/shared'

import { AudioStore } from './audioStore.ts'
import { YouTubeMusic } from './youtubeMusic/service.ts'

/** How many songs of a list to download as soon as its page opens. */
const SONGS_TO_PREPARE = 2

/**
 * Answers each MusicRpcs call from the YouTube Music catalog. Opening a
 * page also starts downloading the songs someone is likely to play from it,
 * so Play starts instantly.
 */
export const MusicRpcsLive = MusicRpcs.toLayer(
  Effect.gen(function* () {
    const youTubeMusic = yield* YouTubeMusic
    const audioStore = yield* AudioStore

    const prepare = (songs: ReadonlyArray<Song>, count = SONGS_TO_PREPARE) =>
      audioStore.warm(Array.map(Array.take(songs, count), song => song.videoId))

    return {
      searchSongs: ({ query }) =>
        youTubeMusic
          .searchSongs(query)
          .pipe(Effect.tap(songs => prepare(songs, 1))),
      searchArtists: ({ query }) => youTubeMusic.searchArtists(query),
      searchAlbums: ({ query }) => youTubeMusic.searchAlbums(query),
      getSong: ({ videoId }) =>
        youTubeMusic
          .getSong(videoId)
          .pipe(Effect.tap(details => prepare([details.song]))),
      getArtist: ({ artistId }) =>
        youTubeMusic
          .getArtist(artistId)
          .pipe(Effect.tap(details => prepare(details.topSongs))),
      getAlbum: ({ albumId }) =>
        youTubeMusic
          .getAlbum(albumId)
          .pipe(Effect.tap(details => prepare(details.tracks))),
    }
  }),
)
