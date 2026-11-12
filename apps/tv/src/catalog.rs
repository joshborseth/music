//! The TV catalog, mirrored from `packages/shared/src/tv.ts`.
//!
//! Plain JSON over HTTP from the server's `/tv/...` routes, so the TV can
//! browse and play without the phone. Change both sides together;
//! `fixtures/tv/` holds examples that both test suites decode.

use serde::{Deserialize, Serialize};

use crate::protocol::QueueTrack;

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

    pub async fn lyrics(&self, video_id: &str) -> Result<Option<String>, String> {
        let path = format!(
            "/tv/lyrics?videoId={}",
            crate::view::percent_encode(video_id)
        );
        self.get::<Lyrics>(&path).await.map(|lyrics| lyrics.text)
    }

    pub async fn liked(&self, video_id: &str) -> Result<bool, String> {
        let path = format!(
            "/tv/liked?videoId={}",
            crate::view::percent_encode(video_id)
        );
        self.get::<Liked>(&path).await.map(|liked| liked.liked)
    }

    pub async fn set_liked(&self, request: &LikeRequest) -> Result<bool, String> {
        let body = serde_json::to_vec(request).map_err(|error| error.to_string())?;
        let response = self
            .http
            .post(format!("{}/tv/like", self.server))
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| "Can't reach the music server".to_owned())?;
        decode::<Liked>(response).await.map(|liked| liked.liked)
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
    fn encodes_a_like_request_like_the_fixture() {
        let request: LikeRequest = fixture("like-request.json");
        let expected: serde_json::Value = fixture("like-request.json");
        assert_eq!(serde_json::to_value(&request).unwrap(), expected);
    }
}
