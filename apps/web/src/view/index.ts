import { Option } from 'effect'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import { ArrowLeft, Search } from 'lucide'

import { button, buttonSizes, buttonVariants } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { PAGE_TOP_ID } from '../constant'
import { Message } from '../message'
import { Model } from '../model'
import { AppRoute, searchRouter } from '../route'
import { routeQuery } from '../update'
import { albumView } from './album'
import { artistView } from './artist'
import { hasMiniPlayer, playerView } from './player'
import { searchView } from './search'
import { emptyState } from './shared'
import { songView } from './song'

const APP_NAME = 'Music'

const pageTitle = (model: Model): string =>
  AppRoute.match(model.route, {
    Search: route =>
      Option.match(routeQuery(route), {
        onNone: () => APP_NAME,
        onSome: query => `${query} · ${APP_NAME}`,
      }),
    Song: () => `Song · ${APP_NAME}`,
    Artist: () => `Artist · ${APP_NAME}`,
    Album: () => `Album · ${APP_NAME}`,
    NotFound: () => `Not found · ${APP_NAME}`,
  })

const detailTopBar = (h: HtmlBuilder<Message>): Html =>
  h.nav(
    [
      h.AriaLabel('Page'),
      h.Class(
        'bg-background/90 sticky top-0 z-10 -mx-4 flex items-center justify-between px-2 pt-[env(safe-area-inset-top)] backdrop-blur',
      ),
    ],
    [
      button(
        {
          onClick: Message.ClickedBack(),
          variant: 'ghost',
          size: 'icon-lg',
          className: 'rounded-full',
        },
        [icon(h, ArrowLeft, 'size-5'), h.span([h.Class('sr-only')], ['Back'])],
        h,
      ),
      h.a(
        [
          h.Href(searchRouter({ q: Option.none(), kind: Option.none() })),
          h.Class(
            cn(
              buttonVariants.ghost,
              buttonSizes['icon-lg'],
              'inline-flex items-center justify-center rounded-full',
            ),
          ),
        ],
        [icon(h, Search, 'size-5'), h.span([h.Class('sr-only')], ['Search'])],
      ),
    ],
  )

const detailPage = (content: Html, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('flex flex-col gap-4')], [detailTopBar(h), content])

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const content = AppRoute.match(model.route, {
    Search: () => searchView(model, h),
    Song: ({ videoId }) => detailPage(songView(model, videoId, h), h),
    Artist: ({ artistId }) => detailPage(artistView(model, artistId, h), h),
    Album: ({ albumId }) => detailPage(albumView(model, albumId, h), h),
    NotFound: () =>
      detailPage(
        emptyState(
          {
            title: 'Page not found',
            description: 'This address does not match any page in the app.',
            kind: 'Song',
          },
          h,
        ),
        h,
      ),
  })

  return {
    title: pageTitle(model),
    body: h.div(
      [
        h.Id(PAGE_TOP_ID),
        h.Class(
          cn(
            'mx-auto min-h-dvh w-full max-w-xl px-4',
            hasMiniPlayer(model)
              ? 'pb-[calc(env(safe-area-inset-bottom)+6rem)]'
              : 'pb-[max(env(safe-area-inset-bottom),2rem)]',
          ),
        ),
      ],
      [h.main([], [content]), playerView(model, h)],
    ),
  }
}
