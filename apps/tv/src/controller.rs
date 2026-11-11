//! Glue between the session, the audio engine, and the screen.
//!
//! The server owns the session. When it names this TV as the active device,
//! the controller makes the engine play the current entry and reports back
//! what the engine does. Either way, the screen shows the session.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::audio::{Command, Engine, Event};
use crate::protocol::{ClientMessage, ServerMessage, SessionState};
use crate::session::Inbound;
use crate::view::{UpNextItem, View};

/// Remote-control actions from the screen.
#[derive(Debug, Clone, Copy)]
pub enum UiAction {
    PlayPause,
    SeekBy(f64),
    Next,
    Previous,
}

const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
const REFRESH_INTERVAL: Duration = Duration::from_millis(250);
const NOTICE_DURATION: Duration = Duration::from_secs(6);
const UP_NEXT_COUNT: usize = 4;

fn local_now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

pub struct Controller {
    device_id: String,
    engine: Engine,
    outbound: UnboundedSender<ClientMessage>,
    connected: bool,
    state: Option<SessionState>,
    /// Server clock minus local clock, in ms.
    clock_offset: f64,
    /// The entry and seek generation the engine was last told to load.
    loaded: Option<(String, u64)>,
    /// Last position the engine reported, and when.
    engine_position: Option<(String, f64, Instant)>,
    last_progress: Instant,
    notice: Option<(String, Instant)>,
}

impl Controller {
    pub fn new(
        device_id: String,
        engine: Engine,
        outbound: UnboundedSender<ClientMessage>,
    ) -> Self {
        Self {
            device_id,
            engine,
            outbound,
            connected: false,
            state: None,
            clock_offset: 0.0,
            loaded: None,
            engine_position: None,
            last_progress: Instant::now(),
            notice: None,
        }
    }

    pub async fn run(
        mut self,
        mut inbound: UnboundedReceiver<Inbound>,
        mut events: UnboundedReceiver<Event>,
        mut actions: UnboundedReceiver<UiAction>,
        render: impl Fn(View),
    ) {
        let mut refresh = tokio::time::interval(REFRESH_INTERVAL);
        refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut shown: Option<View> = None;
        loop {
            tokio::select! {
                Some(message) = inbound.recv() => self.on_inbound(message),
                Some(event) = events.recv() => self.on_engine(event),
                Some(action) = actions.recv() => self.on_action(action),
                _ = refresh.tick() => {}
                else => return,
            }
            let view = self.view();
            if shown.as_ref() != Some(&view) {
                render(view.clone());
                shown = Some(view);
            }
        }
    }

    fn send(&self, message: ClientMessage) {
        let _ = self.outbound.send(message);
    }

    fn server_now(&self) -> f64 {
        local_now_ms() + self.clock_offset
    }

    fn is_active(&self) -> bool {
        self.state
            .as_ref()
            .is_some_and(|state| state.active_device_id.as_deref() == Some(&self.device_id))
    }

    // SESSION

    fn on_inbound(&mut self, message: Inbound) {
        match message {
            Inbound::Connected => self.connected = true,
            // Keep playing what is loaded; the server pauses it if we stay away.
            Inbound::Disconnected => self.connected = false,
            Inbound::Message(ServerMessage::Notice { message }) => {
                self.notice = Some((message, Instant::now()));
            }
            Inbound::Message(ServerMessage::State { state, server_now }) => {
                self.clock_offset = server_now - local_now_ms();
                self.state = Some(state);
                self.reconcile();
            }
        }
    }

    /// Make the engine match the session.
    fn reconcile(&mut self) {
        let Some(state) = &self.state else { return };
        let current = state.current().filter(|_| self.is_active());
        let Some(current) = current else {
            if self.loaded.take().is_some() {
                self.engine.send(Command::Stop);
                self.engine_position = None;
            }
            return;
        };
        let key = (current.entry_id.clone(), state.seek_seq);
        if self.loaded.as_ref() == Some(&key) {
            self.engine.send(Command::SetPlaying(state.playing));
        } else {
            self.engine.send(Command::Load {
                entry_id: current.entry_id.clone(),
                video_id: current.track.video_id.clone(),
                start_seconds: state.position_at(self.server_now()),
                playing: state.playing,
            });
            self.loaded = Some(key);
        }
        let next = state
            .next_after_current()
            .map(|entry| (entry.entry_id.clone(), entry.track.video_id.clone()));
        self.engine.send(Command::SetNext(next));
    }

    // ENGINE

    fn on_engine(&mut self, event: Event) {
        let playing = self.state.as_ref().is_some_and(|state| state.playing);
        match event {
            Event::Position { entry_id, seconds } => {
                let is_current = self
                    .state
                    .as_ref()
                    .and_then(|state| state.current_entry_id.as_deref())
                    == Some(entry_id.as_str());
                if self.is_active()
                    && is_current
                    && self.last_progress.elapsed() >= PROGRESS_INTERVAL
                {
                    self.last_progress = Instant::now();
                    self.send(ClientMessage::Progress {
                        entry_id: entry_id.clone(),
                        position_seconds: seconds,
                        playing,
                    });
                }
                self.engine_position = Some((entry_id, seconds, Instant::now()));
            }
            Event::Advanced {
                from_entry_id,
                to_entry_id,
            } => {
                self.send(ClientMessage::Advanced {
                    from_entry_id: from_entry_id.clone(),
                });
                // Show the new song now instead of waiting for the server.
                if let Some(state) = &mut self.state {
                    if state.current_entry_id.as_deref() == Some(from_entry_id.as_str()) {
                        state.current_entry_id = Some(to_entry_id.clone());
                        state.position_seconds = 0.0;
                        state.position_at = local_now_ms() + self.clock_offset;
                    }
                    self.loaded = Some((to_entry_id, state.seek_seq));
                }
            }
            Event::Ended { entry_id } => self.send(ClientMessage::TrackEnded { entry_id }),
            Event::Failed { entry_id, message } => {
                log::warn!("playback failed for {entry_id}: {message}");
                self.send(ClientMessage::TrackFailed { entry_id, message });
            }
        }
    }

    // REMOTE

    fn on_action(&mut self, action: UiAction) {
        let Some(state) = &self.state else { return };
        if state.current_entry_id.is_none() {
            return;
        }
        match action {
            UiAction::PlayPause if !self.is_active() => self.send(ClientMessage::Transfer {
                device_id: self.device_id.clone(),
            }),
            UiAction::PlayPause if state.playing => self.send(ClientMessage::Pause {}),
            UiAction::PlayPause => self.send(ClientMessage::Resume {}),
            UiAction::SeekBy(delta) => {
                let duration = state
                    .current()
                    .and_then(|entry| entry.track.duration_seconds)
                    .unwrap_or(f64::MAX);
                let target = (self.position() + delta).clamp(0.0, (duration - 1.0).max(0.0));
                self.send(ClientMessage::Seek {
                    position_seconds: target,
                });
            }
            UiAction::Next => self.send(ClientMessage::Next {}),
            UiAction::Previous => self.send(ClientMessage::Previous {}),
        }
    }

    // SCREEN

    /// The position to show: the engine's when this TV plays, else the session's.
    fn position(&self) -> f64 {
        let Some(state) = &self.state else { return 0.0 };
        if self.is_active()
            && let Some((entry_id, seconds, at)) = &self.engine_position
            && state.current_entry_id.as_deref() == Some(entry_id.as_str())
        {
            return if state.playing {
                seconds + at.elapsed().as_secs_f64()
            } else {
                *seconds
            };
        }
        state.position_at(self.server_now())
    }

    fn view(&mut self) -> View {
        if self
            .notice
            .as_ref()
            .is_some_and(|(_, at)| at.elapsed() > NOTICE_DURATION)
        {
            self.notice = None;
        }
        let notice = self
            .notice
            .as_ref()
            .map(|(text, _)| text.clone())
            .unwrap_or_default();
        let Some(state) = &self.state else {
            return View::idle(self.connected, notice);
        };
        let Some(index) = state.current_index() else {
            return View::idle(self.connected, notice);
        };
        let track = &state.queue[index].track;
        let elsewhere = state
            .active_device_id
            .as_deref()
            .filter(|id| *id != self.device_id)
            .and_then(|id| state.devices.iter().find(|device| device.id == id))
            .map(|device| format!("Playing on {}", device.name))
            .unwrap_or_default();
        View {
            connected: self.connected,
            idle: false,
            title: track.title.clone(),
            artists: track.artists.clone(),
            album: track.album.clone().unwrap_or_default(),
            artwork_url: track.artwork_url.clone(),
            duration_seconds: track.duration_seconds.unwrap_or(0.0),
            position_seconds: self.position().max(0.0).floor(),
            playing: state.playing,
            elsewhere,
            notice,
            up_next: state.queue[index + 1..]
                .iter()
                .take(UP_NEXT_COUNT)
                .map(|entry| UpNextItem {
                    title: entry.track.title.clone(),
                    artists: entry.track.artists.clone(),
                })
                .collect(),
        }
    }
}
