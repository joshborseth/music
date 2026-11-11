import { Option, Schema } from 'effect'

import { TAB_ROOT_URLS, Tab } from './route'

/**
 * How the app arrived at the page it shows. Pushing a page slides it in from
 * the right, going back slides it away, and switching tabs cross-fades.
 */
export const NavigationKind = Schema.Literals([
  'Initial',
  'Push',
  'Pop',
  'Replace',
  'SwitchTab',
])
export type NavigationKind = typeof NavigationKind.Type

/** The page each tab was last showing, so switching back returns there. */
export const TabUrls = Schema.Struct({
  Home: Schema.String,
  Search: Schema.String,
  Library: Schema.String,
})
export type TabUrls = typeof TabUrls.Type

/** How far down each visited page was scrolled, by URL path. */
export const ScrollPositions = Schema.Record(Schema.String, Schema.Number)
export type ScrollPositions = typeof ScrollPositions.Type

export const NavigationModel = Schema.Struct({
  activeTab: Tab,
  tabUrls: TabUrls,
  scrollPositions: ScrollPositions,
  maybePendingNavigation: Schema.Option(NavigationKind),
  lastNavigation: NavigationKind,
})
export type NavigationModel = typeof NavigationModel.Type

export const initialNavigationModel = (activeTab: Tab): NavigationModel => ({
  activeTab,
  tabUrls: TAB_ROOT_URLS,
  scrollPositions: {},
  maybePendingNavigation: Option.none(),
  lastNavigation: 'Initial',
})
