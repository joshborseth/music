import { Array, Option, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import {
  Check,
  Disc3,
  FileText,
  Heart,
  ListEnd,
  ListMinus,
  ListPlus,
  ListStart,
  MicVocal,
  Pencil,
  Plus,
  Power,
  SquareArrowUpRightExit,
  Trash2,
} from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  MAX_PLAYLIST_TITLE_LENGTH,
  type MyPlaylistSummary,
  type Session,
  type Song,
} from '@music/shared'

import { PLAYLIST_TITLE_INPUT_ID } from '../constant'
import { Message } from '../message'
import { type Model } from '../model'
import { DragToDismiss } from '../mount'
import {
  deviceStatus,
  deviceStatusText,
  playbackOutput,
} from '../playback/domain'
import { myLibraryQuery, myPlaylistQuery } from '../query'
import { AppRoute } from '../route'
import { ActionSheet, SheetContent } from '../sheet'
import { likedVideoIds } from '../update'
import { deviceIcon, thisDeviceName } from './player'
import {
  ArtworkShape,
  albumHref,
  artistHref,
  artistNames,
  artworkImage,
  firstArtistId,
  playlistCover,
  playlistLength,
  songHref,
} from './shared'

const actionClass =
  'flex h-14 w-full items-center gap-4 px-5 text-left text-[17px] transition-colors active:bg-muted'

const actionButton = (
  onClick: Message,
  iconNode: typeof Disc3,
  label: string,
  h: HtmlBuilder<Message>,
  isDestructive: boolean = false,
  iconClass: string = '',
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(onClick),
      h.Class(cn(actionClass, isDestructive && 'text-destructive')),
    ],
    [
      icon(
        h,
        iconNode,
        cn(
          'size-[22px]',
          isDestructive ? 'text-destructive' : 'text-primary',
          iconClass,
        ),
      ),
      label,
    ],
  )

const sheetHeading = (
  title: string,
  maybeSubtitle: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-0.5 px-5 pt-1 pb-3')],
    [
      h.h2(
        [h.Class('line-clamp-2 text-[20px] font-bold tracking-tight')],
        [title],
      ),
      Option.match(maybeSubtitle, {
        onNone: () => h.empty,
        onSome: subtitle =>
          h.p([h.Class('text-muted-foreground text-[15px]')], [subtitle]),
      }),
    ],
  )

/** The playlist of mine this page shows, if it holds the song. */
const shownPlaylistWith = (
  model: Model,
  videoId: string,
): Option.Option<MyPlaylistSummary> =>
  AppRoute.matchOrElse(
    model.route,
    {
      MyPlaylist: ({ playlistId }) =>
        pipe(
          AsyncData.getData(
            myPlaylistQuery.read(model.myPlaylists, { playlistId }),
          ),
          Option.filter(({ songs }) =>
            Array.some(songs, song => song.videoId === videoId),
          ),
          Option.map(({ playlist }) => playlist),
        ),
    },
    () => Option.none(),
  )

const actionLink = (
  href: string,
  iconNode: typeof Disc3,
  label: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [h.Href(href), h.Class(actionClass)],
    [icon(h, iconNode, 'text-primary size-[22px]'), label],
  )

const songActions = (
  model: Model,
  song: Song,
  h: HtmlBuilder<Message>,
): Html => {
  const isLiked = Array.contains(likedVideoIds(model), song.videoId)
  return songActionsFor(
    song,
    [
      actionButton(
        Message.ClickedToggleLiked({ song }),
        Heart,
        isLiked ? 'Remove from Liked Songs' : 'Add to Liked Songs',
        h,
        false,
        isLiked ? 'fill-current' : '',
      ),
      actionButton(
        Message.ClickedAddToPlaylist({ songs: [song], suggestedTitle: '' }),
        ListPlus,
        'Add to a Playlist…',
        h,
      ),
      Option.match(shownPlaylistWith(model, song.videoId), {
        onNone: () => h.empty,
        onSome: playlist =>
          playlist.isLiked
            ? h.empty
            : actionButton(
                Message.ClickedRemoveFromPlaylist({
                  playlistId: playlist.id,
                  videoId: song.videoId,
                }),
                ListMinus,
                'Remove from This Playlist',
                h,
                true,
              ),
      }),
    ],
    h,
  )
}

const songActionsFor = (
  song: Song,
  playlistActions: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col')],
    [
      h.div(
        [h.Class('flex items-center gap-3 border-b px-5 pt-1 pb-4')],
        [
          artworkImage(
            {
              artwork: song.artwork,
              displayWidth: 56,
              shape: ArtworkShape.Square,
              className: 'size-14',
            },
            h,
          ),
          h.div(
            [h.Class('flex min-w-0 flex-col')],
            [
              h.p(
                [h.Class('line-clamp-1 text-[17px] font-semibold')],
                [song.title],
              ),
              h.p(
                [h.Class('text-muted-foreground line-clamp-1 text-[15px]')],
                [artistNames(song.artists)],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('flex flex-col py-2')],
        [
          actionButton(
            Message.ClickedEnqueueSongs({ songs: [song], placement: 'Next' }),
            ListStart,
            'Play next',
            h,
          ),
          actionButton(
            Message.ClickedEnqueueSongs({ songs: [song], placement: 'Last' }),
            ListEnd,
            'Add to queue',
            h,
          ),
          ...playlistActions,
          Option.match(song.maybeAlbum, {
            onNone: () => h.empty,
            onSome: album =>
              actionLink(albumHref(album.id), Disc3, 'Go to album', h),
          }),
          Option.match(firstArtistId(song.artists), {
            onNone: () => h.empty,
            onSome: artistId =>
              actionLink(artistHref(artistId), MicVocal, 'Go to artist', h),
          }),
          actionLink(songHref(song.videoId), FileText, 'Lyrics and details', h),
        ],
      ),
    ],
  )

/** What a device row says under its name. */
const deviceRowStatus = (
  state: Session.SessionState,
  device: Session.Device,
  isThisOne: boolean,
  isOutput: boolean,
): string => {
  const status = deviceStatus(state, device)
  if (!isThisOne) {
    return deviceStatusText(device, status)
  } else if (isOutput && state.currentEntryId !== null) {
    return state.playing ? 'Playing' : 'Paused'
  } else {
    return 'You are here'
  }
}

/**
 * Turn the TV on and open Joshify, without moving the music: to pick songs on
 * it, or to watch what plays. Only while the app is not open on it.
 */
const wakeButton = (
  state: Session.SessionState,
  device: Session.Device,
  h: HtmlBuilder<Message>,
): Html => {
  const status = deviceStatus(state, device)
  if (device.kind !== 'Tv' || (status !== 'Off' && status !== 'Closed')) {
    return h.empty
  }
  return h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedWakeDevice({ deviceId: device.id })),
      h.AriaLabel(
        status === 'Off'
          ? `Turn on ${device.name} and open Joshify`
          : `Open Joshify on ${device.name}`,
      ),
      h.Class(
        'bg-muted mr-5 flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold active:opacity-60',
      ),
    ],
    [
      icon(h, status === 'Off' ? Power : SquareArrowUpRightExit, 'size-3.5'),
      status === 'Off' ? 'Turn on' : 'Open',
    ],
  )
}

const devicePicker = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col')],
    [
      h.h2(
        [h.Class('px-5 pt-1 pb-3 text-[20px] font-bold tracking-tight')],
        ['Play on'],
      ),
      Option.match(model.maybeSession, {
        onNone: () =>
          h.p(
            [h.Class('text-muted-foreground px-5 pb-4 text-[15px]')],
            ['Connecting to the music server…'],
          ),
        onSome: ({ state }) => {
          const maybeMyDeviceId = Option.map(
            model.maybeIdentity,
            ({ deviceId }) => deviceId,
          )
          const outputId = Option.match(
            playbackOutput(state, maybeMyDeviceId),
            {
              onNone: () => Option.getOrElse(maybeMyDeviceId, () => ''),
              onSome: ({ device }) => device.id,
            },
          )
          return h.div(
            [h.Class('flex flex-col pb-2')],
            [
              ...Array.map(state.devices, device => {
                const isThisOne = Option.contains(maybeMyDeviceId, device.id)
                const isOutput = device.id === outputId
                const status = deviceRowStatus(
                  state,
                  device,
                  isThisOne,
                  isOutput,
                )
                return h.keyed('div')(
                  device.id,
                  [h.Class('flex items-center')],
                  [
                    h.button(
                      [
                        h.Type('button'),
                        h.OnClick(
                          Message.ClickedDevice({ deviceId: device.id }),
                        ),
                        h.AriaPressed(isOutput ? 'true' : 'false'),
                        h.Class(cn(actionClass, 'h-16 min-w-0 flex-1')),
                      ],
                      [
                        h.span(
                          [
                            h.Class(
                              cn(
                                'flex size-10 shrink-0 items-center justify-center rounded-full',
                                isOutput
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-muted',
                              ),
                            ),
                          ],
                          [icon(h, deviceIcon(device, isThisOne), 'size-5')],
                        ),
                        h.span(
                          [h.Class('flex min-w-0 flex-1 flex-col')],
                          [
                            h.span(
                              [h.Class('line-clamp-1 font-medium')],
                              [isThisOne ? thisDeviceName(model) : device.name],
                            ),
                            h.span(
                              [
                                h.Class(
                                  cn(
                                    'line-clamp-1 text-[13px]',
                                    isOutput
                                      ? 'text-primary'
                                      : 'text-muted-foreground',
                                  ),
                                ),
                              ],
                              [status],
                            ),
                          ],
                        ),
                        isOutput
                          ? icon(h, Check, 'text-primary size-5 shrink-0')
                          : h.empty,
                      ],
                    ),
                    wakeButton(state, device, h),
                  ],
                )
              }),
              h.p(
                [h.Class('text-muted-foreground px-5 pt-2 text-[13px]')],
                [
                  'Tap a device to move the music there. Open and Turn on start Joshify on the TV without moving the music.',
                ],
              ),
            ],
          )
        },
      }),
    ],
  )

// PLAYLISTS

const pickerRowClass =
  'flex w-full items-center gap-3 px-5 py-2 text-left transition-colors active:bg-muted'

const PICKER_COVER_WIDTH = 48

const songCountText = (songs: ReadonlyArray<Song>): Option.Option<string> =>
  songs.length > 1 ? Option.some(`${songs.length} songs`) : Option.none()

/** Every playlist of mine to add songs to, after a row for a new one. */
const playlistPicker = (
  model: Model,
  songs: ReadonlyArray<Song>,
  suggestedTitle: string,
  h: HtmlBuilder<Message>,
): Html => {
  const library = myLibraryQuery.read(model.myLibrary)
  const playlists = Option.match(AsyncData.getData(library), {
    onNone: () => [],
    onSome: ({ playlists: mine }) =>
      Array.filter(mine, playlist => !playlist.isLiked),
  })
  return h.div(
    [h.Class('flex flex-col')],
    [
      sheetHeading('Add to a Playlist', songCountText(songs), h),
      h.div(
        [
          h.DataAttribute('sheet-scroll', ''),
          h.Class('flex max-h-[55dvh] flex-col overflow-y-auto pb-2'),
        ],
        [
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedNewPlaylist({ songs, suggestedTitle })),
              h.Class(pickerRowClass),
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
              h.span(
                [h.Class('text-primary text-[17px] font-medium')],
                ['New Playlist…'],
              ),
            ],
          ),
          ...Array.map(playlists, playlist =>
            h.keyed('button')(
              playlist.id,
              [
                h.Type('button'),
                h.OnClick(
                  Message.ClickedPlaylistOption({
                    playlistId: playlist.id,
                    songs,
                  }),
                ),
                h.Class(pickerRowClass),
              ],
              [
                playlistCover(
                  {
                    playlist,
                    displayWidth: PICKER_COVER_WIDTH,
                    shape: ArtworkShape.Square,
                    className: 'size-12',
                  },
                  h,
                ),
                h.span(
                  [h.Class('flex min-w-0 flex-col')],
                  [
                    h.span(
                      [h.Class('line-clamp-1 text-[17px] font-medium')],
                      [playlist.title],
                    ),
                    h.span(
                      [h.Class('text-muted-foreground text-[13px]')],
                      [playlistLength(playlist)],
                    ),
                  ],
                ),
              ],
            ),
          ),
          AsyncData.isPending(library) && Array.isReadonlyArrayEmpty(playlists)
            ? h.p(
                [h.Class('text-muted-foreground px-5 py-3 text-[15px]')],
                ['Loading your playlists…'],
              )
            : h.empty,
        ],
      ),
    ],
  )
}

const sheetButtonClass =
  'pressable flex h-12 flex-1 items-center justify-center rounded-xl text-[17px] font-semibold'

/** A form that names a playlist, for a new one or a rename. */
const playlistTitleForm = (
  model: Model,
  config: Readonly<{
    heading: string
    maybeSubtitle: Option.Option<string>
    submitLabel: string
    onSubmit: Message
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [h.OnSubmit(config.onSubmit), h.Class('flex flex-col gap-4 px-5 pb-2')],
    [
      h.div(
        [h.Class('-mx-5')],
        [sheetHeading(config.heading, config.maybeSubtitle, h)],
      ),
      h.label(
        [h.For(PLAYLIST_TITLE_INPUT_ID), h.Class('sr-only')],
        ['Playlist name'],
      ),
      h.input([
        h.Id(PLAYLIST_TITLE_INPUT_ID),
        h.Type('text'),
        h.Value(model.playlistTitleInput),
        h.Placeholder('Playlist name'),
        h.Maxlength(MAX_PLAYLIST_TITLE_LENGTH),
        h.Autocomplete('off'),
        h.Attribute('enterkeyhint', 'done'),
        h.DataAttribute('no-drag', ''),
        h.OnInput(value => Message.UpdatedPlaylistTitleInput({ value })),
        h.Class(
          'bg-muted placeholder:text-muted-foreground h-12 w-full rounded-xl px-4 text-[17px] outline-none',
        ),
      ]),
      h.div(
        [h.Class('flex gap-3')],
        [
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedCloseSheet()),
              h.Class(cn(sheetButtonClass, 'bg-secondary text-primary')),
            ],
            ['Cancel'],
          ),
          h.button(
            [
              h.Type('submit'),
              h.Class(
                cn(sheetButtonClass, 'bg-primary text-primary-foreground'),
              ),
            ],
            [config.submitLabel],
          ),
        ],
      ),
    ],
  )

const playlistActions = (
  playlistId: string,
  title: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col')],
    [
      sheetHeading(title, Option.none(), h),
      h.div(
        [h.Class('flex flex-col border-t py-2')],
        [
          actionButton(
            Message.ClickedRenamePlaylist({ playlistId, title }),
            Pencil,
            'Rename',
            h,
          ),
          actionButton(
            Message.ClickedDeletePlaylist({ playlistId, title }),
            Trash2,
            'Delete Playlist',
            h,
            true,
          ),
        ],
      ),
    ],
  )

const confirmDeletePlaylist = (
  playlistId: string,
  title: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-4 pb-2')],
    [
      sheetHeading(
        `Delete “${title}”?`,
        Option.some(
          'The playlist goes away on every device. Its songs stay on YouTube Music.',
        ),
        h,
      ),
      h.div(
        [h.Class('flex gap-3 px-5')],
        [
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedCloseSheet()),
              h.Class(cn(sheetButtonClass, 'bg-secondary text-primary')),
            ],
            ['Cancel'],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ConfirmedDeletePlaylist({ playlistId })),
              h.Class(cn(sheetButtonClass, 'bg-destructive text-white')),
            ],
            ['Delete'],
          ),
        ],
      ),
    ],
  )

const confirmClearLibrary = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-4 pb-2')],
    [
      sheetHeading(
        'Clear History?',
        Option.some(
          'The songs played and pages opened on this device are forgotten. Your playlists and liked songs stay.',
        ),
        h,
      ),
      h.div(
        [h.Class('flex gap-3 px-5')],
        [
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedCloseSheet()),
              h.Class(cn(sheetButtonClass, 'bg-secondary text-primary')),
            ],
            ['Cancel'],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ConfirmedClearLibrary()),
              h.Class(cn(sheetButtonClass, 'bg-destructive text-white')),
            ],
            ['Clear'],
          ),
        ],
      ),
    ],
  )

const sheetContent = (
  model: Model,
  content: SheetContent,
  h: HtmlBuilder<Message>,
): Html =>
  SheetContent.match(content, {
    SongActions: ({ song }) => songActions(model, song, h),
    Devices: () => devicePicker(model, h),
    AddToPlaylist: ({ songs, suggestedTitle }) =>
      playlistPicker(model, songs, suggestedTitle, h),
    NewPlaylist: ({ songs }) =>
      playlistTitleForm(
        model,
        {
          heading: 'New Playlist',
          maybeSubtitle: songCountText(songs),
          submitLabel: 'Create',
          onSubmit: Message.SubmittedNewPlaylist({ songs }),
        },
        h,
      ),
    PlaylistActions: ({ playlistId, title }) =>
      playlistActions(playlistId, title, h),
    RenamePlaylist: ({ playlistId }) =>
      playlistTitleForm(
        model,
        {
          heading: 'Rename Playlist',
          maybeSubtitle: Option.none(),
          submitLabel: 'Save',
          onSubmit: Message.SubmittedRenamePlaylist({ playlistId }),
        },
        h,
      ),
    ConfirmDeletePlaylist: ({ playlistId, title }) =>
      confirmDeletePlaylist(playlistId, title, h),
    ConfirmClearLibrary: () => confirmClearLibrary(h),
  })

const sheetLabel = (content: SheetContent): string =>
  SheetContent.match(content, {
    SongActions: ({ song }) => song.title,
    Devices: () => 'Play on',
    AddToPlaylist: () => 'Add to a playlist',
    NewPlaylist: () => 'New playlist',
    PlaylistActions: ({ title }) => title,
    RenamePlaylist: () => 'Rename playlist',
    ConfirmDeletePlaylist: () => 'Delete playlist',
    ConfirmClearLibrary: () => 'Clear history',
  })

const sheetFrame = (
  model: Model,
  content: SheetContent,
  isOpen: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const state = isOpen ? 'open' : 'closed'
  return h.div(
    [],
    [
      h.div([
        h.AriaHidden(true),
        h.DataAttribute('sheet-backdrop', ''),
        h.DataAttribute('state', state),
        h.OnClick(Message.ClickedCloseSheet()),
        h.Class('sheet-backdrop fixed inset-0 z-50 bg-black/45'),
      ]),
      h.div(
        [
          h.Role('dialog'),
          h.AriaModal(true),
          h.AriaLabel(sheetLabel(content)),
          h.AriaHidden(!isOpen),
          h.Inert(!isOpen),
          h.DataAttribute('state', state),
          h.OnMount(DragToDismiss({ sheet: 'ActionSheet' })),
          h.Class(
            'sheet bg-popover text-popover-foreground fixed inset-x-0 bottom-0 z-50 mx-auto max-w-xl rounded-t-[1.5rem] pb-[calc(var(--safe-bottom)+0.5rem)] shadow-2xl',
          ),
        ],
        [
          h.div(
            [h.Class('flex justify-center pt-2 pb-3')],
            [
              h.span([
                h.AriaHidden(true),
                h.Class('bg-muted-foreground/40 h-[5px] w-10 rounded-full'),
              ]),
            ],
          ),
          sheetContent(model, content, h),
        ],
      ),
    ],
  )
}

/** The action sheet, sliding up over everything when shown. */
export const actionSheetView = (model: Model, h: HtmlBuilder<Message>): Html =>
  ActionSheet.match(model.actionSheet, {
    Hidden: () => h.empty,
    Shown: ({ content }) => sheetFrame(model, content, true, h),
    Dismissed: ({ content }) => sheetFrame(model, content, false, h),
  })
