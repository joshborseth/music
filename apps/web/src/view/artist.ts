import { Array, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'
import { User } from 'lucide'

import { icon } from '@/lib/icons'
import { type ArtistDetails } from '@music/shared'

import { Message } from '../message'
import { SyncTitleBarReveal } from '../mount'
import { artistQuery } from '../query'
import { type PageModel } from './page'
import {
  albumCard,
  artworkUrl,
  expandableText,
  loadingPage,
  playActions,
  remote,
  section,
  shelf,
  songSection,
} from './shared'

const HERO_IMAGE_WIDTH = 480

/** A photo that runs edge to edge under the status bar, name on top of it. */
const artistHero = (details: ArtistDetails, h: HtmlBuilder<Message>): Html =>
  h.header(
    [
      h.Class(
        'relative flex aspect-[4/5] max-h-[68vh] w-full items-end overflow-hidden bg-muted',
      ),
    ],
    [
      Option.match(artworkUrl(details.artist.artwork, HERO_IMAGE_WIDTH), {
        onNone: () =>
          h.span(
            [
              h.Class(
                'text-muted-foreground absolute inset-0 flex items-center justify-center',
              ),
            ],
            [icon(h, User, 'size-24')],
          ),
        onSome: url =>
          h.img([
            h.Src(url),
            h.Alt(''),
            h.Loading('eager'),
            h.Decoding('async'),
            h.Referrerpolicy('no-referrer'),
            h.Class('absolute inset-0 size-full object-cover'),
          ]),
      }),
      h.div([
        h.Class(
          'absolute inset-0 bg-gradient-to-b from-black/30 via-transparent via-40% to-black/70',
        ),
      ]),
      h.h1(
        [
          h.OnMount(SyncTitleBarReveal()),
          h.Class(
            'relative px-4 pb-4 text-[40px] leading-[1.05] font-extrabold tracking-tight text-white drop-shadow-lg text-balance',
          ),
        ],
        [details.artist.name],
      ),
    ],
  )

/** The artist page: photo, top songs, releases, and bio. */
export const artistView = (
  model: PageModel,
  artistId: string,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    artistQuery.read(model.artists, { artistId }),
    {
      onLoading: () => loadingPage(h),
      onData: details =>
        h.div(
          [h.Class('flex flex-col gap-8 pb-6')],
          [
            h.div(
              [h.Class('flex flex-col gap-5')],
              [artistHero(details, h), playActions(details.topSongs, h)],
            ),
            songSection(
              {
                title: 'Top songs',
                songs: details.topSongs,
                playing: model.playing,
                swipe: model.swipe,
              },
              h,
            ),
            shelf(
              {
                title: 'Albums',
                items: details.albums,
                toKey: album => album.id,
                toCard: albumCard,
              },
              h,
            ),
            shelf(
              {
                title: 'Singles & EPs',
                items: details.singles,
                toKey: album => album.id,
                toCard: albumCard,
              },
              h,
            ),
            Option.match(details.maybeDescription, {
              onNone: () => h.empty,
              onSome: text => section('About', [expandableText(text, h)], h),
            }),
            Array.isReadonlyArrayEmpty(details.topSongs) &&
            Array.isReadonlyArrayEmpty(details.albums)
              ? h.p(
                  [h.Class('text-muted-foreground px-4 text-[15px]')],
                  ['YouTube Music has no songs listed for this artist.'],
                )
              : h.empty,
          ],
        ),
    },
    h,
  )
