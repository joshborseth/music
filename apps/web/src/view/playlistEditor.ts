import { Array, Option, String } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { Check, CircleMinus, CirclePlus, Menu, Plus, Search } from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  MAX_PLAYLIST_DESCRIPTION_LENGTH,
  MAX_PLAYLIST_TITLE_LENGTH,
  type MyPlaylistDetails,
  type Song,
  coverSongs,
  mosaicCovers,
} from '@music/shared'

import { Message } from '../message'
import { type Model } from '../model'
import { FollowPlaylistDrags, SyncTitleBarReveal } from '../mount'
import { ADD_SONGS_INPUT_ID } from '../playlistEditor'
import { homeQuery, myPlaylistQuery, songSearchQuery } from '../query'
import {
  HERO_ARTWORK_CLASS,
  HERO_ARTWORK_WIDTH,
  artworkGlow,
} from './collection'
import {
  ArtworkShape,
  artistNames,
  artworkImage,
  loadingRows,
  playlistCover,
  requestErrorAlert,
} from './shared'

/*
 * One of my playlists being edited, in place of its page, and the two sheets
 * editing opens: Add Songs, a search that adds to it, and the cover choice.
 */

const ROW_ARTWORK_WIDTH = 48

const COVER_TILE_WIDTH = 110

const fieldClass =
  'bg-muted/80 placeholder:text-muted-foreground w-full rounded-xl px-4 outline-none'

/** "Done", over the top right while a playlist is edited. */
export const doneEditingButton = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedDoneEditingPlaylist()),
      h.Class(
        'pressable floating text-primary pointer-events-auto flex h-10 items-center rounded-full px-4 text-[17px] font-semibold',
      ),
    ],
    ['Done'],
  )

/** The cover, which opens the cover choice, with its title and description as fields. */
const editingHeader = (
  details: MyPlaylistDetails,
  titleInput: string,
  descriptionInput: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.header(
    [
      h.Class(
        'flex flex-col items-center gap-3 px-6 pt-[calc(var(--safe-top)+3.75rem)] text-center',
      ),
    ],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(
            Message.ClickedChoosePlaylistCover({
              playlistId: details.playlist.id,
            }),
          ),
          h.AriaLabel('Change Cover'),
          h.Class('pressable flex flex-col items-center'),
        ],
        [
          playlistCover(
            {
              playlist: details.playlist,
              displayWidth: HERO_ARTWORK_WIDTH,
              shape: ArtworkShape.Card,
              className: HERO_ARTWORK_CLASS,
              isEager: true,
            },
            h,
          ),
          h.span(
            [h.Class('text-primary -mt-1 text-[15px] font-semibold')],
            ['Change Cover'],
          ),
        ],
      ),
      h.input([
        h.Type('text'),
        h.Value(titleInput),
        h.AriaLabel('Playlist name'),
        h.Placeholder('Playlist name'),
        h.Maxlength(MAX_PLAYLIST_TITLE_LENGTH),
        h.Autocomplete('off'),
        h.Attribute('enterkeyhint', 'done'),
        h.OnMount(SyncTitleBarReveal()),
        h.OnInput(value => Message.UpdatedPlaylistEditorTitle({ value })),
        h.Class(
          cn(
            fieldClass,
            'h-12 text-center text-[22px] font-bold tracking-tight',
          ),
        ),
      ]),
      h.textarea([
        h.Value(descriptionInput),
        h.AriaLabel('Description'),
        h.Placeholder('Add Description'),
        h.Maxlength(MAX_PLAYLIST_DESCRIPTION_LENGTH),
        h.Rows(3),
        h.OnInput(value => Message.UpdatedPlaylistEditorDescription({ value })),
        h.Class(cn(fieldClass, 'resize-none py-3 text-left text-[15px]')),
      ]),
    ],
  )

/** The row that opens Add Songs, as the first row of the list. */
const addSongsRow = (playlistId: string, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedAddSongs({ playlistId })),
      h.Class(
        'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors active:bg-muted/70',
      ),
    ],
    [
      h.span(
        [
          h.Class(
            'bg-muted text-primary flex size-12 shrink-0 items-center justify-center rounded-md',
          ),
        ],
        [icon(h, Plus, 'size-6')],
      ),
      h.span([h.Class('text-primary text-[15px] font-medium')], ['Add Songs']),
    ],
  )

const songText = (song: Song, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class('flex min-w-0 flex-1 flex-col')],
    [
      h.span(
        [h.Class('line-clamp-1 text-[15px] leading-snug font-medium')],
        [song.title],
      ),
      h.span(
        [
          h.Class(
            'text-muted-foreground line-clamp-1 text-[13px] leading-snug',
          ),
        ],
        [artistNames(song.artists)],
      ),
    ],
  )

const songArtwork = (song: Song, h: HtmlBuilder<Message>): Html =>
  artworkImage(
    {
      artwork: song.artwork,
      displayWidth: ROW_ARTWORK_WIDTH,
      shape: ArtworkShape.Square,
      className: 'size-12',
    },
    h,
  )

/** A song being edited: take it out, or drag it by its handle. */
const editingRow = (
  playlistId: string,
  song: Song,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center gap-3 pl-2')],
    [
      h.button(
        [
          h.Type('button'),
          h.OnClick(
            Message.ClickedRemoveFromPlaylist({
              playlistId,
              videoId: song.videoId,
            }),
          ),
          h.AriaLabel(`Remove ${song.title}`),
          h.Class(
            'text-destructive flex size-9 shrink-0 items-center justify-center rounded-full active:opacity-50',
          ),
        ],
        [icon(h, CircleMinus, 'size-[22px] fill-current stroke-background')],
      ),
      songArtwork(song, h),
      songText(song, h),
      h.div(
        [
          h.DataAttribute('reorder-handle', ''),
          h.AriaHidden(true),
          h.Class(
            'text-muted-foreground flex h-14 w-12 shrink-0 cursor-grab touch-none items-center justify-center select-none [-webkit-touch-callout:none]',
          ),
        ],
        [icon(h, Menu, 'size-[22px]')],
      ),
    ],
  )

/**
 * The songs, each with its handle; `FollowPlaylistDrags` moves them. A row
 * being dragged is lifted onto a solid surface above the rows it passes.
 */
const editingSongs = (
  details: MyPlaylistDetails,
  h: HtmlBuilder<Message>,
): Html =>
  h.ul(
    [
      h.AriaLabel('Songs'),
      h.OnMount(FollowPlaylistDrags({ playlistId: details.playlist.id })),
      h.Class('flex flex-col'),
    ],
    Array.map(details.songs, song =>
      h.keyed('li')(
        song.videoId,
        [
          h.DataAttribute('playlist-song', song.videoId),
          h.Class(
            'data-dragging:bg-popover data-dragging:relative data-dragging:z-10 data-dragging:shadow-[0_12px_28px_-10px_rgb(0_0_0/0.45)]',
          ),
        ],
        [editingRow(details.playlist.id, song, h)],
      ),
    ),
  )

/** My playlist page while it is being edited. */
export const editingPlaylistView = (
  details: MyPlaylistDetails,
  titleInput: string,
  descriptionInput: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('relative isolate flex flex-col gap-5 pb-6')],
    [
      artworkGlow(
        Option.getOrElse(Array.head(details.playlist.covers), () => []),
        h,
      ),
      editingHeader(details, titleInput, descriptionInput, h),
      h.section(
        [h.AriaLabel('Tracks'), h.Class('border-t')],
        [addSongsRow(details.playlist.id, h), editingSongs(details, h)],
      ),
    ],
  )

// ADD SONGS

const loadedDetails = (
  model: Model,
  playlistId: string,
): Option.Option<MyPlaylistDetails> =>
  AsyncData.getData(myPlaylistQuery.read(model.myPlaylists, { playlistId }))

/** A song to add: + adds it, and its check takes it out again. */
const pickableSongRow = (
  playlistId: string,
  heldVideoIds: ReadonlyArray<string>,
  song: Song,
  h: HtmlBuilder<Message>,
): Html => {
  const isHeld = Array.contains(heldVideoIds, song.videoId)
  return h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedToggleSongInPlaylist({ playlistId, song })),
      h.AriaLabel(isHeld ? `Remove ${song.title}` : `Add ${song.title}`),
      h.AriaPressed(isHeld ? 'true' : 'false'),
      h.Class(
        'flex w-full items-center gap-3 px-5 py-1.5 text-left transition-colors active:bg-muted',
      ),
    ],
    [
      songArtwork(song, h),
      songText(song, h),
      icon(
        h,
        isHeld ? Check : CirclePlus,
        cn('size-6 shrink-0', isHeld ? 'text-primary' : 'text-primary/80'),
      ),
    ],
  )
}

const pickableSongs = (
  playlistId: string,
  heldVideoIds: ReadonlyArray<string>,
  songs: ReadonlyArray<Song>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Role('list'), h.Class('flex flex-col')],
    Array.map(songs, song =>
      h.keyed('div')(
        song.videoId,
        [h.Role('listitem')],
        [pickableSongRow(playlistId, heldVideoIds, song, h)],
      ),
    ),
  )

const hint = (text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Class('text-muted-foreground px-5 py-6 text-[15px]')], [text])

/** Before anything is typed: the songs played lately, from Home. */
const suggestions = (
  model: Model,
  playlistId: string,
  heldVideoIds: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(
    Option.filter(
      Option.map(
        AsyncData.getData(homeQuery.read(model.home)),
        ({ recentlyPlayed }) => recentlyPlayed,
      ),
      Array.isReadonlyArrayNonEmpty,
    ),
    {
      onNone: () => hint('Search for songs to add.', h),
      onSome: songs =>
        h.section(
          [h.Class('flex flex-col gap-1')],
          [
            h.h3(
              [
                h.Class(
                  'text-muted-foreground px-5 pt-2 text-[13px] font-semibold tracking-wide uppercase',
                ),
              ],
              ['Recently Played'],
            ),
            pickableSongs(playlistId, heldVideoIds, songs, h),
          ],
        ),
    },
  )

const searchResults = (
  model: Model,
  playlistId: string,
  heldVideoIds: ReadonlyArray<string>,
  query: string,
  h: HtmlBuilder<Message>,
): Html =>
  AsyncData.matchData(songSearchQuery.read(model.songSearch, { query }), {
    onEmpty: () => loadingRows(h),
    onFailure: error => requestErrorAlert(error, h),
    onData: songs =>
      Array.isReadonlyArrayEmpty(songs)
        ? hint(`No songs found for “${query}”.`, h)
        : pickableSongs(playlistId, heldVideoIds, songs, h),
  })

/** Add Songs: search YouTube Music and add songs to the playlist one by one. */
export const addSongsSheet = (
  model: Model,
  playlistId: string,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeDetails = loadedDetails(model, playlistId)
  const heldVideoIds = Option.match(maybeDetails, {
    onNone: () => [],
    onSome: ({ songs }) => Array.map(songs, ({ videoId }) => videoId),
  })
  const { input, query } = model.addSongsSearch
  return h.div(
    [h.Class('flex h-[calc(100dvh-var(--safe-top)-4rem)] flex-col')],
    [
      h.div(
        [h.Class('flex items-start justify-between gap-3 px-5 pt-1 pb-3')],
        [
          h.div(
            [h.Class('flex min-w-0 flex-col gap-0.5')],
            [
              h.h2(
                [h.Class('text-[20px] font-bold tracking-tight')],
                ['Add Songs'],
              ),
              Option.match(maybeDetails, {
                onNone: () => h.empty,
                onSome: ({ playlist }) =>
                  h.p(
                    [h.Class('text-muted-foreground line-clamp-1 text-[15px]')],
                    [`To “${playlist.title}”`],
                  ),
              }),
            ],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedCloseSheet()),
              h.Class('text-primary h-8 text-[17px] font-semibold'),
            ],
            ['Done'],
          ),
        ],
      ),
      h.div(
        [h.Role('search'), h.Class('relative px-5 pb-3')],
        [
          h.label(
            [h.For(ADD_SONGS_INPUT_ID), h.Class('sr-only')],
            ['Search songs to add'],
          ),
          h.span(
            [
              h.Class(
                'text-muted-foreground pointer-events-none absolute top-5 left-7.5 -translate-y-1/2',
              ),
            ],
            [icon(h, Search, 'size-[18px]')],
          ),
          h.input([
            h.Id(ADD_SONGS_INPUT_ID),
            h.Type('search'),
            h.Value(input),
            h.Placeholder('Songs to add'),
            h.Autocomplete('off'),
            h.Attribute('autocorrect', 'off'),
            h.Attribute('autocapitalize', 'off'),
            h.Spellcheck(false),
            h.Attribute('enterkeyhint', 'search'),
            h.DataAttribute('no-drag', ''),
            h.OnInput(value => Message.UpdatedAddSongsInput({ value })),
            h.Class(
              'bg-muted placeholder:text-muted-foreground h-10 w-full rounded-xl pr-3 pl-9 text-[17px] outline-none [&::-webkit-search-cancel-button]:hidden',
            ),
          ]),
        ],
      ),
      h.div(
        [
          h.DataAttribute('sheet-scroll', ''),
          h.Class('min-h-0 flex-1 overflow-y-auto overscroll-contain border-t'),
        ],
        [
          String.isNonEmpty(query)
            ? searchResults(model, playlistId, heldVideoIds, query, h)
            : suggestions(model, playlistId, heldVideoIds, h),
        ],
      ),
    ],
  )
}

// COVER

/** One choice of cover: its picture and its name, ringed when it is the one shown. */
const coverChoice = (
  config: Readonly<{
    label: string
    accessibleLabel: string
    isSelected: boolean
    onClick: Message
    picture: Html
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(config.onClick),
      h.AriaLabel(config.accessibleLabel),
      h.AriaPressed(config.isSelected ? 'true' : 'false'),
      h.Class(
        'pressable flex min-w-0 flex-col items-stretch gap-1.5 text-left',
      ),
    ],
    [
      h.span(
        [
          h.Class(
            cn(
              'block rounded-xl p-0.5 ring-2',
              config.isSelected ? 'ring-primary' : 'ring-transparent',
            ),
          ),
        ],
        [config.picture],
      ),
      h.span(
        [
          h.Class(
            cn(
              'line-clamp-1 px-0.5 text-[12px] leading-tight',
              config.isSelected
                ? 'text-primary font-semibold'
                : 'text-muted-foreground',
            ),
          ),
        ],
        [config.label],
      ),
    ],
  )

/** The cover choice: the mosaic, or the cover of one of its songs. */
export const chooseCoverSheet = (
  model: Model,
  playlistId: string,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(loadedDetails(model, playlistId), {
    onNone: () => loadingRows(h),
    onSome: ({ playlist, songs }) =>
      h.div(
        [h.Class('flex flex-col')],
        [
          h.h2(
            [h.Class('px-5 pt-1 pb-3 text-[20px] font-bold tracking-tight')],
            ['Choose a Cover'],
          ),
          h.div(
            [
              h.DataAttribute('sheet-scroll', ''),
              h.Role('group'),
              h.AriaLabel('Covers'),
              h.Class(
                'grid max-h-[60dvh] grid-cols-3 gap-x-3 gap-y-4 overflow-y-auto overscroll-contain border-t px-5 pt-4 pb-2',
              ),
            ],
            [
              coverChoice(
                {
                  label: 'Mosaic',
                  accessibleLabel: 'Mosaic',
                  isSelected: Option.isNone(playlist.maybeCoverVideoId),
                  onClick: Message.SelectedPlaylistCover({
                    playlistId,
                    maybeVideoId: Option.none(),
                  }),
                  picture: playlistCover(
                    {
                      playlist: { ...playlist, covers: mosaicCovers(songs) },
                      displayWidth: COVER_TILE_WIDTH,
                      shape: ArtworkShape.Card,
                      className: 'aspect-square w-full',
                    },
                    h,
                  ),
                },
                h,
              ),
              ...Array.map(coverSongs(songs), song =>
                coverChoice(
                  {
                    label: Option.match(song.maybeAlbum, {
                      onNone: () => song.title,
                      onSome: ({ name }) => name,
                    }),
                    accessibleLabel: `Cover of ${song.title}`,
                    isSelected: Option.contains(
                      playlist.maybeCoverVideoId,
                      song.videoId,
                    ),
                    onClick: Message.SelectedPlaylistCover({
                      playlistId,
                      maybeVideoId: Option.some(song.videoId),
                    }),
                    picture: artworkImage(
                      {
                        artwork: song.artwork,
                        displayWidth: COVER_TILE_WIDTH,
                        shape: ArtworkShape.Card,
                        className: 'aspect-square w-full',
                      },
                      h,
                    ),
                  },
                  h,
                ),
              ),
            ],
          ),
        ],
      ),
  })
