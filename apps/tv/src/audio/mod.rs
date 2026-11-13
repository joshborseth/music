//! The playback engine: one thread that owns the decoder and the audio device.
//!
//! The controller tells it what to play ([`Command`]); it reports where it is
//! and when songs change ([`Event`]). The next song is downloaded and its
//! decoder opened ahead of time, so when the current one runs out the next
//! one's samples follow in the same ring buffer with no gap. With Sound
//! Check on, each song's samples are scaled by its gain from the server as
//! they are decoded ([`gain`]).

mod decode;
pub mod gain;
mod output;
pub mod scope;
pub mod source;

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use decode::{CHANNELS, TrackDecoder};
use gain::{Leveller, SongGain};
use output::Output;
use source::TrackData;

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// Start a song from a position, dropping whatever was playing.
    Load {
        entry_id: String,
        video_id: String,
        start_seconds: f64,
        playing: bool,
    },
    /// What to play when the current song ends, if anything.
    SetNext(Option<(String, String)>),
    SetPlaying(bool),
    /// Level songs to the same loudness, or play them as they are.
    SetSoundCheck(bool),
    /// Stop and release the audio device.
    Stop,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Position {
        entry_id: String,
        seconds: f64,
    },
    /// The next song started without a gap.
    Advanced {
        from_entry_id: String,
        to_entry_id: String,
    },
    /// The song finished and nothing followed it.
    Ended {
        entry_id: String,
    },
    Failed {
        entry_id: String,
        message: String,
    },
}

pub struct Engine {
    commands: Sender<Command>,
}

impl Engine {
    /// Start the engine thread. Audio comes from `{server}/audio/{videoId}`.
    pub fn spawn(
        server: String,
        runtime: tokio::runtime::Handle,
        events: tokio::sync::mpsc::UnboundedSender<Event>,
    ) -> Self {
        let (commands, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("audio-engine".into())
            .spawn(move || EngineThread::new(server, runtime, events).run(receiver))
            .expect("spawn audio engine thread");
        Self { commands }
    }

    pub fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }
}

/// Songs kept in memory: the current one, the next one, and a couple of recent ones.
const CACHE_SIZE: usize = 4;
/// Room to leave in the ring before decoding another packet (one AAC frame is 1024).
const DECODE_HEADROOM: usize = 4096 * CHANNELS;
const IDLE_WAIT: Duration = Duration::from_millis(20);
const POSITION_INTERVAL: Duration = Duration::from_millis(500);

/// A stretch of the output ring that belongs to one song.
struct Segment {
    entry_id: String,
    /// Output frame at which this song's first sample plays.
    start_frame: u64,
    /// Song position (seconds) of that first sample.
    base_seconds: f64,
}

struct Decoding {
    entry_id: String,
    decoder: TrackDecoder,
    gain: Arc<SongGain>,
    /// Reached the end of the file and is waiting for the next song to open.
    awaiting_next: bool,
}

enum OpenKind {
    Load,
    Next,
}

struct Opened {
    kind: OpenKind,
    generation: u64,
    entry_id: String,
    gain: Arc<SongGain>,
    result: Result<TrackDecoder, String>,
}

/// A song in memory, with its gain as the server knows it.
struct Cached {
    video_id: String,
    data: Arc<TrackData>,
    gain: Arc<SongGain>,
}

struct EngineThread {
    server: String,
    runtime: tokio::runtime::Handle,
    client: reqwest::Client,
    events: tokio::sync::mpsc::UnboundedSender<Event>,
    cache: Vec<Cached>,
    opened_sender: Sender<Opened>,
    opened: Receiver<Opened>,
    generation: u64,

    output: Option<Output>,
    written_frames: u64,
    pending: Vec<f32>,
    current: Option<Decoding>,
    segments: VecDeque<Segment>,
    /// The last segment ends at this frame and nothing follows it.
    end_frame: Option<u64>,
    next: Option<(String, String)>,
    prepared_next: Option<(String, TrackDecoder, Arc<SongGain>)>,
    playing: bool,
    last_position: Instant,
    sound_check: bool,
    /// The level samples are written at: the current song's gain.
    leveller: Leveller,
}

impl EngineThread {
    fn new(
        server: String,
        runtime: tokio::runtime::Handle,
        events: tokio::sync::mpsc::UnboundedSender<Event>,
    ) -> Self {
        let (opened_sender, opened) = mpsc::channel();
        Self {
            server,
            runtime,
            client: reqwest::Client::new(),
            events,
            cache: Vec::new(),
            opened_sender,
            opened,
            generation: 0,
            output: None,
            written_frames: 0,
            pending: Vec::new(),
            current: None,
            segments: VecDeque::new(),
            end_frame: None,
            next: None,
            prepared_next: None,
            playing: false,
            last_position: Instant::now(),
            sound_check: true,
            leveller: Leveller::default(),
        }
    }

    fn run(mut self, commands: Receiver<Command>) {
        loop {
            let busy = self.playing && self.current.is_some() && self.has_room();
            let wait = if busy { Duration::ZERO } else { IDLE_WAIT };
            match commands.recv_timeout(wait) {
                Ok(command) => {
                    self.handle(command);
                    while let Ok(command) = commands.try_recv() {
                        self.handle(command);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            while let Ok(opened) = self.opened.try_recv() {
                self.receive_opened(opened);
            }
            self.observe();
            self.fill();
        }
    }

    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }

    fn has_room(&self) -> bool {
        !self.pending.is_empty()
            || self
                .output
                .as_ref()
                .is_none_or(|output| output.producer.slots() >= DECODE_HEADROOM)
    }

    // DOWNLOADS

    fn fetch(&mut self, video_id: &str) -> (Arc<TrackData>, Arc<SongGain>) {
        if let Some(index) = self.cache.iter().position(|cached| {
            cached.video_id == video_id
                && cached.data.failed().is_none()
                && !cached.data.is_cancelled()
        }) {
            let entry = self.cache.remove(index);
            let found = (entry.data.clone(), entry.gain.clone());
            self.cache.push(entry);
            return found;
        }
        let data = Arc::new(TrackData::default());
        let url = format!("{}/audio/{}", self.server, video_id);
        self.runtime
            .spawn(data.clone().download(self.client.clone(), url));
        let gain = Arc::new(SongGain::default());
        self.runtime.spawn(gain::fetch(
            self.client.clone(),
            self.server.clone(),
            video_id.to_owned(),
            gain.clone(),
        ));
        self.cache.push(Cached {
            video_id: video_id.to_owned(),
            data: data.clone(),
            gain: gain.clone(),
        });
        if self.cache.len() > CACHE_SIZE {
            let evicted = self.cache.remove(0);
            // Only the cache and its download hold it: nobody is reading.
            if Arc::strong_count(&evicted.data) <= 2 {
                evicted.data.cancel();
            }
        }
        (data, gain)
    }

    fn open(&mut self, kind: OpenKind, entry_id: String, video_id: &str, start_seconds: f64) {
        let (data, gain) = self.fetch(video_id);
        let generation = self.generation;
        let sender = self.opened_sender.clone();
        let sound_check = self.sound_check;
        std::thread::Builder::new()
            .name("audio-open".into())
            .spawn(move || {
                let result = TrackDecoder::open(data, start_seconds);
                // The server's first answer is quick: start the song at its
                // own level rather than gliding there once it plays.
                if sound_check {
                    gain.wait_for_answer(gain::FIRST_ANSWER_WAIT);
                }
                let _ = sender.send(Opened {
                    kind,
                    generation,
                    entry_id,
                    gain,
                    result,
                });
            })
            .expect("spawn decoder opener");
    }

    // COMMANDS

    fn handle(&mut self, command: Command) {
        match command {
            Command::Load {
                entry_id,
                video_id,
                start_seconds,
                playing,
            } => {
                self.generation += 1;
                self.reset_playback();
                self.segments.push_back(Segment {
                    entry_id: entry_id.clone(),
                    start_frame: self.written_frames,
                    base_seconds: start_seconds,
                });
                self.set_playing(playing);
                self.open(OpenKind::Load, entry_id, &video_id, start_seconds);
                // The next song's decoder is unaffected by the jump; reopen it
                // only if the generation guard would drop it.
                if let Some((next_entry, next_video)) = self.next.clone() {
                    self.prepared_next = None;
                    self.open(OpenKind::Next, next_entry, &next_video, 0.0);
                }
                self.emit_position(true);
            }
            Command::SetNext(next) => {
                if next == self.next {
                    return;
                }
                self.next = next.clone();
                self.prepared_next = None;
                match next {
                    Some((entry_id, video_id)) => {
                        self.open(OpenKind::Next, entry_id, &video_id, 0.0)
                    }
                    None => {
                        if self
                            .current
                            .as_ref()
                            .is_some_and(|current| current.awaiting_next)
                        {
                            self.finish_without_next();
                        }
                    }
                }
            }
            Command::SetPlaying(playing) => self.set_playing(playing),
            // The level glides there as the next samples are decoded.
            Command::SetSoundCheck(on) => self.sound_check = on,
            Command::Stop => {
                self.generation += 1;
                self.reset_playback();
                self.next = None;
                self.prepared_next = None;
                self.playing = false;
                self.output = None;
                self.written_frames = 0;
            }
        }
    }

    fn set_playing(&mut self, playing: bool) {
        self.playing = playing;
        if let Some(output) = &self.output {
            output.set_paused(!playing);
        }
    }

    /// Drop everything queued for the device and everything being decoded.
    fn reset_playback(&mut self) {
        if let Some(output) = &self.output {
            output.flush();
            self.written_frames = output.played_frames();
        }
        self.pending.clear();
        self.current = None;
        self.segments.clear();
        self.end_frame = None;
    }

    fn receive_opened(&mut self, opened: Opened) {
        if opened.generation != self.generation {
            return;
        }
        match (opened.kind, opened.result) {
            (OpenKind::Load, Ok(decoder)) => {
                // What played before was dropped: start at this song's level.
                self.leveller
                    .jump_to(gain::wanted_db(self.sound_check, &opened.gain));
                self.current = Some(Decoding {
                    entry_id: opened.entry_id,
                    decoder,
                    gain: opened.gain,
                    awaiting_next: false,
                });
            }
            (OpenKind::Load, Err(message)) => {
                self.segments.clear();
                self.emit(Event::Failed {
                    entry_id: opened.entry_id,
                    message,
                });
            }
            (OpenKind::Next, Ok(decoder)) => {
                if self
                    .next
                    .as_ref()
                    .is_some_and(|(entry, _)| *entry == opened.entry_id)
                {
                    self.prepared_next = Some((opened.entry_id, decoder, opened.gain));
                    if self
                        .current
                        .as_ref()
                        .is_some_and(|current| current.awaiting_next)
                    {
                        self.start_next();
                    }
                }
            }
            (OpenKind::Next, Err(message)) => {
                log::warn!("could not prepare the next song: {message}");
                if self
                    .current
                    .as_ref()
                    .is_some_and(|current| current.awaiting_next)
                {
                    self.finish_without_next();
                }
            }
        }
    }

    // DECODING

    /// Queue the prepared next song right behind the current one.
    fn start_next(&mut self) {
        let Some((entry_id, decoder, gain)) = self.prepared_next.take() else {
            return;
        };
        self.next = None;
        self.segments.push_back(Segment {
            entry_id: entry_id.clone(),
            start_frame: self.written_frames,
            base_seconds: 0.0,
        });
        // Its first samples follow the last song's with no gap: glide from
        // one level to the other so the join doesn't click.
        self.leveller.follow(
            gain::wanted_db(self.sound_check, &gain),
            gain::JOIN_RAMP,
            decoder.rate,
        );
        self.current = Some(Decoding {
            entry_id,
            decoder,
            gain,
            awaiting_next: false,
        });
    }

    fn finish_without_next(&mut self) {
        self.current = None;
        self.end_frame = Some(self.written_frames);
    }

    /// Make sure the device runs at the current song's rate. A change of rate
    /// waits for the old audio to finish playing, then reopens the device.
    fn ensure_output(&mut self, rate: u32) -> bool {
        match &self.output {
            Some(output) if output.rate == rate => true,
            Some(output) if output.played_frames() < self.written_frames => false,
            _ => match Output::open(rate) {
                Ok(output) => {
                    output.set_paused(!self.playing);
                    self.output = Some(output);
                    self.written_frames = 0;
                    for segment in &mut self.segments {
                        segment.start_frame = 0;
                    }
                    true
                }
                Err(message) => {
                    if let Some(current) = self.current.take() {
                        self.emit(Event::Failed {
                            entry_id: current.entry_id,
                            message,
                        });
                    }
                    false
                }
            },
        }
    }

    fn fill(&mut self) {
        loop {
            let Some(current) = &self.current else { return };
            if current.awaiting_next {
                return;
            }
            let rate = current.decoder.rate;
            if !self.ensure_output(rate) {
                return;
            }
            if self.pending.is_empty() {
                let Some(current) = self.current.as_mut() else {
                    return;
                };
                match current.decoder.decode_into(&mut self.pending) {
                    Ok(true) => {
                        // A gain that arrived or changed since, or Sound
                        // Check switched, glides in unnoticed.
                        self.leveller.follow(
                            gain::wanted_db(self.sound_check, &current.gain),
                            gain::CHANGE_RAMP,
                            current.decoder.rate,
                        );
                        self.leveller.apply(&mut self.pending, CHANNELS);
                    }
                    Ok(false) if self.prepared_next.is_some() => {
                        self.start_next();
                        continue;
                    }
                    Ok(false) if self.next.is_some() => {
                        current.awaiting_next = true;
                        return;
                    }
                    Ok(false) => {
                        self.finish_without_next();
                        return;
                    }
                    Err(message) => {
                        let entry_id = current.entry_id.clone();
                        self.current = None;
                        self.emit(Event::Failed { entry_id, message });
                        return;
                    }
                }
            }
            let Some(output) = self.output.as_mut() else {
                return;
            };
            let room = output.producer.slots();
            let count = (room.min(self.pending.len()) / CHANNELS) * CHANNELS;
            if count == 0 {
                return;
            }
            if let Ok(chunk) = output.producer.write_chunk_uninit(count) {
                chunk.fill_from_iter(self.pending.drain(..count));
                self.written_frames += (count / CHANNELS) as u64;
            }
            if !self.pending.is_empty() {
                return;
            }
        }
    }

    // REPORTING

    fn played_frames(&self) -> u64 {
        self.output
            .as_ref()
            .map_or(self.written_frames, Output::played_frames)
    }

    fn observe(&mut self) {
        let played = self.played_frames();
        while self.segments.len() >= 2 && played >= self.segments[1].start_frame {
            let finished = self.segments.pop_front().expect("two segments");
            self.emit(Event::Advanced {
                from_entry_id: finished.entry_id,
                to_entry_id: self.segments[0].entry_id.clone(),
            });
            self.emit_position(true);
        }
        if let Some(end) = self.end_frame
            && played >= end
            && self.segments.len() == 1
        {
            let finished = self.segments.pop_front().expect("one segment");
            self.end_frame = None;
            self.emit(Event::Ended {
                entry_id: finished.entry_id,
            });
        }
        if self.playing {
            self.emit_position(false);
        }
    }

    fn emit_position(&mut self, now: bool) {
        if !now && self.last_position.elapsed() < POSITION_INTERVAL {
            return;
        }
        self.last_position = Instant::now();
        let Some(segment) = self.segments.front() else {
            return;
        };
        let rate = self.output.as_ref().map_or(44_100, |output| output.rate);
        let played = self.played_frames().saturating_sub(segment.start_frame);
        // Where the song is as heard: what the device was handed plays this
        // much later. Lyrics, visuals, and the session all follow this.
        let heard = played as f64 / f64::from(rate) - scope::SCOPE.latency().as_secs_f64();
        let seconds = segment.base_seconds + heard.max(0.0);
        self.emit(Event::Position {
            entry_id: segment.entry_id.clone(),
            seconds,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plays real songs through a running server, into the null device.
    /// `MUSIC_TEST_SERVER=http://127.0.0.1:3901 cargo test -p music-tv -- --ignored`
    #[test]
    #[ignore = "needs a running server"]
    fn seeks_near_the_end_and_advances_without_a_gap() {
        let server = std::env::var("MUSIC_TEST_SERVER").expect("MUSIC_TEST_SERVER");
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let engine = Engine::spawn(server, runtime.handle().clone(), events);
        // "Never Gonna Give You Up" is 3:33 long.
        engine.send(Command::SetNext(Some(("b".into(), "kJQP7kiw5Fk".into()))));
        engine.send(Command::Load {
            entry_id: "a".into(),
            video_id: "dQw4w9WgXcQ".into(),
            start_seconds: 210.0,
            playing: true,
        });
        let started = Instant::now();
        let mut first_position = None;
        let advanced = runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(40), async {
                while let Some(event) = receiver.recv().await {
                    match event {
                        Event::Position { entry_id, seconds }
                            if entry_id == "a" && seconds > 210.05 =>
                        {
                            first_position.get_or_insert((seconds, started.elapsed()));
                        }
                        Event::Advanced {
                            from_entry_id,
                            to_entry_id,
                        } => {
                            return (from_entry_id, to_entry_id);
                        }
                        Event::Failed { message, .. } => panic!("failed: {message}"),
                        _ => {}
                    }
                }
                panic!("engine stopped");
            })
            .await
            .expect("advanced in time")
        });
        assert_eq!(advanced, ("a".to_owned(), "b".to_owned()));
        let (seconds, at) = first_position.expect("played from the seek point");
        eprintln!(
            "audio from {seconds:.2}s after {at:?}; advanced after {:?}",
            started.elapsed()
        );
        engine.send(Command::Stop);
    }
}
