//! The TV catalog, mirrored from `packages/shared/src/tv.ts`.
//!
//! Plain JSON over HTTP from the server's `/tv/...` routes, so the TV can
//! browse and play without the phone. Change both sides together;
//! `fixtures/tv/` holds examples that both test suites decode.

use serde::{Deserialize, Serialize};

use crate::lyrics::SongLyrics;
use crate::protocol::QueueTrack;
use crate::visuals::Depth;

/// The id of the Liked songs playlist (`LIKED_PLAYLIST_ID` in
/// `packages/shared/src/domain.ts`). Its card and page show the heart tile.
pub const LIKED_PLAYLIST_ID: &str = "liked";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardKind {
    Song,
    Album,
    Playlist,
    MyPlaylist,
    Artist,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub kind: CardKind,
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub artwork_url: Option<String>,
    pub track: Option<QueueTrack>,
}

impl Card {
    /// The Liked songs playlist, which has the heart tile for a cover.
    pub fn is_liked_songs(&self) -> bool {
        self.kind == CardKind::MyPlaylist && self.id == LIKED_PLAYLIST_ID
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub title: String,
    pub cards: Vec<Card>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelves {
    pub shelves: Vec<Shelf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CollectionKind {
    Album,
    Playlist,
    MyPlaylist,
    Artist,
}

impl CollectionKind {
    pub fn from_card(kind: CardKind) -> Option<Self> {
        match kind {
            CardKind::Song => None,
            CardKind::Album => Some(Self::Album),
            CardKind::Playlist => Some(Self::Playlist),
            CardKind::MyPlaylist => Some(Self::MyPlaylist),
            CardKind::Artist => Some(Self::Artist),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Album => "Album",
            Self::Playlist => "Playlist",
            Self::MyPlaylist => "MyPlaylist",
            Self::Artist => "Artist",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub kind: CollectionKind,
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub description: Option<String>,
    pub artwork_url: Option<String>,
    pub tracks: Vec<QueueTrack>,
    pub shelves: Vec<Shelf>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub text: Option<String>,
    pub source: Option<String>,
    /// The lyrics timed line by line, when a timed copy matched the song.
    #[serde(default)]
    pub lines: Option<Vec<LyricLine>>,
}

/// Where a song's Sound Check gain comes from. Mirrors `TvLoudnessSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoudnessSource {
    /// The server measured the song's audio.
    Measured,
    /// YouTube's loudness figure, until the server has measured it.
    YouTube,
    /// Nothing known yet: the gain is 0.
    #[serde(other)]
    Unknown,
}

/// How to level one song (`GET /tv/loudness`): `gain_db` brings it to the
/// loudness every song plays at, never past its true peak.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    pub video_id: String,
    pub gain_db: f32,
    pub source: LoudnessSource,
    pub integrated_lufs: Option<f64>,
    pub true_peak_dbtp: Option<f64>,
}

/// Where a song's montage comes from. Mirrors `TvMontageSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MontageSource {
    /// Key frames of the song's music video, in 16:9 cells.
    Video,
    /// The artist's photos and covers, in square cells.
    #[serde(other)]
    Artist,
}

/// One picture of a montage (`TvMontageFrame`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MontageFrame {
    pub seconds: Option<f64>,
    pub color: [f32; 3],
    pub brightness: f32,
    pub busyness: f32,
}

/// A song's own pictures for the visuals (`GET /tv/montage`), packed into
/// one JPEG at `atlas_path`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Montage {
    pub video_id: String,
    pub source: MontageSource,
    pub music_video_id: Option<String>,
    pub columns: u32,
    pub rows: u32,
    pub cell_width: u32,
    pub cell_height: u32,
    pub frames: Vec<MontageFrame>,
    pub atlas_path: String,
}

/// What a stretch of a song is, as the server's analysis heard it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SectionKind {
    Intro,
    Verse,
    Chorus,
    Bridge,
    Breakdown,
    Drop,
    Outro,
}

/// A stretch of a song that hangs together. Sections that sound alike share
/// a `group`; `energy` runs 0 to 1 across the song.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub kind: SectionKind,
    pub group: u32,
    pub energy: f32,
}

/// A stretch of a song, in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// A chord from `start_seconds` until the next: its root's pitch class
/// (0 = C), none when no chord is clear, and whether it is minor.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chord {
    pub start_seconds: f64,
    pub root: Option<u8>,
    pub minor: bool,
}

/// The song's key from `start_seconds` until the next.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    pub start_seconds: f64,
    pub tonic: u8,
    pub minor: bool,
}

/// The whole song as a grayscale picture, a row every `1 / rate` seconds
/// (see `TvScore` in `packages/shared/src/tv.ts` for the columns).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreImage {
    pub rate: f64,
    pub columns: u32,
    /// A PNG, base64.
    pub png: String,
}

/// The score, decoded: `rows × columns` bytes, a row at a time.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Score {
    pub rate: f64,
    pub columns: usize,
    pub rows: usize,
    pub pixels: Vec<u8>,
}

impl Score {
    /// Decode the server's picture; none if it is not a grayscale PNG of
    /// its stated width.
    pub fn decode(image: &ScoreImage) -> Option<Self> {
        let bytes = base64_decode(&image.png)?;
        let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
            .ok()?
            .into_luma8();
        let columns = image.columns as usize;
        if decoded.width() as usize != columns || image.rate <= 0.0 {
            return None;
        }
        Some(Self {
            rate: image.rate,
            columns,
            rows: decoded.height() as usize,
            pixels: decoded.into_raw(),
        })
    }

    /// Column `column` at `seconds` into the song, 0 to 1, read between
    /// rows; 0 outside the song.
    pub fn at(&self, column: usize, seconds: f64) -> f32 {
        let position = seconds * self.rate;
        if self.rows == 0 || column >= self.columns || position < 0.0 {
            return 0.0;
        }
        let row = position.floor() as usize;
        let read = |row: usize| {
            self.pixels
                .get(row * self.columns + column)
                .map_or(0.0, |value| f32::from(*value) / 255.0)
        };
        let fraction = (position - position.floor()) as f32;
        read(row) * (1.0 - fraction) + read(row + 1) * fraction
    }
}

/// Plain base64 (with or without padding); none on any other character.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut bits = 0u32;
    let mut count = 0;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
        }
    }
    Some(out)
}

/// How the visuals leave one scene for the next (`TvTransitionKind` in
/// `packages/shared/src/tv.ts`): the old scene's last frame is frozen and
/// destroyed while the new one shows through. A kind this app doesn't know
/// yet plays as a wipe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransitionKind {
    Cut,
    Shatter,
    Melt,
    ZoomThrough,
    Datamosh,
    #[serde(other)]
    Wipe,
}

/// A build-up and the moment it lands, and how big the landing is (0 to 1).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    pub start_seconds: f64,
    pub land_seconds: f64,
    pub strength: f32,
}

/// How the scene changes where a section starts, over `beats` beats.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub at_seconds: f64,
    pub kind: TransitionKind,
    pub beats: f32,
}

/// The song's single biggest stretch, and where it lands.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Climax {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub land_seconds: f64,
}

/// The song planned as a VJ would cue it (`TvChoreography`): its climax,
/// its builds and where each lands, its breaths, the bars that strobe,
/// and how the scene changes at each section's start. A server from
/// before it sends none.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choreography {
    pub climax: Option<Climax>,
    pub builds: Vec<Build>,
    pub breaths: Vec<Span>,
    pub strobes: Vec<Span>,
    pub transitions: Vec<Transition>,
}

/// A song's beats, bars, sections, and drops, worked out by the server from
/// the audio before it plays. Times are seconds into the song. A server
/// from before the parts (drums, harmony, moments, score) sends none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub video_id: String,
    pub duration_seconds: f64,
    pub tempo: f64,
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
    pub sections: Vec<Section>,
    pub drops: Vec<f64>,
    pub accents: Vec<f64>,
    pub energy_step_seconds: f64,
    pub energy: Vec<f32>,
    /// How driving the whole song is, 0 to 1, whatever its volume: its
    /// hits and its grit. A server from before it existed sends none.
    #[serde(default = "middling_drive")]
    pub drive: f32,
    #[serde(default)]
    pub kicks: Vec<f64>,
    #[serde(default)]
    pub snares: Vec<f64>,
    #[serde(default)]
    pub hats: Vec<f64>,
    #[serde(default)]
    pub chords: Vec<Chord>,
    #[serde(default)]
    pub keys: Vec<Key>,
    #[serde(default)]
    pub stops: Vec<Span>,
    #[serde(default)]
    pub risers: Vec<Span>,
    #[serde(default)]
    pub fills: Vec<Span>,
    #[serde(default, rename = "score")]
    pub score_image: Option<ScoreImage>,
    #[serde(default)]
    pub choreography: Choreography,
    /// `score_image` decoded, once it arrives (`Catalog::analysis`).
    #[serde(skip)]
    pub score: Option<Score>,
}

fn middling_drive() -> f32 {
    0.5
}

/// One sung line of a song's words (`GET /tv/words`): from its start to
/// where its singing ends. A hook's words come back elsewhere in the song.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordLine {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub hook: bool,
}

/// One sung word, timed by the server. `line` indexes `Words::lines`;
/// `glyph` the atlas's glyphs (none when the font can't draw it).
/// `phrase` marks the song's most repeated short phrase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub text: String,
    pub line: usize,
    pub glyph: Option<usize>,
    pub hook: bool,
    pub phrase: bool,
}

/// Where a word sits in the atlas, in pixels, and its baseline, pixels
/// down from the top of its rectangle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Glyph {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub baseline: f32,
}

/// Every distinct word of the song in capitals as a signed distance field:
/// a grayscale PNG (base64), 128 on the letters' edge, a step of 128 for
/// every `spread` pixels. `cap_height` is a capital's height in pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordAtlas {
    pub width: u32,
    pub height: u32,
    pub cap_height: f32,
    pub spread: f32,
    pub png: String,
    pub glyphs: Vec<Glyph>,
}

/// A song's sung words, timed one by one, for the visuals to draw into
/// their scenes; empty for a song without timed lyrics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Words {
    pub video_id: String,
    pub phrase: Option<String>,
    pub lines: Vec<WordLine>,
    pub words: Vec<Word>,
    pub atlas: Option<WordAtlas>,
    /// The atlas's pixels, `width` × `height` a row at a time, once
    /// decoded (`Client::words`); then `atlas.png` is dropped.
    #[serde(skip)]
    pub pixels: Vec<u8>,
}

impl Words {
    /// Decode the atlas's PNG into `pixels`, dropping the atlas when it is
    /// not a grayscale picture of its stated size. True when it reads.
    pub fn decode_atlas(&mut self) -> bool {
        let Some(atlas) = self.atlas.as_mut() else {
            return false;
        };
        let decoded = base64_decode(&atlas.png)
            .and_then(|bytes| {
                image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).ok()
            })
            .map(image::DynamicImage::into_luma8)
            .filter(|image| image.width() == atlas.width && image.height() == atlas.height);
        atlas.png = String::new();
        match decoded {
            Some(image) => {
                self.pixels = image.into_raw();
                true
            }
            None => {
                self.atlas = None;
                false
            }
        }
    }
}

/// One timed line, sung until the next starts. Empty `text` marks a break.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub start_seconds: f64,
    pub text: String,
    pub words: Vec<LyricWord>,
}

/// One word of a line timed word by word.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricWord {
    pub start_seconds: f64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Liked {
    pub video_id: String,
    pub liked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LikeRequest {
    pub track: QueueTrack,
    pub liked: bool,
}

/// What can be saved to the library: an album, or an artist to follow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SaveKind {
    Album,
    Artist,
}

impl SaveKind {
    /// Albums and artists can be saved; playlists can't.
    pub fn from_collection(kind: CollectionKind) -> Option<Self> {
        match kind {
            CollectionKind::Album => Some(Self::Album),
            CollectionKind::Artist => Some(Self::Artist),
            CollectionKind::Playlist | CollectionKind::MyPlaylist => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Album => "Album",
            Self::Artist => "Artist",
        }
    }
}

/// Whether an album is saved to the library, or an artist followed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub kind: SaveKind,
    pub id: String,
    pub saved: bool,
}

/// Save an album or follow an artist, or undo it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub kind: SaveKind,
    pub id: String,
    pub saved: bool,
}

/// An album or an artist a song links to: enough to open its page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: String,
    pub name: String,
}

/// Where a song leads: its album, and the credited artists with a page, in
/// credit order. The queue keeps both only as text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongLinks {
    pub video_id: String,
    pub album: Option<Link>,
    pub artists: Vec<Link>,
}

/// Add a song to one of the playlists made in the app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddToPlaylistRequest {
    pub playlist_id: String,
    pub track: QueueTrack,
}

/// The playlist a song went to; `added` is false when it was there already.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedToPlaylist {
    pub playlist_id: String,
    pub title: String,
    pub added: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub build: Option<String>,
}

/// Why a cover has no depth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DepthMissing {
    /// It is being worked out, or the server couldn't be reached: ask again.
    NotYet,
    /// The server has no depth model, or can't read this cover.
    Never,
}

/// Talks to the server's `/tv/...` routes.
#[derive(Clone)]
pub struct Client {
    server: String,
    http: reqwest::Client,
}

impl Client {
    pub fn new(server: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        Self { server, http }
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        let response = self
            .http
            .get(format!("{}{path}", self.server))
            .send()
            .await
            .map_err(|_| "Can't reach the music server".to_owned())?;
        decode(response).await
    }

    /// Home: the same shelves as the phone's. A mix is a `Playlist` card whose
    /// id is YouTube's radio id, which `collection` opens like any playlist.
    pub async fn home(&self) -> Result<Vec<Shelf>, String> {
        self.get::<Shelves>("/tv/home")
            .await
            .map(|found| found.shelves)
    }

    pub async fn library(&self) -> Result<Vec<Shelf>, String> {
        self.get::<Shelves>("/tv/library")
            .await
            .map(|found| found.shelves)
    }

    pub async fn search(&self, query: &str) -> Result<Vec<Shelf>, String> {
        let path = format!("/tv/search?q={}", crate::view::percent_encode(query));
        self.get::<Shelves>(&path).await.map(|found| found.shelves)
    }

    pub async fn collection(&self, kind: CollectionKind, id: &str) -> Result<Collection, String> {
        let path = format!(
            "/tv/collection?kind={}&id={}",
            kind.as_str(),
            crate::view::percent_encode(id)
        );
        self.get(&path).await
    }

    pub async fn lyrics(&self, video_id: &str) -> Result<Option<SongLyrics>, String> {
        let path = format!(
            "/tv/lyrics?videoId={}",
            crate::view::percent_encode(video_id)
        );
        self.get::<Lyrics>(&path).await.map(|lyrics| {
            lyrics.text.map(|text| SongLyrics {
                text,
                lines: lyrics.lines.unwrap_or_default(),
            })
        })
    }

    pub async fn analysis(&self, video_id: &str) -> Result<Analysis, String> {
        let path = format!(
            "/tv/analysis?videoId={}",
            crate::view::percent_encode(video_id)
        );
        let mut analysis: Analysis = self.get(&path).await?;
        // Decoded here, off the UI thread.
        analysis.score = analysis.score_image.take().and_then(|image| {
            let score = Score::decode(&image);
            if score.is_none() {
                log::warn!("analysis: the score of {video_id} could not be read");
            }
            score
        });
        Ok(analysis)
    }

    /// The depth of the cover at `artwork_url`, for the Diorama scene: the
    /// server's grayscale PNG (`GET /tv/depth`), decoded off the UI thread.
    pub async fn depth(&self, artwork_url: &str) -> Result<Depth, DepthMissing> {
        let response = self
            .http
            .get(format!(
                "{}/tv/depth?url={}",
                self.server,
                crate::view::percent_encode(artwork_url)
            ))
            .send()
            .await
            .map_err(|_| DepthMissing::NotYet)?;
        match response.status().as_u16() {
            200 => {}
            // Worked out now; or no model on the server, or not a cover it
            // can read, which asking again won't change.
            503 | 500 | 502 => return Err(DepthMissing::NotYet),
            _ => return Err(DepthMissing::Never),
        }
        let png = response.bytes().await.map_err(|_| DepthMissing::NotYet)?;
        tokio::task::spawn_blocking(move || Depth::decode(&png))
            .await
            .ok()
            .flatten()
            .ok_or(DepthMissing::Never)
    }

    /// The song's montage and its atlas, the JPEG's bytes, still encoded.
    pub async fn montage(&self, video_id: &str) -> Result<(Montage, Vec<u8>), String> {
        let path = format!(
            "/tv/montage?videoId={}",
            crate::view::percent_encode(video_id)
        );
        let montage: Montage = self.get(&path).await?;
        let response = self
            .http
            .get(format!("{}{}", self.server, montage.atlas_path))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| error.to_string())?;
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        Ok((montage, bytes.to_vec()))
    }

    /// The song's sung words and their atlas, decoded here, off the UI
    /// thread.
    pub async fn words(&self, video_id: &str) -> Result<Words, String> {
        let path = format!(
            "/tv/words?videoId={}",
            crate::view::percent_encode(video_id)
        );
        let mut words: Words = self.get(&path).await?;
        if words.atlas.is_some() && !words.decode_atlas() {
            log::warn!("words: the atlas of {video_id} could not be read");
        }
        Ok(words)
    }

    pub async fn liked(&self, video_id: &str) -> Result<bool, String> {
        let path = format!(
            "/tv/liked?videoId={}",
            crate::view::percent_encode(video_id)
        );
        self.get::<Liked>(&path).await.map(|liked| liked.liked)
    }

    pub async fn set_liked(&self, request: &LikeRequest) -> Result<bool, String> {
        self.post::<Liked>("/tv/like", request)
            .await
            .map(|liked| liked.liked)
    }

    pub async fn saved(&self, kind: SaveKind, id: &str) -> Result<bool, String> {
        let path = format!(
            "/tv/saved?kind={}&id={}",
            kind.as_str(),
            crate::view::percent_encode(id)
        );
        self.get::<Saved>(&path).await.map(|saved| saved.saved)
    }

    pub async fn set_saved(&self, request: &SaveRequest) -> Result<bool, String> {
        self.post::<Saved>("/tv/save", request)
            .await
            .map(|saved| saved.saved)
    }

    pub async fn song_links(&self, video_id: &str) -> Result<SongLinks, String> {
        let path = format!("/tv/song?videoId={}", crate::view::percent_encode(video_id));
        self.get(&path).await
    }

    pub async fn add_to_playlist(
        &self,
        request: &AddToPlaylistRequest,
    ) -> Result<AddedToPlaylist, String> {
        self.post("/tv/playlist-add", request).await
    }

    async fn post<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, String> {
        let body = serde_json::to_vec(body).map_err(|error| error.to_string())?;
        let response = self
            .http
            .post(format!("{}{path}", self.server))
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| "Can't reach the music server".to_owned())?;
        decode(response).await
    }
}

async fn decode<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The music server stopped answering".to_owned())?;
    if !status.is_success() {
        let message = String::from_utf8_lossy(&bytes).trim().to_owned();
        return Err(if message.is_empty() || message.len() > 200 {
            format!("The music server said {status}")
        } else {
            message
        });
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        log::warn!("unreadable catalog answer: {error}");
        "The music server sent something unreadable".to_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/tv");

    fn fixture<T: serde::de::DeserializeOwned>(name: &str) -> T {
        let text = std::fs::read_to_string(format!("{FIXTURES}/{name}")).expect("fixture exists");
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{name}: {error}"))
    }

    #[test]
    fn decodes_shelves() {
        let shelves: Shelves = fixture("shelves.json");
        assert_eq!(shelves.shelves.len(), 2);
        assert!(shelves.shelves[0].cards[0].is_liked_songs());
        let picks = &shelves.shelves[1];
        assert_eq!(picks.cards[0].kind, CardKind::Song);
        assert_eq!(
            picks.cards[0].track.as_ref().unwrap().duration_seconds,
            Some(213.0)
        );
        assert!(picks.cards[1].track.is_none());
        assert_eq!(
            CollectionKind::from_card(picks.cards[2].kind),
            Some(CollectionKind::Artist)
        );
    }

    #[test]
    fn decodes_home_with_its_radio_mixes_and_new_releases() {
        let home: Shelves = fixture("home.json");
        let titles: Vec<_> = home
            .shelves
            .iter()
            .map(|shelf| shelf.title.as_str())
            .collect();
        assert_eq!(
            titles,
            [
                "More like Cobra",
                "Your mixes",
                "New from artists you follow"
            ]
        );
        assert!(home.shelves[0].cards[0].track.is_some());
        // A mix opens as a playlist, which the server answers with its radio.
        let mix = &home.shelves[1].cards[0];
        assert_eq!(
            CollectionKind::from_card(mix.kind),
            Some(CollectionKind::Playlist)
        );
        assert!(mix.id.starts_with("RDAMVM"));
        assert_eq!(
            CollectionKind::from_card(home.shelves[2].cards[0].kind),
            Some(CollectionKind::Album)
        );
    }

    #[test]
    fn decodes_a_collection() {
        let collection: Collection = fixture("collection.json");
        assert_eq!(collection.kind, CollectionKind::Artist);
        assert_eq!(collection.tracks.len(), 1);
        assert_eq!(collection.shelves[0].cards[0].kind, CardKind::Album);
    }

    #[test]
    fn decodes_lyrics_liked_and_version() {
        let lyrics: Lyrics = fixture("lyrics.json");
        assert!(lyrics.text.unwrap().starts_with("We're no strangers"));
        let lines = lyrics.lines.unwrap();
        assert_eq!(lines[0].words[1].text, "no ");
        assert_eq!(lines[2].text, "");
        let untimed: Lyrics = fixture("lyrics-untimed.json");
        assert!(untimed.lines.is_none());
        let none: Lyrics = fixture("lyrics-none.json");
        assert_eq!(none.text, None);
        let liked: Liked = fixture("liked.json");
        assert!(liked.liked);
        let version: Version = fixture("version.json");
        assert!(version.build.is_some());
        let none: Version = fixture("version-none.json");
        assert_eq!(none.build, None);
    }

    #[test]
    fn decodes_a_loudness() {
        let measured: Loudness = fixture("loudness.json");
        assert_eq!(measured.source, LoudnessSource::Measured);
        assert_eq!(measured.gain_db, -6.2);
        assert_eq!(measured.integrated_lufs, Some(-7.8));
        let youtube: Loudness = fixture("loudness-youtube.json");
        assert_eq!(youtube.source, LoudnessSource::YouTube);
        assert_eq!(youtube.true_peak_dbtp, None);
        // A source this app doesn't know yet reads as unknown.
        let newer: LoudnessSource = serde_json::from_str("\"Guessed\"").unwrap();
        assert_eq!(newer, LoudnessSource::Unknown);
    }

    #[test]
    fn decodes_an_analysis() {
        let analysis: Analysis = fixture("analysis.json");
        assert_eq!(analysis.video_id, "abc123");
        assert_eq!(analysis.downbeats.len() * 4, analysis.beats.len());
        assert_eq!(analysis.sections[1].kind, SectionKind::Drop);
        assert_eq!(analysis.drops, vec![4.5]);
        assert_eq!(analysis.kicks.len(), 8);
        assert_eq!(analysis.chords[0].root, None);
        assert_eq!(analysis.chords[1].root, Some(9));
        assert_eq!(analysis.keys[1].tonic, 11);
        assert_eq!(analysis.stops[0].end_seconds, 4.5);
        let score = Score::decode(analysis.score_image.as_ref().unwrap()).unwrap();
        assert_eq!((score.columns, score.rows), (32, 34));
        assert_eq!(score.at(25, 0.0), 1.0);
        assert_eq!(score.at(25, 0.25), 0.0);
        assert!((score.at(25, 0.125) - 0.5).abs() < 0.01);
        assert!((score.at(30, 3.0) - 128.0 / 255.0).abs() < 0.01);
        assert_eq!(score.at(25, 100.0), 0.0);
        let plan = &analysis.choreography;
        assert_eq!(plan.climax.map(|climax| climax.land_seconds), Some(4.5));
        assert_eq!(plan.builds[0].start_seconds, 2.5);
        assert_eq!(plan.builds[0].strength, 1.0);
        assert_eq!(plan.breaths[0].start_seconds, 4.1);
        assert_eq!(plan.strobes[0].end_seconds, 6.5);
        assert_eq!(plan.transitions[0].kind, TransitionKind::Shatter);
        assert_eq!(plan.transitions[0].beats, 2.0);
        // A transition this app doesn't know yet wipes.
        let newer: TransitionKind = serde_json::from_str("\"Swirl\"").unwrap();
        assert_eq!(newer, TransitionKind::Wipe);
    }

    #[test]
    fn decodes_a_montage() {
        let montage: Montage = fixture("montage.json");
        assert_eq!(montage.source, MontageSource::Video);
        assert_eq!(montage.music_video_id.as_deref(), Some("gAjR4_CbPpQ"));
        assert_eq!((montage.columns, montage.rows), (2, 2));
        assert_eq!((montage.cell_width, montage.cell_height), (320, 180));
        assert_eq!(montage.frames.len(), 3);
        assert_eq!(montage.frames[0].seconds, Some(3.5));
        assert_eq!(montage.frames[2].seconds, None);
        assert_eq!(montage.frames[1].color, [0.6, 0.31, 0.5]);
        assert!(
            montage
                .atlas_path
                .starts_with("/tv/montage.jpg?videoId=abc123")
        );
        // A source this app doesn't know yet reads as the artist's pictures.
        let newer: MontageSource = serde_json::from_str("\"Lyrics\"").unwrap();
        assert_eq!(newer, MontageSource::Artist);
    }

    #[test]
    fn decodes_words_and_their_atlas() {
        let mut words: Words = fixture("words.json");
        assert_eq!(words.phrase.as_deref(), Some("la la"));
        assert!(words.lines[0].hook);
        assert_eq!(words.words[1].glyph, Some(0));
        assert_eq!(words.words[3].glyph, None);
        assert!(words.decode_atlas());
        let atlas = words.atlas.as_ref().unwrap();
        assert_eq!(words.pixels.len(), 8 * 4);
        assert!(atlas.png.is_empty());
        assert_eq!(atlas.glyphs[1].x, 5.0);
        // The middle column of each glyph is inside the letters.
        assert_eq!(words.pixels[2], 200);
        assert_eq!(words.pixels[8 + 6], 200);
        assert_eq!(words.pixels[8 + 7], 60);
        let mut none: Words = fixture("words-none.json");
        assert!(none.words.is_empty() && !none.decode_atlas());
    }

    #[test]
    fn an_analysis_from_before_the_parts_still_reads() {
        let mut json: serde_json::Value = fixture("analysis.json");
        for field in [
            "kicks",
            "snares",
            "hats",
            "chords",
            "keys",
            "stops",
            "risers",
            "fills",
            "score",
            "choreography",
        ] {
            json.as_object_mut().unwrap().remove(field);
        }
        let analysis: Analysis = serde_json::from_value(json).unwrap();
        assert!(analysis.kicks.is_empty() && analysis.score_image.is_none());
        assert_eq!(analysis.choreography, Choreography::default());
    }

    #[test]
    fn decodes_saved_and_encodes_a_save_request_like_the_fixture() {
        let saved: Saved = fixture("saved.json");
        assert_eq!(saved.kind, SaveKind::Album);
        assert!(saved.saved);
        let request: SaveRequest = fixture("save-request.json");
        assert_eq!(request.kind, SaveKind::Artist);
        let expected: serde_json::Value = fixture("save-request.json");
        assert_eq!(serde_json::to_value(&request).unwrap(), expected);
        assert_eq!(
            SaveKind::from_collection(CollectionKind::Artist),
            Some(SaveKind::Artist)
        );
        assert_eq!(SaveKind::from_collection(CollectionKind::MyPlaylist), None);
    }

    #[test]
    fn decodes_song_links_and_adding_to_a_playlist() {
        let links: SongLinks = fixture("song.json");
        assert_eq!(links.album.unwrap().id, "MPREb_abc");
        assert_eq!(links.artists.len(), 2);
        let request: AddToPlaylistRequest = fixture("add-to-playlist-request.json");
        assert_eq!(request.playlist_id, "p1");
        let expected: serde_json::Value = fixture("add-to-playlist-request.json");
        assert_eq!(serde_json::to_value(&request).unwrap(), expected);
        let added: AddedToPlaylist = fixture("added-to-playlist.json");
        assert!(added.added);
        assert_eq!(added.title, "Road trip");
    }

    #[test]
    fn encodes_a_like_request_like_the_fixture() {
        let request: LikeRequest = fixture("like-request.json");
        let expected: serde_json::Value = fixture("like-request.json");
        assert_eq!(serde_json::to_value(&request).unwrap(), expected);
    }
}
