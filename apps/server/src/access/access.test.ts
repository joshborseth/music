import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { Effect, Option } from 'effect'
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { COOKIE, gated } from './gate.ts'
import {
  SEEN_EVERY_MS,
  formatCode,
  makeAccessStore,
  normalizeCode,
} from './store.ts'

const ORIGIN = 'https://joshify.example.ts.net'

const setUp = () => {
  let time = 1_000_000
  const now = () => time
  const store = makeAccessStore(new Database(':memory:', { strict: true }), now)
  const app = Effect.map(HttpServerRequest.HttpServerRequest, request =>
    HttpServerResponse.text(`app ${request.method} ${request.url}`),
  )
  const handler = HttpEffect.toWebHandler(
    gated(store, { origin: ORIGIN }, now)(app),
  )
  const call = (path: string, init: RequestInit = {}) =>
    handler(new Request(`http://127.0.0.1:4312${path}`, init))
  const advance = (ms: number) => {
    time += ms
  }
  return { store, call, advance }
}

const cookieOf = (response: Response): string => {
  const header = response.headers.get('set-cookie') ?? ''
  const match = new RegExp(`${COOKIE}=([^;]+)`).exec(header)
  if (match?.[1] === undefined) throw new Error(`No cookie in ${header}`)
  return match[1]
}

const signIn = (
  call: ReturnType<typeof setUp>['call'],
  code: string,
  headers: Record<string, string> = {},
) =>
  call('/sign-in', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      ...headers,
    },
    body: new URLSearchParams({ code }).toString(),
  })

describe('codes', () => {
  test('read back however they are typed', () => {
    expect(normalizeCode('k7qf-2m9x-rt')).toBe('K7QF2M9XRT')
    expect(normalizeCode(' KOQI L ')).toBe('K0Q11')
    expect(formatCode('K7QF2M9XRT')).toBe('K7QF-2M9X-RT')
  })
})

describe('the gate', () => {
  test('sends a page load without a device to sign in, and a fetch a 401', async () => {
    const { call } = setUp()
    const page = await call('/', {
      headers: { 'sec-fetch-mode': 'navigate' },
    })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/sign-in')
    expect((await call('/rpc', { method: 'POST' })).status).toBe(401)
    expect((await call('/audio/abc')).status).toBe(401)
    expect((await call('/session')).status).toBe(401)
    expect((await call('/signed-in')).status).toBe(401)
  })

  test('lets the Home Screen icons and the manifest through', async () => {
    const { call } = setUp()
    const response = await call('/manifest.webmanifest')
    expect(await response.text()).toBe('app GET /manifest.webmanifest')
    expect((await call('/apple-touch-icon.png')).status).toBe(200)
  })

  test('fills in the code from an invite link without signing in', async () => {
    const { call, store } = setUp()
    store.invite('Sam')
    const response = await call('/sign-in?code=K7QF-2M9X-RT')
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.text()).toContain('value="K7QF-2M9X-RT"')
    expect(store.invites()[0]?.devices).toBe(0)
  })

  test('signs a device in with its code and lets it through', async () => {
    const { call, store } = setUp()
    const code = formatCode(store.invite('Sam')).toLowerCase()
    const signedIn = await signIn(call, code)
    expect(signedIn.status).toBe(303)
    expect(signedIn.headers.get('location')).toBe('/')
    const cookie = signedIn.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    const token = cookieOf(signedIn)
    const headers = { cookie: `${COOKIE}=${token}` }
    const app = await call('/rpc', {
      method: 'POST',
      headers: { ...headers, origin: ORIGIN },
    })
    expect(await app.text()).toBe('app POST /rpc')
    expect((await call('/signed-in', { headers })).status).toBe(204)
    expect(store.invites()[0]?.devices).toBe(1)
  })

  test('turns away a wrong code, then everyone guessing too often', async () => {
    const { call, store, advance } = setUp()
    const code = formatCode(store.invite('Sam'))
    const wrong = await signIn(call, 'AAAA-AAAA-AA')
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).toContain('isn’t right')
    for (let i = 0; i < 10; i++) {
      await signIn(call, 'AAAA-AAAA-AA', { 'x-forwarded-for': '203.0.113.9' })
    }
    const lockedOut = await signIn(call, code, {
      'x-forwarded-for': '203.0.113.9',
    })
    expect(lockedOut.status).toBe(429)
    expect((await signIn(call, code)).status).toBe(303)
    advance(16 * 60 * 1000)
    expect(
      (await signIn(call, code, { 'x-forwarded-for': '203.0.113.9' })).status,
    ).toBe(303)
  })

  test('refuses another site’s page acting for a signed-in device', async () => {
    const { call, store } = setUp()
    const token = cookieOf(await signIn(call, store.invite('Sam')))
    const cookie = `${COOKIE}=${token}`
    const posted = await call('/rpc', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    })
    expect(posted.status).toBe(403)
    const socket = await call('/session', {
      headers: { cookie, origin: 'https://evil.example', upgrade: 'websocket' },
    })
    expect(socket.status).toBe(403)
    const signInElsewhere = await signIn(call, store.invite('Pat'), {
      origin: 'https://evil.example',
    })
    expect(signInElsewhere.status).toBe(403)
  })

  test('signs every device out when its invite is revoked', async () => {
    const { call, store } = setUp()
    const token = cookieOf(await signIn(call, store.invite('Sam')))
    store.revoke('Sam')
    const response = await call('/audio/abc', {
      headers: { cookie: `${COOKIE}=${token}` },
    })
    expect(response.status).toBe(401)
    expect(store.invites()).toEqual([])
  })

  test('a new code for a name retires the old code and keeps its devices', async () => {
    const { call, store } = setUp()
    const first = store.invite('Sam')
    const token = cookieOf(await signIn(call, first))
    const second = store.invite('Sam')
    expect(Option.isSome(store.device(token))).toBe(true)
    expect((await signIn(call, first)).status).toBe(401)
    expect((await signIn(call, second)).status).toBe(303)
    expect(store.invites().map(invite => invite.devices)).toEqual([2])
  })

  test('gives a device’s cookie a fresh age once a day', async () => {
    const { call, store, advance } = setUp()
    const token = cookieOf(await signIn(call, store.invite('Sam')))
    const headers = { cookie: `${COOKIE}=${token}` }
    expect((await call('/', { headers })).headers.get('set-cookie')).toBeNull()
    advance(SEEN_EVERY_MS)
    const refreshed = await call('/', { headers })
    expect(cookieOf(refreshed)).toBe(token)
    expect((await call('/', { headers })).headers.get('set-cookie')).toBeNull()
  })
})
