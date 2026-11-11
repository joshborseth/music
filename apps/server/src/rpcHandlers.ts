import { Effect } from 'effect'

import { MusicRpcs } from '@music/shared'

import { YouTubeMusic } from './youtubeMusic/service.ts'

/** Answers each MusicRpcs call from the YouTube Music catalog. */
export const MusicRpcsLive = MusicRpcs.toLayer(
  Effect.gen(function* () {
    const youTubeMusic = yield* YouTubeMusic

    return {
      searchSongs: ({ query }) => youTubeMusic.searchSongs(query),
      searchArtists: ({ query }) => youTubeMusic.searchArtists(query),
      searchAlbums: ({ query }) => youTubeMusic.searchAlbums(query),
      getSong: ({ videoId }) => youTubeMusic.getSong(videoId),
      getArtist: ({ artistId }) => youTubeMusic.getArtist(artistId),
      getAlbum: ({ albumId }) => youTubeMusic.getAlbum(albumId),
    }
  }),
)
