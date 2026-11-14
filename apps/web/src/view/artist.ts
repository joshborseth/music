import { Array, Option, Record, pipe } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { Check, User } from 'lucide'

import { icon } from '@/lib/icons'
import {
  type AlbumSummary,
  type ArtistDetails,
  type MyLibrary,
  type Session,
  type Song,
} from '@music/shared'

import { isArtistFollowed } from '../library'
import { Message } from '../message'
import { SyncTitleBarReveal } from '../mount'
import { artistQuery, myLibraryQuery, playlistQuery } from '../query'
import { artistAlbumsRouter, artistSinglesRouter } from '../route'
import { type PageModel } from './page'
import {
  artistCard,
  artistHref,
  artworkUrl,
  emptyState,
  expandableText,
  joinDetails,
  loadingPage,
  playActions,
  playlistHref,
  releaseCard,
  releaseGridCard,
  remote,
  section,
  seeAllLink,
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
            'pressable floating relative mx-4 mb-5 flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-[15px] font-semibold',
          ),
        ],
        isFollowing
          ? [icon(h, Check, 'text-primary size-4'), 'Following']
          : ['Follow'],
      )
    },
  })
/** Releases a shelf shows before "See All" opens the rest in a grid. */
const SHELF_RELEASES = 10

/** A shelf with more releases than this links to all of them. */
const RELEASES_WITHOUT_SEE_ALL = 4

/** Which of an artist's releases a page lists. */
export type ReleaseKind = 'Albums' | 'Singles'

export const ARTIST_RELEASE_TITLES: Readonly<Record<ReleaseKind, string>> = {
  Albums: 'Albums',
  Singles: 'Singles & EPs',
}

const releasesOf = (
  details: ArtistDetails,
  kind: ReleaseKind,
): ReadonlyArray<AlbumSummary> =>
  kind === 'Albums' ? details.albums : details.singles

const releasesHref = (artistId: string, kind: ReleaseKind): string =>
  kind === 'Albums'
    ? artistAlbumsRouter({ artistId })
    : artistSinglesRouter({ artistId })

/** Songs played from the artist page say so in the player. */
const playingFromArtist = (details: ArtistDetails): Session.PlayingFrom => ({
  kind: 'Artist',
  title: details.artist.name,
  id: details.artist.id,
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
        'relative flex aspect-[4/5] max-h-[68vh] w-full flex-wrap content-end items-end justify-between overflow-hidden bg-muted',
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
            'relative min-w-0 px-4 pb-4 text-[40px] leading-[1.05] font-extrabold tracking-tight break-words text-white drop-shadow-lg text-balance',
          ),
        ],
        [details.artist.name],
      ),
      followButton(details, maybeLibrary, h),
    ],
  )

/**
 * Under a top song's title: its album and how often it was played. The
 * artists are left out, since the page is theirs, and so is a single's
 * album, which only repeats the title.
 */
const topSongDetails =
  (details: ArtistDetails) =>
  (song: Song): string =>
    joinDetails([
      Option.match(song.maybeAlbum, {
        onNone: () => '',
        onSome: ({ name }) => (name === song.title ? '' : name),
      }),
      Option.getOrElse(
        Record.get(details.topSongPlays, song.videoId),
        () => '',
      ),
    ])

/**
 * What Play and Shuffle queue: every song in the artist's See All playlist,
 * most played first, once it has loaded, after the top songs the page
 * lists. Until then, only those.
 */
const artistSongs = (
  model: PageModel,
  details: ArtistDetails,
): ReadonlyArray<Song> =>
  pipe(
    details.maybeAllSongsPlaylistId,
    Option.flatMap(playlistId =>
      AsyncData.getData(playlistQuery.read(model.playlists, { playlistId })),
    ),
    Option.match({
      onNone: () => details.topSongs,
      onSome: ({ tracks }) =>
        Array.dedupeWith(
          Array.appendAll(details.topSongs, tracks),
          (left, right) => left.videoId === right.videoId,
        ),
    }),
  )

/** A shelf of the artist's albums or singles, linking to all of them. */
const releaseShelf = (
  details: ArtistDetails,
  kind: ReleaseKind,
  h: HtmlBuilder<Message>,
): Html => {
  const releases = releasesOf(details, kind)
  return shelf(
    {
      title: ARTIST_RELEASE_TITLES[kind],
      items: Array.take(releases, SHELF_RELEASES),
      toKey: album => album.id,
      toCard: releaseCard,
      maybeAction: Option.liftPredicate(
        seeAllLink(
          ARTIST_RELEASE_TITLES[kind],
          releasesHref(details.artist.id, kind),
        ),
        () => releases.length > RELEASES_WITHOUT_SEE_ALL,
      ),
    },
    h,
  )
}

/**
 * The artist page: photo, top songs with their albums, releases, artists
 * their fans also like, and bio.
 */
export const artistView = (
  model: PageModel,
  artistId: string,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    artistQuery.read(model.artists, { artistId }),
    {
      missing: 'artist',
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
                playActions(
                  artistSongs(model, details),
                  h,
                  details.maybeRadio,
                  Option.some(playingFromArtist(details)),
                ),
              ],
            ),
            songSection(
              {
                title: 'Top Songs',
                songs: details.topSongs,
                playing: model.playing,
                swipe: model.swipe,
                maybeDetails: Option.some(topSongDetails(details)),
                maybePlayingFrom: Option.some(playingFromArtist(details)),
                maybeAction: Option.map(
                  details.maybeAllSongsPlaylistId,
                  playlistId =>
                    seeAllLink('Top Songs', playlistHref(playlistId)),
                ),
              },
              h,
            ),
            releaseShelf(details, 'Albums', h),
            releaseShelf(details, 'Singles', h),
            shelf(
              {
                title: 'Fans Also Like',
                items: details.relatedArtists,
                toKey: artist => artist.id,
                toCard: artistCard,
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

/** Every album, or every single and EP, by an artist, newest first. */
export const artistReleasesView = (
  model: PageModel,
  artistId: string,
  kind: ReleaseKind,
  h: HtmlBuilder<Message>,
): Html =>
  remote(
    artistQuery.read(model.artists, { artistId }),
    {
      missing: 'artist',
      onLoading: () => loadingPage(h),
      onData: details =>
        h.div(
          [h.Class('flex flex-col gap-4 pb-6')],
          [
            h.header(
              [
                h.Class(
                  'flex flex-col gap-0.5 px-4 pt-[calc(var(--safe-top)+3.75rem)]',
                ),
              ],
              [
                h.h1(
                  [
                    h.OnMount(SyncTitleBarReveal()),
                    h.Class(
                      'text-[34px] leading-tight font-bold tracking-tight',
                    ),
                  ],
                  [ARTIST_RELEASE_TITLES[kind]],
                ),
                h.a(
                  [
                    h.Href(artistHref(details.artist.id)),
                    h.Class(
                      'text-primary self-start text-[17px] font-medium active:opacity-60',
                    ),
                  ],
                  [details.artist.name],
                ),
              ],
            ),
            Array.match(releasesOf(details, kind), {
              onEmpty: () =>
                emptyState(
                  {
                    title: `No ${ARTIST_RELEASE_TITLES[kind].toLowerCase()}`,
                    description: `YouTube Music lists none for ${details.artist.name}.`,
                    kind: 'Album',
                  },
                  h,
                ),
              onNonEmpty: releases =>
                h.div(
                  [
                    h.Role('list'),
                    h.Class('grid grid-cols-2 gap-x-3 gap-y-5 px-4'),
                  ],
                  Array.map(releases, album =>
                    h.keyed('div')(
                      album.id,
                      [h.Role('listitem'), h.Class('flex min-w-0')],
                      [releaseGridCard(album, h)],
                    ),
                  ),
                ),
            }),
          ],
        ),
    },
    h,
  )
