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
    #[serde(default)]
    pub repeat: RepeatMode,
    /// The songs after the current one were put in a random order.
    #[serde(default)]
    pub shuffle: bool,
    /// When the music stops by itself, if a sleep timer is set.
    #[serde(default)]
    pub sleep_timer: Option<SleepTimer>,
    /// What the queue was started from, if anything with a page. Servers
    /// before this field leave it out.
    #[serde(default)]
    pub playing_from: Option<PlayingFrom>,
}

/// What kind of thing a queue was started from. Mirrors `PlayingFromKind`
/// in `packages/shared/src/session.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlayingFromKind {
    Album,
    Playlist,
    /// One of the playlists made in the app, Liked Songs among them.
    MyPlaylist,
    Artist,
    /// One of the phone's Home mixes: YouTube Music's radio for a song.
    Mix,
    /// YouTube Music's radio for a song, an album, or an artist.
    Radio,
    Search,
}

/// What the queue was started from, for "Playing from <title>". `id` opens
/// it: an album's browse id, a playlist's id (a mix's or a radio's is the
/// radio playlist's), an artist's channel id, or the words searched for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlayingFrom {
    pub kind: PlayingFromKind,
    pub title: String,
    pub id: String,
}

/// When the music stops by itself. Mirrors `SleepTimer` in
/// `packages/shared/src/session.ts`: the server pauses the session then.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum SleepTimer {
    /// At server epoch milliseconds `ends_at`.
    #[serde(rename_all = "camelCase")]
    At { ends_at: f64 },
    /// As the song playing ends, so nothing follows it without a gap.
    EndOfSong {},
}

/// A sleep timer as someone picks it, for `SetSleepTimer`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum SleepTimerChoice {
    /// After this many minutes.
    Minutes {
        minutes: u32,
    },
    EndOfSong {},
}

/// What happens at the end of a song. Mirrors `RepeatMode` and
/// `followingIndex` in `packages/shared/src/session.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum RepeatMode {
    /// Go on to the next song, and stop after the last.
    #[default]
    Off,
    /// Go on, and start over after the last.
    All,
    /// Play the same song again.
    One,
}

impl RepeatMode {
    /// The repeat button steps off → all → one → off.
    pub fn next(self) -> Self {
        match self {
            Self::Off => Self::All,
            Self::All => Self::One,
            Self::One => Self::Off,
        }
    }
}

/// The index that plays after `index` when that song ends by itself (or
/// plays on with no gap), in a queue of `len`.
pub fn following_index(len: usize, index: usize, repeat: RepeatMode) -> Option<usize> {
    if index >= len {
        return None;
    }
    match repeat {
        RepeatMode::One => Some(index),
        _ if index + 1 < len => Some(index + 1),
        RepeatMode::All => Some(0),
        RepeatMode::Off => None,
    }
}

impl SessionState {
    pub fn current_index(&self) -> Option<usize> {
        let id = self.current_entry_id.as_deref()?;
        self.queue.iter().position(|entry| entry.entry_id == id)
    }

    pub fn current(&self) -> Option<&QueueEntry> {
        self.current_index().map(|index| &self.queue[index])
    }

    /// What plays when the current song ends by itself, as `repeat` says:
    /// with repeat one, the same entry again. Nothing while the sleep timer
    /// stops the music at the song's end: the song then ends (`TrackEnded`)
    /// and the server pauses on what follows.
    pub fn next_after_current(&self) -> Option<&QueueEntry> {
        if self.stops_after_song() {
            return None;
        }
        self.current_index()
            .and_then(|index| following_index(self.queue.len(), index, self.repeat))
            .and_then(|index| self.queue.get(index))
    }

    /// The sleep timer stops the music when the song playing ends.
    pub fn stops_after_song(&self) -> bool {
        matches!(self.sleep_timer, Some(SleepTimer::EndOfSong {}))
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
        /// What the songs come from, when it has a page.
        #[serde(default)]
        playing_from: Option<PlayingFrom>,
        /// Shuffle them, as Shuffle does (`Some(true)`), play them in order,
        /// as Play does (`Some(false)`), or keep the session's shuffle, as
        /// picking one song does (`None`). The session's shuffle becomes it.
        #[serde(default)]
        shuffle: Option<bool>,
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
    /// Clear the songs still to come that someone queued; the current song
    /// and autoplay's songs stay.
    ClearUpcoming {},
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
    SetRepeat {
        mode: RepeatMode,
    },
    /// Shuffle the songs to come, or put them back in order.
    SetShuffle {
        enabled: bool,
    },
    /// Set the sleep timer, or turn it off with none.
    SetSleepTimer {
        timer: Option<SleepTimerChoice>,
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
        /// The house's UTC offset in minutes, from the server's operating
        /// system. Android's own time zone rules can be out of date.
        #[serde(default)]
        utc_offset_minutes: Option<i32>,
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
    fn repeat_decides_what_follows_like_the_server() {
        use RepeatMode::{All, Off, One};
        assert_eq!(following_index(3, 0, Off), Some(1));
        assert_eq!(following_index(3, 2, Off), None);
        assert_eq!(following_index(3, 2, All), Some(0));
        assert_eq!(following_index(3, 1, One), Some(1));
        assert_eq!(following_index(3, 3, All), None);
        assert_eq!(following_index(0, 0, All), None);
        assert_eq!([Off.next(), All.next(), One.next()], [All, One, Off]);
    }

    #[test]
    fn decodes_server_state() {
        let ServerMessage::State {
            state,
            server_now,
            utc_offset_minutes,
            ..
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
        assert_eq!(state.repeat, RepeatMode::All);
        assert!(state.shuffle);
        assert!(!state.queue[0].autoplay);
        assert!(state.queue[1].autoplay);
        assert!(server_now > state.position_at);
        assert_eq!(utc_offset_minutes, Some(-420));
        assert!((state.position_at(state.position_at + 1500.0) - 13.5).abs() < 1e-9);
        assert_eq!(
            state.sleep_timer,
            Some(SleepTimer::At {
                ends_at: 1794427800000.0
            })
        );
        assert!(!state.stops_after_song());
        assert_eq!(
            state.playing_from,
            Some(PlayingFrom {
                kind: PlayingFromKind::Playlist,
                title: "Road Trip".into(),
                id: "PLexample".into(),
            })
        );
    }

    #[test]
    fn a_sleep_timer_at_the_end_of_the_song_lets_it_end() {
        let ServerMessage::State { state, .. } =
            serde_json::from_str(&fixture("server-state-sleep-end-of-song.json")).unwrap()
        else {
            panic!("expected State");
        };
        assert_eq!(state.sleep_timer, Some(SleepTimer::EndOfSong {}));
        assert_eq!(state.playing_from, None);
        assert!(state.stops_after_song());
        assert_eq!(state.next_after_current(), None);
    }

    #[test]
    fn decodes_a_state_from_a_server_before_the_sleep_timer() {
        let mut value: serde_json::Value =
            serde_json::from_str(&fixture("server-state.json")).unwrap();
        value["state"].as_object_mut().unwrap().remove("sleepTimer");
        let ServerMessage::State { state, .. } = serde_json::from_value(value).unwrap() else {
            panic!("expected State");
        };
        assert_eq!(state.sleep_timer, None);
        assert_eq!(state.next_after_current().unwrap().entry_id, "e1");
    }

    #[test]
    fn decodes_a_state_from_a_server_before_playing_from() {
        let mut value: serde_json::Value =
            serde_json::from_str(&fixture("server-state.json")).unwrap();
        value["state"]
            .as_object_mut()
            .unwrap()
            .remove("playingFrom");
        let ServerMessage::State { state, .. } = serde_json::from_value(value).unwrap() else {
            panic!("expected State");
        };
        assert_eq!(state.playing_from, None);
    }

    #[test]
    fn every_playing_from_kind_is_named_as_the_server_names_it() {
        for (kind, name) in [
            (PlayingFromKind::Album, "Album"),
            (PlayingFromKind::Playlist, "Playlist"),
            (PlayingFromKind::MyPlaylist, "MyPlaylist"),
            (PlayingFromKind::Artist, "Artist"),
            (PlayingFromKind::Mix, "Mix"),
            (PlayingFromKind::Radio, "Radio"),
            (PlayingFromKind::Search, "Search"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), name);
            assert_eq!(
                serde_json::from_value::<PlayingFromKind>(name.into()).unwrap(),
                kind
            );
        }
    }

    #[test]
    fn decodes_a_play_queue_without_playing_from() {
        let message: ClientMessage =
            serde_json::from_str(r#"{ "_tag": "PlayQueue", "tracks": [], "startIndex": 0 }"#)
                .unwrap();
        assert_eq!(
            message,
            ClientMessage::PlayQueue {
                tracks: vec![],
                start_index: 0,
                playing_from: None,
                shuffle: None,
            }
        );
    }

    #[test]
    fn encodes_what_the_tv_plays_from() {
        let message = ClientMessage::PlayQueue {
            tracks: vec![],
            start_index: 2,
            playing_from: Some(PlayingFrom {
                kind: PlayingFromKind::Search,
                title: "daft punk".into(),
                id: "daft punk".into(),
            }),
            shuffle: None,
        };
        assert_eq!(
            serde_json::to_value(&message).unwrap(),
            serde_json::json!({
                "_tag": "PlayQueue",
                "tracks": [],
                "startIndex": 2,
                "playingFrom": { "kind": "Search", "title": "daft punk", "id": "daft punk" },
                "shuffle": null,
            })
        );
        let mix = ClientMessage::PlayQueue {
            tracks: vec![],
            start_index: 0,
            playing_from: Some(PlayingFrom {
                kind: PlayingFromKind::Mix,
                title: "Mix: Geese".into(),
                id: "RDAMVMcobra".into(),
            }),
            shuffle: Some(true),
        };
        let encoded = serde_json::to_string(&mix).unwrap();
        assert_eq!(
            serde_json::from_str::<ClientMessage>(&encoded).unwrap(),
            mix
        );
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
                    playing_from: Some(PlayingFrom {
                        kind: PlayingFromKind::Album,
                        title: "Whenever You Need Somebody".into(),
                        id: "MPREb_example".into(),
                    }),
                    shuffle: None,
                },
            ),
            (
                // Play on an album page: in order, and shuffle off.
                "client-play-queue-in-order.json",
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
                    playing_from: Some(PlayingFrom {
                        kind: PlayingFromKind::Album,
                        title: "Whenever You Need Somebody".into(),
                        id: "MPREb_example".into(),
                    }),
                    shuffle: Some(false),
                },
            ),
            (
                // Shuffle on an album page: the server shuffles from the
                // song it starts on, and shuffle is on.
                "client-play-queue-shuffled.json",
                ClientMessage::PlayQueue {
                    tracks: vec![
                        QueueTrack {
                            video_id: "dQw4w9WgXcQ".into(),
                            title: "Never Gonna Give You Up".into(),
                            artists: "Rick Astley".into(),
                            album: Some("Whenever You Need Somebody".into()),
                            duration_seconds: Some(213.5),
                            artwork_url: None,
                        },
                        QueueTrack {
                            video_id: "yPYZpwSpKmA".into(),
                            title: "Together Forever".into(),
                            artists: "Rick Astley".into(),
                            album: Some("Whenever You Need Somebody".into()),
                            duration_seconds: Some(205.5),
                            artwork_url: None,
                        },
                    ],
                    start_index: 1,
                    playing_from: Some(PlayingFrom {
                        kind: PlayingFromKind::Album,
                        title: "Whenever You Need Somebody".into(),
                        id: "MPREb_example".into(),
                    }),
                    shuffle: Some(true),
                },
            ),
            (
                // Songs that come from no page say so with null, never by
                // leaving the field out.
                "client-play-queue-from-nothing.json",
                ClientMessage::PlayQueue {
                    tracks: vec![QueueTrack {
                        video_id: "dQw4w9WgXcQ".into(),
                        title: "Never Gonna Give You Up".into(),
                        artists: "Rick Astley".into(),
                        album: None,
                        duration_seconds: None,
                        artwork_url: None,
                    }],
                    start_index: 0,
                    playing_from: None,
                    shuffle: None,
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
                "client-clear-upcoming.json",
                ClientMessage::ClearUpcoming {},
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
                "client-set-repeat.json",
                ClientMessage::SetRepeat {
                    mode: RepeatMode::One,
                },
            ),
            (
                "client-set-shuffle.json",
                ClientMessage::SetShuffle { enabled: true },
            ),
            (
                "client-set-sleep-timer.json",
                ClientMessage::SetSleepTimer {
                    timer: Some(SleepTimerChoice::Minutes { minutes: 30 }),
                },
            ),
            (
                "client-set-sleep-timer-end-of-song.json",
                ClientMessage::SetSleepTimer {
                    timer: Some(SleepTimerChoice::EndOfSong {}),
                },
            ),
            (
                "client-cancel-sleep-timer.json",
                ClientMessage::SetSleepTimer { timer: None },
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
