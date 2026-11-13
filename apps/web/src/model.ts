import { Schema } from 'effect'

import { Session } from '@music/shared'

import { LibraryItem } from './library'
import { NavigationModel } from './navigation'
import {
  Connection,
  DeviceIdentity,
  LocalChanges,
  PhoneAudio,
  PlayerSheet,
  QueueMove,
  SessionSnapshot,
} from './playback/domain'
import { Swipe } from './playback/swipe'
import {
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  artworkBackdropQuery,
  moodGroupsQuery,
  moodQuery,
  myLibraryQuery,
  myPlaylistQuery,
  playlistQuery,
  playlistSearchQuery,
  songQuery,
  songSearchQuery,
  topResultSearchQuery,
} from './query'
import { AppRoute } from './route'
import { ActionSheet, PlayerPanel } from './sheet'

export const Model = Schema.Struct({
  route: AppRoute,
  navigation: NavigationModel,
  searchInput: Schema.String,
  /**
   * The last search whose results the page showed. They stay on screen while
   * a newer search loads.
   */
  maybeEarlierSearch: Schema.Option(Schema.String),
  recentSearches: Schema.Array(Schema.String),
  recentlyPlayed: Schema.Array(Session.QueueTrack),
  recentlyViewed: Schema.Array(LibraryItem),
  songSearch: songSearchQuery.Model,
  artistSearch: artistSearchQuery.Model,
  albumSearch: albumSearchQuery.Model,
  playlistSearch: playlistSearchQuery.Model,
  topResultSearch: topResultSearchQuery.Model,
  moodGroups: moodGroupsQuery.Model,
  moods: moodQuery.Model,
  songs: songQuery.Model,
  artists: artistQuery.Model,
  albums: albumQuery.Model,
  playlists: playlistQuery.Model,
  myLibrary: myLibraryQuery.Model,
  myPlaylists: myPlaylistQuery.Model,
  /** The full player's background color for each song's artwork. */
  artworkBackdrops: artworkBackdropQuery.Model,
  /** The name being typed for a new or renamed playlist. */
  playlistTitleInput: Schema.String,
  actionSheet: ActionSheet,
  playerPanel: PlayerPanel,
  /** The song whose lyrics already failed to load and were tried again. */
  maybeLyricsRetriedVideoId: Schema.Option(Schema.String),
  maybeIdentity: Schema.Option(DeviceIdentity),
  connection: Connection,
  maybeSession: Schema.Option(SessionSnapshot),
  phoneAudio: PhoneAudio,
  phoneAudioSeconds: Schema.Number,
  lastProgressAt: Schema.Number,
  now: Schema.Number,
  playerSheet: PlayerSheet,
  maybeNotice: Schema.Option(Schema.String),
  /** Where the seek bar is being dragged to, before it is let go. */
  maybeScrubSeconds: Schema.Option(Schema.Number),
  localChanges: LocalChanges,
  /** Songs this phone moved in the queue that the server has not confirmed. */
  queueMoves: Schema.Array(QueueMove),
  swipe: Swipe,
})
export type Model = typeof Model.Type
