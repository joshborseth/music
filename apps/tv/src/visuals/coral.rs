//! CORAL: a reaction-diffusion reef growing in time with the music.
//!
//! Gray-Scott runs on a small grid (`grid`), several steps a frame
//! (`shaders/coral_step.glsl`), its two chemicals kept as float bits in an
//! integer texture (RG32UI): the patterns live in differences of a
//! thousandth, which an 8-bit texture can't hold, and float textures can't
//! be drawn into without an extension. After the steps, one pass turns the
//! reef into an 8-bit picture the GPU can filter (`coral_field.glsl`), and
//! the scene lights it at its own size (`coral.glsl`), one read a pixel.
//!
//! [`Rhythm`] decides, once a frame, how the music grows it: how many
//! steps (busy music grows faster, a stop nearly freezes it), the feed and
//! kill rates (the bass moves them from spots through coral to a maze), a
//! blob seeded where each kick lands, a line drawn by the lead melody, and
//! the drop, which bleaches the reef white, clears it, and seeds it again
//! from the middle. The lab (`apps/tv/visuals-lab/coral.ts`) makes the same
//! moves; keep the two in step.

use glow::HasContext;

use super::gpu::{FULLSCREEN, Gl, Program, Target, begin_pass, bind_texture, fullscreen, set_vec4};
use super::music::Music;
use super::particles::{self, Prepare, STATE_UNIT, STATE2_UNIT, State};

/// The grid's height in texels; its width follows the screen's shape.
const GRID_HEIGHT: i32 = 144;
/// Steps a frame at 60 frames a second, calm to wild, and the most any
/// frame takes.
const CALM_STEPS: f32 = 2.0;
const WILD_STEPS: f32 = 6.0;
const MOST_STEPS: u32 = 6;
/// The kick and drop envelopes jump this much on a new hit, a new drop.
const KICK_RISE: f32 = 0.2;
const DROP_RISE: f32 = 0.3;
/// A drop: seconds the reef shows white before it is cleared, when the
/// clearing ends and the middle is seeded, and how long the white takes to
/// fade, and how much faster it regrows at first.
const BLEACH_FROM: f32 = 0.25;
const BLEACH_TO: f32 = 0.6;
const WHITE_FADE: f32 = 2.5;
const REGROW: f32 = 0.5;
/// How fast the reaction runs against the spreading (`uCoralFeed.z`).
const RATE: f32 = 2.5;

/// The grid for a screen `aspect` times as wide as it is tall.
pub fn grid(aspect: f32) -> (i32, i32) {
    let wide = (GRID_HEIGHT as f32 * aspect.clamp(1.0, 2.5)).round() as i32;
    (wide, GRID_HEIGHT)
}

/// Feed and kill for a pattern from spots (0) through coral (0.5) to a
/// maze (1), on a path that stays where Gray-Scott makes patterns.
pub fn feed_kill(pattern: f32) -> (f32, f32) {
    const SPOTS: (f32, f32) = (0.0367, 0.0649);
    const CORAL: (f32, f32) = (0.052, 0.0635);
    const MAZE: (f32, f32) = (0.029, 0.057);
    let p = pattern.clamp(0.0, 1.0);
    let (from, to, t) = if p < 0.5 {
        (SPOTS, CORAL, p * 2.0)
    } else {
        (CORAL, MAZE, p * 2.0 - 1.0)
    };
    let t = t * t * (3.0 - 2.0 * t);
    (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t)
}

/// What the reef does this frame: its uniforms.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cues {
    /// Steps to run this frame.
    pub steps: u32,
    /// Feed, kill, how fast the reaction runs, and how much to bleach each
    /// step (`uCoralFeed`).
    pub feed: [f32; 4],
    /// A blob to seed in the first step: x, y, radius in texels, how much
    /// (`uCoralBlob`).
    pub blob: [f32; 4],
    /// A line to seed in the first step, in texels (`uCoralLine`).
    pub line: [f32; 4],
    /// The line's strength and radius, a disc to seed in the middle (its
    /// radius), and 1 to start over (`uCoralInk`).
    pub ink: [f32; 4],
    /// The growing edge's glow, how white a drop left the reef, and the
    /// grid's size (`uCoralLook`).
    pub look: [f32; 4],
}

/// How the music grows the reef, frame by frame.
#[derive(Debug, Clone)]
pub struct Rhythm {
    seed: f32,
    grid: (i32, i32),
    last_time: Option<f32>,
    last_kick: f32,
    last_drop: f32,
    /// The bass and the energy, eased over a second or two.
    bass: f32,
    energy: f32,
    kicks: u32,
    dropped: Option<f32>,
    centre_seeded: bool,
    /// Where the melody's line was last frame.
    pen: Option<[f32; 2]>,
    /// Steps owed: a fraction carried to the next frame.
    owed: f32,
    fresh: bool,
}

impl Rhythm {
    pub fn new(seed: f32, grid: (i32, i32)) -> Self {
        Self {
            seed,
            grid,
            last_time: None,
            last_kick: 0.0,
            last_drop: 0.0,
            bass: 0.5,
            energy: 0.4,
            kicks: 0,
            dropped: None,
            centre_seeded: true,
            pen: None,
            owed: 0.0,
            fresh: true,
        }
    }

    pub fn step(&mut self, music: &Music) -> Cues {
        let time = music.time;
        let dt = self
            .last_time
            .map_or(1.0 / 60.0, |last| (time - last).clamp(0.0, 0.1));
        self.last_time = Some(time);
        let (wide, tall) = (self.grid.0 as f32, self.grid.1 as f32);
        let parts = &music.parts;
        let ease = |value: f32, toward: f32, seconds: f32| {
            value + (toward - value) * (1.0 - (-dt / seconds).exp())
        };
        let bass = if music.analyzed {
            parts.bass
        } else {
            music.bands[0]
        };
        self.bass = ease(self.bass, bass, 1.5);
        self.energy = ease(self.energy, music.energy, 1.0);

        // Busy music grows faster; a dead stop nearly freezes it; after a
        // drop, it grows back fast.
        let since = self.dropped.map_or(f32::INFINITY, |at| time - at);
        let regrow = 1.0 + REGROW * (-(since - BLEACH_TO).max(0.0) / 2.0).exp();
        let rate = (CALM_STEPS + (WILD_STEPS - CALM_STEPS) * self.energy)
            * (1.0 - 0.85 * parts.stop)
            * regrow;
        self.owed += rate * dt * 60.0;
        let steps = (self.owed.floor() as u32).min(MOST_STEPS);
        self.owed = (self.owed - steps as f32).min(1.0);

        // The bass picks the pattern.
        let (feed, kill) = feed_kill(0.15 + 0.8 * self.bass);

        // A blob where each kick lands: round a spiral, so the reef fills.
        let rise = music.kick - self.last_kick;
        self.last_kick = music.kick;
        let mut blob = [0.0; 4];
        if rise > KICK_RISE {
            let n = self.kicks as f32;
            self.kicks = self.kicks.wrapping_add(1);
            let angle = n * 2.399_963 + self.seed * std::f32::consts::TAU;
            let reach = (0.12 + 0.3 * (n * 0.618_034).fract()) * tall;
            blob = [
                wide * 0.5 + angle.cos() * reach * 1.6,
                tall * 0.5 + angle.sin() * reach,
                2.5 + 3.0 * rise,
                1.0,
            ];
        }

        // The lead melody draws a line, left to right, as high as it sings.
        let pen = [
            ((time * 0.035 + self.seed).fract()) * wide,
            (0.2 + 0.6 * parts.melody) * tall,
        ];
        let from = match self.pen {
            Some(last) if (last[0] - pen[0]).abs() < wide * 0.5 => last,
            _ => pen,
        };
        self.pen = Some(pen);
        let drawing = smoothstep(0.25, 0.6, parts.lead);

        // A drop: white, then cleared, then seeded in the middle.
        if music.drop - self.last_drop > DROP_RISE {
            self.dropped = Some(time);
            self.centre_seeded = false;
        }
        self.last_drop = music.drop;
        let since = self.dropped.map_or(f32::INFINITY, |at| time - at);
        let bleach = if (BLEACH_FROM..BLEACH_TO).contains(&since) {
            0.2
        } else {
            0.0
        };
        let mut centre = 0.0;
        if since >= BLEACH_TO && !self.centre_seeded {
            self.centre_seeded = true;
            centre = 7.0;
        }
        let white = if since < BLEACH_TO {
            smoothstep(0.0, BLEACH_FROM, since)
        } else {
            (-(since - BLEACH_TO) / WHITE_FADE).exp()
        };

        let reset = if self.fresh { 1.0 } else { 0.0 };
        self.fresh = false;
        Cues {
            // Starting over takes a step of its own.
            steps: steps.max(reset as u32),
            feed: [feed, kill, RATE, bleach],
            blob,
            line: [from[0], from[1], pen[0], pen[1]],
            ink: [drawing, 1.3, centre, reset],
            look: [
                0.5 + 1.6 * music.kick * (0.4 + 0.6 * music.energy) + 0.6 * music.drop,
                white,
                wide,
                tall,
            ],
        }
    }
}

fn smoothstep(from: f32, to: f32, x: f32) -> f32 {
    let t = ((x - from) / (to - from)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The scene: the reef's state, its picture, and its programs.
pub struct Coral {
    states: [State; 2],
    field: Target,
    step: Program,
    picture: Program,
    rhythm: Rhythm,
    seed: Option<f32>,
    look: [f32; 4],
}

impl Coral {
    /// # Safety
    /// Needs the GL context current, with its state saved (`Saved`).
    pub unsafe fn new(
        gl: &Gl,
        compile: &mut dyn FnMut(&str, &str, &str) -> Option<Program>,
        fragment: &dyn Fn(&str) -> String,
    ) -> Option<Self> {
        unsafe {
            let vertex = format!("#version 300 es\n{FULLSCREEN}");
            let step = compile(
                "coral_step.glsl",
                &vertex,
                &particles::formation_source(include_str!("shaders/coral_step.glsl")),
            )?;
            let picture = compile(
                "coral_field.glsl",
                &vertex,
                &fragment(include_str!("shaders/coral_field.glsl")),
            );
            let (wide, tall) = grid(16.0 / 9.0);
            let made = (
                picture,
                State::new(gl, wide, tall, glow::RG32UI),
                State::new(gl, wide, tall, glow::RG32UI),
                super::gpu::target(gl, wide, tall),
            );
            let (Some(picture), Some(a), Some(b), Some(field)) = made else {
                let (picture, a, b, field) = made;
                gl.delete_program(step.program);
                if let Some(picture) = picture {
                    gl.delete_program(picture.program);
                }
                for state in [a, b].into_iter().flatten() {
                    state.delete(gl);
                }
                if let Some(field) = field {
                    gl.delete_framebuffer(field.framebuffer);
                    gl.delete_texture(field.texture);
                }
                return None;
            };
            Some(Self {
                states: [a, b],
                field,
                step,
                picture,
                rhythm: Rhythm::new(0.0, (wide, tall)),
                seed: None,
                look: [0.0; 4],
            })
        }
    }

    /// Before the scene's own pass: this frame's steps, then the picture.
    ///
    /// # Safety
    /// Needs the GL context current, inside the renderer's saved state.
    pub unsafe fn before(&mut self, gl: &Gl, music: &Music, seed: f32, prepare: &Prepare<'_>) {
        unsafe {
            let grid = (self.states[0].width, self.states[0].height);
            if self.seed != Some(seed) {
                self.seed = Some(seed);
                self.rhythm = Rhythm::new(seed, grid);
            }
            let cues = self.rhythm.step(music);
            self.look = cues.look;
            let program = &self.step;
            gl.use_program(Some(program.program));
            // The music and the inputs stay set on the program through
            // every step; only what is seeded changes.
            prepare(program);
            set_vec4(gl, program, "uCoralFeed", cues.feed);
            for step in 0..cues.steps {
                let [now, next] = &self.states;
                next.begin(gl);
                bind_texture(gl, program, "uState", STATE_UNIT, now.texture);
                if step < 2 {
                    // The seeds go in once; after the first step, nothing.
                    let first = step == 0;
                    let pick = |values: [f32; 4]| if first { values } else { [0.0; 4] };
                    set_vec4(gl, program, "uCoralBlob", pick(cues.blob));
                    set_vec4(gl, program, "uCoralLine", pick(cues.line));
                    set_vec4(gl, program, "uCoralInk", pick(cues.ink));
                }
                fullscreen(gl);
                self.states.swap(0, 1);
            }

            let program = &self.picture;
            begin_pass(gl, &self.field);
            gl.use_program(Some(program.program));
            bind_texture(gl, program, "uState", STATE_UNIT, self.states[0].texture);
            fullscreen(gl);
        }
    }

    /// The scene's own pass: the reef's picture and its look.
    ///
    /// # Safety
    /// Needs the GL context current, with `program` in use.
    pub unsafe fn bind(&self, gl: &Gl, program: &Program) {
        unsafe {
            bind_texture(gl, program, "uState2", STATE2_UNIT, self.field.texture);
            set_vec4(gl, program, "uCoralLook", self.look);
        }
    }

    pub fn delete(self, gl: &Gl) {
        unsafe {
            gl.delete_program(self.step.program);
            gl.delete_program(self.picture.program);
            gl.delete_framebuffer(self.field.framebuffer);
            gl.delete_texture(self.field.texture);
        }
        for state in self.states {
            state.delete(gl);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::music::Parts;
    use super::*;

    fn music(time: f32) -> Music {
        Music {
            time,
            dt: 1.0 / 60.0,
            drive: 0.0,
            beats: time * 2.0,
            bar: 0.0,
            beat_pulse: 0.0,
            bar_pulse: 0.0,
            kick: 0.0,
            accent: 0.0,
            bands: [0.0; 4],
            levels: [0.0; 8],
            energy: 0.5,
            tension: 0.0,
            drop: 0.0,
            intensity: 0.5,
            ceiling: 1.0,
            beat_seconds: 0.5,
            on_beat: false,
            on_downbeat: false,
            drop_landed: false,
            surge: false,
            section: None,
            live: true,
            analyzed: true,
            parts: Parts::default(),
        }
    }

    #[test]
    fn the_grid_follows_the_screen() {
        assert_eq!(grid(16.0 / 9.0), (256, 144));
        assert_eq!(grid(4.0 / 3.0), (192, 144));
        // A tall or odd screen still gets a sane grid.
        assert_eq!(grid(0.5), (144, 144));
        assert_eq!(grid(10.0).0, 360);
    }

    #[test]
    fn every_bass_makes_a_pattern() {
        // Along the whole path, feed and kill stay in Gray-Scott's band of
        // patterns (between its dead and its uniform regions).
        for i in 0..=20 {
            let (feed, kill) = feed_kill(i as f32 / 20.0);
            assert!((0.025..=0.056).contains(&feed), "{i}: {feed}");
            assert!((0.055..=0.066).contains(&kill), "{i}: {kill}");
        }
        assert_eq!(feed_kill(0.5), (0.052, 0.0635));
    }

    #[test]
    fn it_starts_over_once_then_grows_with_the_energy() {
        let mut rhythm = Rhythm::new(0.4, grid(16.0 / 9.0));
        let first = rhythm.step(&music(0.0));
        assert_eq!(first.ink[3], 1.0);
        assert!(first.steps >= 1);
        let mut calm = 0;
        for frame in 1..121 {
            let cues = rhythm.step(&music(frame as f32 / 60.0));
            assert_eq!(cues.ink[3], 0.0);
            calm += cues.steps;
        }
        let mut wild = 0;
        for frame in 121..241 {
            let mut busy = music(frame as f32 / 60.0);
            busy.energy = 1.0;
            wild += rhythm.step(&busy).steps;
        }
        assert!(wild as f32 > calm as f32 * 1.3, "{wild} vs {calm}");
        // At 30 frames a second it takes more steps a frame, but never more
        // than the limit, which keeps a frame's cost at a wild one's.
        let mut half = Rhythm::new(0.4, grid(16.0 / 9.0));
        let _ = half.step(&music(0.0));
        let steps: Vec<u32> = (1..61)
            .map(|frame| half.step(&music(frame as f32 / 30.0)).steps)
            .collect();
        let total: u32 = steps.iter().sum();
        assert!(total > calm * 7 / 10, "{total} vs {calm}");
        assert!(steps.iter().all(|&steps| steps <= MOST_STEPS));
    }

    #[test]
    fn kicks_seed_round_a_spiral_inside_the_reef() {
        let (wide, tall) = grid(16.0 / 9.0);
        let mut rhythm = Rhythm::new(0.9, (wide, tall));
        let mut seeds = Vec::new();
        for frame in 0..480 {
            let time = frame as f32 / 60.0;
            let mut beat = music(time);
            beat.kick = (-(time * 2.0).fract() * 0.5 * 12.0).exp();
            let cues = rhythm.step(&beat);
            if cues.blob[3] > 0.0 {
                seeds.push(cues.blob);
            }
        }
        // A kick on each beat.
        assert_eq!(seeds.len(), 16);
        for seed in &seeds {
            assert!((0.0..wide as f32).contains(&seed[0]), "{seed:?}");
            assert!((0.0..tall as f32).contains(&seed[1]), "{seed:?}");
        }
        // Each lands somewhere new.
        assert!(seeds.windows(2).all(|pair| pair[0][..2] != pair[1][..2]));
    }

    #[test]
    fn a_drop_bleaches_then_regrows_from_the_middle() {
        let mut rhythm = Rhythm::new(0.1, grid(16.0 / 9.0));
        let mut frames = Vec::new();
        for frame in 0..300 {
            let time = frame as f32 / 60.0;
            let mut beat = music(time);
            beat.drop = if time >= 1.0 {
                (-(time - 1.0)).exp()
            } else {
                0.0
            };
            frames.push((time, rhythm.step(&beat)));
        }
        let white_at = |t: f32| frames.iter().find(|(time, _)| *time >= t).unwrap().1;
        assert!(white_at(0.9).look[1] < 0.01);
        assert!(white_at(1.25).look[1] > 0.99, "white before it clears");
        assert_eq!(white_at(1.1).feed[3], 0.0);
        assert!(white_at(1.4).feed[3] > 0.0, "cleared");
        let seeded: Vec<f32> = frames
            .iter()
            .filter(|(_, cues)| cues.ink[2] > 0.0)
            .map(|(time, _)| *time)
            .collect();
        assert_eq!(seeded.len(), 1, "seeded once");
        assert!((seeded[0] - 1.6).abs() < 0.02, "{seeded:?}");
        assert!(white_at(4.9).look[1] < 0.35, "the white fades");
    }
}
