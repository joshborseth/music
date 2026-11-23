import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { Person, Song } from '@music/shared'

import { DownloadKind } from './downloads/domain'
import { SortableKind } from './library'

/** A page whose ⋯ opens `CollectionActions`. */
export const CollectionKind = Schema.Literals(['Album', 'Playlist'])
export type CollectionKind = typeof CollectionKind.Type

/** What an action sheet offers. */
export const SheetContent = defineTaggedUnion({
  SongActions: { song: Song },
  /**
   * Everything that can be done with a whole album or playlist. The sheet
   * reads it from the page's own data, so it stays as current as the page.
   */
  CollectionActions: { kind: CollectionKind, id: Schema.String },
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
  /** What an admin can do about someone with an account. */
  PersonActions: { person: Person },
  /** An admin gives someone a new password. */
  ResetPassword: { userId: Schema.String, username: Schema.String },
  ConfirmRemovePerson: { userId: Schema.String, username: Schema.String },
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
