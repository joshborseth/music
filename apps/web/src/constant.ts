import { Duration } from 'effect'

export const SEARCH_INPUT_ID = 'search-input'

export const SEARCH_DEBOUNCE = Duration.millis(350)

export const RECENT_SEARCHES_KEY = 'music:recent-searches'

export const MAX_RECENT_SEARCHES = 8

export const SEARCH_BAR_ATTRIBUTE = 'search-bar'
export const SEARCH_BAR_SELECTOR = `[data-${SEARCH_BAR_ATTRIBUTE}]`

export const SEARCH_RESULTS_ATTRIBUTE = 'search-results'
export const SEARCH_RESULTS_SELECTOR = `[data-${SEARCH_RESULTS_ATTRIBUTE}]`

export const PAGE_ATTRIBUTE = 'page'
export const PAGE_SELECTOR = `[data-${PAGE_ATTRIBUTE}]`

export const TITLE_BAR_ATTRIBUTE = 'title-bar'
export const TITLE_BAR_SELECTOR = `[data-${TITLE_BAR_ATTRIBUTE}]`

export const PLAYLIST_TITLE_INPUT_ID = 'playlist-title-input'
