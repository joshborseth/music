import { Match } from 'effect'
import type { Runtime } from 'foldkit'

import type { Message } from './message'
import type { Model } from './model'
import { pageKey } from './route'

/**
 * Animates moving between pages the way a native app does: a pushed page
 * slides in over the last one, going back slides it away, and switching tabs
 * cross-fades. Typing a search stays on the same page and never animates.
 *
 * Several Messages land in the frame that changes the page, so this compares
 * the pages themselves rather than looking for one Message.
 */
export const viewTransition: Runtime.ViewTransitionConfig<Model, Message> = ({
  previousModel,
  model,
}) =>
  pageKey(previousModel.route) === pageKey(model.route)
    ? false
    : Match.value(model.navigation.lastNavigation).pipe(
        Match.withReturnType<Runtime.ViewTransitionDecision>(),
        Match.when('Push', () => ({ types: ['push'] })),
        Match.when('Pop', () => ({ types: ['pop'] })),
        Match.when('SwitchTab', () => ({ types: ['tab'] })),
        Match.orElse(() => false),
      )
