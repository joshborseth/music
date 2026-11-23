import { Option } from 'effect'
import type { Headers } from 'effect/http'

/*
 * Who a request is from, as the gate (`gate.ts`) tells the app behind it.
 * It sets these headers itself, after dropping any copy a request brought.
 */

/** Whose library and session a request uses: an account's id, or `home`. */
export const OWNER_HEADER = 'x-joshify-owner'
/** The signed-in account's id; absent for a guest on the home network. */
export const USER_HEADER = 'x-joshify-user'
/** The owner's library and session: the TV's, and every guest's. */
export const HOME_OWNER = 'home'

/** Whose library and session a request uses, as the gate said. */
export const ownerOf = (headers: Headers.Headers): string =>
  headers[OWNER_HEADER] ?? HOME_OWNER

/** The signed-in account a request is from, as the gate said. */
export const userOf = (headers: Headers.Headers): Option.Option<string> =>
  Option.fromNullishOr(headers[USER_HEADER])
