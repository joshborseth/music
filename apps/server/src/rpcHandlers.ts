import { Array, Effect, Option } from 'effect'
import type { Headers } from 'effect/http'

import {
  AccountError,
  JOIN_PATH,
  MusicRpcs,
  type Song,
  type Viewer,
} from '@music/shared'

import { ownerOf, userOf } from './access/owner.ts'
import { AccountsService } from './access/public.ts'
import { homeFeed } from './home.ts'
import { homeFeedInput, loadNewReleases, loadSongRadio } from './homeSources.ts'
import { TimedLyrics } from './lyrics/service.ts'
import { ArtworkPalette } from './palette/service.ts'
import { Libraries } from './playlists/libraries.ts'
import { Prefetcher, pageJobs } from './prefetch.ts'
import { SessionHub } from './session/hub.ts'
import { YouTubeMusic } from './youtubeMusic/service.ts'

/** A request's headers as Better Auth reads them: its cookie names the session. */
const webHeaders = (headers: Headers.Headers): globalThis.Headers => {
  const result = new globalThis.Headers()
  for (const [name, value] of Object.entries(headers)) result.set(name, value)
  return result
}

interface Call {
  readonly headers: Headers.Headers
}

/**
 * Answers each MusicRpcs call from the YouTube Music catalog, the caller's
 * own library (`Libraries`, by the account the gate found), or the
 * accounts. Opening a page also gets the songs someone is likely to play
 * from it ready, so Play starts instantly: the first ones downloaded whole,
 * the next few with their links found. Each person's latest page replaces
 * their previous one's plan.
 */
export const MusicRpcsLive = MusicRpcs.toLayer(
  Effect.gen(function* () {
    const youTubeMusic = yield* YouTubeMusic
    const prefetcher = yield* Prefetcher
    const libraries = yield* Libraries
    const accounts = yield* AccountsService
    const hub = yield* SessionHub
    const artworkPalette = yield* ArtworkPalette
    const timedLyrics = yield* TimedLyrics

    const prepare =
      (call: Call) =>
      (songs: ReadonlyArray<Song>, downloads: number, resolves: number) =>
        prefetcher.plan(
          `Page:${ownerOf(call.headers)}`,
          pageJobs(
            Array.map(songs, song => song.videoId),
            downloads,
            resolves,
          ),
        )

    const libraryOf = (call: Call) => libraries.of(ownerOf(call.headers))

    const viewerOf = (call: Call): Effect.Effect<Viewer, AccountError> =>
      Option.match(userOf(call.headers), {
        onNone: () => Effect.succeed<Viewer>({ _tag: 'Guest' }),
        onSome: userId =>
          Effect.map(
            accounts.signedIn(webHeaders(call.headers)),
            Option.match({
              onNone: (): Viewer => ({ _tag: 'Guest' }),
              onSome: (account): Viewer =>
                account.id === userId
                  ? {
                      _tag: 'SignedIn',
                      id: account.id,
                      username: account.username,
                      role: account.role,
                      isOwner: Option.contains(accounts.ownerId(), account.id),
                    }
                  : { _tag: 'Guest' },
            }),
          ),
      })

    return {
      searchSongs: ({ query }, call) =>
        youTubeMusic
          .searchSongs(query)
          .pipe(Effect.tap(songs => prepare(call)(songs, 1, 2))),
      searchArtists: ({ query }) => youTubeMusic.searchArtists(query),
      searchAlbums: ({ query }) => youTubeMusic.searchAlbums(query),
      searchPlaylists: ({ query }) => youTubeMusic.searchPlaylists(query),
      searchTopResult: ({ query }) => youTubeMusic.searchTopResult(query),
      searchSuggestions: ({ query }) => youTubeMusic.searchSuggestions(query),
      getMoodsAndGenres: () => youTubeMusic.getMoodsAndGenres(),
      getMood: ({ params }) => youTubeMusic.getMood(params),
      getSong: ({ videoId }, call) =>
        youTubeMusic.getSong(videoId).pipe(
          Effect.tap(details => prepare(call)([details.song], 1, 0)),
          Effect.flatMap(timedLyrics.withTimedLines),
        ),
      getArtist: ({ artistId }, call) =>
        youTubeMusic
          .getArtist(artistId)
          .pipe(Effect.tap(details => prepare(call)(details.topSongs, 2, 3))),
      getAlbum: ({ albumId }, call) =>
        youTubeMusic
          .getAlbum(albumId)
          .pipe(Effect.tap(details => prepare(call)(details.tracks, 2, 3))),
      getPlaylist: ({ playlistId }, call) =>
        youTubeMusic
          .getPlaylist(playlistId)
          .pipe(Effect.tap(details => prepare(call)(details.tracks, 2, 3))),
      getMyLibrary: (_, call) =>
        Effect.flatMap(libraryOf(call), store => store.library()),
      getLibrarySongs: (_, call) =>
        Effect.flatMap(libraryOf(call), store => store.librarySongs()),
      getMyPlaylist: ({ playlistId }, call) =>
        Effect.flatMap(libraryOf(call), store =>
          store
            .playlist(playlistId)
            .pipe(Effect.tap(details => prepare(call)(details.songs, 2, 3))),
        ),
      editPlaylists: ({ edit }, call) =>
        Effect.flatMap(libraryOf(call), store => store.edit(edit)),
      getHome: (_, call) =>
        Effect.flatMap(libraryOf(call), store =>
          homeFeedInput(store).pipe(Effect.map(homeFeed)),
        ),
      getNewReleases: (_, call) =>
        Effect.flatMap(libraryOf(call), store =>
          loadNewReleases(store, youTubeMusic),
        ),
      getSongRadio: ({ videoId }, call) =>
        Effect.flatMap(libraryOf(call), store =>
          loadSongRadio(store, youTubeMusic, videoId),
        ),
      getRadio: ({ station }) => youTubeMusic.getRadio(station),
      getArtworkBackdrop: ({ artworkUrl }) =>
        artworkPalette.backdropFor(artworkUrl),

      getViewer: (_, call) => viewerOf(call),
      getPeople: (_, call) => accounts.people(webHeaders(call.headers)),
      createInvite: ({ role }, call) =>
        accounts.inviteAs(webHeaders(call.headers), role).pipe(
          Effect.map(created => ({
            invite: created.invite,
            link: `${accounts.origin}${JOIN_PATH}?code=${created.code}`,
            people: created.people,
          })),
        ),
      revokeInvite: ({ inviteId }, call) =>
        accounts.revokeInvite(webHeaders(call.headers), inviteId),
      setRole: ({ userId, role }, call) =>
        accounts.setRole(webHeaders(call.headers), userId, role),
      resetPassword: ({ userId, password }, call) =>
        accounts.resetPassword(webHeaders(call.headers), userId, password),
      removePerson: ({ userId }, call) =>
        accounts
          .removePerson(webHeaders(call.headers), userId)
          .pipe(
            Effect.tap(() =>
              Effect.andThen(libraries.remove(userId), hub.forget(userId)),
            ),
          ),
      changePassword: ({ currentPassword, newPassword }, call) =>
        accounts.changePassword(
          webHeaders(call.headers),
          currentPassword,
          newPassword,
        ),
    }
  }),
)
