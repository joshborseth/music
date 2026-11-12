import { Schema } from 'effect'

import { QueueTrack } from './session.ts'

/*
 * The TV app's catalog: plain JSON over HTTP, so the Rust TV app can browse
 * and play without the phone. The web app keeps using Effect RPC; these
 * routes reshape the same catalog into what a TV screen needs.
 *
 * Mirrored by serde types in `apps/tv/src/catalog.rs`. Like the session
 * protocol, every field is plain JSON (nullable, never Option). Change both
 * sides together, and update the shared fixtures in `fixtures/tv/` that both
 * test suites decode.
 *
 *   GET  /tv/home                          TvShelves  your playlists, then YouTube Music's home feed
 *   GET  /tv/library                       TvShelves  your playlists, Liked songs first
 *   GET  /tv/search?q=…                    TvShelves  songs, artists, albums, playlists
 *   GET  /tv/collection?kind=…&id=…        TvCollection
 *   GET  /tv/lyrics?videoId=…              TvLyrics
 *   GET  /tv/liked?videoId=…               TvLiked
 *   POST /tv/like   (TvLikeRequest)        TvLiked
 *   GET  /tv/version                       TvVersion
 *   POST /tv/updating                      204: the TV is installing an update; reopen it after
 *
 * A failure answers with a non-2xx status and a plain-text message.
 */

/** What a card opens. A song card plays; the rest open a collection. */
export const TvCardKind = Schema.Literals([
  'Song',
  'Album',
  'Playlist',
  'MyPlaylist',
  'Artist',
])
export type TvCardKind = typeof TvCardKind.Type

/** One tile on a shelf. */
export const TvCard = Schema.Struct({
  kind: TvCardKind,
  /** The videoId, albumId, playlistId, my playlist's id, or artistId. */
  id: Schema.String,
  title: Schema.String,
  /** Artists, "Album · 2024", "Playlist · 32 songs", and so on. */
  subtitle: Schema.String,
  artworkUrl: Schema.NullOr(Schema.String),
  /** Set for song cards: enough to play it. */
  track: Schema.NullOr(QueueTrack),
})
export type TvCard = typeof TvCard.Type

/** One titled row of cards. */
export const TvShelf = Schema.Struct({
  title: Schema.String,
  cards: Schema.Array(TvCard),
})
export type TvShelf = typeof TvShelf.Type

export const TvShelves = Schema.Struct({
  shelves: Schema.Array(TvShelf),
})
export type TvShelves = typeof TvShelves.Type

/** The collections a card can open. */
export const TvCollectionKind = Schema.Literals([
  'Album',
  'Playlist',
  'MyPlaylist',
  'Artist',
])
export type TvCollectionKind = typeof TvCollectionKind.Type

/**
 * An album, playlist, one of my playlists, or an artist. `tracks` is what
 * Play and Shuffle play: the tracklist, or an artist's top songs. An artist
 * also has shelves (albums, singles and EPs, similar artists).
 */
export const TvCollection = Schema.Struct({
  kind: TvCollectionKind,
  id: Schema.String,
  title: Schema.String,
  /** "Album · Artist · 2024", "Artist", "Playlist · 32 songs". */
  subtitle: Schema.String,
  description: Schema.NullOr(Schema.String),
  artworkUrl: Schema.NullOr(Schema.String),
  tracks: Schema.Array(QueueTrack),
  shelves: Schema.Array(TvShelf),
})
export type TvCollection = typeof TvCollection.Type

/** A song's lyrics. YouTube Music's are not timed. */
export const TvLyrics = Schema.Struct({
  text: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
})
export type TvLyrics = typeof TvLyrics.Type

/** Whether a song is in Liked songs. */
export const TvLiked = Schema.Struct({
  videoId: Schema.String,
  liked: Schema.Boolean,
})
export type TvLiked = typeof TvLiked.Type

/** Add a song to Liked songs, or take it out. */
export const TvLikeRequest = Schema.Struct({
  track: QueueTrack,
  liked: Schema.Boolean,
})
export type TvLikeRequest = typeof TvLikeRequest.Type

/** The TV app build the server has. Null when none is built. */
export const TvVersion = Schema.Struct({
  build: Schema.NullOr(Schema.String),
})
export type TvVersion = typeof TvVersion.Type
