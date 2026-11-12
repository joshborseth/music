//! The screensaver's visualizer: full-screen scenes that move with the music
//! this TV plays, painted in the cover's colors.
//!
//! A thread of its own paints each frame in software on a small canvas
//! (`canvas.rs`), which the screen stretches over the TV. The UI thread only
//! picks up the newest frame, so the remote stays quick while it runs. It
//! runs only while the screensaver shows and this TV plays.

mod canvas;
mod look;
mod scenes;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use slint::{Rgba8Pixel, SharedPixelBuffer};

pub use look::Cover;
use look::Look;
use scenes::Scene;

use crate::visualizer::{Analyzer, BARS};

const FRAME: Duration = Duration::from_millis(33);
/// Each scene shows this long before the next takes over.
const SCENE_TIME: f32 = 30.0;
/// Waveform samples a scene gets: the newest, about 12 ms of audio.
pub const WAVE: usize = 512;

/// The music, as the scenes see it in one frame.
pub struct Audio {
    /// The visualizer's bars, each 0 to 1.
    pub bands: [f32; BARS],
    /// The newest samples, scaled up so quiet songs move as much as loud ones.
    pub wave: [f32; WAVE],
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
    /// Everything together.
    pub level: f32,
    /// True on the frame a kick drum hits.
    pub kick: bool,
    /// 1 on a kick, fading to 0 over a quarter second.
    pub beat: f32,
    /// Seconds since the visuals started.
    pub time: f32,
    /// Seconds since the last frame.
    pub dt: f32,
    /// A clock that runs faster when the music is louder.
    pub drive: f32,
}

/// Turns the analyzer's bars and the raw samples into `Audio`.
struct Listener {
    analyzer: Analyzer,
    bass_average: f32,
    last_bass: f32,
    since_kick: f32,
    beat: f32,
    peak: f32,
    drive: f32,
}

impl Listener {
    fn new() -> Self {
        Self {
            analyzer: Analyzer::new(),
            bass_average: 0.0,
            last_bass: 0.0,
            since_kick: 1.0,
            beat: 0.0,
            peak: 0.3,
            drive: 0.0,
        }
    }

    fn hear(&mut self, time: f32, dt: f32) -> Audio {
        let bands = *self.analyzer.frame();
        let average = |range: std::ops::Range<usize>| {
            let length = range.len() as f32;
            bands[range].iter().sum::<f32>() / length
        };
        let bass = average(0..10);
        let mid = average(10..30);
        let treble = average(30..BARS);
        let level = bass * 0.45 + mid * 0.35 + treble * 0.2;

        self.since_kick += dt;
        let kick = bass > self.bass_average + 0.07
            && bass - self.last_bass > 0.03
            && self.since_kick > 0.22;
        if kick {
            self.since_kick = 0.0;
            self.beat = 1.0;
        } else {
            self.beat = (self.beat - dt * 4.0).max(0.0);
        }
        self.bass_average += (bass - self.bass_average) * (dt * 1.5).min(1.0);
        self.last_bass = bass;

        let samples = self.analyzer.samples();
        let newest = &samples[samples.len() - WAVE..];
        let peak = newest
            .iter()
            .fold(0.0f32, |peak, sample| peak.max(sample.abs()));
        self.peak = if peak > self.peak {
            peak
        } else {
            self.peak + (peak - self.peak) * (dt * 0.8).min(1.0)
        };
        let gain = 0.8 / self.peak.max(0.08);
        let mut wave = [0.0; WAVE];
        for (out, sample) in wave.iter_mut().zip(newest) {
            *out = (sample * gain).clamp(-1.2, 1.2);
        }

        self.drive += dt * (0.4 + level * 1.6 + self.beat * 0.6);
        Audio {
            bands,
            wave,
            bass,
            mid,
            treble,
            level,
            kick,
            beat: self.beat,
            time,
            dt,
            drive: self.drive,
        }
    }
}

/// Paints frames: the scenes, the canvas they share, and the music.
pub struct Engine {
    listener: Listener,
    canvas: canvas::Canvas,
    look: Look,
    scenes: Vec<Box<dyn Scene>>,
    scene: usize,
    scene_time: f32,
    started: Instant,
    last: Instant,
}

impl Engine {
    pub fn new(first_scene: usize) -> Self {
        let scenes = scenes::all();
        let now = Instant::now();
        Self {
            listener: Listener::new(),
            canvas: canvas::Canvas::new(),
            look: Look::new(None),
            scene: first_scene % scenes.len(),
            scenes,
            scene_time: 0.0,
            started: now,
            last: now,
        }
    }

    fn set_cover(&mut self, cover: Option<Arc<Cover>>) {
        let same = match (&self.look.cover, &cover) {
            (Some(old), Some(new)) => Arc::ptr_eq(old, new),
            (None, None) => true,
            _ => false,
        };
        if !same {
            self.look = Look::new(cover);
        }
    }

    fn next_scene(&mut self) {
        self.scene_time = 0.0;
        for _ in 0..self.scenes.len() {
            self.scene = (self.scene + 1) % self.scenes.len();
            if self.usable(self.scene) {
                break;
            }
        }
    }

    fn usable(&self, scene: usize) -> bool {
        !self.scenes[scene].needs_cover() || self.look.cover.is_some()
    }

    /// Paint the next frame, `dt` seconds after the last.
    fn paint(&mut self, dt: f32) -> SharedPixelBuffer<Rgba8Pixel> {
        let time = self.started.elapsed().as_secs_f32();
        let audio = self.listener.hear(time, dt);
        self.scene_time += dt;
        if self.scene_time >= SCENE_TIME || !self.usable(self.scene) {
            self.next_scene();
        }
        self.scenes[self.scene].draw(&mut self.canvas, &audio, &self.look);
        self.canvas.to_pixels()
    }

    pub fn frame(&mut self) -> SharedPixelBuffer<Rgba8Pixel> {
        let now = Instant::now();
        let dt = now
            .duration_since(self.last)
            .as_secs_f32()
            .clamp(0.001, 0.1);
        self.last = now;
        self.paint(dt)
    }
}

/// The running visuals. Dropping it stops the thread.
pub struct Visuals {
    shared: Arc<Shared>,
}

struct Shared {
    running: AtomicBool,
    frame: Mutex<Option<SharedPixelBuffer<Rgba8Pixel>>>,
    cover: Mutex<Option<Arc<Cover>>>,
    skips: AtomicUsize,
}

impl Visuals {
    pub fn start(cover: Option<Arc<Cover>>) -> Self {
        let shared = Arc::new(Shared {
            running: AtomicBool::new(true),
            frame: Mutex::new(None),
            cover: Mutex::new(cover),
            skips: AtomicUsize::new(0),
        });
        let painter = shared.clone();
        // A different scene each time the screensaver starts.
        let first = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| (elapsed.as_secs() / 7) as usize);
        let spawned = std::thread::Builder::new()
            .name("visuals".into())
            .spawn(move || paint_until_stopped(&painter, first));
        if let Err(error) = spawned {
            log::warn!("visuals failed to start: {error}");
        }
        Self { shared }
    }

    pub fn set_cover(&self, cover: Option<Arc<Cover>>) {
        *self
            .shared
            .cover
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = cover;
    }

    /// The newest frame, once.
    pub fn take_frame(&self) -> Option<SharedPixelBuffer<Rgba8Pixel>> {
        self.shared
            .frame
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }

    /// Move on to the next scene now.
    #[cfg(feature = "screenshots")]
    pub fn skip(&self) {
        self.shared.skips.fetch_add(1, Ordering::Relaxed);
    }
}

impl Drop for Visuals {
    fn drop(&mut self) {
        self.shared.running.store(false, Ordering::Relaxed);
    }
}

fn paint_until_stopped(shared: &Shared, first_scene: usize) {
    let mut engine = Engine::new(first_scene);
    let mut next = Instant::now();
    while shared.running.load(Ordering::Relaxed) {
        let cover = shared
            .cover
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        engine.set_cover(cover);
        for _ in 0..shared.skips.swap(0, Ordering::Relaxed) {
            engine.next_scene();
        }
        let frame = engine.frame();
        *shared.frame.lock().unwrap_or_else(PoisonError::into_inner) = Some(frame);
        next += FRAME;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::scope::SCOPE;

    fn cover() -> Arc<Cover> {
        let image = image::RgbImage::from_fn(64, 64, |x, y| {
            image::Rgb([(x * 4) as u8, (y * 4) as u8, 160])
        });
        Arc::new(Cover::new(&image::DynamicImage::ImageRgb8(image)))
    }

    /// A kick and a chord, as if the TV just played them.
    fn play(start: usize) {
        let rate = 44_100.0;
        SCOPE.set_rate(44_100);
        let frames: Vec<f32> = (start..start + 4096)
            .map(|index| {
                let time = index as f32 / rate;
                let kick = (-(time % 0.5) * 18.0).exp() * (TAU * 55.0 * time).sin();
                let chord: f32 = [220.0, 330.0, 440.0, 1320.0]
                    .iter()
                    .map(|hz| (TAU * hz * time).sin() * 0.15)
                    .sum();
                0.6 * kick + chord
            })
            .collect();
        SCOPE.write(&frames, 1);
    }

    use std::f32::consts::TAU;

    #[test]
    fn every_scene_paints_the_music() {
        for scene in 0..scenes::all().len() {
            let mut engine = Engine::new(scene);
            engine.set_cover(Some(cover()));
            for frame in 0..40 {
                play(frame * 1470);
                engine.paint(1.0 / 30.0);
            }
            assert_eq!(engine.scene, scene);
            let brightness = engine.canvas.brightness();
            assert!(
                brightness > 0.02 && brightness.is_finite(),
                "scene {scene} brightness {brightness}"
            );
        }
    }

    #[test]
    fn the_cover_scene_is_skipped_without_a_cover() {
        let mut engine = Engine::new(0);
        for _ in 0..scenes::all().len() * 2 {
            engine.next_scene();
            assert!(engine.usable(engine.scene));
        }
    }

    /// How long each scene takes to paint a frame:
    /// `cargo test -p music-tv --release -- --ignored --nocapture frame_cost`
    #[test]
    #[ignore]
    fn frame_cost() {
        for scene in 0..scenes::all().len() {
            let mut engine = Engine::new(scene);
            engine.set_cover(Some(cover()));
            let frames = 120;
            let start = Instant::now();
            for frame in 0..frames {
                play(frame * 1470);
                engine.paint(1.0 / 30.0);
            }
            let each = start.elapsed() / frames as u32;
            println!("scene {scene}: {each:?} per frame");
        }
    }
}
