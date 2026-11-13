import { Array, Option, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder, createLazy } from 'foldkit/html'
import {
  AudioLines,
  Check,
  CircleArrowDown,
  CircleX,
  Disc3,
  FileText,
  Heart,
  ListEnd,
  ListMinus,
  ListMusic,
  ListPlus,
  ListStart,
  MicVocal,
  Moon,
  Pencil,
  Plus,
  Power,
  Radio,
  Share,
  SquareArrowUpRightExit,
  TimerOff,
  Trash2,
} from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  type AlbumDetails,
  type Artwork,
  MAX_PLAYLIST_TITLE_LENGTH,
  type MyPlaylistSummary,
  type PlaylistDetails,
  type Session,
  type Song,
} from '@music/shared'

import { PLAYLIST_TITLE_INPUT_ID } from '../constant'
import {
  type DownloadKind,
  DownloadStatus,
  downloadStatus,
} from '../downloads/domain'
import { isAlbumSaved } from '../library'
import { Message } from '../message'
import { type Model } from '../model'
import { DragToDismiss } from '../mount'
import {
  SLEEP_TIMER_MINUTES,
  SleepCountdown,
  countdownText,
  currentEntry,
  deviceStatus,
  deviceStatusText,
  playbackOutput,
  sleepCountdown,
} from '../playback/domain'
import {
  albumQuery,
  myLibraryQuery,
  myPlaylistQuery,
  playlistQuery,
} from '../query'
import { AppRoute } from '../route'
import { ActionSheet, type CollectionKind, SheetContent } from '../sheet'
import { likedVideoIds } from '../update'
import {
  type DownloadRequest,
  albumDownload,
  playlistDownload,
} from './collectionDownload'
import { librarySortSheet } from './library'
import { deviceIcon, thisDeviceName } from './player'
import {
  type AddSongsModel,
  addSongsSheet,
  chooseCoverSheet,
} from './playlistEditor'
import {
  ArtworkShape,
  albumHref,
  artistHref,
  artistNames,
  artworkImage,
  firstArtistId,
  playlistCover,
  playlistHref,
  playlistLength,
  songHref,
} from './shared'

/**
 * What the action sheet shows. It leaves out the playback clock, so a
 * playing song never redraws a sheet, open or slid away. The sleep timer
 * sheet's countdown comes worked out instead, and only while it is that
 * sheet.
 */
export type SheetModel = Readonly<
  Pick<
    Model,
    | 'actionSheet'
    | 'route'
    | 'albums'
    | 'playlists'
    | 'myLibrary'
    | 'myPlaylists'
    | 'downloads'
    | 'libraryPrefs'
    | 'maybeIdentity'
    | 'maybeSession'
    | 'playlistTitleInput'
    | 'playerSheet'
  > &
    AddSongsModel & { sleepTimerSubtitle: string }
>

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
  model: SheetModel,
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

/**
 * Sound Check's switch, under the song playing in the full player's ⋯. It
 * is the session's, so it holds on every device; only the TV levels songs
 * so far, because iOS ignores a web page's audio volume.
 */
const soundCheckSwitch = (isOn: boolean, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedToggleSoundCheck()),
      h.AriaPressed(isOn ? 'true' : 'false'),
      h.Class(cn(actionClass, 'h-auto min-h-14 border-t py-2.5')),
    ],
    [
      icon(h, AudioLines, 'text-primary size-[22px] shrink-0'),
      h.span(
        [h.Class('flex min-w-0 flex-1 flex-col')],
        [
          'Sound Check',
          h.span(
            [h.Class('text-muted-foreground text-[13px]')],
            ['Plays every song at the same volume on the TV.'],
          ),
        ],
      ),
      h.span(
        [
          h.AriaHidden(true),
          h.Class(
            cn(
              'flex h-[31px] w-[51px] shrink-0 items-center rounded-full p-0.5 transition-colors',
              isOn ? 'bg-primary justify-end' : 'bg-muted justify-start',
            ),
          ),
        ],
        [h.span([h.Class('size-[27px] rounded-full bg-white shadow')])],
      ),
    ],
  )

/** Sound Check's switch, when the sheet is about the song in the open player. */
const playerSettings = (
  model: SheetModel,
  song: Song,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(
    Option.filter(
      model.maybeSession,
      ({ state }) =>
        model.playerSheet._tag === 'Open' &&
        Option.exists(
          currentEntry(state),
          entry => entry.track.videoId === song.videoId,
        ),
    ),
    {
      onNone: () => h.empty,
      onSome: ({ state }) => soundCheckSwitch(state.soundCheck, h),
    },
  )

const songActions = (
  model: SheetModel,
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
    model.route,
    playerSettings(model, song, h),
  )
}

/** Whether the page on screen is this album's, where Go to Album would stay put. */
const isOnAlbum = (route: AppRoute, albumId: string): boolean =>
  AppRoute.matchOrElse(
    route,
    { Album: album => album.albumId === albumId },
    () => false,
  )

/** Whether the page on screen is this song's own. */
const isOnSong = (route: AppRoute, videoId: string): boolean =>
  AppRoute.matchOrElse(
    route,
    { Song: page => page.videoId === videoId },
    () => false,
  )

/** The top of a sheet about one thing: its artwork, title, and who made it. */
const itemHeading = (
  artwork: Artwork,
  title: string,
  subtitle: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center gap-3 border-b px-5 pt-1 pb-4')],
    [
      artworkImage(
        {
          artwork,
          displayWidth: 56,
          shape: ArtworkShape.Square,
          className: 'size-14',
        },
        h,
      ),
      h.div(
        [h.Class('flex min-w-0 flex-col')],
        [
          h.p([h.Class('line-clamp-1 text-[17px] font-semibold')], [title]),
          h.p(
            [h.Class('text-muted-foreground line-clamp-1 text-[15px]')],
            [subtitle],
          ),
        ],
      ),
    ],
  )

/**
 * ⋯ on a song. Go to Album and Lyrics and Details leave out the page they
 * would open when it is the one on screen.
 */
const songActionsFor = (
  song: Song,
  playlistActions: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
  route: AppRoute,
  settings: Html = h.empty,
): Html =>
  h.div(
    [h.Class('flex flex-col')],
    [
      itemHeading(song.artwork, song.title, artistNames(song.artists), h),
      h.div(
        [h.Class('flex flex-col py-2')],
        [
          actionButton(
            Message.ClickedEnqueueSongs({ songs: [song], placement: 'Next' }),
            ListStart,
            'Play Next',
            h,
          ),
          actionButton(
            Message.ClickedEnqueueSongs({ songs: [song], placement: 'Last' }),
            ListEnd,
            'Add to Queue',
            h,
          ),
          actionButton(
            Message.ClickedStartRadio({ song }),
            Radio,
            'Start Radio',
            h,
          ),
          ...playlistActions,
          Option.match(
            Option.filter(song.maybeAlbum, ({ id }) => !isOnAlbum(route, id)),
            {
              onNone: () => h.empty,
              onSome: album =>
                actionLink(albumHref(album.id), Disc3, 'Go to Album', h),
            },
          ),
          Option.match(firstArtistId(song.artists), {
            onNone: () => h.empty,
            onSome: artistId =>
              actionLink(artistHref(artistId), MicVocal, 'Go to Artist', h),
          }),
          isOnSong(route, song.videoId)
            ? h.empty
            : actionLink(
                songHref(song.videoId),
                FileText,
                'Lyrics and Details',
                h,
              ),
          shareAction(song.title, songHref(song.videoId), h),
        ],
      ),
      settings,
    ],
  )

/** Download the songs, or take them off the phone once some are on it. */
const downloadAction = (
  model: SheetModel,
  request: DownloadRequest,
  h: HtmlBuilder<Message>,
): Html => {
  const { collection } = request
  const remove = actionButton(
    Message.ClickedRemoveDownload({
      kind: collection.kind,
      id: collection.id,
      title: collection.title,
    }),
    CircleX,
    'Remove Download',
    h,
  )
  const download = actionButton(
    Message.ClickedDownload(request),
    CircleArrowDown,
    'Download',
    h,
  )
  return Array.isReadonlyArrayEmpty(collection.videoIds)
    ? h.empty
    : DownloadStatus.match(
        downloadStatus(model.downloads, collection.kind, collection.id),
        {
          Unavailable: () => h.empty,
          NotDownloaded: () => download,
          Downloading: () => remove,
          Incomplete: () => download,
          Downloaded: () => remove,
        },
      )
}

/**
 * The songs of an album or playlist, put after the current song or at the
 * end of the queue. One message carries them all.
 */
const enqueueActions = (
  songs: ReadonlyArray<Song>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.isReadonlyArrayEmpty(songs)
    ? []
    : [
        actionButton(
          Message.ClickedEnqueueSongs({ songs, placement: 'Next' }),
          ListStart,
          'Play Next',
          h,
        ),
        actionButton(
          Message.ClickedEnqueueSongs({ songs, placement: 'Last' }),
          ListEnd,
          'Add to Queue',
          h,
        ),
      ]

const addSongsToPlaylistAction = (
  songs: ReadonlyArray<Song>,
  title: string,
  h: HtmlBuilder<Message>,
): Html =>
  Array.isReadonlyArrayEmpty(songs)
    ? h.empty
    : actionButton(
        Message.ClickedAddToPlaylist({ songs, suggestedTitle: title }),
        ListPlus,
        'Add to a Playlist…',
        h,
      )

const goToArtistAction = (
  maybeArtistId: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeArtistId, {
    onNone: () => h.empty,
    onSome: artistId =>
      actionLink(artistHref(artistId), MicVocal, 'Go to Artist', h),
  })

const shareAction = (
  title: string,
  href: string,
  h: HtmlBuilder<Message>,
): Html =>
  actionButton(Message.ClickedShare({ title, href }), Share, 'Share', h)

const albumActions = (
  model: SheetModel,
  details: AlbumDetails,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const { album, tracks, maybeRadio } = details
  return [
    ...enqueueActions(tracks, h),
    Option.match(maybeRadio, {
      onNone: () => h.empty,
      onSome: station =>
        actionButton(
          Message.ClickedStartStationRadio({ station, title: album.title }),
          Radio,
          'Start Radio',
          h,
        ),
    }),
    downloadAction(model, albumDownload(details), h),
    Option.match(AsyncData.getData(myLibraryQuery.read(model.myLibrary)), {
      onNone: () => h.empty,
      onSome: library => {
        const isSaved = isAlbumSaved(library, album.id)
        return actionButton(
          Message.ClickedToggleAlbumSaved({ album }),
          isSaved ? Check : Plus,
          isSaved ? 'Remove from Library' : 'Save to Library',
          h,
        )
      },
    }),
    addSongsToPlaylistAction(tracks, album.title, h),
    goToArtistAction(firstArtistId(album.artists), h),
    shareAction(album.title, albumHref(album.id), h),
  ]
}

const playlistDetailsActions = (
  model: SheetModel,
  details: PlaylistDetails,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const { playlist, maybeOwner, tracks } = details
  return [
    ...enqueueActions(tracks, h),
    downloadAction(model, playlistDownload(details), h),
    addSongsToPlaylistAction(tracks, playlist.title, h),
    goToArtistAction(
      Option.flatMap(maybeOwner, ({ maybeId }) => maybeId),
      h,
    ),
    shareAction(playlist.title, playlistHref(playlist.id), h),
  ]
}

/**
 * ⋯ on an album or playlist: queue all of its songs, start its radio,
 * download, save, or copy it, go to its artist, or share it. Read from the
 * page's own data, which is loaded whenever its ⋯ shows.
 */
const collectionActions = (
  model: SheetModel,
  kind: CollectionKind,
  id: string,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeParts =
    kind === 'Album'
      ? Option.map(
          AsyncData.getData(albumQuery.read(model.albums, { albumId: id })),
          details => ({
            heading: itemHeading(
              details.album.artwork,
              details.album.title,
              artistNames(details.album.artists),
              h,
            ),
            actions: albumActions(model, details, h),
          }),
        )
      : Option.map(
          AsyncData.getData(
            playlistQuery.read(model.playlists, { playlistId: id }),
          ),
          details => ({
            heading: itemHeading(
              details.playlist.artwork,
              details.playlist.title,
              Option.match(details.maybeOwner, {
                onNone: () =>
                  Option.getOrElse(
                    details.playlist.maybeSubtitle,
                    () => 'Playlist',
                  ),
                onSome: ({ name }) => name,
              }),
              h,
            ),
            actions: playlistDetailsActions(model, details, h),
          }),
        )
  return Option.match(maybeParts, {
    onNone: () => h.empty,
    onSome: ({ heading, actions }) =>
      h.div(
        [h.Class('flex flex-col')],
        [heading, h.div([h.Class('flex flex-col py-2')], actions)],
      ),
  })
}

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
/** The TV's wake button, if it shows one: Turn On or Open. */
const maybeWakeStatus = (
  state: Session.SessionState,
  device: Session.Device,
): Option.Option<'Off' | 'Closed'> => {
  const status = deviceStatus(state, device)
  return device.kind === 'Tv' && (status === 'Off' || status === 'Closed')
    ? Option.some(status)
    : Option.none()
}

/**
 * What the device list says under it. It names only the buttons on screen:
 * Turn On for a TV that is off, Open for one that is on without Joshify.
 */
const devicePickerHelp = (state: Session.SessionState): string => {
  const wakeStatuses = Array.getSomes(
    Array.map(state.devices, device => maybeWakeStatus(state, device)),
  )
  const hasTurnOn = Array.contains(wakeStatuses, 'Off')
  const hasOpen = Array.contains(wakeStatuses, 'Closed')
  const tap = 'Tap a device to play the music there.'
  if (hasTurnOn && hasOpen) {
    return `${tap} Turn On and Open start Joshify on the TV, and the music keeps playing where it is.`
  }
  if (hasTurnOn) {
    return `${tap} Turn On switches the TV on and opens Joshify, and the music keeps playing where it is.`
  }
  if (hasOpen) {
    return `${tap} Open starts Joshify on the TV, and the music keeps playing where it is.`
  }
  return tap
}

const wakeButton = (
  state: Session.SessionState,
  device: Session.Device,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeStatus = maybeWakeStatus(state, device)
  if (Option.isNone(maybeStatus)) {
    return h.empty
  }
  const status = maybeStatus.value
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
      status === 'Off' ? 'Turn On' : 'Open',
    ],
  )
}

const devicePicker = (model: SheetModel, h: HtmlBuilder<Message>): Html =>
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
                [devicePickerHelp(state)],
              ),
            ],
          )
        },
      }),
    ],
  )

// SLEEP TIMER

const minutesLabel = (minutes: number): string =>
  minutes === 60 ? '1 hour' : `${minutes} minutes`

/** What the sleep timer sheet says under its title. */
const sleepTimerSubtitle = (model: Model): string =>
  Option.match(
    Option.flatMap(model.maybeSession, snapshot =>
      sleepCountdown(snapshot, model.now),
    ),
    {
      onNone: () => 'Stop the music after a while, wherever it plays.',
      onSome: countdown =>
        SleepCountdown.match(countdown, {
          Remaining: ({ seconds }) =>
            `The music stops in ${countdownText(seconds)}.`,
          EndOfSong: () => 'The music stops when this song ends.',
        }),
    },
  )

const sleepTimerPicker = (model: SheetModel, h: HtmlBuilder<Message>): Html => {
  const maybeTimer = Option.flatMap(model.maybeSession, ({ state }) =>
    Option.fromNullishOr(state.sleepTimer),
  )
  const isEndOfSong = Option.exists(
    maybeTimer,
    timer => timer._tag === 'EndOfSong',
  )
  return h.div(
    [h.Class('flex flex-col')],
    [
      sheetHeading('Sleep Timer', Option.some(model.sleepTimerSubtitle), h),
      h.div(
        [h.Class('flex flex-col border-t py-2')],
        [
          ...Array.map(SLEEP_TIMER_MINUTES, minutes =>
            h.keyed('button')(
              `${minutes}`,
              [
                h.Type('button'),
                h.OnClick(
                  Message.SelectedSleepTimer({
                    timer: { _tag: 'Minutes', minutes },
                  }),
                ),
                h.Class(actionClass),
              ],
              [
                icon(h, Moon, 'text-primary size-[22px]'),
                minutesLabel(minutes),
              ],
            ),
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(
                Message.SelectedSleepTimer({ timer: { _tag: 'EndOfSong' } }),
              ),
              h.AriaPressed(isEndOfSong ? 'true' : 'false'),
              h.Class(actionClass),
            ],
            [
              icon(h, Moon, 'text-primary size-[22px] fill-current'),
              h.span([h.Class('flex-1')], ['End of song']),
              isEndOfSong ? icon(h, Check, 'text-primary size-5') : h.empty,
            ],
          ),
          Option.isSome(maybeTimer)
            ? actionButton(
                Message.SelectedSleepTimer({ timer: null }),
                TimerOff,
                'Turn Off Timer',
                h,
                true,
              )
            : h.empty,
        ],
      ),
    ],
  )
}

// PLAYLISTS

const pickerRowClass =
  'flex w-full items-center gap-3 px-5 py-2 text-left transition-colors active:bg-muted'

const PICKER_COVER_WIDTH = 48

const songCountText = (songs: ReadonlyArray<Song>): Option.Option<string> =>
  songs.length > 1 ? Option.some(`${songs.length} songs`) : Option.none()

/** Every playlist of mine to add songs to, after a row for a new one. */
const playlistPicker = (
  model: SheetModel,
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
  model: SheetModel,
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
            Message.ClickedEditPlaylist({ playlistId }),
            ListMusic,
            'Edit Playlist',
            h,
          ),
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

const confirmClearRecentlyViewed = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-4 pb-2')],
    [
      sheetHeading(
        'Clear Recently Viewed?',
        Option.some(
          'The albums, artists, and playlists opened on this phone are forgotten. Your library stays.',
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
              h.OnClick(Message.ConfirmedClearRecentlyViewed()),
              h.Class(cn(sheetButtonClass, 'bg-destructive text-white')),
            ],
            ['Clear'],
          ),
        ],
      ),
    ],
  )

const confirmRemoveDownload = (
  kind: DownloadKind,
  id: string,
  title: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-4 pb-2')],
    [
      sheetHeading(
        `Remove “${title}” from Downloads?`,
        Option.some(
          'Its songs leave this phone, unless another download has them. You can still play it with a connection.',
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
              h.OnClick(Message.ConfirmedRemoveDownload({ kind, id })),
              h.Class(cn(sheetButtonClass, 'bg-destructive text-white')),
            ],
            ['Remove'],
          ),
        ],
      ),
    ],
  )

const sheetContent = (
  model: SheetModel,
  content: SheetContent,
  h: HtmlBuilder<Message>,
): Html =>
  SheetContent.match(content, {
    SongActions: ({ song }) => songActions(model, song, h),
    CollectionActions: ({ kind, id }) => collectionActions(model, kind, id, h),
    Devices: () => devicePicker(model, h),
    SleepTimer: () => sleepTimerPicker(model, h),
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
    ConfirmClearRecentlyViewed: () => confirmClearRecentlyViewed(h),
    ConfirmRemoveDownload: ({ kind, id, title }) =>
      confirmRemoveDownload(kind, id, title, h),
    LibrarySort: ({ kind }) => librarySortSheet(model.libraryPrefs, kind, h),
    AddSongs: ({ playlistId }) => addSongsSheet(model, playlistId, h),
    ChoosePlaylistCover: ({ playlistId }) =>
      chooseCoverSheet(model, playlistId, h),
  })

const sheetLabel = (content: SheetContent): string =>
  SheetContent.match(content, {
    SongActions: ({ song }) => song.title,
    CollectionActions: ({ kind }) =>
      kind === 'Album' ? 'Album Options' : 'Playlist Options',
    Devices: () => 'Play on',
    SleepTimer: () => 'Sleep Timer',
    AddToPlaylist: () => 'Add to a Playlist',
    NewPlaylist: () => 'New Playlist',
    PlaylistActions: ({ title }) => title,
    RenamePlaylist: () => 'Rename Playlist',
    ConfirmDeletePlaylist: () => 'Delete Playlist',
    ConfirmClearRecentlyViewed: () => 'Clear Recently Viewed',
    ConfirmRemoveDownload: () => 'Remove Download',
    LibrarySort: ({ kind }) => `Sort ${kind} By`,
    AddSongs: () => 'Add Songs',
    ChoosePlaylistCover: () => 'Choose a Cover',
  })

const sheetFrame = (
  model: SheetModel,
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

const sheetView = (model: SheetModel, h: HtmlBuilder<Message>): Html =>
  ActionSheet.match(model.actionSheet, {
    Hidden: () => h.empty,
    Shown: ({ content }) => sheetFrame(model, content, true, h),
    Dismissed: ({ content }) => sheetFrame(model, content, false, h),
  })

/** One slot: there is one action sheet. */
const lazySheet = createLazy()

/** Builds the sheet's model from its parts, which the slot compares. */
const renderSheet = (
  actionSheet: Model['actionSheet'],
  route: Model['route'],
  albums: Model['albums'],
  playlists: Model['playlists'],
  myLibrary: Model['myLibrary'],
  myPlaylists: Model['myPlaylists'],
  downloads: Model['downloads'],
  libraryPrefs: Model['libraryPrefs'],
  maybeIdentity: Model['maybeIdentity'],
  maybeSession: Model['maybeSession'],
  playlistTitleInput: string,
  playerSheet: Model['playerSheet'],
  home: Model['home'],
  songSearch: Model['songSearch'],
  addSongsSearch: Model['addSongsSearch'],
  sleepTimerSubtitle: string,
  h: HtmlBuilder<Message>,
): Html =>
  sheetView(
    {
      actionSheet,
      route,
      albums,
      playlists,
      myLibrary,
      myPlaylists,
      downloads,
      libraryPrefs,
      maybeIdentity,
      maybeSession,
      playlistTitleInput,
      playerSheet,
      home,
      songSearch,
      addSongsSearch,
      sleepTimerSubtitle,
    },
    h,
  )

const isSleepTimerSheet = (sheet: ActionSheet): boolean =>
  sheet._tag !== 'Hidden' && sheet.content._tag === 'SleepTimer'

/**
 * The action sheet, sliding up over everything when shown. It is drawn
 * again only when something it shows changes, open or slid away.
 */
export const actionSheetView = (model: Model, h: HtmlBuilder<Message>): Html =>
  lazySheet(renderSheet, [
    model.actionSheet,
    model.route,
    model.albums,
    model.playlists,
    model.myLibrary,
    model.myPlaylists,
    model.downloads,
    model.libraryPrefs,
    model.maybeIdentity,
    model.maybeSession,
    model.playlistTitleInput,
    model.playerSheet,
    model.home,
    model.songSearch,
    model.addSongsSearch,
    isSleepTimerSheet(model.actionSheet) ? sleepTimerSubtitle(model) : '',
    h,
  ])
