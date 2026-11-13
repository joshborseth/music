//! Sound Check: every song turned up or down to the same loudness.
//!
//! The server measures each song and says how many dB bring it to the level
//! every song plays at (`GET /tv/loudness`). [`fetch`] asks as the song is
//! downloaded: first for what the server knows now (its measurement, or
//! YouTube's figure until then), then, when that wasn't the measurement, for
//! the measurement once it is made. The engine applies the gain to samples
//! as it decodes them, through a [`Leveller`] that glides from one level to
//! the next: quickly where one song meets the next, so a gapless join
//! doesn't click, and slowly when the level changes while a song plays.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use crate::catalog::{Loudness, LoudnessSource};

/// Where one song meets the next: short enough to sound like the cut it is,
/// long enough that the step in level doesn't click.
pub const JOIN_RAMP: Duration = Duration::from_millis(50);
/// A song's level changing while it plays (its measurement arrived, Sound
/// Check was switched): slow enough to go unnoticed.
pub const CHANGE_RAMP: Duration = Duration::from_millis(1500);
/// How long a song about to open waits for the server's first answer, so
/// it starts at its own level instead of gliding to it.
pub const FIRST_ANSWER_WAIT: Duration = Duration::from_millis(500);
/// Changes smaller than this aren't worth a glide.
const SAME_DB: f32 = 0.05;

/// How long the server may take to answer what it knows now.
const QUICK_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the server may take to download and measure a song.
const MEASURE_TIMEOUT: Duration = Duration::from_secs(240);

/// One song's gain in dB, shared between its fetch and the engine.
#[derive(Debug)]
pub struct SongGain {
    /// The gain's `f32` bits; NaN until the server says.
    db: AtomicU32,
    /// The server answered (or failed to) the first time it was asked.
    answered: AtomicBool,
}

impl Default for SongGain {
    fn default() -> Self {
        Self {
            db: AtomicU32::new(f32::NAN.to_bits()),
            answered: AtomicBool::new(false),
        }
    }
}

impl SongGain {
    pub fn set_db(&self, db: f32) {
        if db.is_finite() {
            self.db.store(db.to_bits(), Ordering::Relaxed);
        }
    }

    /// The gain, once the server has said.
    pub fn db(&self) -> Option<f32> {
        let db = f32::from_bits(self.db.load(Ordering::Relaxed));
        db.is_finite().then_some(db)
    }

    fn set_answered(&self) {
        self.answered.store(true, Ordering::Relaxed);
    }

    /// Block until the server's first answer, or `limit` has passed.
    pub fn wait_for_answer(&self, limit: Duration) {
        let started = Instant::now();
        while !self.answered.load(Ordering::Relaxed) && started.elapsed() < limit {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// The gain to play a song at: its own with Sound Check on, and none with it
/// off or before the server has said.
pub fn wanted_db(sound_check: bool, gain: &SongGain) -> f32 {
    if sound_check {
        gain.db().unwrap_or(0.0)
    } else {
        0.0
    }
}

pub fn amplitude(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

fn frames(duration: Duration, rate: u32) -> usize {
    (duration.as_secs_f64() * f64::from(rate)).round() as usize
}

/// Applies a gain to interleaved samples, gliding in a straight line from
/// one level to the next.
#[derive(Debug, Clone, PartialEq)]
pub struct Leveller {
    /// The amplitude the last frame was played at.
    current: f32,
    target: f32,
    target_db: f32,
    /// Added to `current` every frame until it reaches `target`.
    step: f32,
}

impl Default for Leveller {
    fn default() -> Self {
        Self {
            current: 1.0,
            target: 1.0,
            target_db: 0.0,
            step: 0.0,
        }
    }
}

impl Leveller {
    /// Play at `db` from the next frame, for a song that starts on its own.
    pub fn jump_to(&mut self, db: f32) {
        self.target_db = db;
        self.target = amplitude(db);
        self.current = self.target;
        self.step = 0.0;
    }

    /// Glide to `db` over `ramp` at `rate`, unless it is heading there already.
    pub fn follow(&mut self, db: f32, ramp: Duration, rate: u32) {
        if (db - self.target_db).abs() < SAME_DB {
            return;
        }
        self.target_db = db;
        self.target = amplitude(db);
        let frames = frames(ramp, rate).max(1);
        self.step = (self.target - self.current) / frames as f32;
    }

    /// Scale `samples` (`channels` to a frame) by the level, moving it along
    /// its glide frame by frame.
    pub fn apply(&mut self, samples: &mut [f32], channels: usize) {
        if self.step == 0.0 && self.current == 1.0 {
            return;
        }
        for frame in samples.chunks_exact_mut(channels) {
            if self.step != 0.0 {
                self.current += self.step;
                let arrived = if self.step > 0.0 {
                    self.current >= self.target
                } else {
                    self.current <= self.target
                };
                if arrived {
                    self.current = self.target;
                    self.step = 0.0;
                }
            }
            for sample in frame {
                *sample *= self.current;
            }
        }
    }
}

// FETCHING

async fn ask(client: &reqwest::Client, url: &str, timeout: Duration) -> Result<Loudness, String> {
    let response = client
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| error.to_string())?;
    let body = response.bytes().await.map_err(|error| error.to_string())?;
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}

/// Ask `server` for `video_id`'s gain, then for its measurement when the
/// first answer wasn't one, setting `gain` as each answer comes. Failures
/// are only logged: the song plays at the gain it has.
pub async fn fetch(
    client: reqwest::Client,
    server: String,
    video_id: String,
    gain: std::sync::Arc<SongGain>,
) {
    let url = format!(
        "{server}/tv/loudness?videoId={}",
        crate::view::percent_encode(&video_id)
    );
    let first = ask(&client, &url, QUICK_TIMEOUT).await;
    if let Ok(loudness) = &first {
        gain.set_db(loudness.gain_db);
    }
    gain.set_answered();
    match first {
        Ok(loudness) if loudness.source == LoudnessSource::Measured => return,
        Ok(_) => {}
        Err(message) => log::warn!("couldn't get the loudness of {video_id}: {message}"),
    }
    match ask(&client, &format!("{url}&wait=true"), MEASURE_TIMEOUT).await {
        Ok(loudness) => gain.set_db(loudness.gain_db),
        Err(message) => log::warn!("couldn't get the measured loudness of {video_id}: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    const RATE: u32 = 48_000;

    fn level(leveller: &mut Leveller, frames: usize) -> Vec<f32> {
        let mut samples = vec![1.0; frames * 2];
        leveller.apply(&mut samples, 2);
        samples
    }

    #[test]
    fn a_song_without_a_gain_plays_untouched() {
        let mut leveller = Leveller::default();
        let mut samples = vec![0.25, -0.5, 1.0, -1.0];
        leveller.apply(&mut samples, 2);
        assert_eq!(samples, vec![0.25, -0.5, 1.0, -1.0]);
    }

    #[test]
    fn a_song_that_starts_on_its_own_starts_at_its_level() {
        let mut leveller = Leveller::default();
        leveller.jump_to(-6.0);
        let samples = level(&mut leveller, 4);
        assert!(samples.iter().all(|sample| (sample - 0.501).abs() < 0.001));
    }

    #[test]
    fn a_change_glides_over_its_ramp_and_stays() {
        let mut leveller = Leveller::default();
        leveller.follow(-20.0, CHANGE_RAMP, RATE);
        let ramp = frames(CHANGE_RAMP, RATE);
        let samples = level(&mut leveller, ramp + 100);
        // Left and right move together, frame by frame, always down.
        for frame in samples.chunks_exact(2) {
            assert_eq!(frame[0], frame[1]);
        }
        let lefts: Vec<f32> = samples.iter().step_by(2).copied().collect();
        assert!(lefts.windows(2).all(|pair| pair[1] <= pair[0]));
        assert!(lefts[ramp / 2] > 0.5 && lefts[ramp / 2] < 0.6);
        assert!((lefts[ramp + 50] - 0.1).abs() < 1e-4);
        // Asking for the same level again changes nothing.
        let before = leveller.clone();
        leveller.follow(-20.01, CHANGE_RAMP, RATE);
        assert_eq!(leveller, before);
    }

    #[test]
    fn a_gapless_join_to_a_quieter_song_does_not_click() {
        // A 1 kHz tone at full scale running straight from one song into the
        // next, which is 12 dB quieter: the join glides, so no sample jumps
        // further than the tone itself moves between samples.
        let tone =
            |at: usize| (at as f32 * 2.0 * std::f32::consts::PI * 1000.0 / RATE as f32).sin();
        let biggest_jump = |samples: &[f32]| {
            samples
                .windows(2)
                .map(|pair| (pair[1] - pair[0]).abs())
                .fold(0.0f32, f32::max)
        };
        let natural = biggest_jump(&(0..RATE as usize).map(tone).collect::<Vec<_>>());
        let mut leveller = Leveller::default();
        leveller.jump_to(0.0);
        let mut first: Vec<f32> = (0..1000).flat_map(|at| [tone(at), tone(at)]).collect();
        leveller.apply(&mut first, 2);
        leveller.follow(-12.0, JOIN_RAMP, RATE);
        let mut second: Vec<f32> = (1000..6000).flat_map(|at| [tone(at), tone(at)]).collect();
        leveller.apply(&mut second, 2);
        let heard: Vec<f32> = first.iter().chain(&second).step_by(2).copied().collect();
        assert!(biggest_jump(&heard) <= natural * 1.01);
        assert!((leveller.current - amplitude(-12.0)).abs() < 1e-6);
    }

    #[test]
    fn sound_check_off_or_unknown_plays_at_the_songs_own_level() {
        let gain = SongGain::default();
        assert_eq!(gain.db(), None);
        assert_eq!(wanted_db(true, &gain), 0.0);
        gain.set_db(f32::NAN);
        assert_eq!(gain.db(), None);
        gain.set_db(-4.5);
        assert_eq!(wanted_db(true, &gain), -4.5);
        assert_eq!(wanted_db(false, &gain), 0.0);
    }

    /// Answers `/tv/loudness` with each of `answers` in turn, and records
    /// each request's path.
    fn fake_server(answers: Vec<&'static str>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        std::thread::spawn(move || {
            for (stream, answer) in listener.incoming().zip(answers) {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                }
                let path = line.split_whitespace().nth(1).unwrap_or_default();
                log.lock().unwrap().push(path.to_owned());
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                    answer.len()
                );
            }
        });
        (url, requests)
    }

    fn fetch_from(server: String, gain: &Arc<SongGain>) {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(fetch(
            reqwest::Client::new(),
            server,
            "abc 123".into(),
            gain.clone(),
        ));
    }

    #[test]
    fn youtubes_figure_stands_in_until_the_measurement_comes() {
        let (server, requests) = fake_server(vec![
            r#"{"videoId":"abc 123","gainDb":-3.6,"source":"YouTube","integratedLufs":null,"truePeakDbtp":null}"#,
            r#"{"videoId":"abc 123","gainDb":-6.2,"source":"Measured","integratedLufs":-7.8,"truePeakDbtp":0.4}"#,
        ]);
        let gain = Arc::new(SongGain::default());
        fetch_from(server, &gain);
        assert_eq!(gain.db(), Some(-6.2));
        assert_eq!(
            *requests.lock().unwrap(),
            vec![
                "/tv/loudness?videoId=abc%20123",
                "/tv/loudness?videoId=abc%20123&wait=true"
            ]
        );
    }

    #[test]
    fn a_measured_song_is_asked_about_once() {
        let (server, requests) = fake_server(vec![
            r#"{"videoId":"abc 123","gainDb":2.5,"source":"Measured","integratedLufs":-16.5,"truePeakDbtp":-4}"#,
        ]);
        let gain = Arc::new(SongGain::default());
        fetch_from(server, &gain);
        gain.wait_for_answer(Duration::from_secs(1));
        assert_eq!(gain.db(), Some(2.5));
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_server_that_cant_say_leaves_the_song_as_it_is() {
        let (server, _) = fake_server(vec!["not json", "not json"]);
        let gain = Arc::new(SongGain::default());
        fetch_from(server, &gain);
        assert_eq!(gain.db(), None);
        // Nothing left to wait for.
        let started = Instant::now();
        gain.wait_for_answer(Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
