import { Schema } from 'effect'

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
})
export type Model = typeof Model.Type
