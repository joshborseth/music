//! The TV catalog, mirrored from `packages/shared/src/tv.ts`.
//!
//! Plain JSON over HTTP from the server's `/tv/...` routes, so the TV can
//! browse and play without the phone. Change both sides together;
//! `fixtures/tv/` holds examples that both test suites decode.

use serde::{Deserialize, Serialize};

use crate::lyrics::SongLyrics;
use crate::protocol::QueueTrack;

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

/// A song's beats, bars, sections, and drops, worked out by the server from
/// the audio before it plays. Times are seconds into the song.
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
}

fn middling_drive() -> f32 {
    0.5
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub build: Option<String>,
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
        self.get(&path).await
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
    fn decodes_an_analysis() {
        let analysis: Analysis = fixture("analysis.json");
        assert_eq!(analysis.video_id, "abc123");
        assert_eq!(analysis.downbeats.len() * 4, analysis.beats.len());
        assert_eq!(analysis.sections[1].kind, SectionKind::Drop);
        assert_eq!(analysis.drops, vec![4.5]);
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
    fn encodes_a_like_request_like_the_fixture() {
        let request: LikeRequest = fixture("like-request.json");
        let expected: serde_json::Value = fixture("like-request.json");
        assert_eq!(serde_json::to_value(&request).unwrap(), expected);
    }
}
