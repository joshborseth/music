import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { Song } from '@music/shared'

import { DownloadKind } from './downloads/domain'
import { SortableKind } from './library'

/** What an action sheet offers. */
export const SheetContent = defineTaggedUnion({
  SongActions: { song: Song },
  Devices: {},
  /** Stop the music after a while, or at the end of the song. */
  SleepTimer: {},
  /** Pick one of my playlists to add the songs to, or start a new one. */
  AddToPlaylist: { songs: Schema.Array(Song), suggestedTitle: Schema.String },
  /** Name a new playlist holding the songs. */
  NewPlaylist: { songs: Schema.Array(Song) },
  PlaylistActions: { playlistId: Schema.String, title: Schema.String },
  RenamePlaylist: { playlistId: Schema.String },
  ConfirmDeletePlaylist: { playlistId: Schema.String, title: Schema.String },
  /** Forget the albums, artists, and playlists opened on this device. */
  ConfirmClearRecentlyViewed: {},
  /** Pick the order the Library lists one kind of thing in. */
  LibrarySort: { kind: SortableKind },
  /** Search for songs to add to one of my playlists. */
  AddSongs: { playlistId: Schema.String },
  /** Pick the mosaic or one song's cover for one of my playlists. */
  ChoosePlaylistCover: { playlistId: Schema.String },
  /** Take a download off the phone. */
  ConfirmRemoveDownload: {
    kind: DownloadKind,
    id: Schema.String,
    title: Schema.String,
  },
})
export type SheetContent = typeof SheetContent.Type

/**
 * The action sheet that slides up from the bottom. A dismissed sheet keeps its
 * content so it can slide away showing what it showed.
 */
export const ActionSheet = defineTaggedUnion({
  Hidden: {},
  Shown: { content: SheetContent },
  Dismissed: { content: SheetContent },
})
export type ActionSheet = typeof ActionSheet.Type

/** Which view fills the middle of the full player. */
export const PlayerPanel = Schema.Literals(['Artwork', 'Lyrics', 'Queue'])
export type PlayerPanel = typeof PlayerPanel.Type
