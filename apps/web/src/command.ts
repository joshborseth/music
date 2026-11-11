import { Effect, Option, Random, Schema } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { Command, Dom } from 'foldkit'
import { back, load, pushUrl, replaceUrl } from 'foldkit/navigation'

import { BrowserKeyValueStore } from '@effect/platform-browser'
import { Session, Song } from '@music/shared'

import {
  RECENT_SEARCHES_KEY,
  SEARCH_DEBOUNCE,
  SEARCH_INPUT_ID,
} from './constant'
import {
  LibraryItem,
  RECENTLY_PLAYED_KEY,
  RECENTLY_VIEWED_KEY,
  RecentlyPlayedJson,
  RecentlyViewedJson,
} from './library'
import { Message } from './message'

const RecentSearchesJson = Schema.fromJsonString(Schema.Array(Schema.String))

/** Opens `url`, noting where the page being left was scrolled to. */
export const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) =>
    Effect.gen(function* () {
      const { pathname, search } = globalThis.location
      const scrollTop = globalThis.scrollY
      yield* pushUrl(url)
      return Message.CompletedNavigateInternal({
        fromUrl: `${pathname}${search}`,
        scrollTop,
      })
    }),
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

/** Glides back to the top, as tapping the current tab does in native apps. */
export const ScrollToTop = Command.define('ScrollToTop', {
  messages: [Message.CompletedScrollToTop],
  execute: Effect.sync(() =>
    globalThis.scrollTo({ top: 0, behavior: 'smooth' }),
  ).pipe(Effect.as(Message.CompletedScrollToTop())),
})

/**
 * The app puts each page back where it was left, so the browser must not
 * also try to while the page is still rendering.
 */
export const TakeOverScrollRestoration = Command.define(
  'TakeOverScrollRestoration',
  {
    messages: [Message.CompletedTakeOverScrollRestoration],
    execute: Effect.sync(() => {
      globalThis.history.scrollRestoration = 'manual'
    }).pipe(Effect.as(Message.CompletedTakeOverScrollRestoration())),
  },
)

export const LockScroll = Command.define('LockScroll', {
  messages: [Message.CompletedLockScroll],
  execute: Dom.lockScroll.pipe(Effect.as(Message.CompletedLockScroll())),
})

export const UnlockScroll = Command.define('UnlockScroll', {
  messages: [Message.CompletedUnlockScroll],
  execute: Dom.unlockScroll.pipe(Effect.as(Message.CompletedUnlockScroll())),
})

/** Puts the keyboard away once a search is submitted. */
export const BlurSearchInput = Command.define('BlurSearchInput', {
  messages: [Message.CompletedBlurSearchInput],
  execute: Effect.sync(() => {
    const element = globalThis.document.getElementById(SEARCH_INPUT_ID)
    if (element instanceof HTMLElement) {
      element.blur()
    }
  }).pipe(Effect.as(Message.CompletedBlurSearchInput())),
})

export const ShuffleSongs = Command.define('ShuffleSongs', {
  args: { songs: Schema.Array(Song) },
  messages: [Message.CompletedShuffleSongs],
  execute: ({ songs }) =>
    Random.shuffle(songs).pipe(
      Effect.map(shuffled =>
        Message.CompletedShuffleSongs({ songs: shuffled }),
      ),
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

const readStored = <A>(key: string, codec: Schema.Codec<A, string>) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore
    const maybeJson = Option.fromNullishOr(yield* store.get(key))
    const json = yield* Effect.fromOption(maybeJson)
    return yield* Schema.decodeEffect(codec)(json)
  }).pipe(Effect.option)

export const LoadLibrary = Command.define('LoadLibrary', {
  messages: [Message.CompletedLoadLibrary],
  execute: Effect.gen(function* () {
    const maybeRecentlyPlayed = yield* readStored(
      RECENTLY_PLAYED_KEY,
      RecentlyPlayedJson,
    )
    const maybeRecentlyViewed = yield* readStored(
      RECENTLY_VIEWED_KEY,
      RecentlyViewedJson,
    )
    return Message.CompletedLoadLibrary({
      recentlyPlayed: Option.getOrElse(maybeRecentlyPlayed, () => []),
      recentlyViewed: Option.getOrElse(maybeRecentlyViewed, () => []),
    })
  }).pipe(Effect.provide(BrowserKeyValueStore.layerLocalStorage)),
})

const writeStored = <A>(
  key: string,
  codec: Schema.Codec<A, string>,
  value: A,
) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore
    const json = yield* Schema.encodeEffect(codec)(value)
    yield* store.set(key, json)
  }).pipe(Effect.ignore, Effect.provide(BrowserKeyValueStore.layerLocalStorage))

export const SaveRecentlyPlayed = Command.define('SaveRecentlyPlayed', {
  args: { recentlyPlayed: Schema.Array(Session.QueueTrack) },
  messages: [Message.CompletedSaveRecentlyPlayed],
  execute: ({ recentlyPlayed }) =>
    writeStored(RECENTLY_PLAYED_KEY, RecentlyPlayedJson, recentlyPlayed).pipe(
      Effect.as(Message.CompletedSaveRecentlyPlayed()),
    ),
})

export const SaveRecentlyViewed = Command.define('SaveRecentlyViewed', {
  args: { recentlyViewed: Schema.Array(LibraryItem) },
  messages: [Message.CompletedSaveRecentlyViewed],
  execute: ({ recentlyViewed }) =>
    writeStored(RECENTLY_VIEWED_KEY, RecentlyViewedJson, recentlyViewed).pipe(
      Effect.as(Message.CompletedSaveRecentlyViewed()),
    ),
})
