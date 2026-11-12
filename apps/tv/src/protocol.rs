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
    /// Autoplay added it as the queue ran low: a similar song.
    #[serde(default)]
    pub autoplay: bool,
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
    /// The app is open on it and connected.
    pub online: bool,
    pub waking: bool,
    /// Whether a TV itself is on, as Home Assistant last saw it.
    #[serde(default)]
    pub powered_on: Option<bool>,
    /// The device's own output volume (0 to 1), or none when it can't be set.
    #[serde(default)]
    pub volume: Option<f64>,
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
    /// Similar songs are added as the queue runs out.
    #[serde(default)]
    pub autoplay: bool,
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

/// Messages this app sends.
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
    /// Replace the queue and start playing it.
    #[serde(rename_all = "camelCase")]
    PlayQueue {
        tracks: Vec<QueueTrack>,
        start_index: usize,
    },
    #[serde(rename_all = "camelCase")]
    Enqueue {
        tracks: Vec<QueueTrack>,
        placement: Placement,
    },
    #[serde(rename_all = "camelCase")]
    RemoveEntry {
        entry_id: String,
    },
    #[serde(rename_all = "camelCase")]
    SkipTo {
        entry_id: String,
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
    /// Turn autoplay on or off.
    SetAutoplay {
        enabled: bool,
    },
    #[serde(rename_all = "camelCase")]
    Transfer {
        device_id: String,
    },
    /// Turn a device on and open the app, without moving playback there.
    #[serde(rename_all = "camelCase")]
    Wake {
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
    /// This TV's own volume (0 to 1), or none when the TV fixed it.
    Volume {
        level: Option<f64>,
    },
    /// Ask another device to change its volume (0 to 1).
    #[serde(rename_all = "camelCase")]
    SetDeviceVolume {
        device_id: String,
        level: f64,
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
    /// Change this TV's volume (0 to 1): a phone asked.
    SetVolume {
        level: f64,
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
        assert_eq!(state.devices[0].volume, None);
        assert_eq!(state.devices[1].volume, Some(0.25));
        assert_eq!(state.devices[0].powered_on, None);
        assert_eq!(state.devices[1].powered_on, Some(false));
        assert!(state.autoplay);
        assert!(!state.queue[0].autoplay);
        assert!(state.queue[1].autoplay);
        assert!(server_now > state.position_at);
        assert!((state.position_at(state.position_at + 1500.0) - 13.5).abs() < 1e-9);
    }

    #[test]
    fn decodes_notice() {
        let message: ServerMessage = serde_json::from_str(&fixture("server-notice.json")).unwrap();
        assert!(matches!(message, ServerMessage::Notice { .. }));
    }

    #[test]
    fn decodes_set_volume() {
        let message: ServerMessage =
            serde_json::from_str(&fixture("server-set-volume.json")).unwrap();
        assert_eq!(message, ServerMessage::SetVolume { level: 0.4 });
    }

    #[test]
    fn decodes_a_device_from_a_server_before_volume() {
        let device: Device = serde_json::from_str(
            r#"{ "id": "tv", "name": "TV", "kind": "Tv", "online": true, "waking": false }"#,
        )
        .unwrap();
        assert_eq!(device.volume, None);
        assert_eq!(device.powered_on, None);
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
    fn decodes_a_pause_with_where_it_stopped() {
        let message: ClientMessage =
            serde_json::from_str(&fixture("client-pause-at.json")).unwrap();
        assert_eq!(
            message,
            ClientMessage::Pause {
                at: Some(StoppedAt {
                    entry_id: "e0".into(),
                    position_seconds: 12.5,
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
            (
                "client-play-queue.json",
                ClientMessage::PlayQueue {
                    tracks: vec![QueueTrack {
                        video_id: "dQw4w9WgXcQ".into(),
                        title: "Never Gonna Give You Up".into(),
                        artists: "Rick Astley".into(),
                        album: Some("Whenever You Need Somebody".into()),
                        duration_seconds: Some(213.5),
                        artwork_url: None,
                    }],
                    start_index: 0,
                },
            ),
            (
                "client-enqueue.json",
                ClientMessage::Enqueue {
                    tracks: vec![QueueTrack {
                        video_id: "dQw4w9WgXcQ".into(),
                        title: "Never Gonna Give You Up".into(),
                        artists: "Rick Astley".into(),
                        album: None,
                        duration_seconds: None,
                        artwork_url: None,
                    }],
                    placement: Placement::Next,
                },
            ),
            (
                "client-skip-to.json",
                ClientMessage::SkipTo {
                    entry_id: "e1".into(),
                },
            ),
            (
                "client-remove-entry.json",
                ClientMessage::RemoveEntry {
                    entry_id: "e1".into(),
                },
            ),
            (
                "client-transfer.json",
                ClientMessage::Transfer {
                    device_id: "tv".into(),
                },
            ),
            (
                "client-wake.json",
                ClientMessage::Wake {
                    device_id: "tv".into(),
                },
            ),
            (
                "client-volume.json",
                ClientMessage::Volume { level: Some(0.25) },
            ),
            (
                "client-volume-fixed.json",
                ClientMessage::Volume { level: None },
            ),
            (
                "client-set-autoplay.json",
                ClientMessage::SetAutoplay { enabled: false },
            ),
            (
                "client-set-device-volume.json",
                ClientMessage::SetDeviceVolume {
                    device_id: "tv".into(),
                    level: 0.4,
                },
            ),
        ];
        for (name, message) in cases {
            let expected: serde_json::Value = serde_json::from_str(&fixture(name)).unwrap();
            assert_eq!(serde_json::to_value(&message).unwrap(), expected, "{name}");
        }
    }
}
