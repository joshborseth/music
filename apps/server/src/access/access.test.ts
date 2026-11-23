import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { Effect, Option } from 'effect'
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { type Accounts, makeAccounts } from './accounts.ts'
import { gated } from './gate.ts'
import { HOME_OWNER, OWNER_HEADER, USER_HEADER } from './owner.ts'

const ORIGIN = 'https://joshify.example.ts.net'
const PASSWORD = 'correct horse'

const setUp = async (options: { readonly requireSignIn?: boolean } = {}) => {
  let time = Date.parse('2026-11-22T12:00:00Z')
  const now = () => time
  const accounts = await Effect.runPromise(
    makeAccounts(new Database(':memory:'), {
      secret: 'test-secret-test-secret-test-secret-42',
      origin: ORIGIN,
      now,
    }),
  )
  // The app answers with who the gate said the request is from.
  const app = Effect.map(HttpServerRequest.HttpServerRequest, request =>
    HttpServerResponse.text(
      `owner=${request.headers[OWNER_HEADER] ?? '-'} user=${request.headers[USER_HEADER] ?? '-'}`,
    ),
  )
  const handler = HttpEffect.toWebHandler(
    gated(
      accounts,
      { origin: ORIGIN, requireSignIn: options.requireSignIn ?? true },
      now,
    )(app),
  )
  const call = (path: string, init: RequestInit = {}) =>
    handler(new Request(`http://127.0.0.1:4312${path}`, init))
  const advance = (ms: number) => {
    time += ms
  }
  return { accounts, call, advance }
}

const inviteCode = (accounts: Accounts, role: 'Admin' | 'Member' = 'Member') =>
  Effect.runPromise(accounts.createInvite('test', role)).then(
    created => created.code,
  )

const form = (
  fields: Record<string, string>,
  origin = ORIGIN,
): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    origin,
  },
  body: new URLSearchParams(fields).toString(),
})

/** The session cookie a response set, as a `Cookie` header. */
const cookieOf = (response: Response): string => {
  const cookie = response.headers
    .getSetCookie()
    .map(line => line.split(';')[0] ?? '')
    .find(pair => pair.includes('session_token=') && !pair.endsWith('='))
  if (cookie === undefined) {
    throw new Error(`No session cookie in ${response.headers.getSetCookie()}`)
  }
  return cookie
}

type Call = Awaited<ReturnType<typeof setUp>>['call']

const join = async (call: Call, code: string, username: string) => {
  const response = await call(
    '/join',
    form({ code, username, password: PASSWORD, confirm: PASSWORD }),
  )
  expect(response.status).toBe(303)
  return cookieOf(response)
}

describe('the public address', () => {
  test('sends a page load to sign in, and refuses anything else', async () => {
    const { call } = await setUp()
    const page = await call('/', { headers: { accept: 'text/html' } })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/sign-in')
    expect((await call('/rpc', { method: 'POST' })).status).toBe(401)
    expect((await call('/audio/abc')).status).toBe(401)
    expect((await call('/signed-in')).status).toBe(401)
  })

  test('serves the icons and the manifest to anyone', async () => {
    const { call } = await setUp()
    expect((await call('/manifest.webmanifest')).status).toBe(200)
    expect((await call('/apple-touch-icon.png')).status).toBe(200)
    expect(await (await call('/robots.txt')).text()).toContain('Disallow: /')
  })

  test('makes the first account from an invite the owner, an admin', async () => {
    const { accounts, call } = await setUp()
    const code = await inviteCode(accounts, 'Member')
    const cookie = await join(call, code, 'Josh')
    const response = await call('/', { headers: { cookie } })
    expect(await response.text()).toMatch(
      new RegExp(`^owner=${HOME_OWNER} user=\\S+$`),
    )
    const people = accounts.listAll()
    expect(people.people).toEqual([
      expect.objectContaining({
        username: 'josh',
        role: 'Admin',
        isOwner: true,
      }),
    ])
    expect(people.invites).toEqual([])
  })

  test('gives everyone else their own library and session', async () => {
    const { accounts, call } = await setUp()
    await join(call, await inviteCode(accounts), 'josh')
    const cookie = await join(call, await inviteCode(accounts), 'sam')
    const text = await (await call('/', { headers: { cookie } })).text()
    const sam = accounts.listAll().people.find(p => p.username === 'sam')
    expect(sam?.role).toBe('Member')
    expect(text).toBe(`owner=${sam?.id} user=${sam?.id}`)
  })

  test('uses an invite once', async () => {
    const { accounts, call } = await setUp()
    const code = await inviteCode(accounts)
    await join(call, code, 'josh')
    const again = await call(
      '/join',
      form({ code, username: 'sam', password: PASSWORD, confirm: PASSWORD }),
    )
    expect(again.status).toBe(400)
    expect(await again.text()).toContain('has been used, has expired')
    expect((await call(`/join?code=${code}`)).status).toBe(404)
  })

  test('lets an invite expire after a week', async () => {
    const { accounts, call, advance } = await setUp()
    const code = await inviteCode(accounts)
    expect((await call(`/join?code=${code}`)).status).toBe(200)
    advance(7 * 24 * 60 * 60 * 1000 + 1)
    expect((await call(`/join?code=${code}`)).status).toBe(404)
  })

  test('checks a new account’s username and passwords', async () => {
    const { accounts, call } = await setUp()
    const code = await inviteCode(accounts)
    const attempt = (fields: Record<string, string>) =>
      call('/join', form({ code, ...fields })).then(r => r.text())
    expect(
      await attempt({
        username: 'no spaces',
        password: PASSWORD,
        confirm: PASSWORD,
      }),
    ).toContain('letters, numbers, dots, or underscores')
    expect(
      await attempt({ username: 'sam', password: 'short', confirm: 'short' }),
    ).toContain('characters for your password')
    expect(
      await attempt({
        username: 'sam',
        password: PASSWORD,
        confirm: 'other one',
      }),
    ).toContain('don’t match')
    await join(call, code, 'sam')
    expect(
      await call(
        '/join',
        form({
          code: await inviteCode(accounts),
          username: 'SAM',
          password: PASSWORD,
          confirm: PASSWORD,
        }),
      ).then(r => r.text()),
    ).toContain('already has that username')
  })

  test('signs in with a username and password, and out again', async () => {
    const { accounts, call } = await setUp()
    await join(call, await inviteCode(accounts), 'josh')
    const wrong = await call(
      '/sign-in',
      form({ username: 'josh', password: 'not it at all' }),
    )
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).toContain('isn’t right')
    const signedIn = await call(
      '/sign-in',
      form({ username: 'Josh', password: PASSWORD }),
    )
    expect(signedIn.status).toBe(303)
    expect(signedIn.headers.get('location')).toBe('/')
    const cookie = cookieOf(signedIn)
    expect((await call('/signed-in', { headers: { cookie } })).status).toBe(204)
    const out = await call('/sign-out', {
      ...form({}),
      headers: { origin: ORIGIN, cookie },
    })
    expect(out.status).toBe(303)
    expect(out.headers.get('location')).toBe('/sign-in')
    expect((await call('/signed-in', { headers: { cookie } })).status).toBe(401)
  })

  test('locks sign-in after ten wrong passwords from one address', async () => {
    const { accounts, call, advance } = await setUp()
    await join(call, await inviteCode(accounts), 'josh')
    const attempt = (password: string) =>
      call('/sign-in', {
        ...form({ username: 'josh', password }),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: ORIGIN,
          'x-forwarded-for': '203.0.113.9',
        },
      })
    for (let index = 0; index < 10; index++) {
      expect((await attempt('wrong password')).status).toBe(401)
    }
    expect((await attempt(PASSWORD)).status).toBe(429)
    advance(15 * 60 * 1000 + 1)
    expect((await attempt(PASSWORD)).status).toBe(303)
  })

  test('refuses forms and changes from another site', async () => {
    const { accounts, call } = await setUp()
    const cookie = await join(call, await inviteCode(accounts), 'josh')
    const signIn = await call(
      '/sign-in',
      form({ username: 'josh', password: PASSWORD }, 'https://evil.example'),
    )
    expect(signIn.status).toBe(403)
    const rpc = await call('/rpc', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    })
    expect(rpc.status).toBe(403)
  })

  test('drops the headers a request brings to claim someone else', async () => {
    const { accounts, call } = await setUp()
    await join(call, await inviteCode(accounts), 'josh')
    const cookie = await join(call, await inviteCode(accounts), 'sam')
    const sam = accounts.listAll().people.find(p => p.username === 'sam')
    const text = await (
      await call('/', {
        headers: { cookie, [OWNER_HEADER]: HOME_OWNER, [USER_HEADER]: 'josh' },
      })
    ).text()
    expect(text).toBe(`owner=${sam?.id} user=${sam?.id}`)
  })
})

describe('the home network', () => {
  test('lets a guest use the owner’s session without signing in', async () => {
    const { call } = await setUp({ requireSignIn: false })
    expect(await (await call('/')).text()).toBe(`owner=${HOME_OWNER} user=-`)
    expect((await call('/signed-in')).status).toBe(204)
  })

  test('drops a guest’s claim to be someone', async () => {
    const { call } = await setUp({ requireSignIn: false })
    const text = await (
      await call('/', {
        headers: { [OWNER_HEADER]: 'sam', [USER_HEADER]: 'sam' },
      })
    ).text()
    expect(text).toBe(`owner=${HOME_OWNER} user=-`)
  })
})

describe('admin', () => {
  const headersFor = (cookie: string) => new Headers({ cookie })

  test('only admins see and manage people', async () => {
    const { accounts, call } = await setUp()
    const josh = headersFor(
      await join(call, await inviteCode(accounts), 'josh'),
    )
    const sam = headersFor(await join(call, await inviteCode(accounts), 'sam'))
    const refused = await Effect.runPromise(Effect.flip(accounts.people(sam)))
    expect(refused.reason).toBe('NotAllowed')
    const people = await Effect.runPromise(accounts.people(josh))
    expect(people.people.map(person => person.username)).toEqual([
      'josh',
      'sam',
    ])
    const samId = people.people[1]?.id ?? ''
    const promoted = await Effect.runPromise(
      accounts.setRole(josh, samId, 'Admin'),
    )
    expect(promoted.people[1]?.role).toBe('Admin')
    // Sam, now an admin, still can't demote or remove the owner.
    const ownerId = Option.getOrThrow(accounts.ownerId())
    const demote = await Effect.runPromise(
      Effect.flip(accounts.setRole(sam, ownerId, 'Member')),
    )
    expect(demote.reason).toBe('Owner')
    const remove = await Effect.runPromise(
      Effect.flip(accounts.removePerson(sam, ownerId)),
    )
    expect(remove.reason).toBe('Owner')
  })

  test('resetting a password signs the person out everywhere', async () => {
    const { accounts, call } = await setUp()
    const josh = headersFor(
      await join(call, await inviteCode(accounts), 'josh'),
    )
    const samCookie = await join(call, await inviteCode(accounts), 'sam')
    const samId =
      accounts.listAll().people.find(p => p.username === 'sam')?.id ?? ''
    await Effect.runPromise(
      accounts.resetPassword(josh, samId, 'a brand new one'),
    )
    expect(
      (await call('/signed-in', { headers: { cookie: samCookie } })).status,
    ).toBe(401)
    const signIn = await call(
      '/sign-in',
      form({ username: 'sam', password: 'a brand new one' }),
    )
    expect(signIn.status).toBe(303)
  })

  test('removing someone signs them out and frees their username', async () => {
    const { accounts, call } = await setUp()
    const josh = headersFor(
      await join(call, await inviteCode(accounts), 'josh'),
    )
    const samCookie = await join(call, await inviteCode(accounts), 'sam')
    const samId =
      accounts.listAll().people.find(p => p.username === 'sam')?.id ?? ''
    const after = await Effect.runPromise(accounts.removePerson(josh, samId))
    expect(after.people.map(person => person.username)).toEqual(['josh'])
    expect(
      (await call('/signed-in', { headers: { cookie: samCookie } })).status,
    ).toBe(401)
    await join(call, await inviteCode(accounts), 'sam')
  })

  test('changing your own password needs the current one', async () => {
    const { accounts, call } = await setUp()
    const josh = headersFor(
      await join(call, await inviteCode(accounts), 'josh'),
    )
    const wrong = await Effect.runPromise(
      Effect.flip(
        accounts.changePassword(josh, 'not my password', 'next one!'),
      ),
    )
    expect(wrong.reason).toBe('WrongPassword')
    const weak = await Effect.runPromise(
      Effect.flip(accounts.changePassword(josh, PASSWORD, 'short')),
    )
    expect(weak.reason).toBe('WeakPassword')
    await Effect.runPromise(
      accounts.changePassword(josh, PASSWORD, 'next one!'),
    )
    const signIn = await call(
      '/sign-in',
      form({ username: 'josh', password: 'next one!' }),
    )
    expect(signIn.status).toBe(303)
  })

  test('invites list until used or revoked', async () => {
    const { accounts, call } = await setUp()
    const josh = headersFor(
      await join(call, await inviteCode(accounts), 'josh'),
    )
    const created = await Effect.runPromise(accounts.inviteAs(josh, 'Admin'))
    expect(created.people.invites).toEqual([
      expect.objectContaining({ role: 'Admin', createdBy: 'josh' }),
    ])
    const after = await Effect.runPromise(
      accounts.revokeInvite(josh, created.invite.id),
    )
    expect(after.invites).toEqual([])
    expect((await call(`/join?code=${created.code}`)).status).toBe(404)
  })
})
