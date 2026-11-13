//! The now-playing screen's visuals: scenes drawn on the GPU that move with
//! the song, in the cover's color.
//!
//! - `music.rs` hears the TV's output and follows the server's analysis of
//!   the song (beats, bars, sections, drops).
//! - `director.rs` picks the scene for each part of the song.
//! - `gpu.rs` draws it with OpenGL ES, under the app's UI, every frame the
//!   screen shows. The scenes themselves are shaders in `shaders/`, which
//!   also run in the browser lab (`apps/tv/visuals-lab`). `motion.rs` works
//!   out once a frame what they would otherwise work out at every pixel,
//!   and `sizing.rs` picks each scene's size so frames come on time.
//!
//! Everything here runs on the UI thread, inside Slint's rendering
//! notifier. While the visuals show, each frame asks for the next.

mod director;
mod gpu;
mod look;
mod motion;
mod music;
mod sizing;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use slint::{ComponentHandle, GraphicsAPI, RenderingState};

pub use look::Cover;

use crate::App;
use crate::catalog::Analysis;
use crate::view::PlayClock;
use director::{Director, Shot};
use gpu::{Renderer, Shade};
use music::{Listener, Song};

/// Seconds the visuals take to fade in.
const FADE_IN: f32 = 1.2;
/// Seconds the shade takes to move when the lyrics come or go, as the UI's
/// layers did (`animate opacity { duration: 700ms; }`).
const SHADE_MOVE: f32 = 0.7;
/// How often to tell the server how smoothly frames come.
const PACE_REPORT_EVERY: Duration = Duration::from_secs(300);
/// The first report comes this soon, once the scenes have settled on a size.
const FIRST_PACE_REPORT: Duration = Duration::from_secs(20);

/// What the now-playing screen shows, for the visuals.
#[derive(Clone)]
pub struct Stage {
    pub entry_id: String,
    pub cover: Option<Arc<Cover>>,
    pub analysis: Option<Arc<Analysis>>,
    pub playing: bool,
    /// The lyrics show on the right, beside the song.
    pub side: bool,
}

/// A frame read back from the screen: RGBA, top row first.
pub struct Screenshot {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

type Capture = Box<dyn FnOnce(Screenshot)>;

struct State {
    stage: Option<Stage>,
    clock: PlayClock,
    listener: Listener,
    director: Director,
    gl: Option<glow::Context>,
    renderer: Option<Renderer>,
    /// Set when the GPU path could not start: the screen keeps its backdrop.
    failed: bool,
    report: Box<dyn Fn(String)>,
    last_frame: Option<Instant>,
    fade: f32,
    song: Option<String>,
    capture: Option<Capture>,
    shade: Shade,
    pace: Pace,
    shown_scene: Option<usize>,
}

/// How smoothly frames come, between two reports to the server.
#[derive(Default)]
struct Pace {
    since: Option<Instant>,
    frames: u32,
    /// Frames that took longer than a frame and a half at 60 Hz: a stutter.
    late: u32,
    worst: f32,
    reports: u32,
}

impl Pace {
    /// Count a frame that took `dt` seconds. Returns a line for the server
    /// when one is due.
    fn frame(
        &mut self,
        dt: f32,
        size: (u32, u32),
        sizes: impl FnOnce() -> String,
    ) -> Option<String> {
        let now = Instant::now();
        let since = *self.since.get_or_insert(now);
        self.frames += 1;
        if dt > sizing::LATE {
            self.late += 1;
        }
        self.worst = self.worst.max(dt);
        let due = if self.reports == 0 {
            FIRST_PACE_REPORT
        } else {
            PACE_REPORT_EVERY
        };
        let elapsed = now - since;
        if elapsed < due {
            return None;
        }
        let line = format!(
            "visuals: {}×{} screen, {:.1} fps, {:.1}% of frames late, worst {:.0} ms; scenes at {}",
            size.0,
            size.1,
            f64::from(self.frames) / elapsed.as_secs_f64(),
            f64::from(self.late) * 100.0 / f64::from(self.frames.max(1)),
            self.worst * 1000.0,
            sizes(),
        );
        *self = Self {
            reports: self.reports + 1,
            since: Some(now),
            ..Self::default()
        };
        Some(line)
    }

    /// The visuals stopped: the next frames start a fresh count.
    fn pause(&mut self) {
        *self = Self {
            reports: self.reports,
            ..Self::default()
        };
    }
}

/// The running visuals. Cheap to clone.
#[derive(Clone)]
pub struct Visuals {
    state: Rc<RefCell<State>>,
}

impl Visuals {
    /// Hook into `app`'s rendering. `report` sends a line to the server's
    /// log: the GPU found, shader errors, how fast frames come.
    pub fn install(app: &App, clock: PlayClock, report: impl Fn(String) + 'static) -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(1, |elapsed| {
                elapsed.subsec_nanos() ^ elapsed.as_secs() as u32
            });
        let state = Rc::new(RefCell::new(State {
            stage: None,
            clock,
            listener: Listener::new(),
            director: Director::new(seed),
            gl: None,
            renderer: None,
            failed: false,
            report: Box::new(report),
            last_frame: None,
            fade: 0.0,
            song: None,
            capture: None,
            shade: Shade::default(),
            pace: Pace::default(),
            shown_scene: None,
        }));
        let notified = state.clone();
        let window = app.as_weak();
        let hooked = app.window().set_rendering_notifier(move |rendering, api| {
            let Ok(mut state) = notified.try_borrow_mut() else {
                return;
            };
            match rendering {
                RenderingState::RenderingSetup => state.set_up(api),
                RenderingState::BeforeRendering => {
                    let size = window.upgrade().map(|app| app.window().size());
                    if let Some(size) = size
                        && state.draw((size.width, size.height))
                        && let Some(app) = window.upgrade()
                    {
                        app.window().request_redraw();
                    }
                }
                RenderingState::AfterRendering => {
                    if let (Some(capture), Some(gl), Some(app)) =
                        (state.capture.take(), state.gl.as_ref(), window.upgrade())
                    {
                        let size = app.window().size();
                        capture(Screenshot {
                            width: size.width,
                            height: size.height,
                            rgba: Renderer::read_screen(gl, (size.width, size.height)),
                        });
                    }
                }
                RenderingState::RenderingTeardown => state.tear_down(),
                _ => {}
            }
        });
        if let Err(error) = hooked {
            log::warn!("visuals: no GPU hook ({error:?}); showing the backdrop");
            state.borrow_mut().failed = true;
        }
        Self { state }
    }

    /// Show the visuals for `stage`, or stop them (`None`).
    pub fn set_stage(&self, app: &App, stage: Option<Stage>) {
        let Ok(mut state) = self.state.try_borrow_mut() else {
            return;
        };
        let starting = state.stage.is_none() && stage.is_some();
        if stage.is_none() {
            state.fade = 0.0;
            state.last_frame = None;
            state.pace.pause();
        }
        state.stage = stage;
        if starting {
            app.window().request_redraw();
        }
    }

    /// True when the GPU draws the screen's background, so the UI must
    /// leave it clear.
    pub fn drawing(&self) -> bool {
        // Before the first frame sets the GPU up, assume it will work.
        self.state.try_borrow().is_ok_and(|state| {
            !state.failed
                && state.stage.is_some()
                && (state.renderer.is_some() || state.gl.is_none())
        })
    }

    /// Read the next frame from the screen, with the UI on it.
    pub fn capture(&self, app: &App, done: impl FnOnce(Screenshot) + 'static) {
        if let Ok(mut state) = self.state.try_borrow_mut() {
            state.capture = Some(Box::new(done));
        }
        app.window().request_redraw();
    }

    /// Move on to the next scene now: for screenshots.
    #[cfg(feature = "screenshots")]
    pub fn skip(&self) {
        if let Ok(mut state) = self.state.try_borrow_mut() {
            state.director.skip();
        }
    }
}

impl State {
    fn set_up(&mut self, api: &GraphicsAPI<'_>) {
        // A new context (the app came back): nothing from the old one is
        // valid. Drop it without GL calls, since its names could now belong
        // to Skia's objects in the new context.
        self.renderer = None;
        self.gl = None;
        self.failed = false;
        let GraphicsAPI::NativeOpenGL { get_proc_address } = api else {
            self.failed = true;
            (self.report)("visuals: the UI is not drawn with OpenGL; no visuals".to_owned());
            return;
        };
        let gl = unsafe { glow::Context::from_loader_function_cstr(|name| get_proc_address(name)) };
        match Renderer::new(&gl) {
            Ok((renderer, report)) => {
                let mut line = format!("visuals: GPU {} ({})", report.renderer, report.version);
                if !report.errors.is_empty() {
                    line.push_str(&format!("; scenes left out: {}", report.errors.join(" | ")));
                }
                log::info!("{line}");
                (self.report)(line);
                self.renderer = Some(renderer);
            }
            Err(report) => {
                let line = format!(
                    "visuals: could not start on {} ({}): {}",
                    report.renderer,
                    report.version,
                    report.errors.join(" | ")
                );
                log::error!("{line}");
                (self.report)(line);
                self.failed = true;
            }
        }
        self.gl = Some(gl);
    }

    fn tear_down(&mut self) {
        if let (Some(renderer), Some(gl)) = (self.renderer.take(), self.gl.as_ref()) {
            renderer.delete(gl);
        }
        self.gl = None;
    }

    /// Draw a frame if the visuals show. True when another frame is wanted.
    fn draw(&mut self, size: (u32, u32)) -> bool {
        if self.failed {
            return false;
        }
        let Some(stage) = self.stage.clone() else {
            return false;
        };
        let (Some(gl), Some(renderer)) = (self.gl.as_ref(), self.renderer.as_mut()) else {
            return false;
        };
        let now = Instant::now();
        // How long the last frame really took; `None` on the first.
        let took = self.last_frame.map(|last| (now - last).as_secs_f32());
        let dt = took.unwrap_or(1.0 / 60.0).clamp(0.001, 0.1);
        self.last_frame = Some(now);
        self.fade = (self.fade + dt / FADE_IN).min(1.0);
        if took.is_some() {
            renderer.pace(dt);
        }

        if self.song.as_deref() != Some(stage.entry_id.as_str()) {
            self.song = Some(stage.entry_id.clone());
            self.listener.new_song();
        }
        renderer.set_cover(gl, stage.cover.as_ref());
        // The clock already counts what is heard.
        let seconds = self
            .clock
            .seconds()
            .filter(|(entry, _)| *entry == stage.entry_id)
            .map(|(_, seconds)| seconds);
        let step = dt / SHADE_MOVE;
        let toward = |value: f32, on: bool| {
            if on {
                (value + step).min(1.0)
            } else {
                (value - step).max(0.0)
            }
        };
        self.shade = Shade {
            side: toward(self.shade.side, stage.side),
            centre: toward(self.shade.centre, !stage.side),
        };
        let song = stage
            .analysis
            .as_deref()
            .zip(seconds)
            .map(|(analysis, seconds)| Song {
                analysis,
                seconds,
                playing: stage.playing,
            });
        let music = self.listener.hear(dt, song);
        let has_cover = renderer.has_cover();
        let mut shot: Shot = self
            .director
            .direct(&music, Some(stage.entry_id.as_str()), has_cover);
        // A scene whose shader did not compile on this GPU shows the one before.
        if !renderer.can_draw(shot.current.scene) {
            shot.current.scene = (0..8).find(|scene| renderer.can_draw(*scene)).unwrap_or(0);
        }
        if shot.next.is_some_and(|(next, _)| {
            !renderer.can_draw(next.scene) || next.scene == shot.current.scene
        }) {
            shot.next = None;
        }
        let latest = shot.next.map_or(shot.current.scene, |(next, _)| next.scene);
        if self.shown_scene != Some(latest) {
            self.shown_scene = Some(latest);
            log::info!(
                "visuals: {} ({:?})",
                director::SCENES[latest].name,
                music.section.map(|section| section.kind)
            );
        }
        renderer.release_unused(&shot);
        renderer.draw(
            gl,
            &music,
            &mut self.listener,
            &shot,
            self.fade,
            self.shade,
            size,
        );

        if let Some(took) = took
            && let Some(line) = self.pace.frame(took, size, || renderer.sizes())
        {
            log::info!("{line}");
            (self.report)(line);
        }
        true
    }
}
