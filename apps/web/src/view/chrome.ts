import { Array } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'
import { ChevronLeft, House, type IconNode, LibraryBig, Search } from 'lucide'

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
 * Wraps a page in its own fixed scroll box and has it enter at the scroll
 * position it was left at. The document itself never scrolls: iOS 26 blurs
 * the top of a Home Screen app whenever the document is scrolled (see
 * `.page-scroller` in styles.css). Each page gets its own element, so moving
 * between pages replaces the DOM and runs the page transition.
 */
export const page = (
  model: Model,
  className: string,
  content: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('div')(
    pageKey(model.route),
    [
      h.OnMount(RestoreScroll({ top: restoredScrollTop(model) })),
      h.DataAttribute(PAGE_ATTRIBUTE, ''),
      h.Class('page-scroller'),
    ],
    [
      h.main(
        [
          h.Class(
            cn('mx-auto flex min-h-full w-full max-w-xl flex-col', className),
          ),
        ],
        content,
      ),
    ],
  )

// TOP EDGE

/**
 * A plain bar in the page color across the top of the screen. Each page
 * fades it in as its own header scrolls away, so the header shows untouched
 * at the top.
 */
const scrollEdge = (className: string, h: HtmlBuilder<Message>): Html =>
  h.div([h.AriaHidden(true), h.Class(cn('scroll-edge', className))])

/** Covers the status bar so scrolled content never runs under the clock. */
export const statusBarCover = (h: HtmlBuilder<Message>): Html =>
  h.div([
    h.AriaHidden(true),
    h.Class(
      'status-bar-edge pointer-events-none fixed inset-x-0 top-0 z-30 h-[var(--safe-top)]',
    ),
  ])

const compactTitle = (title: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.AriaHidden(true),
      h.Class(
        'reveal-on-scroll pointer-events-none fixed inset-x-0 top-0 z-30 flex h-[calc(var(--safe-top)+var(--nav-bar-height))] items-end justify-center pb-2.5 [--reveal-start:calc(40px+var(--large-title-gap))] [--reveal-end:calc(96px+var(--large-title-gap))]',
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
        'flex items-end justify-between gap-3 px-4 pt-[calc(var(--safe-top)+var(--nav-bar-height)+var(--large-title-gap))] pb-2',
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
 * centered one over the top edge, as iOS does it.
 */
export const largeTitleHeader = (
  title: string,
  maybeTrailing: Html,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  scrollEdge(
    'reveal-on-scroll [--reveal-start:var(--large-title-gap)] [--reveal-end:calc(var(--nav-bar-height)+var(--large-title-gap))]',
    h,
  ),
  compactTitle(title, h),
  largeTitle(title, maybeTrailing, h),
]

const backButton = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedBack()),
      h.AriaLabel('Back'),
      h.Class(
        'pressable floating pointer-events-auto flex size-10 items-center justify-center rounded-full',
      ),
    ],
    [icon(h, ChevronLeft, 'size-6 -ml-0.5')],
  )

/**
 * A round button for the top right of a detail page, matching Back. An
 * `isOn` button shows its icon in the accent color.
 */
export const navBarButton = (
  config: Readonly<{
    onClick: Message
    iconNode: IconNode
    label: string
    isOn?: boolean
    /** Classes for the icon, such as `fill-current` for a filled heart. */
    iconClass?: string
  }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(config.onClick),
      h.AriaLabel(config.label),
      h.Class(
        cn(
          'pressable floating pointer-events-auto flex size-10 items-center justify-center rounded-full',
          config.isOn === true && 'text-primary',
        ),
      ),
    ],
    [icon(h, config.iconNode, cn('size-[22px]', config.iconClass))],
  )

/** Room a row of round nav bar buttons takes from the screen's edge. */
const navBarButtonsWidth = (buttons: number): string => {
  const count = Math.max(1, buttons)
  return `calc(0.75rem + ${count} * 2.5rem + ${count - 1} * 0.5rem + 0.5rem)`
}

/**
 * The top of a detail page: a round back button floating over the hero, and
 * the top edge with the page title, which fade in together as the page's own
 * title slides under them. The edge sits inside the title bar so it shares
 * the reveal range that `SyncTitleBarReveal` measures onto it. `trailing`
 * sits opposite the back button; `trailingButtons` is how many round
 * buttons it can hold. The title stays centered while it fits between the
 * buttons, moves aside to fit, and ends in "…" past that.
 */
export const detailNavBar = (
  title: string,
  trailing: Html,
  h: HtmlBuilder<Message>,
  trailingButtons: number = 0,
): ReadonlyArray<Html> => [
  h.div(
    [
      h.AriaHidden(true),
      h.DataAttribute(TITLE_BAR_ATTRIBUTE, ''),
      h.Class(
        'reveal-on-scroll pointer-events-none fixed inset-x-0 top-0 z-30 grid h-[calc(var(--safe-top)+var(--nav-bar-height)+0.5rem)] grid-cols-[minmax(var(--title-start),1fr)_minmax(0,max-content)_minmax(var(--title-end),1fr)] items-end pb-3 [--reveal-end:240px] [--reveal-start:180px]',
      ),
      h.Style({
        '--title-start': navBarButtonsWidth(1),
        '--title-end': navBarButtonsWidth(trailingButtons),
      }),
    ],
    [
      scrollEdge('', h),
      h.span(
        [
          h.Class(
            'relative z-[31] col-start-2 min-w-0 truncate text-[17px] font-semibold',
          ),
        ],
        [title],
      ),
    ],
  ),
  h.nav(
    [
      h.AriaLabel('Page'),
      h.Class(
        'pointer-events-none fixed inset-x-0 top-0 z-30 flex items-center justify-between px-3 pt-[calc(var(--safe-top)+0.25rem)]',
      ),
    ],
    [backButton(h), trailing],
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
          'flex flex-1 flex-col items-center justify-center gap-0.5 rounded-full transition-colors active:opacity-60',
          isActive
            ? 'text-primary bg-foreground/[0.07]'
            : 'text-muted-foreground',
        ),
      ),
    ],
    [
      icon(h, tabIcons[tab], cn('size-6', isActive && 'stroke-[2.4]')),
      h.span([h.Class('text-[10px] font-medium tracking-wide')], [tab]),
    ],
  )
}

/**
 * The capsule floating along the bottom that switches between Home, Search,
 * and Library.
 */
export const tabBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-none fixed inset-x-0 bottom-0 z-20 px-3 pb-[var(--tab-bar-bottom)]',
      ),
    ],
    [
      h.nav(
        [
          h.Role('tablist'),
          h.AriaLabel('Sections'),
          h.Style({ viewTransitionName: 'tab-bar' }),
          h.Class(
            'floating pointer-events-auto mx-auto flex h-[var(--tab-bar-height)] max-w-md rounded-full p-1',
          ),
        ],
        Array.map(TABS, tab => tabButton(tab, model.navigation.activeTab, h)),
      ),
    ],
  )
