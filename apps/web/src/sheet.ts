import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { Song } from '@music/shared'

/** What an action sheet offers. */
export const SheetContent = defineTaggedUnion({
  SongActions: { song: Song },
  Devices: {},
  /** Pick one of my playlists to add the songs to, or start a new one. */
  AddToPlaylist: { songs: Schema.Array(Song), suggestedTitle: Schema.String },
  /** Name a new playlist holding the songs. */
  NewPlaylist: { songs: Schema.Array(Song) },
  PlaylistActions: { playlistId: Schema.String, title: Schema.String },
  RenamePlaylist: { playlistId: Schema.String },
  ConfirmDeletePlaylist: { playlistId: Schema.String, title: Schema.String },
  /** Forget the albums, artists, and playlists opened on this device. */
  ConfirmClearRecentlyViewed: {},
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
