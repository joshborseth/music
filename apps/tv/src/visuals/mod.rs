//! The now-playing screen's visuals: full-screen scenes that move with the
//! music this TV plays, painted in the cover's colors.
//!
//! A thread of its own paints each frame in software on a small canvas
//! (`canvas.rs`), which the screen stretches over the TV. The UI thread only
//! picks up the newest frame, so the remote stays quick while it runs. It
//! runs while the now-playing screen shows.
//!
//! The music picks the scenes. Calm songs get the slow, liquid ones and loud
//! songs with a strong kick get the fast ones; a new scene takes over when
//! the music surges (a drop, a chorus) or the song changes. While nothing
//! plays on this TV (paused, or playing on a phone), a slow made-up pulse
//! keeps the calm scenes drifting in the cover's colors.

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
/// A scene shows at least this long, unless the song changes.
const SCENE_MIN: f32 = 14.0;
/// After this long, the next kick brings on another scene.
const SCENE_LONG: f32 = 40.0;
/// After this long, another scene takes over, kick or not.
const SCENE_MAX: f32 = 55.0;
/// A new song brings a new scene once the old one has shown this long.
const SCENE_SONG_MIN: f32 = 5.0;
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
    /// How intense the music has been lately, 0 calm to 1 wild.
    pub intensity: f32,
    /// True on the frame the music surges: a drop or a chorus coming in.
    pub surge: bool,
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
    /// How loud the last second was, and the last ten.
    recent: f32,
    lately: f32,
    /// Kicks per second, over the last ten seconds or so.
    kick_rate: f32,
    since_surge: f32,
    /// 1 while no music plays here, so the made-up pulse takes over.
    calm: f32,
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
            recent: 0.0,
            lately: 0.0,
            kick_rate: 0.0,
            since_surge: 0.0,
            calm: 1.0,
        }
    }

    fn hear(&mut self, time: f32, dt: f32) -> Audio {
        let mut bands = *self.analyzer.frame();
        let live = self.analyzer.is_moving();
        // Ease into the made-up pulse over two seconds; leave it at once.
        self.calm = if live {
            0.0
        } else {
            (self.calm + dt * 0.5).min(1.0)
        };
        if self.calm > 0.0 {
            for (index, band) in bands.iter_mut().enumerate() {
                *band += self.calm * calm_band(index, time);
            }
        }
        let average = |range: std::ops::Range<usize>| {
            let length = range.len() as f32;
            bands[range].iter().sum::<f32>() / length
        };
        let bass = average(0..10);
        let mid = average(10..30);
        let treble = average(30..BARS);
        let level = bass * 0.45 + mid * 0.35 + treble * 0.2;

        self.since_kick += dt;
        let kick = if live {
            bass > self.bass_average + 0.07
                && bass - self.last_bass > 0.03
                && self.since_kick > 0.22
        } else {
            // A slow heartbeat while nothing plays.
            self.calm > 0.5 && self.since_kick > CALM_BEAT
        };
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
        for (index, (out, sample)) in wave.iter_mut().zip(newest).enumerate() {
            let calm = self.calm * calm_wave(index, time);
            *out = (sample * gain * (1.0 - self.calm) + calm).clamp(-1.2, 1.2);
        }

        // The music's mood, and the moment it surges.
        self.recent += (level - self.recent) * (dt * 1.5).min(1.0);
        self.lately += (level - self.lately) * (dt * 0.1).min(1.0);
        let kicked = if kick && live { 1.0 / dt } else { 0.0 };
        self.kick_rate += (kicked - self.kick_rate) * (dt * 0.1).min(1.0);
        self.since_surge += dt;
        let surge = live
            && self.since_surge > 6.0
            && self.recent > 0.28
            && self.recent > self.lately * 1.45 + 0.04;
        if surge {
            self.since_surge = 0.0;
        }
        let intensity = if live {
            (self.lately * 1.7 + self.kick_rate * 0.22 - 0.15).clamp(0.0, 1.0)
        } else {
            0.0
        };

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
            intensity,
            surge,
        }
    }
}

/// Seconds between the made-up beats while nothing plays.
const CALM_BEAT: f32 = 2.6;

/// A soft, slowly rolling spectrum for while nothing plays.
fn calm_band(band: usize, time: f32) -> f32 {
    let along = band as f32 / BARS as f32;
    let swell = 0.5 + 0.5 * (time * 0.35 + along * 5.0).sin();
    (0.06 + 0.12 * swell) * (1.0 - along * 0.6)
}

/// A slow, gently folding wave for while nothing plays.
fn calm_wave(index: usize, time: f32) -> f32 {
    let along = index as f32 / WAVE as f32 * std::f32::consts::TAU;
    0.35 * (along + time * 0.8).sin() + 0.15 * (along * 3.0 - time * 1.3).sin()
}

/// Paints frames: the scenes, the canvas they share, and the music.
pub struct Engine {
    listener: Listener,
    canvas: canvas::Canvas,
    look: Look,
    scenes: Vec<Box<dyn Scene>>,
    scene: usize,
    scene_time: f32,
    /// The scenes shown before this one, newest last.
    shown: Vec<usize>,
    /// The cover changed: a new song deserves a new scene.
    new_song: bool,
    /// Breaks ties between scenes that suit the music equally.
    seed: u32,
    started: Instant,
    last: Instant,
}

impl Engine {
    pub fn new(seed: u32) -> Self {
        let scenes = scenes::all();
        let now = Instant::now();
        let mut engine = Self {
            listener: Listener::new(),
            canvas: canvas::Canvas::new(),
            look: Look::new(None),
            scene: 0,
            scenes,
            scene_time: 0.0,
            shown: Vec::new(),
            new_song: false,
            seed: seed | 1,
            started: now,
            last: now,
        };
        // Start calm: nothing has played yet.
        engine.scene = engine.pick(0.0);
        engine
    }

    fn set_cover(&mut self, cover: Option<Arc<Cover>>) {
        let same = match (&self.look.cover, &cover) {
            (Some(old), Some(new)) => Arc::ptr_eq(old, new),
            (None, None) => true,
            _ => false,
        };
        if !same {
            self.new_song |= self.look.cover.is_some() && cover.is_some();
            self.look = Look::new(cover);
        }
    }

    /// The scene that suits music this intense best, leaving out the one
    /// showing and the two before it.
    fn pick(&mut self, intensity: f32) -> usize {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 17;
        self.seed ^= self.seed << 5;
        let recent: Vec<usize> = self.shown.iter().rev().take(2).copied().collect();
        let fit = |scene: usize| {
            let jitter = ((self.seed.wrapping_mul(scene as u32 + 7) >> 8) % 1000) as f32 / 4000.0;
            (self.scenes[scene].intensity() - intensity).abs() + jitter
        };
        let choose = |avoid: &dyn Fn(usize) -> bool| {
            (0..self.scenes.len())
                .filter(|scene| self.usable(*scene) && !avoid(*scene))
                .min_by(|a, b| fit(*a).total_cmp(&fit(*b)))
        };
        choose(&|scene| scene == self.scene || recent.contains(&scene))
            .or_else(|| choose(&|scene| scene == self.scene))
            .unwrap_or(self.scene)
    }

    fn next_scene(&mut self, intensity: f32) {
        let next = self.pick(intensity);
        if next != self.scene {
            self.shown.push(self.scene);
            if self.shown.len() > 8 {
                self.shown.remove(0);
            }
        }
        self.scene = next;
        self.scene_time = 0.0;
        self.new_song = false;
    }

    fn usable(&self, scene: usize) -> bool {
        !self.scenes[scene].needs_cover() || self.look.cover.is_some()
    }

    /// Whether the music calls for another scene now.
    fn time_for_a_change(&self, audio: &Audio) -> bool {
        let time = self.scene_time;
        !self.usable(self.scene)
            || (self.new_song && time >= SCENE_SONG_MIN)
            || (audio.surge && time >= SCENE_MIN)
            || (audio.kick && time >= SCENE_LONG)
            || time >= SCENE_MAX
    }

    /// The next scene in order, whatever the music: for screenshots.
    fn skip(&mut self) {
        self.shown.push(self.scene);
        for _ in 0..self.scenes.len() {
            self.scene = (self.scene + 1) % self.scenes.len();
            if self.usable(self.scene) {
                break;
            }
        }
        self.scene_time = 0.0;
    }

    /// Paint the next frame, `dt` seconds after the last.
    fn paint(&mut self, dt: f32) -> SharedPixelBuffer<Rgba8Pixel> {
        let time = self.started.elapsed().as_secs_f32();
        let audio = self.listener.hear(time, dt);
        self.scene_time += dt;
        if self.time_for_a_change(&audio) {
            self.next_scene(audio.intensity);
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
        // Different choices each time the visuals start.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(1, |elapsed| {
                elapsed.subsec_nanos() ^ elapsed.as_secs() as u32
            });
        let spawned = std::thread::Builder::new()
            .name("visuals".into())
            .spawn(move || paint_until_stopped(&painter, seed));
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

fn paint_until_stopped(shared: &Shared, seed: u32) {
    let mut engine = Engine::new(seed);
    let mut next = Instant::now();
    while shared.running.load(Ordering::Relaxed) {
        let cover = shared
            .cover
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        engine.set_cover(cover);
        for _ in 0..shared.skips.swap(0, Ordering::Relaxed) {
            engine.skip();
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
            let mut engine = Engine::new(1);
            engine.set_cover(Some(cover()));
            engine.scene = scene;
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
    fn the_cover_scenes_are_skipped_without_a_cover() {
        let mut engine = Engine::new(1);
        for step in 0..scenes::all().len() * 2 {
            engine.next_scene(step as f32 / 20.0);
            assert!(engine.usable(engine.scene));
        }
    }

    #[test]
    fn the_music_picks_the_scene() {
        let mut engine = Engine::new(1);
        engine.set_cover(Some(cover()));
        let calm = engine.pick(0.0);
        let wild = engine.pick(1.0);
        assert!(engine.scenes[calm].intensity() <= 0.3, "calm got {calm}");
        assert!(engine.scenes[wild].intensity() >= 0.7, "wild got {wild}");
    }

    #[test]
    fn scenes_take_turns_without_repeating_soon() {
        let mut engine = Engine::new(1);
        engine.set_cover(Some(cover()));
        let mut seen = vec![engine.scene];
        for _ in 0..3 {
            engine.next_scene(0.5);
            assert!(
                !seen.contains(&engine.scene),
                "{seen:?} then {}",
                engine.scene
            );
            seen.push(engine.scene);
        }
    }

    #[test]
    fn a_new_song_brings_a_new_scene() {
        let mut engine = Engine::new(1);
        engine.set_cover(Some(cover()));
        let first = engine.scene;
        engine.set_cover(Some(cover()));
        for frame in 0..((SCENE_SONG_MIN + 1.0) * 30.0) as usize {
            play(frame * 1470);
            engine.paint(1.0 / 30.0);
        }
        assert_ne!(engine.scene, first);
    }

    #[test]
    fn silence_still_moves() {
        let mut engine = Engine::new(1);
        engine.set_cover(Some(cover()));
        SCOPE.write(&[0.0; 4096], 1);
        for _ in 0..90 {
            engine.paint(1.0 / 30.0);
        }
        assert!(engine.canvas.brightness() > 0.01);
    }

    /// How long each scene takes to paint a frame:
    /// `cargo test -p music-tv --release -- --ignored --nocapture frame_cost`
    #[test]
    #[ignore]
    fn frame_cost() {
        for scene in 0..scenes::all().len() {
            let mut engine = Engine::new(1);
            engine.set_cover(Some(cover()));
            engine.scene = scene;
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
