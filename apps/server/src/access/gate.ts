import { Effect, Option } from 'effect'
import {
  Cookies,
  Headers as HttpHeaders,
  HttpServerRequest,
  HttpServerResponse,
  UrlParams,
} from 'effect/http'

import { JOIN_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from '@music/shared'

import type { Accounts, SetCookies } from './accounts.ts'
import { HOME_OWNER, OWNER_HEADER, USER_HEADER } from './owner.ts'
import {
  type JoinNotice,
  type SignInNotice,
  joinPage,
  signInPage,
} from './page.ts'

/*
 * Who each request is from. Every listener passes through `gated`: it reads
 * the account a request's session cookie names (`accounts.ts`), and tells
 * the app behind it in two headers it sets itself, after dropping any copy
 * the request brought:
 *
 * - `x-joshify-owner`: whose library and session the request uses: the
 *   account's id, or `home` for the owner (the TV's session).
 * - `x-joshify-user`: the signed-in account's id; absent for a guest.
 *
 * On the public address (`requireSignIn`) a request without an account gets
 * the sign-in page or a 401. On the home network it is a guest of the
 * owner's session, as the TV and anyone scanning its QR code have always
 * been.
 */

/** Answers 204 when the app may load, so the web app can tell (`signIn.ts`). */
export const SIGNED_IN_PATH = '/signed-in'

/**
 * What a browser fetches without its cookies (the manifest is fetched
 * without credentials), or before signing in: the sign-in page's logo and
 * the Home Screen icons. None of it says anything about anyone.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/maskable-icon-512x512.png',
])

const ROBOTS = 'User-agent: *\nDisallow: /\n'

/** Failed sign-ins allowed from one address, and from everyone, per window. */
const FAILURES_PER_ADDRESS = 10
const FAILURES_IN_ALL = 100
const FAILURE_WINDOW_MS = 15 * 60 * 1000

export interface GateConfig {
  /** The address pages are served at, such as `https://joshify.example.ts.net`. */
  readonly origin: string
  /** Whether a request must come from an account (the public address). */
  readonly requireSignIn: boolean
}

/** Counts failed sign-ins, per address and in all, over a window. */
export const makeFailureCounter = (now: () => number) => {
  const byAddress = new Map<string, Array<number>>()
  let all: Array<number> = []
  const prune = (times: ReadonlyArray<number>) =>
    times.filter(time => now() - time < FAILURE_WINDOW_MS)
  return {
    isLockedOut: (address: string): boolean => {
      all = prune(all)
      const recent = prune(byAddress.get(address) ?? [])
      byAddress.set(address, recent)
      return (
        all.length >= FAILURES_IN_ALL || recent.length >= FAILURES_PER_ADDRESS
      )
    },
    fail: (address: string): void => {
      all.push(now())
      byAddress.set(address, [...prune(byAddress.get(address) ?? []), now()])
      if (byAddress.size > 10_000) {
        byAddress.clear()
      }
    },
  }
}

type FailureCounter = ReturnType<typeof makeFailureCounter>

const urlOf = (url: string): URL => new URL(url, 'http://gate')

/** The client's address, which Funnel's proxy puts first. */
const clientAddress = (request: HttpServerRequest.HttpServerRequest): string =>
  (request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() ||
  Option.getOrElse(request.remoteAddress, () => 'unknown')

/** The request's headers as Better Auth reads them. */
const webHeaders = (request: HttpServerRequest.HttpServerRequest): Headers => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    headers.set(name, value)
  }
  if (!headers.has('x-forwarded-for')) {
    headers.set('x-forwarded-for', clientAddress(request))
  }
  return headers
}

/**
 * Whether another site's page could have sent this: a request that changes
 * something (anything but GET or HEAD) or opens the session's WebSocket
 * must come from the app's own pages, which browsers say in `Origin`.
 */
const isCrossSite = (
  request: HttpServerRequest.HttpServerRequest,
  config: GateConfig,
): boolean => {
  const changes =
    !['GET', 'HEAD'].includes(request.method) ||
    request.headers['upgrade']?.toLowerCase() === 'websocket'
  const maybeOrigin = request.headers['origin']
  if (!changes || maybeOrigin === undefined) return false
  if (config.requireSignIn) return maybeOrigin !== config.origin
  // NOTE: the home network has several addresses (plain HTTP, HTTPS, the
  // machine's name), all on this host. A page from anywhere else is not ours.
  const host = request.headers['host']
  return host === undefined || urlOf(maybeOrigin).host !== host
}

/** A page load (not a fetch, an image, or the audio element). */
const isPageLoad = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.method === 'GET' &&
  (request.headers['sec-fetch-mode'] === 'navigate' ||
    (request.headers['sec-fetch-mode'] === undefined &&
      (request.headers['accept'] ?? '').includes('text/html')))

const NO_STORE = { 'cache-control': 'no-store' }

const html = (text: string, status: number) =>
  HttpServerResponse.text(text, {
    status,
    contentType: 'text/html; charset=utf-8',
    headers: NO_STORE,
  })

/** A redirect after a form, carrying the cookies it set. */
const redirectWith = (location: string, cookies: SetCookies) =>
  HttpServerResponse.redirect(location, {
    status: 303,
    headers: NO_STORE,
  }).pipe(HttpServerResponse.mergeCookies(Cookies.fromSetCookie(cookies)))

const formOf = (request: HttpServerRequest.HttpServerRequest) =>
  request.urlParamsBody.pipe(
    Effect.map(
      params => (name: string) =>
        Option.getOrElse(UrlParams.getFirst(params, name), () => ''),
    ),
    Effect.orElseSucceed(() => (_name: string) => ''),
  )

const signInPost = (
  request: HttpServerRequest.HttpServerRequest,
  accounts: Accounts,
  failures: FailureCounter,
) =>
  Effect.gen(function* () {
    const address = clientAddress(request)
    const page = (username: string, notice: SignInNotice, status: number) =>
      html(signInPage(username, notice), status)
    if (failures.isLockedOut(address)) return page('', 'TooManyTries', 429)
    const field = yield* formOf(request)
    const username = field('username').trim()
    return yield* accounts
      .signIn(username, field('password'), webHeaders(request))
      .pipe(
        Effect.map(cookies => redirectWith('/', cookies)),
        Effect.catchTag('WrongPassword', () => {
          failures.fail(address)
          return Effect.as(
            Effect.logWarning('A wrong password', { address, username }),
            page(username, 'WrongPassword', 401),
          )
        }),
      )
  })

const joinGet = (
  request: HttpServerRequest.HttpServerRequest,
  accounts: Accounts,
) => {
  const code = urlOf(request.url).searchParams.get('code') ?? ''
  const maybeInvite = accounts.findInvite(code)
  return html(
    joinPage(maybeInvite, code, '', 'None'),
    Option.isSome(maybeInvite) ? 200 : 404,
  )
}

const joinPost = (
  request: HttpServerRequest.HttpServerRequest,
  accounts: Accounts,
  failures: FailureCounter,
) =>
  Effect.gen(function* () {
    const address = clientAddress(request)
    const field = yield* formOf(request)
    const code = field('code')
    const username = field('username').trim()
    const page = (notice: JoinNotice, status: number) =>
      html(joinPage(accounts.findInvite(code), code, username, notice), status)
    if (failures.isLockedOut(address)) return page('TooManyTries', 429)
    return yield* accounts
      .join({
        code,
        username,
        password: field('password'),
        confirm: field('confirm'),
        headers: webHeaders(request),
      })
      .pipe(
        Effect.map(cookies => redirectWith('/', cookies)),
        Effect.catchTag('JoinError', error => {
          if (error.problem === 'InviteGone') failures.fail(address)
          return Effect.succeed(page(error.problem, 400))
        }),
      )
  })

/**
 * Puts `app` behind accounts. Sessions are looked up on every request (one
 * indexed SQLite read), so signing someone out takes effect at once.
 */
export const gated =
  (accounts: Accounts, config: GateConfig, now: () => number = Date.now) =>
  <E, R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > => {
    const failures = makeFailureCounter(now)
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const pathname = urlOf(request.url).pathname

      if (pathname === '/robots.txt') {
        return HttpServerResponse.text(ROBOTS)
      }
      const isForm =
        request.method === 'POST' &&
        (pathname === SIGN_IN_PATH ||
          pathname === JOIN_PATH ||
          pathname === SIGN_OUT_PATH)
      if (isForm && isCrossSite(request, config)) {
        return HttpServerResponse.text('Forbidden', { status: 403 })
      }
      if (pathname === SIGN_IN_PATH && request.method === 'POST') {
        return yield* signInPost(request, accounts, failures)
      }
      if (pathname === JOIN_PATH) {
        return request.method === 'POST'
          ? yield* joinPost(request, accounts, failures)
          : joinGet(request, accounts)
      }
      if (pathname === SIGN_OUT_PATH && request.method === 'POST') {
        const cookies = yield* accounts.signOut(webHeaders(request))
        return redirectWith(SIGN_IN_PATH, cookies)
      }

      const maybeAccount = yield* accounts.signedIn(webHeaders(request))
      if (pathname === SIGN_IN_PATH) {
        return Option.isSome(maybeAccount)
          ? HttpServerResponse.redirect('/', { headers: NO_STORE })
          : html(signInPage('', 'None'), 200)
      }
      if (PUBLIC_PATHS.has(pathname)) {
        return yield* app
      }
      if (Option.isNone(maybeAccount) && config.requireSignIn) {
        return isPageLoad(request)
          ? HttpServerResponse.redirect(SIGN_IN_PATH, { headers: NO_STORE })
          : HttpServerResponse.text('Sign in first', {
              status: 401,
              headers: NO_STORE,
            })
      }
      if (isCrossSite(request, config)) {
        return HttpServerResponse.text('Forbidden', { status: 403 })
      }
      if (pathname === SIGNED_IN_PATH) {
        return HttpServerResponse.empty({ status: 204, headers: NO_STORE })
      }
      const withoutOurs = HttpHeaders.removeMany(request.headers, [
        OWNER_HEADER,
        USER_HEADER,
      ])
      const headers = Option.match(maybeAccount, {
        onNone: () => HttpHeaders.set(withoutOurs, OWNER_HEADER, HOME_OWNER),
        onSome: account =>
          HttpHeaders.setAll(withoutOurs, {
            [OWNER_HEADER]: Option.contains(accounts.ownerId(), account.id)
              ? HOME_OWNER
              : account.id,
            [USER_HEADER]: account.id,
          }),
      })
      return yield* Effect.provideService(
        app,
        HttpServerRequest.HttpServerRequest,
        request.modify({ headers }),
      )
    })
  }
