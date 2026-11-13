import { Database } from 'bun:sqlite'
import {
  Array,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Result,
  Schema,
  String,
  pipe,
} from 'effect'

import {
  AlbumSummary,
  ArtistSummary,
  type Artwork,
  LIKED_PLAYLIST_ID,
  MAX_PLAYLIST_TITLE_LENGTH,
  MusicNotFoundError,
  type MyLibrary,
  type MyPlaylistDetails,
  type MyPlaylistSummary,
  type PlaylistEdit,
  type PlaylistEditResult,
  PlaylistStoreError,
  Song,
} from '@music/shared'

const LIKED_TITLE = 'Liked songs'
const UNTITLED = 'Untitled playlist'

/** How many covers the mosaic shows, and how far down to look for them. */
const MOSAIC_COVERS = 4
const COVER_SEARCH_DEPTH = 24

/**
 * Bumped whenever the tables change. Each step in MIGRATIONS takes the file
 * from the version before it.
 */
const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE playlists (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE playlist_songs (
    playlist_id TEXT NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
    video_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    duration_seconds REAL,
    song TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, video_id)
  ) STRICT;

  CREATE INDEX playlist_songs_by_position
    ON playlist_songs (playlist_id, position);
  `,
  `
  CREATE TABLE play_history (
    video_id TEXT PRIMARY KEY,
    song TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    play_count INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX play_history_by_time ON play_history (played_at);
  `,
  `
  CREATE TABLE saved_albums (
    album_id TEXT PRIMARY KEY,
    album TEXT NOT NULL,
    saved_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE followed_artists (
    artist_id TEXT PRIMARY KEY,
    artist TEXT NOT NULL,
    followed_at INTEGER NOT NULL
  ) STRICT;
  `,
]

/** Songs the play history keeps; older plays drop off. */
export const PLAY_HISTORY_SIZE = 200

// ROWS

/** A song is kept as JSON, so a playlist page needs no trip to YouTube. */
const SongJson = Schema.fromJsonString(Schema.toCodecJson(Song))
const encodeSong = Schema.encodeSync(SongJson)
const decodeSong = Schema.decodeUnknownOption(SongJson)

/** Saved albums and followed artists are kept whole too, as JSON. */
const AlbumJson = Schema.fromJsonString(Schema.toCodecJson(AlbumSummary))
const encodeAlbum = Schema.encodeSync(AlbumJson)
const decodeAlbum = Schema.decodeUnknownOption(AlbumJson)

const ArtistJson = Schema.fromJsonString(Schema.toCodecJson(ArtistSummary))
const encodeArtist = Schema.encodeSync(ArtistJson)
const decodeArtist = Schema.decodeUnknownOption(ArtistJson)

const SummaryRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  updated_at: Schema.Number,
  song_count: Schema.Number,
  total_seconds: Schema.Number,
})
type SummaryRow = typeof SummaryRow.Type

const SongRow = Schema.Struct({ song: Schema.String })

const PlayedRow = Schema.Struct({
  song: Schema.String,
  play_count: Schema.Number,
})
const AlbumRow = Schema.Struct({ album: Schema.String })
const ArtistRow = Schema.Struct({ artist: Schema.String })
const VideoIdRow = Schema.Struct({ video_id: Schema.String })
const PositionRow = Schema.Struct({ position: Schema.NullOr(Schema.Number) })
const VersionRow = Schema.Struct({ user_version: Schema.Number })

const decodeRows =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (rows: ReadonlyArray<unknown>): ReadonlyArray<A> =>
    Schema.decodeUnknownSync(Schema.Array(schema))(rows)

// TITLES

/** A title as it is kept: trimmed, not empty, and not too long. */
export const normalizeTitle = (title: string): string =>
  pipe(
    String.trim(title),
    Option.liftPredicate(String.isNonEmpty),
    Option.map(trimmed => trimmed.slice(0, MAX_PLAYLIST_TITLE_LENGTH).trim()),
    Option.getOrElse(() => UNTITLED),
  )

/** Up to four covers from different albums, in playlist order. */
export const mosaicCovers = (
  songs: ReadonlyArray<Song>,
): ReadonlyArray<Artwork> =>
  pipe(
    songs,
    Array.filter(song => Array.isReadonlyArrayNonEmpty(song.artwork)),
    Array.dedupeWith(
      (left, right) =>
        Option.getOrElse(
          Option.map(left.maybeAlbum, ({ id }) => id),
          () => left.videoId,
        ) ===
        Option.getOrElse(
          Option.map(right.maybeAlbum, ({ id }) => id),
          () => right.videoId,
        ),
    ),
    Array.take(MOSAIC_COVERS),
    Array.map(song => song.artwork),
  )

// SERVICE

export interface PlaylistStoreShape {
  readonly library: () => Effect.Effect<MyLibrary, PlaylistStoreError>
  readonly playlist: (
    playlistId: string,
  ) => Effect.Effect<MyPlaylistDetails, MusicNotFoundError | PlaylistStoreError>
  readonly edit: (
    edit: PlaylistEdit,
  ) => Effect.Effect<
    PlaylistEditResult,
    MusicNotFoundError | PlaylistStoreError
  >
  /** Notes that `song` played, on any device. */
  readonly recordPlay: (song: Song) => Effect.Effect<void, PlaylistStoreError>
  /** The songs played most recently, newest first, each once. */
  readonly recentlyPlayed: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Song>, PlaylistStoreError>
  /**
   * The songs played most often, with how many times, the most played
   * first (the latest played first on a tie).
   */
  readonly mostPlayed: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PlayedSong>, PlaylistStoreError>
}

/** A song from the play history and how many times it played. */
export type PlayedSong = Readonly<{ song: Song; playCount: number }>

/**
 * The playlists made in the app, Liked songs, the albums saved and artists
 * followed, and what played lately, kept in one SQLite file on the server.
 */
export class PlaylistStore extends Context.Service<
  PlaylistStore,
  PlaylistStoreShape
>()('PlaylistStore') {}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : globalThis.String(cause)

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

/**
 * Builds the store on an open database. `now` and `newId` are passed in so
 * tests can fix them.
 */
export const makePlaylistStore = (
  db: Database,
  options: Readonly<{ now: () => number; newId: () => string }>,
): PlaylistStoreShape => {
  migrate(db)

  const ensureLiked = (): void => {
    const now = options.now()
    db.query(
      `INSERT OR IGNORE INTO playlists (id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(LIKED_PLAYLIST_ID, LIKED_TITLE, now, now)
  }
  ensureLiked()

  const songsOf = (
    playlistId: string,
    limit: number = -1,
  ): ReadonlyArray<Song> =>
    pipe(
      db
        .query(
          `SELECT song FROM playlist_songs WHERE playlist_id = ?
           ORDER BY position LIMIT ?`,
        )
        .all(playlistId, limit),
      decodeRows(SongRow),
      Array.map(row => decodeSong(row.song)),
      Array.getSomes,
    )

  const toSummary = (row: SummaryRow): MyPlaylistSummary => ({
    id: row.id,
    title: row.title,
    isLiked: row.id === LIKED_PLAYLIST_ID,
    songCount: row.song_count,
    totalSeconds: Math.round(row.total_seconds),
    covers: mosaicCovers(songsOf(row.id, COVER_SEARCH_DEPTH)),
    updatedAt: row.updated_at,
  })

  const SUMMARY_SELECT = `
    SELECT p.id, p.title, p.updated_at,
      COUNT(s.video_id) AS song_count,
      COALESCE(SUM(s.duration_seconds), 0) AS total_seconds
    FROM playlists p
    LEFT JOIN playlist_songs s ON s.playlist_id = p.id`

  const readSummary = (playlistId: string): Option.Option<MyPlaylistSummary> =>
    pipe(
      db
        .query(`${SUMMARY_SELECT} WHERE p.id = ? GROUP BY p.id`)
        .all(playlistId),
      decodeRows(SummaryRow),
      Array.head,
      Option.map(toSummary),
    )

  const readAlbums = (): ReadonlyArray<AlbumSummary> =>
    pipe(
      db
        .query(
          'SELECT album FROM saved_albums ORDER BY saved_at DESC, rowid DESC',
        )
        .all(),
      decodeRows(AlbumRow),
      Array.map(row => decodeAlbum(row.album)),
      Array.getSomes,
    )

  const readArtists = (): ReadonlyArray<ArtistSummary> =>
    pipe(
      db
        .query(
          `SELECT artist FROM followed_artists
           ORDER BY followed_at DESC, rowid DESC`,
        )
        .all(),
      decodeRows(ArtistRow),
      Array.map(row => decodeArtist(row.artist)),
      Array.getSomes,
    )

  const readLibrary = (): MyLibrary => ({
    playlists: pipe(
      db
        .query(
          `${SUMMARY_SELECT} GROUP BY p.id
           ORDER BY p.id = ? DESC, p.updated_at DESC, p.created_at DESC`,
        )
        .all(LIKED_PLAYLIST_ID),
      decodeRows(SummaryRow),
      Array.map(toSummary),
    ),
    likedVideoIds: pipe(
      db
        .query(
          `SELECT video_id FROM playlist_songs WHERE playlist_id = ?
           ORDER BY position`,
        )
        .all(LIKED_PLAYLIST_ID),
      decodeRows(VideoIdRow),
      Array.map(row => row.video_id),
    ),
    albums: readAlbums(),
    artists: readArtists(),
  })

  const readDetails = (playlistId: string): Option.Option<MyPlaylistDetails> =>
    Option.map(readSummary(playlistId), playlist => ({
      playlist,
      songs: songsOf(playlistId),
    }))

  const touch = (playlistId: string): void => {
    db.query('UPDATE playlists SET updated_at = ? WHERE id = ?').run(
      options.now(),
      playlistId,
    )
  }

  const edgePosition = (playlistId: string, edge: 'MIN' | 'MAX'): number =>
    pipe(
      db
        .query(
          `SELECT ${edge}(position) AS position FROM playlist_songs
           WHERE playlist_id = ?`,
        )
        .all(playlistId),
      decodeRows(PositionRow),
      Array.head,
      Option.flatMap(row => Option.fromNullishOr(row.position)),
      Option.getOrElse(() => 0),
    )

  /** Adds songs at one end, skipping any the playlist already holds. */
  const insertSongs = (
    playlistId: string,
    songs: ReadonlyArray<Song>,
    end: 'Start' | 'End',
  ): void => {
    const insert = db.query(
      `INSERT OR IGNORE INTO playlist_songs
         (playlist_id, video_id, position, duration_seconds, song, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const now = options.now()
    const unique = Array.dedupeWith(
      songs,
      (left, right) => left.videoId === right.videoId,
    )
    const ordered = end === 'Start' ? Array.reverse(unique) : unique
    Array.forEach(ordered, song => {
      const position =
        end === 'Start'
          ? edgePosition(playlistId, 'MIN') - 1
          : edgePosition(playlistId, 'MAX') + 1
      insert.run(
        playlistId,
        song.videoId,
        position,
        Option.getOrNull(song.maybeDurationSeconds),
        encodeSong(song),
        now,
      )
    })
  }

  const exists = (playlistId: string): boolean =>
    Option.isSome(readSummary(playlistId))

  const notFound = (playlistId: string) =>
    new MusicNotFoundError({ id: playlistId })

  const whenExists =
    (playlistId: string, change: () => void) =>
    (): Result.Result<Option.Option<string>, MusicNotFoundError> => {
      if (!exists(playlistId)) {
        return Result.fail(notFound(playlistId))
      }
      change()
      return Result.succeed(Option.some(playlistId))
    }

  const removeSong = (playlistId: string, videoId: string): void => {
    db.query(
      'DELETE FROM playlist_songs WHERE playlist_id = ? AND video_id = ?',
    ).run(playlistId, videoId)
  }

  /** Saving again moves the album to the top, with its latest details. */
  const setAlbumSaved = (album: AlbumSummary, isSaved: boolean): void => {
    if (isSaved) {
      db.query(
        `INSERT INTO saved_albums (album_id, album, saved_at) VALUES (?, ?, ?)
         ON CONFLICT (album_id) DO UPDATE SET
           album = excluded.album,
           saved_at = excluded.saved_at`,
      ).run(album.id, encodeAlbum(album), options.now())
    } else {
      db.query('DELETE FROM saved_albums WHERE album_id = ?').run(album.id)
    }
  }

  const setArtistFollowed = (
    artist: ArtistSummary,
    isFollowed: boolean,
  ): void => {
    if (isFollowed) {
      db.query(
        `INSERT INTO followed_artists (artist_id, artist, followed_at)
         VALUES (?, ?, ?)
         ON CONFLICT (artist_id) DO UPDATE SET
           artist = excluded.artist,
           followed_at = excluded.followed_at`,
      ).run(artist.id, encodeArtist(artist), options.now())
    } else {
      db.query('DELETE FROM followed_artists WHERE artist_id = ?').run(
        artist.id,
      )
    }
  }

  /**
   * Changes the database, returning the id of the playlist it changed, if
   * it changed one.
   */
  const change = (
    edit: PlaylistEdit,
  ): (() => Result.Result<Option.Option<string>, MusicNotFoundError>) =>
    Match.valueTags(edit, {
      Create:
        ({ title, songs }) =>
        () => {
          const id = options.newId()
          const now = options.now()
          db.query(
            `INSERT INTO playlists (id, title, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
          ).run(id, normalizeTitle(title), now, now)
          insertSongs(id, songs, 'End')
          return Result.succeed(Option.some(id))
        },
      Rename: ({ playlistId, title }) =>
        whenExists(playlistId, () => {
          if (playlistId !== LIKED_PLAYLIST_ID) {
            db.query('UPDATE playlists SET title = ? WHERE id = ?').run(
              normalizeTitle(title),
              playlistId,
            )
            touch(playlistId)
          }
        }),
      Delete: ({ playlistId }) =>
        whenExists(playlistId, () => {
          if (playlistId !== LIKED_PLAYLIST_ID) {
            db.query('DELETE FROM playlists WHERE id = ?').run(playlistId)
          }
        }),
      AddSongs: ({ playlistId, songs }) =>
        whenExists(playlistId, () => {
          insertSongs(playlistId, songs, 'End')
          touch(playlistId)
        }),
      RemoveSong: ({ playlistId, videoId }) =>
        whenExists(playlistId, () => {
          removeSong(playlistId, videoId)
          touch(playlistId)
        }),
      SetLiked:
        ({ song, isLiked }) =>
        () => {
          ensureLiked()
          if (isLiked) {
            insertSongs(LIKED_PLAYLIST_ID, [song], 'Start')
          } else {
            removeSong(LIKED_PLAYLIST_ID, song.videoId)
          }
          touch(LIKED_PLAYLIST_ID)
          return Result.succeed(Option.some(LIKED_PLAYLIST_ID))
        },
      SetAlbumSaved:
        ({ album, isSaved }) =>
        () => {
          setAlbumSaved(album, isSaved)
          return Result.succeed(Option.none())
        },
      SetArtistFollowed:
        ({ artist, isFollowed }) =>
        () => {
          setArtistFollowed(artist, isFollowed)
          return Result.succeed(Option.none())
        },
    })

  /** Runs the change in one transaction, then reads back what it changed. */
  const applyEdit = (
    edit: PlaylistEdit,
  ): Result.Result<PlaylistEditResult, MusicNotFoundError> =>
    Result.map(db.transaction(change(edit))(), maybeChangedId => ({
      library: readLibrary(),
      maybePlaylist: Option.flatMap(maybeChangedId, readDetails),
    }))

  /** Moves the song to the top of the history and drops the oldest plays. */
  const writePlay = (song: Song): void => {
    db.transaction(() => {
      db.query(
        `INSERT INTO play_history (video_id, song, played_at, play_count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (video_id) DO UPDATE SET
           song = excluded.song,
           played_at = excluded.played_at,
           play_count = play_count + 1`,
      ).run(song.videoId, encodeSong(song), options.now())
      db.query(
        `DELETE FROM play_history WHERE video_id NOT IN (
           SELECT video_id FROM play_history
           ORDER BY played_at DESC LIMIT ?
         )`,
      ).run(PLAY_HISTORY_SIZE)
    })()
  }

  const readRecentlyPlayed = (limit: number): ReadonlyArray<Song> =>
    pipe(
      db
        .query(
          `SELECT song FROM play_history
           ORDER BY played_at DESC LIMIT ?`,
        )
        .all(limit),
      decodeRows(SongRow),
      Array.map(row => decodeSong(row.song)),
      Array.getSomes,
    )

  const readMostPlayed = (limit: number): ReadonlyArray<PlayedSong> =>
    pipe(
      db
        .query(
          `SELECT song, play_count FROM play_history
           ORDER BY play_count DESC, played_at DESC LIMIT ?`,
        )
        .all(limit),
      decodeRows(PlayedRow),
      Array.map(row =>
        Option.map(decodeSong(row.song), song => ({
          song,
          playCount: row.play_count,
        })),
      ),
      Array.getSomes,
    )

  const attempt = <A>(run: () => A) =>
    Effect.try({
      try: run,
      catch: cause => new PlaylistStoreError({ message: errorMessage(cause) }),
    })

  return {
    library: Effect.fn('PlaylistStore.library')(function* () {
      return yield* attempt(readLibrary)
    }),
    playlist: Effect.fn('PlaylistStore.playlist')(function* (
      playlistId: string,
    ) {
      const maybeDetails = yield* attempt(() => readDetails(playlistId))
      return yield* Option.match(maybeDetails, {
        onNone: () => Effect.fail(notFound(playlistId)),
        onSome: Effect.succeed,
      })
    }),
    edit: Effect.fn('PlaylistStore.edit')(function* (edit: PlaylistEdit) {
      const result = yield* attempt(() => applyEdit(edit))
      return yield* Effect.fromResult(result)
    }),
    recordPlay: Effect.fn('PlaylistStore.recordPlay')(function* (song: Song) {
      yield* attempt(() => writePlay(song))
    }),
    recentlyPlayed: Effect.fn('PlaylistStore.recentlyPlayed')(function* (
      limit: number,
    ) {
      return yield* attempt(() => readRecentlyPlayed(limit))
    }),
    mostPlayed: Effect.fn('PlaylistStore.mostPlayed')(function* (
      limit: number,
    ) {
      return yield* attempt(() => readMostPlayed(limit))
    }),
  }
}

/**
 * Opens the playlist database at `PLAYLISTS_DB_PATH`, by default
 * `~/.local/share/music/playlists.sqlite`, for the life of the server.
 */
export const PlaylistStoreLive = Layer.effect(PlaylistStore)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* Config.String('HOME').pipe(Config.withDefault('/tmp'))
    const file = yield* Config.String('PLAYLISTS_DB_PATH').pipe(
      Config.withDefault(
        path.join(home, '.local', 'share', 'music', 'playlists.sqlite'),
      ),
    )
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.orDie)
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(file, { create: true, strict: true })),
      database => Effect.sync(() => database.close()),
    )
    return PlaylistStore.of(
      makePlaylistStore(db, {
        now: () => Date.now(),
        newId: () => crypto.randomUUID(),
      }),
    )
  }),
)
