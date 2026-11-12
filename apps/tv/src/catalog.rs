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
