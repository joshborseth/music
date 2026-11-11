import { Schema } from 'effect'

import {
  Connection,
  DeviceIdentity,
  PhoneAudio,
  PlayerSheet,
  SessionSnapshot,
} from './playback/domain'
import {
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  songQuery,
  songSearchQuery,
} from './query'
import { AppRoute } from './route'

export const Model = Schema.Struct({
  route: AppRoute,
  searchInput: Schema.String,
  recentSearches: Schema.Array(Schema.String),
  songSearch: songSearchQuery.Model,
  artistSearch: artistSearchQuery.Model,
  albumSearch: albumSearchQuery.Model,
  songs: songQuery.Model,
  artists: artistQuery.Model,
  albums: albumQuery.Model,
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
})
export type Model = typeof Model.Type
