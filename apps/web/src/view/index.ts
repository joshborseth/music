import { Array, Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import { Check, CircleArrowDown, CircleCheck, Ellipsis, Plus } from 'lucide'

import { type AlbumSummary, type MyLibrary } from '@music/shared'

import {
  DownloadStatus,
  type DownloadedCollection,
  downloadStatus,
  progressRing,
} from '../downloads/domain'
import { isAlbumSaved } from '../library'
import { Message } from '../message'
import { Model } from '../model'
import { isEditing } from '../playlistEditor'
import {
  albumQuery,
  artistQuery,
  moodQuery,
  myLibraryQuery,
  myPlaylistQuery,
  playlistQuery,
  songQuery,
} from '../query'
import { AppRoute } from '../route'
import { type CollectionKind } from '../sheet'
import { routeQuery } from '../update'
import { albumView } from './album'
import { ARTIST_RELEASE_TITLES, artistReleasesView, artistView } from './artist'
import { detailNavBar, navBarButton, page, tabBar } from './chrome'
import {
  DOWNLOAD_ARTWORK_WIDTH,
  albumDownload,
  playlistDownload,
} from './collectionDownload'
import { homeView } from './home'
import { libraryView } from './library'
import { moodView } from './mood'
import { myPlaylistView } from './myPlaylist'
import { type PageModel, memoizedPage } from './page'
import { hasMiniPlayer, playerView } from './player'
import { playlistView } from './playlist'
import { doneEditingButton } from './playlistEditor'
import { searchView } from './search'
import { artworkUrl, emptyState } from './shared'
import { actionSheetView } from './sheet'
import { songView } from './song'

const APP_NAME = 'Joshify'

const pageTitle = (model: Model): string =>
  AppRoute.match(model.route, {
    Home: () => APP_NAME,
    Search: route =>
      Option.match(routeQuery(route), {
        onNone: () => `Search · ${APP_NAME}`,
        onSome: query => `${query} · ${APP_NAME}`,
      }),
    Library: () => `Library · ${APP_NAME}`,
    Song: () => `Song · ${APP_NAME}`,
    Artist: () => `Artist · ${APP_NAME}`,
    ArtistAlbums: () => `Albums · ${APP_NAME}`,
    ArtistSingles: () => `Singles & EPs · ${APP_NAME}`,
    Album: () => `Album · ${APP_NAME}`,
    Playlist: () => `Playlist · ${APP_NAME}`,
    MyPlaylist: () => `Playlist · ${APP_NAME}`,
    Mood: () => `Browse · ${APP_NAME}`,
    NotFound: () => `Not found · ${APP_NAME}`,
  })

/**
 * A detail page under its nav bar. `trailingButtons` is the most round
 * buttons `trailing` can show, which the title bar keeps clear of.
 */
const detailPage = (
  maybeTitle: Option.Option<string>,
  content: Html,
  h: HtmlBuilder<Message>,
  trailing: Html = h.empty,
  trailingButtons: number = 0,
): ReadonlyArray<Html> => [
  ...detailNavBar(
    Option.getOrElse(maybeTitle, () => ''),
    trailing,
    h,
    trailingButtons,
  ),
  content,
]

/** ⋯ on an album or playlist: everything else that can be done with it. */
const collectionActionsButton = (
  kind: CollectionKind,
  maybeId: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeId, {
    onNone: () => h.empty,
    onSome: id =>
      navBarButton(
        {
          onClick: Message.ClickedCollectionActions({ kind, id }),
          iconNode: Ellipsis,
          label: kind === 'Album' ? 'Album Options' : 'Playlist Options',
        },
        h,
      ),
  })

/**
 * Saves the album to the Library, or takes it out. Shown once the Library
 * has loaded, so it never shows the wrong state.
 */
const saveAlbumButton = (
  maybeAlbum: Option.Option<AlbumSummary>,
  maybeLibrary: Option.Option<MyLibrary>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(Option.all([maybeAlbum, maybeLibrary]), {
    onNone: () => h.empty,
    onSome: ([album, library]) => {
      const isSaved = isAlbumSaved(library, album.id)
      return navBarButton(
        {
          onClick: Message.ClickedToggleAlbumSaved({ album }),
          iconNode: isSaved ? Check : Plus,
          label: isSaved ? 'Remove from Library' : 'Save to Library',
          isOn: isSaved,
        },
        h,
      )
    },
  })

/**
 * Downloads an album or playlist to the phone, shows how far it has got as
 * a ring that fills, and once it is all there, a check that offers to
 * remove it. Hidden where nothing can be downloaded (no Cache Storage).
 */
const downloadButton = (
  model: PageModel,
  maybeCollection: Option.Option<DownloadedCollection>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(
    Option.filter(maybeCollection, ({ videoIds }) =>
      Array.isReadonlyArrayNonEmpty(videoIds),
    ),
    {
      onNone: () => h.empty,
      onSome: collection => {
        const remove = Message.ClickedRemoveDownload({
          kind: collection.kind,
          id: collection.id,
          title: collection.title,
        })
        return DownloadStatus.match(
          downloadStatus(model.downloads, collection.kind, collection.id),
          {
            Unavailable: () => h.empty,
            NotDownloaded: () =>
              navBarButton(
                {
                  onClick: Message.ClickedDownload({ collection }),
                  iconNode: CircleArrowDown,
                  label: 'Download',
                },
                h,
              ),
            Downloading: ({ saved, total }) =>
              navBarButton(
                {
                  onClick: remove,
                  iconNode: progressRing(saved / total),
                  label: `Downloading, ${saved} of ${total} songs`,
                  isOn: true,
                },
                h,
              ),
            Incomplete: ({ saved, total }) =>
              navBarButton(
                {
                  onClick: Message.ClickedDownload({ collection }),
                  iconNode: progressRing(saved / total),
                  label: `${saved} of ${total} songs downloaded. Download the rest`,
                },
                h,
              ),
            Downloaded: () =>
              navBarButton(
                {
                  onClick: remove,
                  iconNode: CircleCheck,
                  label: 'Downloaded. Remove from Downloads',
                  isOn: true,
                },
                h,
              ),
          },
        )
      },
    },
  )

const navBarButtons = (
  buttons: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html => h.div([h.Class('flex gap-2')], buttons)

const routeContent = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('contents')], routeParts(model, h))

const routeParts = (
  model: PageModel,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  AppRoute.match(model.route, {
    Home: () => homeView(model, h),
    Search: () => searchView(model, h),
    Library: () => libraryView(model, h),
    Song: ({ videoId }) =>
      detailPage(
        Option.map(
          AsyncData.getData(songQuery.read(model.songs, { videoId })),
          ({ song }) => song.title,
        ),
        songView(model, videoId, h),
        h,
      ),
    Artist: ({ artistId }) =>
      detailPage(
        Option.map(
          AsyncData.getData(artistQuery.read(model.artists, { artistId })),
          ({ artist }) => artist.name,
        ),
        artistView(model, artistId, h),
        h,
      ),
    ArtistAlbums: ({ artistId }) =>
      detailPage(
        Option.some(ARTIST_RELEASE_TITLES.Albums),
        artistReleasesView(model, artistId, 'Albums', h),
        h,
      ),
    ArtistSingles: ({ artistId }) =>
      detailPage(
        Option.some(ARTIST_RELEASE_TITLES.Singles),
        artistReleasesView(model, artistId, 'Singles', h),
        h,
      ),
    Album: ({ albumId }) => {
      const maybeAlbum = AsyncData.getData(
        albumQuery.read(model.albums, { albumId }),
      )
      return detailPage(
        Option.map(maybeAlbum, ({ album }) => album.title),
        albumView(model, albumId, h),
        h,
        navBarButtons(
          [
            saveAlbumButton(
              Option.map(maybeAlbum, ({ album }) => album),
              AsyncData.getData(myLibraryQuery.read(model.myLibrary)),
              h,
            ),
            downloadButton(model, Option.map(maybeAlbum, albumDownload), h),
            collectionActionsButton(
              'Album',
              Option.map(maybeAlbum, ({ album }) => album.id),
              h,
            ),
          ],
          h,
        ),
        3,
      )
    },
    Playlist: ({ playlistId }) => {
      const maybePlaylist = AsyncData.getData(
        playlistQuery.read(model.playlists, { playlistId }),
      )
      return detailPage(
        Option.map(maybePlaylist, ({ playlist }) => playlist.title),
        playlistView(model, playlistId, h),
        h,
        navBarButtons(
          [
            downloadButton(
              model,
              Option.map(maybePlaylist, playlistDownload),
              h,
            ),
            collectionActionsButton(
              'Playlist',
              Option.map(maybePlaylist, ({ playlist }) => playlist.id),
              h,
            ),
          ],
          h,
        ),
        2,
      )
    },
    MyPlaylist: ({ playlistId }) => {
      const maybeDetails = AsyncData.getData(
        myPlaylistQuery.read(model.myPlaylists, { playlistId }),
      )
      const maybePlaylist = Option.map(maybeDetails, ({ playlist }) => playlist)
      return detailPage(
        Option.map(maybePlaylist, ({ title }) => title),
        myPlaylistView(model, playlistId, h),
        h,
        isEditing(model.playlistEditor, playlistId)
          ? doneEditingButton(h)
          : navBarButtons(
              [
                downloadButton(
                  model,
                  Option.map(
                    maybeDetails,
                    ({ playlist, songs }): DownloadedCollection => ({
                      kind: 'MyPlaylist',
                      id: playlist.id,
                      title: playlist.title,
                      subtitle: playlist.isLiked
                        ? 'Your likes'
                        : 'Your playlist',
                      maybeArtworkUrl: Option.flatMap(
                        Array.head(playlist.covers),
                        cover => artworkUrl(cover, DOWNLOAD_ARTWORK_WIDTH),
                      ),
                      videoIds: Array.map(songs, ({ videoId }) => videoId),
                    }),
                  ),
                  h,
                ),
                Option.match(
                  Option.filter(maybePlaylist, ({ isLiked }) => !isLiked),
                  {
                    onNone: () => h.empty,
                    onSome: ({ id, title }) =>
                      navBarButton(
                        {
                          onClick: Message.ClickedPlaylistActions({
                            playlistId: id,
                            title,
                          }),
                          iconNode: Ellipsis,
                          label: 'Playlist Options',
                        },
                        h,
                      ),
                  },
                ),
              ],
              h,
            ),
        2,
      )
    },
    Mood: ({ params }) =>
      detailPage(
        Option.map(
          AsyncData.getData(moodQuery.read(model.moods, { params })),
          ({ title }) => title,
        ),
        moodView(model, params, h),
        h,
      ),
    NotFound: () =>
      detailPage(
        Option.none(),
        h.div(
          [h.Class('pt-[calc(var(--safe-top)+3.75rem)]')],
          [
            emptyState(
              {
                title: 'Page not found',
                description: 'This address does not match any page in the app.',
                kind: 'Song',
              },
              h,
            ),
          ],
        ),
        h,
      ),
  })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: pageTitle(model),
  body: h.div(
    [h.Class('mx-auto w-full max-w-xl')],
    [
      page(
        model,
        hasMiniPlayer(model)
          ? 'pb-[calc(var(--tab-bar-space)+var(--mini-player-height)+1.5rem)]'
          : 'pb-[calc(var(--tab-bar-space)+1rem)]',
        [memoizedPage(model, routeContent, h)],
        h,
      ),
      tabBar(model, h),
      playerView(model, h),
      actionSheetView(model, h),
    ],
  ),
})
