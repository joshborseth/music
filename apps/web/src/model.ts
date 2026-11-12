import { Schema } from 'effect'

import { Session } from '@music/shared'

import { LibraryItem } from './library'
import { NavigationModel } from './navigation'
import {
  Connection,
  DeviceIdentity,
  PhoneAudio,
  PlayerSheet,
  SessionSnapshot,
} from './playback/domain'
import { Swipe } from './playback/swipe'
import {
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  homeQuery,
  myLibraryQuery,
  myPlaylistQuery,
  playlistQuery,
  playlistSearchQuery,
  songQuery,
  songSearchQuery,
} from './query'
import { AppRoute } from './route'
import { ActionSheet, PlayerPanel } from './sheet'

export const Model = Schema.Struct({
  route: AppRoute,
  navigation: NavigationModel,
  searchInput: Schema.String,
  recentSearches: Schema.Array(Schema.String),
  recentlyPlayed: Schema.Array(Session.QueueTrack),
  recentlyViewed: Schema.Array(LibraryItem),
  home: homeQuery.Model,
  songSearch: songSearchQuery.Model,
  artistSearch: artistSearchQuery.Model,
  albumSearch: albumSearchQuery.Model,
  playlistSearch: playlistSearchQuery.Model,
  songs: songQuery.Model,
  artists: artistQuery.Model,
  albums: albumQuery.Model,
  playlists: playlistQuery.Model,
  myLibrary: myLibraryQuery.Model,
  myPlaylists: myPlaylistQuery.Model,
  /** The name being typed for a new or renamed playlist. */
  playlistTitleInput: Schema.String,
  actionSheet: ActionSheet,
  playerPanel: PlayerPanel,
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
  swipe: Swipe,
})
export type Model = typeof Model.Type
