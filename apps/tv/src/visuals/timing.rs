//! How long the GPU spends on each part of a frame, for the pace report:
//! the scenes, the effects (bloom and the picture), and the screen
//! (`present`). What is left of a frame is the UI Skia draws on top, and
//! the system putting it on screen.
//!
//! Timer queries (`GL_EXT_disjoint_timer_query`) count GPU time without
//! stalling: each frame's answers are read a few frames later, when they
//! are ready. A GPU without the extension reports nothing.

use std::collections::HashMap;

use glow::HasContext;

/// Frames of queries in flight before the oldest is read back.
const IN_FLIGHT: usize = 4;
/// `GL_GPU_DISJOINT_EXT`: true when something (a clock change, a context
/// switch) made the last timings meaningless.
const GPU_DISJOINT: u32 = 0x8FBB;

/// The parts of a frame, timed apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Scenes,
    Effects,
    Screen,
}

const PARTS: usize = 3;

struct Frame {
    queries: [glow::Query; PARTS],
    /// Which parts this frame timed, and the scene it drew alone, if any.
    used: [bool; PARTS],
    scene: Option<usize>,
    waiting: bool,
}

pub struct Timer {
    frames: Vec<Frame>,
    next: usize,
    /// This frame's queries, or none while the oldest are still busy.
    current: Option<usize>,
    running: Option<Part>,
    /// Sums in ms and counts since the last report: the effects and the
    /// screen, then the scenes, each drawn alone.
    effects: (f64, u32),
    screen: (f64, u32),
    scenes: HashMap<usize, (f64, u32)>,
}

impl Timer {
    /// A timer, if this GPU can time.
    pub fn new(gl: &glow::Context) -> Option<Self> {
        if !gl
            .supported_extensions()
            .contains("GL_EXT_disjoint_timer_query")
        {
            return None;
        }
        let mut frames = Vec::with_capacity(IN_FLIGHT);
        for _ in 0..IN_FLIGHT {
            let mut queries = Vec::with_capacity(PARTS);
            for _ in 0..PARTS {
                queries.push(unsafe { gl.create_query() }.ok()?);
            }
            frames.push(Frame {
                queries: [queries[0], queries[1], queries[2]],
                used: [false; PARTS],
                scene: None,
                waiting: false,
            });
        }
        Some(Self {
            frames,
            next: 0,
            current: None,
            running: None,
            effects: (0.0, 0),
            screen: (0.0, 0),
            scenes: HashMap::new(),
        })
    }

    /// A new frame starts: read back the oldest one's answers, if ready,
    /// and use its queries for this frame. `scene` is the scene drawn
    /// alone this frame, if one is.
    pub fn frame(&mut self, gl: &glow::Context, scene: Option<usize>) {
        let disjoint = unsafe { gl.get_parameter_i32(GPU_DISJOINT) } != 0;
        let index = self.next;
        let frame = &mut self.frames[index];
        self.current = None;
        if frame.waiting {
            let last = frame
                .used
                .iter()
                .rposition(|used| *used)
                .map_or(frame.queries[0], |part| frame.queries[part]);
            let ready = unsafe { gl.get_query_parameter_u32(last, glow::QUERY_RESULT_AVAILABLE) };
            if ready == 0 {
                // Still busy: skip timing this frame rather than wait.
                return;
            }
            if !disjoint {
                let ms = |query| {
                    f64::from(unsafe { gl.get_query_parameter_u32(query, glow::QUERY_RESULT) })
                        / 1e6
                };
                let [scenes, effects, screen] = frame.queries;
                if frame.used[0]
                    && let Some(scene) = frame.scene
                {
                    let sum = self.scenes.entry(scene).or_default();
                    sum.0 += ms(scenes);
                    sum.1 += 1;
                }
                if frame.used[1] {
                    self.effects.0 += ms(effects);
                    self.effects.1 += 1;
                }
                if frame.used[2] {
                    self.screen.0 += ms(screen);
                    self.screen.1 += 1;
                }
            }
        }
        frame.waiting = false;
        frame.used = [false; PARTS];
        frame.scene = scene;
        self.current = Some(index);
        self.next = (index + 1) % IN_FLIGHT;
    }

    /// Start timing `part` of this frame.
    pub fn begin(&mut self, gl: &glow::Context, part: Part) {
        let Some(index) = self.current else {
            return;
        };
        let frame = &mut self.frames[index];
        if self.running.is_some() || frame.used[part as usize] {
            return;
        }
        unsafe { gl.begin_query(glow::TIME_ELAPSED, frame.queries[part as usize]) };
        frame.used[part as usize] = true;
        self.running = Some(part);
    }

    pub fn end(&mut self, gl: &glow::Context) {
        if self.running.take().is_some()
            && let Some(index) = self.current
        {
            unsafe { gl.end_query(glow::TIME_ELAPSED) };
            self.frames[index].waiting = true;
        }
    }

    /// The averages since the last report, then start over: "GPU ms a
    /// frame: Silk 2.1, Halo 3.4; effects 1.2; screen 2.0".
    pub fn report(&mut self, names: impl Fn(usize) -> &'static str) -> String {
        let average = |(sum, count): (f64, u32)| sum / f64::from(count.max(1));
        let mut scenes: Vec<(usize, (f64, u32))> = self.scenes.drain().collect();
        scenes.sort_by_key(|(scene, _)| *scene);
        let scenes: Vec<String> = scenes
            .into_iter()
            .map(|(scene, sum)| format!("{} {:.1}", names(scene), average(sum)))
            .collect();
        let line = format!(
            "GPU ms a frame: {}; effects {:.1}; screen {:.1}",
            if scenes.is_empty() {
                "no scene alone".to_owned()
            } else {
                scenes.join(", ")
            },
            average(self.effects),
            average(self.screen),
        );
        self.effects = (0.0, 0);
        self.screen = (0.0, 0);
        line
    }

    pub fn delete(self, gl: &glow::Context) {
        for frame in self.frames {
            for query in frame.queries {
                unsafe { gl.delete_query(query) };
            }
        }
    }
}
