//! The playback session protocol, mirrored from `packages/shared/src/session.ts`.
//!
//! JSON text frames over the `/session` WebSocket. Every message has a `_tag`.
//! Change both sides together; `fixtures/session/` holds examples that both
//! test suites decode.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueTrack {
    pub video_id: String,
    pub title: String,
    pub artists: String,
    pub album: Option<String>,
    pub duration_seconds: Option<f64>,
    pub artwork_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub entry_id: String,
    pub track: QueueTrack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeviceKind {
    Web,
    Tv,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub kind: DeviceKind,
    pub online: bool,
    pub waking: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub devices: Vec<Device>,
    pub active_device_id: Option<String>,
    pub queue: Vec<QueueEntry>,
    pub current_entry_id: Option<String>,
    pub playing: bool,
    pub position_seconds: f64,
    /// Server epoch milliseconds when `position_seconds` was true.
    pub position_at: f64,
    pub seek_seq: u64,
}

impl SessionState {
    pub fn current_index(&self) -> Option<usize> {
        let id = self.current_entry_id.as_deref()?;
        self.queue.iter().position(|entry| entry.entry_id == id)
    }

    pub fn current(&self) -> Option<&QueueEntry> {
        self.current_index().map(|index| &self.queue[index])
    }

    pub fn next_after_current(&self) -> Option<&QueueEntry> {
        self.current_index()
            .and_then(|index| self.queue.get(index + 1))
    }

    /// Where playback is at server time `server_now` (epoch ms).
    pub fn position_at(&self, server_now: f64) -> f64 {
        if self.playing {
            self.position_seconds + ((server_now - self.position_at).max(0.0) / 1000.0)
        } else {
            self.position_seconds
        }
    }
}

/// What a player is already doing when it reconnects, so the session follows
/// it. The TV reloads where the session left off instead, so it sends none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerReport {
    pub entry_id: String,
    pub position_seconds: f64,
    pub playing: bool,
    pub playing_set_here: bool,
    pub seek_seq: u64,
}

/// Where a player stopped, and the session jump it was following.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedAt {
    pub entry_id: String,
    pub position_seconds: f64,
    pub seek_seq: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Placement {
    Next,
    Last,
}

/// Messages this app sends. The TV never builds a queue, so the queue editing
/// commands are left out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum ClientMessage {
    #[serde(rename_all = "camelCase")]
    Hello {
        device_id: String,
        name: String,
        kind: DeviceKind,
        #[serde(default)]
        player: Option<PlayerReport>,
    },
    Resume {},
    #[serde(rename_all = "camelCase")]
    Pause {
        /// Where the player stopped. The TV leaves it to the server.
        #[serde(default)]
        at: Option<StoppedAt>,
    },
    #[serde(rename_all = "camelCase")]
    Seek {
        position_seconds: f64,
    },
    Next {},
    Previous {},
    #[serde(rename_all = "camelCase")]
    Transfer {
        device_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        entry_id: String,
        position_seconds: f64,
        playing: bool,
    },
    #[serde(rename_all = "camelCase")]
    Advanced {
        from_entry_id: String,
    },
    #[serde(rename_all = "camelCase")]
    TrackEnded {
        entry_id: String,
    },
    #[serde(rename_all = "camelCase")]
    TrackFailed {
        entry_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "_tag")]
pub enum ServerMessage {
    #[serde(rename_all = "camelCase")]
    State {
        state: SessionState,
        /// Server epoch milliseconds when this was sent.
        server_now: f64,
        /// Messages from this connection the state includes. The TV waits
        /// for the server instead, so it does not use it.
        #[serde(default)]
        ack: u64,
    },
    Notice {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/session");

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{FIXTURES}/{name}")).expect("fixture exists")
    }

    #[test]
    fn decodes_server_state() {
        let ServerMessage::State {
            state, server_now, ..
        } = serde_json::from_str(&fixture("server-state.json")).unwrap()
        else {
            panic!("expected State");
        };
        assert_eq!(state.queue.len(), 2);
        assert_eq!(
            state.current().unwrap().track.title,
            "Never Gonna Give You Up"
        );
        assert_eq!(state.next_after_current().unwrap().entry_id, "e1");
        assert_eq!(state.devices[1].kind, DeviceKind::Tv);
        assert!(server_now > state.position_at);
        assert!((state.position_at(state.position_at + 1500.0) - 13.5).abs() < 1e-9);
    }

    #[test]
    fn decodes_notice() {
        let message: ServerMessage = serde_json::from_str(&fixture("server-notice.json")).unwrap();
        assert!(matches!(message, ServerMessage::Notice { .. }));
    }

    #[test]
    fn decodes_a_hello_with_a_player_report() {
        let message: ClientMessage =
            serde_json::from_str(&fixture("client-hello-player.json")).unwrap();
        assert_eq!(
            message,
            ClientMessage::Hello {
                device_id: "phone-1".into(),
                name: "iPhone".into(),
                kind: DeviceKind::Web,
                player: Some(PlayerReport {
                    entry_id: "e1".into(),
                    position_seconds: 42.5,
                    playing: true,
                    playing_set_here: false,
                    seek_seq: 3,
                }),
            }
        );
    }

    #[test]
    fn encodes_client_messages_like_the_fixtures() {
        let cases = [
            (
                "client-hello.json",
                ClientMessage::Hello {
                    device_id: "tv".into(),
                    name: "TV".into(),
                    kind: DeviceKind::Tv,
                    player: None,
                },
            ),
            (
                "client-progress.json",
                ClientMessage::Progress {
                    entry_id: "e0".into(),
                    position_seconds: 42.5,
                    playing: true,
                },
            ),
            (
                "client-advanced.json",
                ClientMessage::Advanced {
                    from_entry_id: "e0".into(),
                },
            ),
            ("client-pause.json", ClientMessage::Pause { at: None }),
        ];
        for (name, message) in cases {
            let expected: serde_json::Value = serde_json::from_str(&fixture(name)).unwrap();
            assert_eq!(serde_json::to_value(&message).unwrap(), expected, "{name}");
        }
    }
}
