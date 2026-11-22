import { Duration, Effect, Option } from 'effect'
import { HttpServerRequest, HttpServerResponse, UrlParams } from 'effect/http'

import { type Notice, signInPage } from './page.ts'
import type { AccessStore } from './store.ts'

/*
 * The lock on the app's public address. Tailscale Funnel forwards the
 * internet to a listener of its own (`PUBLIC_PORT`, on loopback only), and
 * every request there passes through `gated`: a device signed in with an
 * invite code (`store.ts`) gets the whole app, as on the home network;
 * anything else gets the sign-in page or a 401. The home network's listeners
 * don't pass through it.
 *
 * Opening an invite link only fills in the code: signing in takes the form's
 * POST, so a chat app fetching the link for a preview signs nobody in.
 */

export const COOKIE = 'joshify_device'
/** The longest a browser keeps a cookie (Chrome caps it at 400 days). */
export const COOKIE_MAX_AGE = Duration.days(400)

export const SIGN_IN_PATH = '/sign-in'
/** Answers 204 when signed in, so the web app can tell (`signIn.ts`). */
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
  '/robots.txt',
])

const ROBOTS = 'User-agent: *\nDisallow: /\n'

/** Failed codes allowed from one address, and from everyone, per window. */
const FAILURES_PER_ADDRESS = 10
const FAILURES_IN_ALL = 100
const FAILURE_WINDOW_MS = 15 * 60 * 1000

export interface GateConfig {
  /** The public address, such as `https://joshify.example.ts.net`. */
  readonly origin: string
}

/**
 * Counts failed codes, per address and in all, over a window. Fifty bits of
 * code against a hundred guesses every quarter hour takes ages to find one.
 */
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

const pathnameOf = (url: string): string => new URL(url, 'http://gate').pathname

const queryParam = (url: string, name: string): string =>
  new URL(url, 'http://gate').searchParams.get(name) ?? ''

/** The client's address, which Funnel's proxy puts first. */
const clientAddress = (request: HttpServerRequest.HttpServerRequest): string =>
  (request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() ||
  Option.getOrElse(request.remoteAddress, () => 'unknown')

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
  return changes && maybeOrigin !== undefined && maybeOrigin !== config.origin
}

/** A page load (not a fetch, an image, or the audio element). */
const isPageLoad = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.method === 'GET' &&
  (request.headers['sec-fetch-mode'] === 'navigate' ||
    (request.headers['sec-fetch-mode'] === undefined &&
      (request.headers['accept'] ?? '').includes('text/html')))

const NO_STORE = { 'cache-control': 'no-store' }

const page = (code: string, notice: Notice, status: number) =>
  HttpServerResponse.text(signInPage(code, notice), {
    status,
    contentType: 'text/html; charset=utf-8',
    headers: NO_STORE,
  })

const withDeviceCookie = (token: string) =>
  HttpServerResponse.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE,
  })

const signIn = (
  request: HttpServerRequest.HttpServerRequest,
  store: AccessStore,
  failures: FailureCounter,
  config: GateConfig,
) =>
  Effect.gen(function* () {
    const address = clientAddress(request)
    if (isCrossSite(request, config)) {
      return HttpServerResponse.text('Forbidden', { status: 403 })
    }
    if (failures.isLockedOut(address)) {
      return page('', 'TooManyTries', 429)
    }
    const code = yield* request.urlParamsBody.pipe(
      Effect.map(params =>
        Option.getOrElse(UrlParams.getFirst(params, 'code'), () => ''),
      ),
      Effect.orElseSucceed(() => ''),
    )
    const maybeToken = store.signIn(code, request.headers['user-agent'] ?? '')
    if (Option.isNone(maybeToken)) {
      failures.fail(address)
      yield* Effect.logWarning('A wrong invite code', address)
      return page(code, 'WrongCode', 401)
    }
    return yield* HttpServerResponse.redirect('/', {
      status: 303,
      headers: NO_STORE,
    }).pipe(withDeviceCookie(maybeToken.value), Effect.orDie)
  })

/**
 * Puts `app` behind the lock. Devices are looked up in `store` on every
 * request (one indexed SQLite read), so revoking an invite takes effect at
 * once, and a device's cookie gets a fresh 400 days once a day.
 */
export const gated =
  (store: AccessStore, config: GateConfig, now: () => number = Date.now) =>
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
      const pathname = pathnameOf(request.url)
      const maybeDevice = Option.flatMap(
        Option.fromNullishOr(request.cookies[COOKIE]),
        store.device,
      )

      if (pathname === SIGN_IN_PATH) {
        if (request.method === 'POST') {
          return yield* signIn(request, store, failures, config)
        }
        if (Option.isSome(maybeDevice)) {
          return HttpServerResponse.redirect('/', { headers: NO_STORE })
        }
        return page(queryParam(request.url, 'code'), 'None', 200)
      }
      if (pathname === '/robots.txt') {
        return HttpServerResponse.text(ROBOTS)
      }
      if (PUBLIC_PATHS.has(pathname)) {
        return yield* app
      }
      if (Option.isNone(maybeDevice)) {
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
      const response = yield* app
      const token = request.cookies[COOKIE]
      return maybeDevice.value.isDue && token !== undefined
        ? yield* withDeviceCookie(token)(response).pipe(
            Effect.orElseSucceed(() => response),
          )
        : response
    })
  }
