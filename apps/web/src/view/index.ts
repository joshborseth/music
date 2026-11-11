import { Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Document, Html, HtmlBuilder } from 'foldkit/html'

import { cn } from '@/lib/utils'

import { Message } from '../message'
import { Model } from '../model'
import { albumQuery, artistQuery, playlistQuery, songQuery } from '../query'
import { AppRoute } from '../route'
import { routeQuery } from '../update'
import { albumView } from './album'
import { artistView } from './artist'
import { detailNavBar, page, tabBar } from './chrome'
import { homeView } from './home'
import { libraryView } from './library'
import { type PageModel, memoizedPage } from './page'
import { hasMiniPlayer, playerView } from './player'
import { playlistView } from './playlist'
import { searchView } from './search'
import { emptyState } from './shared'
import { actionSheetView } from './sheet'
import { songView } from './song'

const APP_NAME = 'Music'

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
    Album: () => `Album · ${APP_NAME}`,
    Playlist: () => `Playlist · ${APP_NAME}`,
    NotFound: () => `Not found · ${APP_NAME}`,
  })

const detailPage = (
  maybeTitle: Option.Option<string>,
  content: Html,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  ...detailNavBar(
    Option.getOrElse(maybeTitle, () => ''),
    h,
  ),
  content,
]

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
    Album: ({ albumId }) =>
      detailPage(
        Option.map(
          AsyncData.getData(albumQuery.read(model.albums, { albumId })),
          ({ album }) => album.title,
        ),
        albumView(model, albumId, h),
        h,
      ),
    Playlist: ({ playlistId }) =>
      detailPage(
        Option.map(
          AsyncData.getData(
            playlistQuery.read(model.playlists, { playlistId }),
          ),
          ({ playlist }) => playlist.title,
        ),
        playlistView(model, playlistId, h),
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
      h.main(
        [
          h.Class(
            cn(
              hasMiniPlayer(model)
                ? 'pb-[calc(var(--tab-bar-height)+var(--safe-bottom)+var(--mini-player-height)+1rem)]'
                : 'pb-[calc(var(--tab-bar-height)+var(--safe-bottom)+0.5rem)]',
            ),
          ),
        ],
        [page(model, [memoizedPage(model, routeContent, h)], h)],
      ),
      tabBar(model, h),
      playerView(model, h),
      actionSheetView(model, h),
    ],
  ),
})
