import { Array } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'
import { ChevronLeft, House, LibraryBig, Search } from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { PAGE_ATTRIBUTE, TITLE_BAR_ATTRIBUTE } from '../constant'
import { Message } from '../message'
import { type Model } from '../model'
import { RestoreScroll } from '../mount'
import { TABS, type Tab, pageKey } from '../route'
import { restoredScrollTop } from '../update'

// PAGE

/**
 * Wraps a page so it enters at the scroll position it was left at. Each page
 * gets its own element, so moving between pages replaces the DOM and runs
 * the page transition.
 */
export const page = (
  model: Model,
  content: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('div')(
    pageKey(model.route),
    [
      h.OnMount(RestoreScroll({ top: restoredScrollTop(model) })),
      h.DataAttribute(PAGE_ATTRIBUTE, ''),
      h.Class('flex min-h-dvh flex-col'),
    ],
    content,
  )

// TOP BARS

/** Covers the status bar so scrolled content never runs under the clock. */
export const statusBarCover = (h: HtmlBuilder<Message>): Html =>
  h.div([
    h.AriaHidden(true),
    h.Class(
      'page-glass pointer-events-none fixed inset-x-0 top-0 z-30 h-[var(--safe-top)]',
    ),
  ])

const compactTitleBar = (title: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.AriaHidden(true),
      h.Class(
        'reveal-on-scroll page-glass pointer-events-none fixed inset-x-0 top-0 z-30 flex h-[calc(var(--safe-top)+var(--nav-bar-height))] items-end justify-center border-b pb-2.5',
      ),
    ],
    [h.span([h.Class('text-[17px] font-semibold')], [title])],
  )

/** A tab's big bold title, with room for a button beside it. */
export const largeTitle = (
  title: string,
  maybeTrailing: Html,
  h: HtmlBuilder<Message>,
): Html =>
  h.header(
    [
      h.Class(
        'flex items-end justify-between gap-3 px-4 pt-[calc(var(--safe-top)+var(--nav-bar-height))] pb-2',
      ),
    ],
    [
      h.h1(
        [h.Class('text-[34px] leading-tight font-bold tracking-tight')],
        [title],
      ),
      maybeTrailing,
    ],
  )

/**
 * The top of a tab: a large title that scrolls away, replaced by a small
 * centered one in a frosted bar, as iOS does it.
 */
export const largeTitleHeader = (
  title: string,
  maybeTrailing: Html,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  statusBarCover(h),
  compactTitleBar(title, h),
  largeTitle(title, maybeTrailing, h),
]

const backButton = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedBack()),
      h.AriaLabel('Back'),
      h.Class(
        'pressable chrome pointer-events-auto flex size-10 items-center justify-center rounded-full border border-white/10 shadow-sm',
      ),
    ],
    [icon(h, ChevronLeft, 'size-6 -ml-0.5')],
  )

/**
 * The bar over a detail page: a round back button floating over the hero,
 * and a frosted bar with the page title that fades in once the hero has
 * scrolled away.
 */
export const detailNavBar = (
  title: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  h.div(
    [
      h.AriaHidden(true),
      h.DataAttribute(TITLE_BAR_ATTRIBUTE, ''),
      h.Class(
        'reveal-on-scroll page-glass pointer-events-none fixed inset-x-0 top-0 z-30 flex h-[calc(var(--safe-top)+var(--nav-bar-height)+0.5rem)] items-end justify-center border-b px-16 pb-3 [--reveal-end:240px] [--reveal-start:180px]',
      ),
    ],
    [h.span([h.Class('line-clamp-1 text-[17px] font-semibold')], [title])],
  ),
  h.nav(
    [
      h.AriaLabel('Page'),
      h.Class(
        'pointer-events-none fixed inset-x-0 top-0 z-30 flex items-center px-3 pt-[calc(var(--safe-top)+0.25rem)]',
      ),
    ],
    [backButton(h)],
  ),
]

// TAB BAR

const tabIcons = { Home: House, Search, Library: LibraryBig } as const

const tabButton = (tab: Tab, activeTab: Tab, h: HtmlBuilder<Message>): Html => {
  const isActive = tab === activeTab
  return h.button(
    [
      h.Type('button'),
      h.Role('tab'),
      h.AriaSelected(isActive),
      h.OnClick(Message.ClickedTab({ tab })),
      h.Class(
        cn(
          'flex flex-1 flex-col items-center justify-center gap-0.5 pt-1.5 transition-colors active:opacity-60',
          isActive ? 'text-primary' : 'text-muted-foreground',
        ),
      ),
    ],
    [
      icon(h, tabIcons[tab], cn('size-6', isActive && 'stroke-[2.4]')),
      h.span([h.Class('text-[10px] font-medium tracking-wide')], [tab]),
    ],
  )
}

/** The bar along the bottom that switches between Home, Search, and Library. */
export const tabBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.nav(
    [
      h.Role('tablist'),
      h.AriaLabel('Sections'),
      h.Style({ viewTransitionName: 'tab-bar' }),
      h.Class(
        'chrome fixed inset-x-0 bottom-0 z-20 flex h-[calc(var(--tab-bar-height)+var(--safe-bottom))] border-t pb-[var(--safe-bottom)]',
      ),
    ],
    Array.map(TABS, tab => tabButton(tab, model.navigation.activeTab, h)),
  )
