import { Schema } from 'effect'

import { QueueTrack } from './session.ts'

/*
 * The TV app's catalog: plain JSON over HTTP, so the Rust TV app can browse
 * and play without the phone. The web app keeps using Effect RPC; these
 * routes reshape the same catalog into what a TV screen needs.
 *
 * Mirrored by serde types in `apps/tv/src/catalog.rs`. Like the session
 * protocol, every field is plain JSON (nullable, never Option). Change both
 * sides together, and update the shared fixtures in `fixtures/tv/` that both
 * test suites decode.
 *
 *   GET  /tv/home                          TvShelves  the phone's Home: albums and songs played lately
 *                                                    (on any device), your mixes (playlists whose id
 *                                                    is YouTube's radio id, RDAMVM + a song), more
 *                                                    like the song played last, new releases from the
 *                                                    artists you follow, your playlists, your latest
 *                                                    liked songs, the artists you follow, and your
 *                                                    latest playlists' songs, the fuller shelves first
 *   GET  /tv/library                       TvShelves  your playlists, Liked songs first, then
 *                                                    saved albums and followed artists
 *   GET  /tv/search?q=…                    TvShelves  songs, artists, albums, playlists
 *   GET  /tv/collection?kind=…&id=…        TvCollection
 *   GET  /tv/lyrics?videoId=…              TvLyrics
 *   GET  /tv/analysis?videoId=…            TvAnalysis the song's beats, bars, sections and drops
 *   GET  /tv/loudness?videoId=…[&wait=true] TvLoudness the gain that levels the song (Sound Check):
 *                                                    the best known now, or with `wait`, once the
 *                                                    server has measured it
 *   GET  /tv/montage?videoId=…             TvMontage  key frames of the song's music video (or the
 *                                                    artist's photos and covers) for the visuals
 *   GET  /tv/montage.jpg?videoId=…         the frames, packed into one JPEG (`TvMontage`)
 *   GET  /tv/liked?videoId=…               TvLiked
 *   POST /tv/like   (TvLikeRequest)        TvLiked
 *   GET  /tv/saved?kind=…&id=…             TvSaved    whether an album is saved or an artist followed
 *   POST /tv/save   (TvSaveRequest)        TvSaved
 *   GET  /tv/song?videoId=…                TvSong     the album and the artists a song links to
 *   POST /tv/playlist-add (TvAddToPlaylistRequest)
 *                                          TvAddedToPlaylist  add a song to a playlist you made
 *   GET  /tv/version                       TvVersion
 *   POST /tv/updating                      204: the TV is installing an update; reopen it after
 *
 * A failure answers with a non-2xx status and a plain-text message.
 */

/** What a card opens. A song card plays; the rest open a collection. */
export const TvCardKind = Schema.Literals([
  'Song',
  'Album',
  'Playlist',
  'MyPlaylist',
  'Artist',
])
export type TvCardKind = typeof TvCardKind.Type

/** One tile on a shelf. */
export const TvCard = Schema.Struct({
  kind: TvCardKind,
  /** The videoId, albumId, playlistId, my playlist's id, or artistId. */
  id: Schema.String,
  title: Schema.String,
  /** Artists, "Album · 2024", "Playlist · 32 songs", and so on. */
  subtitle: Schema.String,
  artworkUrl: Schema.NullOr(Schema.String),
  /** Set for song cards: enough to play it. */
  track: Schema.NullOr(QueueTrack),
})
export type TvCard = typeof TvCard.Type

/** One titled row of cards. */
export const TvShelf = Schema.Struct({
  title: Schema.String,
  cards: Schema.Array(TvCard),
})
export type TvShelf = typeof TvShelf.Type

export const TvShelves = Schema.Struct({
  shelves: Schema.Array(TvShelf),
})
export type TvShelves = typeof TvShelves.Type

/** The collections a card can open. */
export const TvCollectionKind = Schema.Literals([
  'Album',
  'Playlist',
  'MyPlaylist',
  'Artist',
])
export type TvCollectionKind = typeof TvCollectionKind.Type

/**
 * An album, playlist, one of my playlists, or an artist. `tracks` is what
 * Play and Shuffle play: the tracklist, or an artist's top songs. An artist
 * also has shelves (albums, and singles and EPs).
 */
export const TvCollection = Schema.Struct({
  kind: TvCollectionKind,
  id: Schema.String,
  title: Schema.String,
  /** "Album · Artist · 2024", "Artist", "Playlist · 32 songs". */
  subtitle: Schema.String,
  description: Schema.NullOr(Schema.String),
  artworkUrl: Schema.NullOr(Schema.String),
  tracks: Schema.Array(QueueTrack),
  shelves: Schema.Array(TvShelf),
})
export type TvCollection = typeof TvCollection.Type

/** One word of a timed line. */
export const TvLyricWord = Schema.Struct({
  startSeconds: Schema.Number,
  text: Schema.String,
})
export type TvLyricWord = typeof TvLyricWord.Type

/**
 * One timed line, sung until the next line starts. An empty `text` marks an
 * instrumental break; `words` is empty unless timed word by word.
 */
export const TvLyricLine = Schema.Struct({
  startSeconds: Schema.Number,
  text: Schema.String,
  words: Schema.Array(TvLyricWord),
})
export type TvLyricLine = typeof TvLyricLine.Type

/** A song's lyrics, and the same lyrics timed line by line when known. */
export const TvLyrics = Schema.Struct({
  text: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  lines: Schema.NullOr(Schema.Array(TvLyricLine)),
})
export type TvLyrics = typeof TvLyrics.Type

/** Whether a song is in Liked songs. */
export const TvLiked = Schema.Struct({
  videoId: Schema.String,
  liked: Schema.Boolean,
})
export type TvLiked = typeof TvLiked.Type

/** Add a song to Liked songs, or take it out. */
export const TvLikeRequest = Schema.Struct({
  track: QueueTrack,
  liked: Schema.Boolean,
})
export type TvLikeRequest = typeof TvLikeRequest.Type

/** What can be saved to the library: an album, or an artist to follow. */
export const TvSaveKind = Schema.Literals(['Album', 'Artist'])
export type TvSaveKind = typeof TvSaveKind.Type

/** Whether an album is saved to the library, or an artist followed. */
export const TvSaved = Schema.Struct({
  kind: TvSaveKind,
  id: Schema.String,
  saved: Schema.Boolean,
})
export type TvSaved = typeof TvSaved.Type

/**
 * Save an album or follow an artist, or undo it. The server looks the album
 * or artist up itself, so the TV sends only its id.
 */
export const TvSaveRequest = Schema.Struct({
  kind: TvSaveKind,
  id: Schema.String,
  saved: Schema.Boolean,
})
export type TvSaveRequest = typeof TvSaveRequest.Type

/** An album or an artist a song links to: enough to open its page. */
export const TvLink = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})
export type TvLink = typeof TvLink.Type

/**
 * Where a song leads: its album, and the credited artists that have a page,
 * in credit order. The queue keeps both only as text.
 */
export const TvSong = Schema.Struct({
  videoId: Schema.String,
  album: Schema.NullOr(TvLink),
  artists: Schema.Array(TvLink),
})
export type TvSong = typeof TvSong.Type

/**
 * Add a song to one of the playlists made in the app. The playlists come
 * from `/tv/library` (its MyPlaylist cards other than Liked songs).
 */
export const TvAddToPlaylistRequest = Schema.Struct({
  playlistId: Schema.String,
  track: QueueTrack,
})
export type TvAddToPlaylistRequest = typeof TvAddToPlaylistRequest.Type

/** The playlist a song went to; `added` is false when it was there already. */
export const TvAddedToPlaylist = Schema.Struct({
  playlistId: Schema.String,
  title: Schema.String,
  added: Schema.Boolean,
})
export type TvAddedToPlaylist = typeof TvAddedToPlaylist.Type

/** The TV app build the server has. Null when none is built. */
export const TvVersion = Schema.Struct({
  build: Schema.NullOr(Schema.String),
})
export type TvVersion = typeof TvVersion.Type

/**
 * A stretch of a song that hangs together: an intro, a verse, a chorus.
 * `group` numbers the sections that sound alike, so a chorus that comes back
 * shares its first appearance's group. `energy` is how loud and busy it is,
 * 0 to 1 across the song.
 */
export const TvSectionKind = Schema.Literals([
  'Intro',
  'Verse',
  'Chorus',
  'Bridge',
  'Breakdown',
  'Drop',
  'Outro',
])
export type TvSectionKind = typeof TvSectionKind.Type

export const TvSection = Schema.Struct({
  startSeconds: Schema.Number,
  endSeconds: Schema.Number,
  kind: TvSectionKind,
  group: Schema.Number,
  energy: Schema.Number,
})
export type TvSection = typeof TvSection.Type

/** A stretch of a song, in seconds: a stop, a riser, a drum fill. */
export const TvSpan = Schema.Struct({
  startSeconds: Schema.Number,
  endSeconds: Schema.Number,
})
export type TvSpan = typeof TvSpan.Type

/**
 * A chord, from `startSeconds` until the next one: its root as a pitch
 * class (0 = C, 11 = B), and whether it is minor. A null root is no clear
 * chord (drums alone, silence, noise).
 */
export const TvChord = Schema.Struct({
  startSeconds: Schema.Number,
  root: Schema.NullOr(Schema.Number),
  minor: Schema.Boolean,
})
export type TvChord = typeof TvChord.Type

/** The song's key from `startSeconds` until the next one. */
export const TvKey = Schema.Struct({
  startSeconds: Schema.Number,
  tonic: Schema.Number,
  minor: Schema.Boolean,
})
export type TvKey = typeof TvKey.Type

/**
 * The whole song as a picture the TV's GPU reads ahead of what plays: a
 * grayscale PNG (base64), one row every `1 / rate` seconds from the start,
 * `columns` values a row, each 0 to 255. Columns 0 to 23 are the spectrum,
 * low to high; then the drums, the kick, the snare, and the hi-hat (each a
 * hit decaying over a few tenths of a second), the bass, how strongly a
 * lead melody stands out, the melody's height across the song's own range
 * (0 when none sings), and how bright the sound is.
 */
export const TvScore = Schema.Struct({
  rate: Schema.Number,
  columns: Schema.Number,
  png: Schema.String,
})
export type TvScore = typeof TvScore.Type

/**
 * How the visuals leave one scene for the next: the old scene's last frame
 * is frozen and destroyed while the new one shows through. `Shatter` breaks
 * it into shards that fly at the camera (a drop), `ZoomThrough` rushes it
 * past the camera (the end of a riser), `Melt` drips it away and `Wipe`
 * sweeps an edge in the cover's color across it (calm changes), and
 * `Datamosh` drags its pixels along the new scene's shapes (a chorus coming
 * back). `Cut` changes at once.
 */
export const TvTransitionKind = Schema.Literals([
  'Cut',
  'Shatter',
  'Melt',
  'ZoomThrough',
  'Datamosh',
  'Wipe',
])
export type TvTransitionKind = typeof TvTransitionKind.Type

/**
 * A build-up and the moment it lands: from `startSeconds` the screen pushes
 * in and closes in, until `landSeconds`, on a beat, where it hits.
 * `strength` is how big the landing is, 0 to 1: a drop is 1, a louder
 * section after a riser less.
 */
export const TvBuild = Schema.Struct({
  startSeconds: Schema.Number,
  landSeconds: Schema.Number,
  strength: Schema.Number,
})
export type TvBuild = typeof TvBuild.Type

/** How the scene changes where a section starts, over `beats` beats. */
export const TvTransition = Schema.Struct({
  atSeconds: Schema.Number,
  kind: TvTransitionKind,
  beats: Schema.Number,
})
export type TvTransition = typeof TvTransition.Type

/**
 * The song's single biggest stretch (usually its last chorus or biggest
 * drop), from `startSeconds` to `endSeconds`, landing at `landSeconds`.
 */
export const TvClimax = Schema.Struct({
  startSeconds: Schema.Number,
  endSeconds: Schema.Number,
  landSeconds: Schema.Number,
})
export type TvClimax = typeof TvClimax.Type

/**
 * The song planned as a VJ would cue it, from the rest of the analysis, so
 * the visuals can anticipate its moments rather than react to them:
 *
 * - `climax`: the biggest stretch, which gets the wildest scene and the
 *   biggest effects; null when nothing stands out (a flat ambient piece).
 * - `builds`: each build-up and the exact moment it lands.
 * - `breaths`: where the music stops dead; the picture freezes, and the
 *   return lands like a drop.
 * - `strobes`: the bars where hard strobing fits (drops and the climax of
 *   a driving song only), a span from one downbeat to another.
 * - `transitions`: how the scene changes at each section's start but the
 *   first.
 */
export const TvChoreography = Schema.Struct({
  climax: Schema.NullOr(TvClimax),
  builds: Schema.Array(TvBuild),
  breaths: Schema.Array(TvSpan),
  strobes: Schema.Array(TvSpan),
  transitions: Schema.Array(TvTransition),
})
export type TvChoreography = typeof TvChoreography.Type

/**
 * What the TV's visuals know about a song before it plays, worked out once
 * from the cached audio. Times are seconds into the song.
 *
 * - `beats`: every beat, in order. `downbeats` are the beats that start a bar.
 * - `drops`: the moments the music lands after a build-up (where the visuals
 *   hit hardest); the build-up is the few bars before each.
 * - `accents`: strong hits between beats (snares, stabs), at most a few a second.
 * - `energy`: loudness 0 to 1 every `energyStepSeconds`, smoothed, normalized
 *   to the song's own loudest moment.
 * - `drive`: how driving the whole song is, 0 to 1, whatever its volume (its
 *   hits and its grit), so a ballad's loudest part still looks calm.
 * - `kicks`, `snares`, `hats`: each drum hit, told apart from the rest of
 *   the music (the beat is where hits would be; these are where they are).
 * - `chords` and `keys`: the harmony, chord by chord, and the key, which
 *   changes where the song modulates (a last chorus a step up).
 * - `stops`: where the music cuts out mid-song. `risers`: sweeps and builds
 *   that climb into what follows. `fills`: drum fills into a new section.
 * - `choreography`: the song's moments planned from all of the above.
 */
export const TvAnalysis = Schema.Struct({
  videoId: Schema.String,
  durationSeconds: Schema.Number,
  tempo: Schema.Number,
  beats: Schema.Array(Schema.Number),
  downbeats: Schema.Array(Schema.Number),
  sections: Schema.Array(TvSection),
  drops: Schema.Array(Schema.Number),
  accents: Schema.Array(Schema.Number),
  energyStepSeconds: Schema.Number,
  energy: Schema.Array(Schema.Number),
  drive: Schema.Number,
  kicks: Schema.Array(Schema.Number),
  snares: Schema.Array(Schema.Number),
  hats: Schema.Array(Schema.Number),
  chords: Schema.Array(TvChord),
  keys: Schema.Array(TvKey),
  stops: Schema.Array(TvSpan),
  risers: Schema.Array(TvSpan),
  fills: Schema.Array(TvSpan),
  score: TvScore,
  choreography: TvChoreography,
})
export type TvAnalysis = typeof TvAnalysis.Type

/**
 * Where a song's Sound Check gain comes from: the server's own measurement
 * of the audio (`Measured`), YouTube's loudness figure for the song, used
 * until the measurement is ready and only ever to turn a song down
 * (`YouTube`), or nothing yet (`Unknown`, gain 0).
 */
export const TvLoudnessSource = Schema.Literals([
  'Measured',
  'YouTube',
  'Unknown',
])
export type TvLoudnessSource = typeof TvLoudnessSource.Type

/**
 * How to level one song. `gainDb` is what to add to its level so it plays
 * at about -14 LUFS, never so much that its true peak passes -1 dBTP.
 * `integratedLufs` is the song's loudness behind the gain: the server's EBU
 * R128 measurement, or YouTube's figure, and null when `Unknown`.
 * `truePeakDbtp` is measured only (null for a silent song).
 */
export const TvLoudness = Schema.Struct({
  videoId: Schema.String,
  gainDb: Schema.Number,
  source: TvLoudnessSource,
  integratedLufs: Schema.NullOr(Schema.Number),
  truePeakDbtp: Schema.NullOr(Schema.Number),
})
export type TvLoudness = typeof TvLoudness.Type

/**
 * Where a song's montage comes from: key frames of its official music video
 * (`Video`), or, for a song without one, the artist's photos and the
 * artist's album covers (`Artist`).
 */
export const TvMontageSource = Schema.Literals(['Video', 'Artist'])
export type TvMontageSource = typeof TvMontageSource.Type

/**
 * One picture of a montage, one cell of the atlas. `seconds` is where in
 * the music video it was taken (null for a photo or a cover). `color` is
 * its average color, `brightness` its average light, and `busyness` how
 * much detail and contrast it holds (a plain sky 0, a crowd 1), all 0 to 1,
 * so the visuals can pick dark, calm pictures for calm music and busy,
 * bright ones for the loudest.
 */
export const TvMontageFrame = Schema.Struct({
  seconds: Schema.NullOr(Schema.Number),
  color: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
  brightness: Schema.Number,
  busyness: Schema.Number,
})
export type TvMontageFrame = typeof TvMontageFrame.Type

/**
 * A song's own pictures, cut into the TV's visuals: `frames.length`
 * pictures packed into one JPEG (`atlasPath`, on this server), `columns`
 * across and `rows` down, each `cellWidth` × `cellHeight` pixels, row by
 * row from the top left. A video's frames fill 16:9 cells; photos and
 * covers fill square ones. `musicVideoId` is the video they came from.
 */
export const TvMontage = Schema.Struct({
  videoId: Schema.String,
  source: TvMontageSource,
  musicVideoId: Schema.NullOr(Schema.String),
  columns: Schema.Number,
  rows: Schema.Number,
  cellWidth: Schema.Number,
  cellHeight: Schema.Number,
  frames: Schema.Array(TvMontageFrame),
  atlasPath: Schema.String,
})
export type TvMontage = typeof TvMontage.Type
