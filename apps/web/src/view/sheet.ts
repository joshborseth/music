import { Array, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'
import { Check, Disc3, FileText, ListEnd, ListStart, MicVocal } from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { type Session, type Song } from '@music/shared'

import { Message } from '../message'
import { type Model } from '../model'
import { DragToDismiss } from '../mount'
import { ActionSheet, SheetContent } from '../sheet'
import { deviceIcon } from './player'
import {
  ArtworkShape,
  albumHref,
  artistHref,
  artistNames,
  artworkImage,
  firstArtistId,
  songHref,
} from './shared'

const actionClass =
  'flex h-14 w-full items-center gap-4 px-5 text-left text-[17px] transition-colors active:bg-muted'

const actionButton = (
  onClick: Message,
  iconNode: typeof Disc3,
  label: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [h.Type('button'), h.OnClick(onClick), h.Class(actionClass)],
    [icon(h, iconNode, 'text-primary size-[22px]'), label],
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

const songActions = (song: Song, h: HtmlBuilder<Message>): Html =>
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

const deviceStatus = (device: Session.Device, isActive: boolean): string => {
  if (device.waking) {
    return 'Turning on…'
  } else if (!device.online) {
    return 'Off · tap to turn on'
  } else if (isActive) {
    return 'Playing'
  } else {
    return ''
  }
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
        onSome: ({ state }) =>
          h.div(
            [h.Class('flex flex-col pb-2')],
            Array.map(state.devices, device => {
              const isThisOne = Option.exists(
                model.maybeIdentity,
                ({ deviceId }) => deviceId === device.id,
              )
              const isActive = state.activeDeviceId === device.id
              const status = deviceStatus(device, isActive)
              return h.keyed('button')(
                device.id,
                [
                  h.Type('button'),
                  h.OnClick(Message.ClickedDevice({ deviceId: device.id })),
                  h.AriaPressed(isActive ? 'true' : 'false'),
                  h.Class(cn(actionClass, 'h-16')),
                ],
                [
                  h.span(
                    [
                      h.Class(
                        cn(
                          'flex size-10 shrink-0 items-center justify-center rounded-full',
                          isActive
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
                        [isThisOne ? `This ${device.name}` : device.name],
                      ),
                      status === ''
                        ? h.empty
                        : h.span(
                            [h.Class('text-muted-foreground text-[13px]')],
                            [status],
                          ),
                    ],
                  ),
                  isActive ? icon(h, Check, 'text-primary size-5') : h.empty,
                ],
              )
            }),
          ),
      }),
    ],
  )

const sheetContent = (
  model: Model,
  content: SheetContent,
  h: HtmlBuilder<Message>,
): Html =>
  SheetContent.match(content, {
    SongActions: ({ song }) => songActions(song, h),
    Devices: () => devicePicker(model, h),
  })

const sheetLabel = (content: SheetContent): string =>
  SheetContent.match(content, {
    SongActions: ({ song }) => song.title,
    Devices: () => 'Play on',
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
