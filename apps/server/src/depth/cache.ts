import { Database } from 'bun:sqlite'
import { Array, Option, Schema } from 'effect'

/*
 * Covers' depth maps, as the PNGs the TV gets, kept in a SQLite file by
 * artwork URL. Songs from one album share a cover, so most songs find
 * theirs here. The file holds at most `capBytes` of maps: past that, the
 * ones used longest ago go.
 */

/**
 * Bumped when the maps come out differently (another model, another
 * smoothing), so old ones are worked out again.
 */
export const DEPTH_VERSION = 1

/** Enough for a couple of thousand covers. */
export const DEFAULT_CAP_BYTES = 64 * 1024 * 1024

const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE cover_depth (
    url TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    png BLOB NOT NULL,
    bytes INTEGER NOT NULL,
    used_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX cover_depth_by_use ON cover_depth (used_at);
  `,
]

const PngRow = Schema.Struct({ png: Schema.Uint8Array })
const decodePngRow = Schema.decodeUnknownOption(PngRow)

const VersionRow = Schema.Struct({ user_version: Schema.Number })
const decodeVersionRow = Schema.decodeUnknownOption(VersionRow)

const TotalRow = Schema.Struct({ total: Schema.NullOr(Schema.Number) })
const decodeTotalRow = Schema.decodeUnknownOption(TotalRow)

export interface DepthCache {
  /** The cover's depth map, made by the current version; marks it used. */
  readonly get: (url: string, now: number) => Option.Option<Uint8Array>
  /** Keep a depth map, then trim the file back under its cap. */
  readonly put: (url: string, png: Uint8Array, now: number) => void
  /** The bytes of maps kept. */
  readonly totalBytes: () => number
}

export const makeDepthCache = (
  db: Database,
  capBytes: number = DEFAULT_CAP_BYTES,
  version: number = DEPTH_VERSION,
): DepthCache => {
  db.run('PRAGMA journal_mode = WAL')
  const schemaVersion = Option.match(
    decodeVersionRow(db.query('PRAGMA user_version').get()),
    { onNone: () => 0, onSome: row => row.user_version },
  )
  db.transaction(() => {
    Array.forEach(MIGRATIONS.slice(schemaVersion), step => db.run(step))
    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`)
  })()

  const select = db.query(
    'SELECT png FROM cover_depth WHERE url = ? AND version = ?',
  )
  const touch = db.query('UPDATE cover_depth SET used_at = ? WHERE url = ?')
  const upsert = db.query(
    `INSERT INTO cover_depth (url, version, png, bytes, used_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (url) DO UPDATE SET
       version = excluded.version,
       png = excluded.png,
       bytes = excluded.bytes,
       used_at = excluded.used_at`,
  )
  // Everything past the cap, counting from the most recently used.
  const trim = db.query(
    `DELETE FROM cover_depth WHERE url IN (
       SELECT url FROM (
         SELECT url, SUM(bytes) OVER (ORDER BY used_at DESC, url) AS kept
         FROM cover_depth
       ) WHERE kept > ?
     )`,
  )
  const total = db.query('SELECT SUM(bytes) AS total FROM cover_depth')

  return {
    get: (url, now) => {
      const found = Option.map(
        decodePngRow(select.get(url, version)),
        row => row.png,
      )
      if (Option.isSome(found)) touch.run(now, url)
      return found
    },
    put: (url, png, now) => {
      db.transaction(() => {
        upsert.run(url, version, png, png.byteLength, now)
        trim.run(capBytes)
      })()
    },
    totalBytes: () =>
      Option.match(decodeTotalRow(total.get()), {
        onNone: () => 0,
        onSome: row => row.total ?? 0,
      }),
  }
}
