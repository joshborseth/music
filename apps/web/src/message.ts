import { Schema } from 'effect'
import { Url } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest } from 'foldkit/navigation'

import { Session, Song } from '@music/shared'

import { LibraryItem } from './library'
import { MediaKey } from './playback/domain'
import { SwipeTarget } from './playback/swipe'
import {
  albumQuery,
  albumSearchQuery,
  artistQuery,
  artistSearchQuery,
  homeQuery,
  playlistQuery,
  songQuery,
  songSearchQuery,
} from './query'
import { SearchKind, Tab } from './route'
import { PlayerPanel } from './sheet'

export const Message = defineMessageUnion({
  CompletedNavigateInternal: {
    fromUrl: Schema.String,
    scrollTop: Schema.Number,
  },
  CompletedLoadExternal: {},
  CompletedNavigateBack: {},
  CompletedReplaceSearchUrl: {},
  CompletedScrollToTop: {},
  CompletedRestoreScroll: {},
  CompletedFollowSheetDrags: {},
  CompletedTakeOverScrollRestoration: {},
  CompletedFocusSearchInput: {},
  CompletedBlurSearchInput: {},
  CompletedLockScroll: {},
  CompletedUnlockScroll: {},
  CompletedLoadLibrary: {
    recentlyPlayed: Schema.Array(Session.QueueTrack),
    recentlyViewed: Schema.Array(LibraryItem),
  },
  CompletedSaveRecentlyPlayed: {},
  CompletedSaveRecentlyViewed: {},
  CompletedShuffleSongs: { songs: Schema.Array(Song) },
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
  ClickedTab: { tab: Tab },
  ClickedClearLibrary: {},
  ClickedShuffleSongs: { songs: Schema.Array(Song) },
  ClickedSongActions: { song: Song },
  ClickedDevices: {},
  ClickedCloseSheet: {},
  SwipedDownSheet: {},
  SwipedDownPlayer: {},
  SelectedPlayerPanel: { panel: PlayerPanel },
  ClickedRetry: {},
  GotSongSearchMessage: { message: songSearchQuery.Message },
  GotArtistSearchMessage: { message: artistSearchQuery.Message },
  GotAlbumSearchMessage: { message: albumSearchQuery.Message },
  GotSongMessage: { message: songQuery.Message },
  GotArtistMessage: { message: artistQuery.Message },
  GotAlbumMessage: { message: albumQuery.Message },
  GotPlaylistMessage: { message: playlistQuery.Message },
  GotHomeMessage: { message: homeQuery.Message },

  CompletedLoadDeviceIdentity: {
    deviceId: Schema.String,
    deviceName: Schema.String,
  },
  AcquiredSessionSocket: {},
  ReleasedSessionSocket: {},
  FailedConnectSessionSocket: { error: Schema.String },
  ClosedSessionSocket: {},
  CompletedWaitBeforeReconnect: {},
  ReceivedSessionState: {
    state: Session.SessionState,
    serverNow: Schema.Number,
    receivedAt: Schema.Number,
  },
  ReceivedSessionNotice: { message: Schema.String },
  CompletedSendToSession: {},
  CompletedWaitBeforeHideNotice: { message: Schema.String },
  TickedClock: { now: Schema.Number },

  AcquiredPhoneAudio: {},
  ReleasedPhoneAudio: {},
  FailedAcquirePhoneAudio: {},
  CompletedUnlockPhoneAudio: {},
  CompletedLoadPhoneAudio: { isBlocked: Schema.Boolean },
  CompletedSetPhoneAudioPlaying: { isBlocked: Schema.Boolean },
  CompletedStopPhoneAudio: {},
  CompletedSeekPhoneAudio: {},
  CompletedPrefetchSongs: {},
  ChangedPhoneAudioBuffering: { isBuffering: Schema.Boolean },
  UpdatedScrubPosition: { seconds: Schema.Number },
  ClickedSkipBy: { seconds: Schema.Number },
  CompletedUpdateMediaSession: {},
  UpdatedPhoneAudioTime: { seconds: Schema.Number, at: Schema.Number },
  EndedPhoneAudio: {},
  FailedPhoneAudio: { error: Schema.String },
  PressedMediaKey: { key: MediaKey },

  ClickedPlaySongs: { songs: Schema.Array(Song), startIndex: Schema.Number },
  ClickedEnqueueSongs: {
    songs: Schema.Array(Song),
    placement: Session.Placement,
  },
  ClickedTogglePlayback: {},
  ClickedNextTrack: {},
  ClickedPreviousTrack: {},
  ChangedSeekPosition: { seconds: Schema.Number },
  ClickedDevice: { deviceId: Schema.String },
  ClickedQueueEntry: { entryId: Schema.String },
  ClickedRemoveQueueEntry: { entryId: Schema.String },
  ClickedOpenPlayer: {},
  ClickedClosePlayer: {},
  ClickedStartBlockedAudio: {},
  ClickedDismissNotice: {},

  PressedSwipeable: {
    target: SwipeTarget,
    pointerId: Schema.Number,
    clientX: Schema.Number,
    clientY: Schema.Number,
    timeStamp: Schema.Number,
  },
  MovedSwipePointer: {
    pointerId: Schema.Number,
    clientX: Schema.Number,
    clientY: Schema.Number,
    timeStamp: Schema.Number,
  },
  ReleasedSwipePointer: { pointerId: Schema.Number, timeStamp: Schema.Number },
  CancelledSwipePointer: { pointerId: Schema.Number },
})
export type Message = typeof Message.Type
