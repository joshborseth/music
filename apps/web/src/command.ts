import { Effect, Option, Schema } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { Command, Dom } from 'foldkit'
import { back, load, pushUrl, replaceUrl } from 'foldkit/navigation'

import { BrowserKeyValueStore } from '@effect/platform-browser'

import {
  PAGE_TOP_ID,
  RECENT_SEARCHES_KEY,
  SEARCH_DEBOUNCE,
  SEARCH_INPUT_ID,
} from './constant'
import { Message } from './message'

const RecentSearchesJson = Schema.fromJsonString(Schema.Array(Schema.String))

export const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) =>
    pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
})

export const LoadExternal = Command.define('LoadExternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) =>
    load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
})

export const NavigateBack = Command.define('NavigateBack', {
  messages: [Message.CompletedNavigateBack],
  execute: back().pipe(Effect.as(Message.CompletedNavigateBack())),
})

export const ReplaceSearchUrl = Command.define('ReplaceSearchUrl', {
  args: { url: Schema.String },
  messages: [Message.CompletedReplaceSearchUrl],
  execute: ({ url }) =>
    replaceUrl(url).pipe(Effect.as(Message.CompletedReplaceSearchUrl())),
})

export const ScrollToTop = Command.define('ScrollToTop', {
  messages: [Message.CompletedScrollToTop],
  execute: Dom.scrollIntoView(`#${PAGE_TOP_ID}`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedScrollToTop()),
  ),
})

export const FocusSearchInput = Command.define('FocusSearchInput', {
  messages: [Message.CompletedFocusSearchInput],
  execute: Dom.focus(`#${SEARCH_INPUT_ID}`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusSearchInput()),
  ),
})

export const WaitBeforeSearch = Command.define('WaitBeforeSearch', {
  args: { query: Schema.String },
  messages: [Message.CompletedWaitBeforeSearch],
  execute: ({ query }) =>
    Effect.sleep(SEARCH_DEBOUNCE).pipe(
      Effect.as(Message.CompletedWaitBeforeSearch({ query })),
    ),
})

export const LoadRecentSearches = Command.define('LoadRecentSearches', {
  messages: [Message.CompletedLoadRecentSearches],
  execute: Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore
    const maybeJson = Option.fromNullishOr(
      yield* store.get(RECENT_SEARCHES_KEY),
    )
    const json = yield* Effect.fromOption(maybeJson)
    const recentSearches = yield* Schema.decodeEffect(RecentSearchesJson)(json)
    return Message.CompletedLoadRecentSearches({ recentSearches })
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        Message.CompletedLoadRecentSearches({ recentSearches: [] }),
      ),
    ),
    Effect.provide(BrowserKeyValueStore.layerLocalStorage),
  ),
})

export const SaveRecentSearches = Command.define('SaveRecentSearches', {
  args: { recentSearches: Schema.Array(Schema.String) },
  messages: [Message.CompletedSaveRecentSearches],
  execute: ({ recentSearches }) =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore
      const json =
        yield* Schema.encodeEffect(RecentSearchesJson)(recentSearches)
      yield* store.set(RECENT_SEARCHES_KEY, json)
      return Message.CompletedSaveRecentSearches()
    }).pipe(
      Effect.catch(() => Effect.succeed(Message.CompletedSaveRecentSearches())),
      Effect.provide(BrowserKeyValueStore.layerLocalStorage),
    ),
})
