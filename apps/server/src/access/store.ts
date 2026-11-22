import { Database } from 'bun:sqlite'
import { Array, Option, Schema } from 'effect'
import { createHash, randomBytes } from 'node:crypto'

/*
 * Who may use the app from the internet (`gate.ts`). Each person gets an
 * invite: a name and a code. Signing in with the code on a device gives that
 * device a token, kept in a cookie for good; revoking the invite signs every
 * one of its devices out. Codes and tokens are kept only as SHA-256 hashes,
 * so the file alone signs nobody in.
 */

/** Bumped whenever the tables change. Never edit a shipped step. */
const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE invites (
    name TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE devices (
    token_hash TEXT PRIMARY KEY,
    invite TEXT NOT NULL REFERENCES invites (name) ON DELETE CASCADE,
    user_agent TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  ) STRICT;
  `,
]

/** A device that has gone quiet this long is noted as seen again. */
export const SEEN_EVERY_MS = 24 * 60 * 60 * 1000

/** Crockford's base 32: no I, L, O, or U, so a code reads back unambiguously. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 10

export interface Invite {
  readonly name: string
  readonly createdAt: number
  readonly devices: number
  readonly maybeLastSeen: Option.Option<number>
}

export interface Device {
  readonly invite: string
  /** Whether the device's cookie is due to be sent again with a fresh age. */
  readonly isDue: boolean
}

export interface AccessStore {
  /**
   * A new invite and its code. For a name already invited, a new code
   * replaces the old one, and devices signed in stay signed in.
   */
  readonly invite: (name: string) => string
  /** Removes an invite and signs out its devices. Whether there was one. */
  readonly revoke: (name: string) => boolean
  readonly invites: () => ReadonlyArray<Invite>
  /** A new device token for a code, when the code is an invite's. */
  readonly signIn: (code: string, userAgent: string) => Option.Option<string>
  /** The device a token belongs to, noting that it was seen. */
  readonly device: (token: string) => Option.Option<Device>
}

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex')

/**
 * A code as someone types it back: any case, with or without dashes or
 * spaces, and with the letters Crockford reads as digits.
 */
export const normalizeCode = (typed: string): string =>
  typed
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')

/** `K7QF-2M9X-RT`: ten characters (50 bits), grouped to read out. */
export const formatCode = (code: string): string =>
  [code.slice(0, 4), code.slice(4, 8), code.slice(8)].join('-')

const newCode = (): string =>
  // NOTE: 256 is a multiple of 32, so each byte maps to a letter evenly.
  Array.fromIterable(randomBytes(CODE_LENGTH))
    .map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length])
    .join('')

const newToken = (): string => randomBytes(32).toString('base64url')

const VersionRow = Schema.Struct({ user_version: Schema.Number })
const InviteRow = Schema.Struct({
  name: Schema.String,
  created_at: Schema.Number,
  devices: Schema.Number,
  last_seen: Schema.NullOr(Schema.Number),
})
const NameRow = Schema.Struct({ name: Schema.String })
const DeviceRow = Schema.Struct({
  invite: Schema.String,
  last_seen: Schema.Number,
})

const decodeRows =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (rows: ReadonlyArray<unknown>): ReadonlyArray<A> =>
    Schema.decodeUnknownSync(Schema.Array(schema))(rows)

const migrate = (db: Database): void => {
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  const [versionRow] = decodeRows(VersionRow)(
    db.query('PRAGMA user_version').all(),
  )
  const version = versionRow?.user_version ?? 0
  db.transaction(() => {
    Array.forEach(MIGRATIONS.slice(version), step => db.run(step))
    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`)
  })()
}

/** Builds the store on an open database; `now` is passed in for tests. */
export const makeAccessStore = (
  db: Database,
  now: () => number,
): AccessStore => {
  migrate(db)

  const invite = (name: string): string => {
    const code = newCode()
    db.query(
      `INSERT INTO invites (name, code_hash, created_at) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET code_hash = excluded.code_hash`,
    ).run(name, sha256(code), now())
    return code
  }

  const revoke = (name: string): boolean =>
    db.query('DELETE FROM invites WHERE name = ?').run(name).changes > 0

  const invites = (): ReadonlyArray<Invite> =>
    decodeRows(InviteRow)(
      db
        .query(
          `SELECT invites.name, invites.created_at,
             COUNT(devices.token_hash) AS devices,
             MAX(devices.last_seen) AS last_seen
           FROM invites LEFT JOIN devices ON devices.invite = invites.name
           GROUP BY invites.name ORDER BY invites.created_at`,
        )
        .all(),
    ).map(row => ({
      name: row.name,
      createdAt: row.created_at,
      devices: row.devices,
      maybeLastSeen: Option.fromNullOr(row.last_seen),
    }))

  const signIn = (code: string, userAgent: string): Option.Option<string> => {
    const normalized = normalizeCode(code)
    if (normalized.length !== CODE_LENGTH) {
      return Option.none()
    }
    const [maybeRow] = decodeRows(NameRow)(
      db
        .query('SELECT name FROM invites WHERE code_hash = ?')
        .all(sha256(normalized)),
    )
    if (maybeRow === undefined) {
      return Option.none()
    }
    const token = newToken()
    const time = now()
    db.query(
      `INSERT INTO devices (token_hash, invite, user_agent, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(sha256(token), maybeRow.name, userAgent.slice(0, 300), time, time)
    return Option.some(token)
  }

  const device = (token: string): Option.Option<Device> => {
    const tokenHash = sha256(token)
    const [maybeRow] = decodeRows(DeviceRow)(
      db
        .query('SELECT invite, last_seen FROM devices WHERE token_hash = ?')
        .all(tokenHash),
    )
    if (maybeRow === undefined) {
      return Option.none()
    }
    const time = now()
    const isDue = time - maybeRow.last_seen >= SEEN_EVERY_MS
    if (isDue) {
      db.query('UPDATE devices SET last_seen = ? WHERE token_hash = ?').run(
        time,
        tokenHash,
      )
    }
    return Option.some({ invite: maybeRow.invite, isDue })
  }

  return { invite, revoke, invites, signIn, device }
}

/** Opens (or creates) the access file at `file`. */
export const openAccessDatabase = (file: string): Database =>
  new Database(file, { create: true, strict: true })
