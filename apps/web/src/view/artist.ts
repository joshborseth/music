import { Array, Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { Check, User } from 'lucide'

import { icon } from '@/lib/icons'
import { type ArtistDetails, type MyLibrary } from '@music/shared'

import { isArtistFollowed } from '../library'
import { Message } from '../message'
import { SyncTitleBarReveal } from '../mount'
import { artistQuery, myLibraryQuery } from '../query'
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

/**
 * Follows the artist, keeping them in the Library, or unfollows them. Shown
 * once the Library has loaded, so it never shows the wrong state.
 */
const followButton = (
  details: ArtistDetails,
  maybeLibrary: Option.Option<MyLibrary>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeLibrary, {
    onNone: () => h.empty,
    onSome: library => {
      const isFollowing = isArtistFollowed(library, details.artist.id)
      return h.button(
        [
          h.Type('button'),
          h.OnClick(
            Message.ClickedToggleArtistFollowed({ artist: details.artist }),
          ),
          h.AriaLabel(
            isFollowing
              ? `Unfollow ${details.artist.name}`
              : `Follow ${details.artist.name}`,
          ),
          h.Class(
            'pressable floating relative mr-4 mb-5 flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-[15px] font-semibold',
          ),
        ],
        isFollowing
          ? [icon(h, Check, 'text-primary size-4'), 'Following']
          : ['Follow'],
      )
    },
  })

/** A photo that runs edge to edge under the status bar, name on top of it. */
const artistHero = (
  details: ArtistDetails,
  maybeLibrary: Option.Option<MyLibrary>,
  h: HtmlBuilder<Message>,
): Html =>
  h.header(
    [
      h.Class(
        'relative flex aspect-[4/5] max-h-[68vh] w-full items-end justify-between gap-3 overflow-hidden bg-muted',
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
      followButton(details, maybeLibrary, h),
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
              [
                artistHero(
                  details,
                  AsyncData.getData(myLibraryQuery.read(model.myLibrary)),
                  h,
                ),
                playActions(details.topSongs, h),
              ],
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
