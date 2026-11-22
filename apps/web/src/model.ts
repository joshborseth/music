import { Schema } from 'effect'

import { Downloads } from './downloads/domain'
import { LibraryFilter, LibraryItem, LibraryPrefs } from './library'
import { NavigationModel } from './navigation'
import {
  Connection,
  DeviceIdentity,
  LocalChanges,
  PhoneAudio,
  PlayerSheet,
  QueueEdit,
  SessionSnapshot,
} from './playback/domain'
import { Swipe } from './playback/swipe'
import { AddSongsSearch, PlaylistEditor } from './playlistEditor'
import {
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  artworkBackdropQuery,
  homeQuery,
  librarySongsQuery,
  moodGroupsQuery,
  moodQuery,
  myLibraryQuery,
  myPlaylistQuery,
  newReleasesQuery,
  playlistQuery,
  playlistSearchQuery,
  searchSuggestionsQuery,
  songQuery,
  songRadioQuery,
  songSearchQuery,
  topResultSearchQuery,
} from './query'
import { AppRoute } from './route'
import { ActionSheet, PlayerPanel } from './sheet'
import { SuggestionList } from './suggestions'

export const Model = Schema.Struct({
  route: AppRoute,
  navigation: NavigationModel,
  searchInput: Schema.String,
  /**
   * The last search whose results the page showed. They stay on screen while
   * a newer search loads.
   */
  maybeEarlierSearch: Schema.Option(Schema.String),
  /**
   * How many of a search's Top shelves (artists, albums, playlists) show.
   * They come one a frame, after its first rows.
   */
  shownTopShelves: Schema.Struct({
    query: Schema.String,
    count: Schema.Number,
  }),
  recentSearches: Schema.Array(Schema.String),
  /** Whether suggestions show under the search box, as something is typed. */
  suggestionList: SuggestionList,
  searchSuggestions: searchSuggestionsQuery.Model,
  /** Albums, artists, and playlists opened on this device, newest first. */
  recentlyViewed: Schema.Array(LibraryItem),
  libraryFilter: LibraryFilter,
  /** How this device sorts and lays out the Library. */
  libraryPrefs: LibraryPrefs,
  /** What is typed in the Library's search field, which filters it. */
  librarySearchInput: Schema.String,
  /** The playlist page being edited, if any. */
  playlistEditor: PlaylistEditor,
  addSongsSearch: AddSongsSearch,
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
  /** Every song in my playlists and Liked Songs, for the Library's Songs. */
  librarySongs: librarySongsQuery.Model,
  myPlaylists: myPlaylistQuery.Model,
  /** What played lately on any device, from the server's history. */
  home: homeQuery.Model,
  /** The latest releases of the artists I follow, for Home. */
  newReleases: newReleasesQuery.Model,
  songRadios: songRadioQuery.Model,
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
  /**
   * Counts the fresh sockets opened in place of one that may have died
   * unnoticed (`returnToPage`). A new count opens a new socket.
   */
  sessionSocketGeneration: Schema.Number,
  /** When the page went out of sight, while it is out of sight. */
  maybePageHiddenAt: Schema.Option(Schema.Number),
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
  /** Queue changes this phone made that the server has not confirmed. */
  queueEdits: Schema.Array(QueueEdit),
  /**
   * The session was made on this phone while the server could not be
   * reached (`offlineSessionState`): it plays on its own until the server
   * is back, and then hands its queue over.
   */
  isOfflineSession: Schema.Boolean,
  swipe: Swipe,
  /** Albums and playlists downloaded on this phone. */
  downloads: Downloads,
})
export type Model = typeof Model.Type
