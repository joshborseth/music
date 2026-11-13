import { Option, Schema, String } from 'effect'
import { AsyncData } from 'foldkit'
import { defineTaggedUnion } from 'foldkit/schema'

import { searchSuggestionsQuery } from './query'

/*
 * The list of suggestions under the search box, as Apple Music shows it:
 * from the first letter typed until something is searched for. The search
 * itself still waits for a pause in typing.
 */

// MODEL

/**
 * Whether the list shows. While it shows, it keeps the last typed words
 * whose suggestions arrived, which stay on screen until the next ones do.
 */
export const SuggestionList = defineTaggedUnion({
  Hidden: {},
  Shown: { maybeEarlierQuery: Schema.Option(Schema.String) },
})
export type SuggestionList = typeof SuggestionList.Type

/** The words suggestions are asked for: what is typed, trimmed and lowercase. */
export const suggestionQuery = (input: string): string =>
  String.toLowerCase(String.trim(input))

type SuggestionModel = Readonly<{
  searchInput: string
  suggestionList: SuggestionList
  searchSuggestions: typeof searchSuggestionsQuery.Model.Type
}>

const isLoaded = (model: SuggestionModel, query: string): boolean =>
  Option.isSome(
    AsyncData.getData(
      searchSuggestionsQuery.read(model.searchSuggestions, { query }),
    ),
  )

/**
 * The list once `input` is typed: shown while there is anything typed,
 * remembering the words typed before when their suggestions are the ones
 * on screen.
 */
export const listForInput = (
  model: SuggestionModel,
  input: string,
): SuggestionList => {
  const query = suggestionQuery(input)
  if (String.isEmpty(query)) {
    return SuggestionList.Hidden()
  }
  const before = suggestionQuery(model.searchInput)
  const maybeEarlierQuery = SuggestionList.match(model.suggestionList, {
    Hidden: () => Option.none<string>(),
    Shown: ({ maybeEarlierQuery }) =>
      String.isNonEmpty(before) && isLoaded(model, before)
        ? Option.some(before)
        : maybeEarlierQuery,
  })
  return SuggestionList.Shown({ maybeEarlierQuery })
}

/**
 * The suggestions to show: those for what is typed, or until they arrive,
 * those for the words typed before. Empty while the list is hidden.
 */
export const shownSuggestions = (
  model: SuggestionModel,
): ReadonlyArray<string> => {
  const read = (query: string) =>
    AsyncData.getData(
      searchSuggestionsQuery.read(model.searchSuggestions, { query }),
    )
  return SuggestionList.match(model.suggestionList, {
    Hidden: (): ReadonlyArray<string> => [],
    Shown: ({ maybeEarlierQuery }) =>
      Option.getOrElse(
        Option.orElse(read(suggestionQuery(model.searchInput)), () =>
          Option.flatMap(maybeEarlierQuery, read),
        ),
        (): ReadonlyArray<string> => [],
      ),
  })
}
