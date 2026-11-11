import { Schema } from 'effect'
import { Url } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest } from 'foldkit/navigation'

import {
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  songQuery,
  songSearchQuery,
} from './query'
import { SearchKind } from './route'

export const Message = defineMessageUnion({
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  CompletedNavigateBack: {},
  CompletedReplaceSearchUrl: {},
  CompletedScrollToTop: {},
  CompletedFocusSearchInput: {},
  CompletedWaitBeforeSearch: { query: Schema.String },
  CompletedLoadRecentSearches: { recentSearches: Schema.Array(Schema.String) },
  CompletedSaveRecentSearches: {},
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url.Url },
  UpdatedSearchInput: { value: Schema.String },
  SubmittedSearch: {},
  ClickedClearSearch: {},
  SelectedSearchKind: { kind: SearchKind },
  ClickedRecentSearch: { query: Schema.String },
  ClickedClearRecentSearches: {},
  ClickedBack: {},
  ClickedRetry: {},
  GotSongSearchMessage: { message: songSearchQuery.Message },
  GotArtistSearchMessage: { message: artistSearchQuery.Message },
  GotAlbumSearchMessage: { message: albumSearchQuery.Message },
  GotSongMessage: { message: songQuery.Message },
  GotArtistMessage: { message: artistQuery.Message },
  GotAlbumMessage: { message: albumQuery.Message },
})
export type Message = typeof Message.Type
