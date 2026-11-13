import { Effect, Layer, Option } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcClient, RpcSerialization } from 'effect/rpc'

import { MusicRpcs } from '@music/shared'

const url = process.argv[2] ?? 'http://localhost:3001/rpc'

const ProtocolLive = RpcClient.layerProtocolHttp({ url }).pipe(
  Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]),
)

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(MusicRpcs)
  const songs = yield* client.searchSongs({ query: 'fleetwood mac the chain' })
  const artists = yield* client.searchArtists({ query: 'fleetwood mac' })
  const albums = yield* client.searchAlbums({ query: 'rumours' })
  console.log(
    'songs',
    songs.length,
    songs[0]?.title,
    songs[0]?.artwork.at(-1)?.url,
  )
  console.log(
    'artists',
    artists.length,
    artists[0]?.name,
    artists[0]?.maybeAudience,
  )
  console.log(
    'albums',
    albums.length,
    albums[0]?.title,
    albums[0]?.maybeKind,
    albums[0]?.maybeYear,
  )
  const first = songs[0]
  if (first !== undefined) {
    const song = yield* client.getSong({ videoId: first.videoId })
    console.log(
      'song',
      song.song.title,
      song.song.maybeAlbum,
      song.maybeViewCount,
      Option.map(song.maybeLyrics, lyrics => lyrics.text.slice(0, 40)),
    )
  }
  const artistId = artists[0]?.id
  if (artistId !== undefined) {
    const artist = yield* client.getArtist({ artistId })
    console.log(
      'artist',
      artist.artist.name,
      'top',
      artist.topSongs.length,
      'albums',
      artist.albums.length,
      'singles',
      artist.singles.length,
      Option.map(artist.maybeDescription, d => d.slice(0, 40)),
    )
  }
  const albumId = albums[0]?.id
  if (albumId !== undefined) {
    const album = yield* client.getAlbum({ albumId })
    console.log(
      'album',
      album.album.title,
      album.album.artists,
      album.maybeLengthSummary,
      'tracks',
      album.tracks.length,
      album.tracks[0]?.artwork.length,
    )
  }
  const playlists = yield* client.searchPlaylists({ query: 'top 500 songs' })
  console.log(
    'playlists',
    playlists.length,
    playlists[0]?.title,
    playlists[0]?.maybeSubtitle,
  )
  const longPlaylistId = playlists[0]?.id
  if (longPlaylistId !== undefined) {
    const long = yield* client.getPlaylist({ playlistId: longPlaylistId })
    console.log('long playlist tracks', long.tracks.length)
  }
  const library = yield* client.getMyLibrary()
  console.log(
    'my playlists',
    library.playlists.map(({ title, songCount }) => `${title}:${songCount}`),
    'albums',
    library.albums.length,
    'artists',
    library.artists.length,
  )
  const home = yield* client.getHome()
  console.log(
    'home',
    'jump back in',
    home.jumpBackIn.length,
    'recently played',
    home.recentlyPlayed.length,
  )
  const seed = home.recentlyPlayed[0]?.videoId
  if (seed !== undefined) {
    const radio = yield* client.getSongRadio({ videoId: seed })
    console.log('more like', home.recentlyPlayed[0]?.title, radio.length)
  }
  const missing = yield* client
    .getAlbum({ albumId: 'MPREb_doesnotexist' })
    .pipe(Effect.flip)
  console.log('missing album ->', missing._tag)
}).pipe(Effect.scoped, Effect.provide(ProtocolLive))

Effect.runPromise(program).catch(error => {
  console.error(error)
  process.exitCode = 1
})
