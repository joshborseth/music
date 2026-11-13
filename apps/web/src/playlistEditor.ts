import { Array, Option, Schema, pipe } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { type Song } from '@music/shared'

/*
 * Editing one of my own playlists in place, as Apple Music does: its title
 * and description become fields, its songs get a handle to drag them by and
 * a button to take them out, and Add Songs opens a search that adds to it.
 * Moves, covers, and songs added or removed are saved as they happen; the
 * title and description when Done is tapped.
 */

/** Whether a playlist page is being edited, and what has been typed. */
export const PlaylistEditor = defineTaggedUnion({
  Closed: {},
  Editing: {
    playlistId: Schema.String,
    titleInput: Schema.String,
    descriptionInput: Schema.String,
  },
})
export type PlaylistEditor = typeof PlaylistEditor.Type

/** The search in the Add Songs sheet: what is typed, and what was searched. */
export const AddSongsSearch = Schema.Struct({
  input: Schema.String,
  query: Schema.String,
})
export type AddSongsSearch = typeof AddSongsSearch.Type

export const ADD_SONGS_INPUT_ID = 'add-songs-input'

/** Whether the page of the playlist with this id is being edited. */
export const isEditing = (
  editor: PlaylistEditor,
  playlistId: string,
): boolean => editor._tag === 'Editing' && editor.playlistId === playlistId

/**
 * The songs with one moved before another, or to the end when that one is
 * gone. The server moves it the same way (`moveSong` in the store).
 */
export const moveSong = (
  songs: ReadonlyArray<Song>,
  videoId: string,
  maybeBeforeVideoId: Option.Option<string>,
): ReadonlyArray<Song> =>
  Option.match(
    Array.findFirst(songs, song => song.videoId === videoId),
    {
      onNone: () => songs,
      onSome: moving => {
        const others = Array.filter(songs, song => song.videoId !== videoId)
        const at = pipe(
          maybeBeforeVideoId,
          Option.flatMap(beforeId =>
            Array.findFirstIndex(others, song => song.videoId === beforeId),
          ),
          Option.getOrElse(() => others.length),
        )
        return [...Array.take(others, at), moving, ...Array.drop(others, at)]
      },
    },
  )
