import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { admin, username as usernamePlugin } from 'better-auth/plugins'
import { Database } from 'bun:sqlite'
import { Array, Effect, Option, Schema } from 'effect'
import { createHash, randomBytes } from 'node:crypto'

import {
  AccountError,
  type AccountRole,
  type Invite,
  JOIN_PATH,
  MAX_INVITE_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  type People,
  type Person,
  USERNAME_PATTERN,
} from '@music/shared'

/*
 * Accounts, through Better Auth: a username and a password each, kept in
 * `AUTH_DB_PATH` with its own tables (`user`, `session`, `account`,
 * `verification`). Better Auth's HTTP routes aren't served; the gate's own
 * forms (`gate.ts`) and the RPCs call it on the server, so the only ways in
 * are the ones written here.
 *
 * Nobody signs up alone: sign-up through Better Auth is off, and an account
 * is made only from an invite (`joshify_invites`), which an admin makes and
 * which works once. The first account made becomes the owner
 * (`joshify_meta`): the TV's session and the library from before accounts
 * are theirs, and nobody can demote or remove them.
 */

/** Better Auth keeps an email per user; ours are never mailed. */
const EMAIL_DOMAIN = 'users.joshify.invalid'

/** A device stays signed in this long, renewed each day it's used. */
const SESSION_DAYS = 400
const DAY_SECONDS = 24 * 60 * 60

/** Who made the invites made from this machine's command line. */
export const MACHINE_INVITER = 'this machine'

/** How long an invite link works. */
export const INVITE_DAYS = 7
const DAY_MS = DAY_SECONDS * 1000

/** Crockford's base 32: no I, L, O, or U, so a code reads back unambiguously. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 16

/**
 * Our own tables beside Better Auth's. Each step runs once, counted in
 * `joshify_meta` under `migrations`; add a change as a new step, and never
 * edit a shipped one. The first step predates the count, so it stays safe to
 * run again.
 */
const OUR_MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE IF NOT EXISTS joshify_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS joshify_invites (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  `,
  // NOTE: invites keep their code from here on, so an admin can send the
  // link again; older invites have none and can only be revoked.
  `
  ALTER TABLE joshify_invites ADD COLUMN name TEXT NOT NULL DEFAULT '';
  ALTER TABLE joshify_invites ADD COLUMN code TEXT;
  `,
]

const MIGRATIONS_KEY = 'migrations'

/** Someone signed in, as a request's cookie says. */
export interface SignedIn {
  readonly id: string
  readonly username: string
  readonly role: AccountRole
}

/** Why an invite page or its form was turned away. */
export type JoinProblem =
  | 'InviteGone'
  | 'UsernameInvalid'
  | 'UsernameTaken'
  | 'PasswordInvalid'
  | 'PasswordsDiffer'

export class JoinError extends Schema.TaggedError<JoinError>()('JoinError', {
  problem: Schema.Literals([
    'InviteGone',
    'UsernameInvalid',
    'UsernameTaken',
    'PasswordInvalid',
    'PasswordsDiffer',
  ]),
}) {}

/** A Better Auth call that failed: its HTTP status name, such as `UNAUTHORIZED`. */
export class AuthCallError extends Schema.TaggedError<AuthCallError>()(
  'AuthCallError',
  { status: Schema.String, message: Schema.String },
) {}

export class WrongPassword extends Schema.TaggedError<WrongPassword>()(
  'WrongPassword',
  {},
) {}

/** The cookies a response should set, as `Set-Cookie` header values. */
export type SetCookies = ReadonlyArray<string>

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex')

/** An invite code as typed: no dashes or spaces, upper case. */
export const normalizeCode = (code: string): string =>
  code.replace(/[\s-]/g, '').toUpperCase()

const newCode = (): string =>
  Array.fromIterable(randomBytes(CODE_LENGTH))
    .map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length])
    .join('')

const toRole = (stored: unknown): AccountRole =>
  stored === 'admin' ? 'Admin' : 'Member'

const fromRole = (role: AccountRole): 'admin' | 'user' =>
  role === 'Admin' ? 'admin' : 'user'

const isUsername = (text: string): boolean => USERNAME_PATTERN.test(text)

/** Who an invite is for, tidied: one line, trimmed, and not too long. */
export const cleanInviteName = (name: string): string =>
  name.replace(/\s+/g, ' ').trim().slice(0, MAX_INVITE_NAME_LENGTH).trim()

const isPassword = (text: string): boolean =>
  text.length >= MIN_PASSWORD_LENGTH && text.length <= MAX_PASSWORD_LENGTH

const UserRow = Schema.Struct({
  id: Schema.String,
  username: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
})
const LastActiveRow = Schema.Struct({
  userId: Schema.String,
  lastActive: Schema.String,
})
const InviteRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  code: Schema.NullOr(Schema.String),
  role: Schema.String,
  created_by: Schema.String,
  created_at: Schema.Number,
  expires_at: Schema.Number,
})
const ValueRow = Schema.Struct({ value: Schema.String })

const INVITE_COLUMNS =
  'id, name, code, role, created_by, created_at, expires_at'

const decodeRows =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (rows: unknown): ReadonlyArray<S['Type']> =>
    Schema.decodeUnknownSync(Schema.Array(schema))(rows)

const epoch = (iso: string): number => {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? time : 0
}

const failed = (message: string) =>
  new AccountError({ reason: 'Failed', message })

const notAllowed = () =>
  new AccountError({ reason: 'NotAllowed', message: 'Only an admin can.' })

/** The status a Better Auth `APIError` carries, if it is one. */
const statusOf = (error: unknown): Option.Option<string> =>
  typeof error === 'object' &&
  error !== null &&
  'status' in error &&
  typeof error.status === 'string'
    ? Option.some(error.status)
    : Option.none()

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export interface AccountsConfig {
  /** Signs session cookies. At least 32 characters. */
  readonly secret: string
  /** Where invite links point: the public address. */
  readonly origin: string
  readonly now?: () => number
}

const makeBetterAuth = (db: Database, config: AccountsConfig) =>
  betterAuth({
    appName: 'Joshify',
    database: db,
    secret: config.secret,
    baseURL: config.origin,
    telemetry: { enabled: false },
    // NOTE: the gate logs failed sign-ins itself, with the address.
    logger: { level: 'error' },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
    },
    session: {
      expiresIn: SESSION_DAYS * DAY_SECONDS,
      updateAge: DAY_SECONDS,
    },
    advanced: { useSecureCookies: true },
    plugins: [
      usernamePlugin({ minUsernameLength: 3, maxUsernameLength: 30 }),
      admin(),
    ],
  })

type Auth = ReturnType<typeof makeBetterAuth>

const setCookiesOf = (headers: Headers): SetCookies => headers.getSetCookie()

const runOurMigrations = (db: Database): void => {
  db.run(OUR_MIGRATIONS[0] ?? '')
  const done = Number(
    decodeRows(ValueRow)(
      db
        .query('SELECT value FROM joshify_meta WHERE key = ?')
        .all(MIGRATIONS_KEY),
    )[0]?.value ?? '1',
  )
  Array.forEach(OUR_MIGRATIONS, (step, index) => {
    if (index < done) return
    db.transaction(() => {
      db.run(step)
      db.query(
        'INSERT OR REPLACE INTO joshify_meta (key, value) VALUES (?, ?)',
      ).run(MIGRATIONS_KEY, String(index + 1))
    })()
  })
}

/**
 * Opens the accounts in `db`, making their tables on first use. The
 * database stays open for as long as the accounts are used.
 */
export const makeAccounts = (db: Database, config: AccountsConfig) =>
  Effect.gen(function* () {
    const now = config.now ?? Date.now
    const auth: Auth = makeBetterAuth(db, config)
    yield* Effect.tryPromise({
      try: async () => (await getMigrations(auth.options)).runMigrations(),
      catch: error => failed(`Could not set up accounts: ${messageOf(error)}`),
    })
    runOurMigrations(db)

    const call = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: error =>
          new AuthCallError({
            status: Option.getOrElse(statusOf(error), () => ''),
            message: messageOf(error),
          }),
      })

    const ownerId = (): Option.Option<string> =>
      Option.map(
        Option.fromNullishOr(
          decodeRows(ValueRow)(
            db
              .query("SELECT value FROM joshify_meta WHERE key = 'owner'")
              .all(),
          )[0],
        ),
        row => row.value,
      )

    const findUser = (id: string) =>
      Option.fromNullishOr(
        decodeRows(UserRow)(
          db
            .query(
              'SELECT id, username, role, createdAt FROM user WHERE id = ?',
            )
            .all(id),
        )[0],
      )

    /** The signed-in account a request's cookies name, if any. */
    const signedIn = (headers: Headers) =>
      call(() => auth.api.getSession({ headers })).pipe(
        Effect.map(maybeSession =>
          Option.flatMap(Option.fromNullishOr(maybeSession), session =>
            session.user.banned === true
              ? Option.none<SignedIn>()
              : Option.some<SignedIn>({
                  id: session.user.id,
                  username: session.user.username ?? session.user.name,
                  role: toRole(session.user.role),
                }),
          ),
        ),
        Effect.catch(error =>
          Effect.as(
            Effect.logWarning('Reading a session failed', error.message),
            Option.none<SignedIn>(),
          ),
        ),
      )

    /** Sign in with a username and a password: the cookies to set. */
    const signIn = (username: string, password: string, headers: Headers) =>
      isUsername(username) && password.length <= MAX_PASSWORD_LENGTH
        ? call(() =>
            auth.api.signInUsername({
              body: { username: username.toLowerCase(), password },
              headers,
              returnHeaders: true,
            }),
          ).pipe(
            Effect.map(result => setCookiesOf(result.headers)),
            Effect.mapError(() => new WrongPassword()),
          )
        : Effect.fail(new WrongPassword())

    const signOut = (headers: Headers) =>
      call(() => auth.api.signOut({ headers, returnHeaders: true })).pipe(
        Effect.map(result => setCookiesOf(result.headers)),
        Effect.orElseSucceed((): SetCookies => []),
      )

    const findInvite = (code: string): Option.Option<Invite> =>
      Option.map(
        Option.fromNullishOr(
          decodeRows(InviteRow)(
            db
              .query(
                `SELECT ${INVITE_COLUMNS}
                 FROM joshify_invites WHERE code_hash = ? AND expires_at > ?`,
              )
              .all(sha256(normalizeCode(code)), now()),
          )[0],
        ),
        toInvite,
      )

    /**
     * Make an account from an invite and sign this device in. The invite is
     * used up only once the account exists.
     */
    const join = (input: {
      readonly code: string
      readonly username: string
      readonly password: string
      readonly confirm: string
      readonly headers: Headers
    }) =>
      Effect.gen(function* () {
        const maybeInvite = findInvite(input.code)
        if (Option.isNone(maybeInvite)) {
          return yield* new JoinError({ problem: 'InviteGone' })
        }
        if (!isUsername(input.username)) {
          return yield* new JoinError({ problem: 'UsernameInvalid' })
        }
        if (!isPassword(input.password)) {
          return yield* new JoinError({ problem: 'PasswordInvalid' })
        }
        if (input.password !== input.confirm) {
          return yield* new JoinError({ problem: 'PasswordsDiffer' })
        }
        const username = input.username.toLowerCase()
        const taken =
          db.query('SELECT 1 FROM user WHERE username = ?').all(username)
            .length > 0
        if (taken) return yield* new JoinError({ problem: 'UsernameTaken' })
        const invite = maybeInvite.value
        const isFirst = Option.isNone(ownerId())
        const created = yield* call(() =>
          auth.api.createUser({
            body: {
              email: `${username}@${EMAIL_DOMAIN}`,
              password: input.password,
              name: input.username,
              // NOTE: the first account owns the box, so it is an admin
              // whatever its invite said.
              role: fromRole(isFirst ? 'Admin' : invite.role),
              data: { username, displayUsername: input.username },
            },
          }),
        ).pipe(
          Effect.mapError(error =>
            error.status === 'UNPROCESSABLE_ENTITY'
              ? new JoinError({ problem: 'UsernameTaken' })
              : new JoinError({ problem: 'InviteGone' }),
          ),
        )
        db.transaction(() => {
          db.query('DELETE FROM joshify_invites WHERE id = ?').run(invite.id)
          db.query(
            "INSERT OR IGNORE INTO joshify_meta (key, value) VALUES ('owner', ?)",
          ).run(created.user.id)
        })()
        yield* Effect.logInfo(
          `${username} made an account from an invite by ${invite.createdBy}`,
        )
        return yield* signIn(username, input.password, input.headers).pipe(
          Effect.orElseSucceed((): SetCookies => []),
        )
      })

    /** The link that opens an invite: what an admin sends. */
    const linkOf = (code: string): string =>
      `${config.origin}${JOIN_PATH}?code=${code}`

    const toInvite = (row: typeof InviteRow.Type): Invite => ({
      id: row.id,
      name: row.name,
      link: row.code === null ? null : linkOf(row.code),
      role: row.role === 'Admin' ? 'Admin' : 'Member',
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    })

    const readPeople = (): People => {
      const owner = ownerId()
      const lastActive = new Map(
        decodeRows(LastActiveRow)(
          db
            .query(
              'SELECT userId, MAX(updatedAt) AS lastActive FROM session GROUP BY userId',
            )
            .all(),
        ).map(row => [row.userId, epoch(row.lastActive)]),
      )
      const people = decodeRows(UserRow)(
        db
          .query(
            'SELECT id, username, role, createdAt FROM user ORDER BY createdAt',
          )
          .all(),
      ).map((row): Person => ({
        id: row.id,
        username: row.username ?? row.id,
        role: toRole(row.role),
        isOwner: Option.contains(owner, row.id),
        createdAt: epoch(row.createdAt),
        lastActiveAt: lastActive.get(row.id) ?? null,
      }))
      const invites = decodeRows(InviteRow)(
        db
          .query(
            `SELECT ${INVITE_COLUMNS}
             FROM joshify_invites WHERE expires_at > ? ORDER BY created_at`,
          )
          .all(now()),
      ).map(toInvite)
      return { people, invites }
    }

    /** The caller, when an admin; fails otherwise. */
    const adminOf = (headers: Headers) =>
      Effect.flatMap(signedIn(headers), maybeAccount =>
        Option.isSome(maybeAccount) && maybeAccount.value.role === 'Admin'
          ? Effect.succeed(maybeAccount.value)
          : Effect.fail(notAllowed()),
      )

    const requireUser = (userId: string) =>
      Option.isSome(findUser(userId))
        ? Effect.void
        : Effect.fail(
            new AccountError({
              reason: 'NotFound',
              message: 'Nobody has that account.',
            }),
          )

    const notOwner = (userId: string) =>
      Option.contains(ownerId(), userId)
        ? Effect.fail(
            new AccountError({
              reason: 'Owner',
              message: 'The owner stays an admin and can’t be removed.',
            }),
          )
        : Effect.void

    const toAccountError = (error: AuthCallError) => failed(error.message)

    /** A new invite, for whoever `name` says, and its code. */
    const createInvite = (createdBy: string, role: AccountRole, name = '') =>
      Effect.sync(() => {
        const code = newCode()
        const row = {
          id: crypto.randomUUID(),
          name: cleanInviteName(name),
          code,
          role: role === 'Admin' ? 'Admin' : 'Member',
          created_by: createdBy,
          created_at: now(),
          expires_at: now() + INVITE_DAYS * DAY_MS,
        }
        db.query(
          `INSERT INTO joshify_invites
             (id, code_hash, code, name, role, created_by, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          sha256(code),
          row.code,
          row.name,
          row.role,
          row.created_by,
          row.created_at,
          row.expires_at,
        )
        db.query('DELETE FROM joshify_invites WHERE expires_at <= ?').run(now())
        return { invite: toInvite(row), code }
      })

    return {
      /** Where invite links point. */
      origin: config.origin,
      ownerId,
      signedIn,
      signIn,
      signOut,
      findInvite,
      join,
      createInvite,
      /** The username an account has, if it exists. */
      usernameOf: (userId: string): Option.Option<string> =>
        Option.flatMap(findUser(userId), row =>
          Option.fromNullishOr(row.username),
        ),
      /** Everyone, for this machine's own command line. */
      listAll: readPeople,
      people: (headers: Headers) => Effect.map(adminOf(headers), readPeople),
      inviteAs: (headers: Headers, role: AccountRole, name: string) =>
        Effect.flatMap(adminOf(headers), account =>
          createInvite(account.username, role, name),
        ).pipe(
          Effect.map(created => ({
            invite: created.invite,
            people: readPeople(),
          })),
        ),
      revokeInvite: (headers: Headers, inviteId: string) =>
        Effect.map(adminOf(headers), () => {
          db.query('DELETE FROM joshify_invites WHERE id = ?').run(inviteId)
          return readPeople()
        }),
      setRole: (headers: Headers, userId: string, role: AccountRole) =>
        Effect.gen(function* () {
          yield* adminOf(headers)
          yield* requireUser(userId)
          yield* notOwner(userId)
          yield* call(() =>
            auth.api.setRole({
              body: { userId, role: fromRole(role) },
              headers,
            }),
          ).pipe(Effect.mapError(toAccountError))
          return readPeople()
        }),
      resetPassword: (headers: Headers, userId: string, password: string) =>
        Effect.gen(function* () {
          yield* adminOf(headers)
          yield* requireUser(userId)
          if (!isPassword(password)) {
            return yield* new AccountError({
              reason: 'WeakPassword',
              message: `Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`,
            })
          }
          yield* call(() =>
            auth.api.setUserPassword({
              body: { userId, newPassword: password },
              headers,
            }),
          ).pipe(Effect.mapError(toAccountError))
          yield* call(() =>
            auth.api.revokeUserSessions({ body: { userId }, headers }),
          ).pipe(Effect.mapError(toAccountError))
        }),
      removePerson: (headers: Headers, userId: string) =>
        Effect.gen(function* () {
          yield* adminOf(headers)
          yield* requireUser(userId)
          yield* notOwner(userId)
          yield* call(() =>
            auth.api.removeUser({ body: { userId }, headers }),
          ).pipe(Effect.mapError(toAccountError))
          return readPeople()
        }),
      changePassword: (
        headers: Headers,
        currentPassword: string,
        newPassword: string,
      ) =>
        Effect.gen(function* () {
          if (!isPassword(newPassword)) {
            return yield* new AccountError({
              reason: 'WeakPassword',
              message: `Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`,
            })
          }
          yield* call(() =>
            auth.api.changePassword({
              body: { currentPassword, newPassword },
              headers,
            }),
          ).pipe(
            Effect.mapError(error =>
              error.status === 'UNAUTHORIZED'
                ? notAllowed()
                : new AccountError({
                    reason: 'WrongPassword',
                    message: 'Your current password isn’t right.',
                  }),
            ),
          )
        }),
    }
  })

export type Accounts = Effect.Success<ReturnType<typeof makeAccounts>>
