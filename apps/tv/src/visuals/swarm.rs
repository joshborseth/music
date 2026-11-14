//! SWARM: the particle engine (`particles.rs`) as a scene. Its shapes are
//! `shaders/swarm_targets.glsl`; what is under the particles (their trails
//! and a haze) is `shaders/swarm.glsl`.
//!
//! [`Choreography`] decides, once a frame, what the swarm does: which
//! shape it holds and which comes next, how far along the change is, the
//! blast of each kick, the swirl of each snare, the stream behind the
//! lead melody, and the drop, which blows the shape apart until the next
//! downbeat, when the particles snap into the next one. It works only from
//! the music's values (the beat count, the kick and drop envelopes), so
//! the lab (`apps/tv/visuals-lab/particles.ts`, `choreography`) makes the
//! same moves from the same frames; keep the two in step.

use super::gpu::{Gl, Program, Target, set_f32};
use super::music::Music;
use super::particles::{self, Forces, Particles, Prepare};

/// The shapes, in `swarm_targets.glsl`'s numbering: the cover (where the
/// swarm starts), a galaxy, rings, and a grid.
const COVER: u32 = 0;
const SHAPES: u32 = 4;

/// Bars a shape holds before the next phrase brings another.
const PHRASE_BARS: i64 = 8;
/// Seconds a change of shape takes to sweep through the swarm, and the
/// snap back after a drop.
const MORPH_SECONDS: f32 = 1.6;
const SNAP_SECONDS: f32 = 0.2;
/// Without a beat to count, seconds a shape holds.
const NO_BEAT_SECONDS: f32 = 20.0;
/// Seconds without a new bar after which there is no beat to count.
const NO_BEAT_BARS_SECONDS: f32 = 4.0;
/// The kick envelope must jump this much in a frame to be a new hit.
const KICK_RISE: f32 = 0.2;
/// The drop envelope jumps this much the frame a drop lands.
const DROP_RISE: f32 = 0.3;
/// The longest step the simulation takes; a longer frame is cut to it.
const LONGEST_STEP: f32 = 1.0 / 20.0;

/// What the swarm does this frame: its uniforms.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cues {
    /// The shape before and after, how far each particle has moved on,
    /// and 1 while a drop holds the shape apart (`uSwarmForm`).
    pub form: [f32; 4],
    pub forces: Forces,
    /// How much of the last frame's light stays (`uSwarmTrail`).
    pub trail: f32,
}

/// The swarm's moves through a song.
#[derive(Debug, Clone)]
pub struct Choreography {
    random: u32,
    from: u32,
    to: u32,
    /// When the latest change of shape began, and how long it takes.
    changed: f32,
    morph: f32,
    /// The bar counted last, and how many have passed on this shape.
    bar: Option<i64>,
    bars_on: i64,
    /// When the bar count last moved.
    bar_changed: f32,
    section: Option<usize>,
    /// The section changed: the next downbeat brings a new shape.
    section_changed: bool,
    last_time: Option<f32>,
    last_kick: f32,
    last_drop: f32,
    /// When a drop blew the shape apart; `None` once it has re-formed.
    scattered: Option<f32>,
    /// When the swarm last snapped back.
    reformed: f32,
    stream_clock: f32,
}

impl Choreography {
    /// The moves for a look with `seed` (0 to 1): the same seed makes the
    /// same moves to the same music.
    pub fn new(seed: f32) -> Self {
        let random = ((seed.clamp(0.0, 1.0) * 16_777_215.0) as u32).wrapping_mul(2_654_435_761) | 1;
        Self {
            random,
            from: COVER,
            to: COVER,
            changed: 0.0,
            morph: MORPH_SECONDS,
            bar: None,
            bars_on: 0,
            bar_changed: 0.0,
            section: None,
            section_changed: false,
            last_time: None,
            last_kick: 0.0,
            last_drop: 0.0,
            scattered: None,
            reformed: f32::NEG_INFINITY,
            stream_clock: seed * 40.0,
        }
    }

    fn next_random(&mut self) -> u32 {
        self.random ^= self.random << 13;
        self.random ^= self.random >> 17;
        self.random ^= self.random << 5;
        self.random
    }

    /// Move on to another shape, never the one showing.
    fn change(&mut self, time: f32, morph: f32) {
        let step = 1 + self.next_random() % (SHAPES - 1);
        self.from = self.to;
        self.to = (self.to + step) % SHAPES;
        self.changed = time;
        self.morph = morph;
        self.bars_on = 0;
    }

    /// One frame of `music` (whose section is `section`, if known).
    pub fn step(&mut self, music: &Music, section: Option<usize>) -> Cues {
        let time = music.time;
        let dt = match self.last_time {
            Some(last) => (time - last).clamp(0.0, LONGEST_STEP),
            None => {
                self.changed = time;
                self.bar_changed = time;
                1.0 / 60.0
            }
        };
        self.last_time = Some(time);
        if section != self.section {
            if self.section.is_some() {
                self.section_changed = true;
            }
            self.section = section;
        }

        let bar = (music.beats / 4.0).floor() as i64;
        let downbeat = self.bar.is_some_and(|last| bar > last);
        if self.bar != Some(bar) {
            self.bar = Some(bar);
            self.bar_changed = time;
        }

        // The drop: blown apart now, back together on a later downbeat.
        let dropped = music.drop - self.last_drop > DROP_RISE;
        self.last_drop = music.drop;
        let mut blast = 0.0;
        let mut heat = 0.0;
        if dropped {
            self.scattered = Some(time);
            blast += 2.6;
            heat = 0.5;
        }
        // Without a beat (none counted for a while), the clock stands in
        // for the downbeats.
        let beatless = time - self.bar_changed > NO_BEAT_BARS_SECONDS;
        if let Some(at) = self.scattered {
            // Apart at least a beat, so the explosion shows, then together
            // again on the downbeat.
            let apart = time - at;
            if (downbeat && apart >= music.beat_seconds * 0.9) || (beatless && apart > 3.0) {
                self.scattered = None;
                self.reformed = time;
                self.section_changed = false;
                self.change(time, SNAP_SECONDS);
            }
        } else if downbeat {
            self.bars_on += 1;
            if self.bars_on >= PHRASE_BARS || self.section_changed {
                self.section_changed = false;
                self.change(time, MORPH_SECONDS);
            }
        } else if beatless && time - self.changed > NO_BEAT_SECONDS {
            self.change(time, MORPH_SECONDS);
        }

        // Each kick blows the shape outward.
        let rise = music.kick - self.last_kick;
        self.last_kick = music.kick;
        if rise > KICK_RISE {
            blast += rise * (0.35 + 0.55 * music.energy);
            heat = f32::max(heat, 0.35 * rise);
        }

        let scatter = if self.scattered.is_some() { 1.0 } else { 0.0 };
        let snap = (-(time - self.reformed).max(0.0) * 2.5).exp();
        let morph = ((time - self.changed) / self.morph).clamp(0.0, 1.0);
        let parts = &music.parts;
        let pull = 20.0 * (1.0 - scatter) * (1.0 + 5.0 * snap);
        let swirl = 0.05 + 0.5 * parts.snare + 0.25 * parts.fill + 0.15 * scatter;
        let drag = if scatter > 0.0 { 1.6 } else { 4.2 + 8.0 * snap };
        self.stream_clock += dt * (0.5 + 0.7 * music.energy);
        let keep = 0.8 + 0.12 * scatter;
        Cues {
            form: [self.from as f32, self.to as f32, morph, scatter],
            forces: Forces {
                force: [pull, swirl, drag, dt],
                blast: [0.0, 0.0, blast, heat],
                stream: [
                    self.stream_clock,
                    (parts.melody - 0.5) * 0.35,
                    parts.lead,
                    0.09,
                ],
            },
            trail: keep.powf(dt * 60.0),
        }
    }
}

/// The scene: the engine, its shapes, and its moves.
pub struct Swarm {
    particles: Particles,
    targets: Program,
    choreography: Choreography,
    /// The look the swarm is drawing; a new one starts it over.
    seed: Option<f32>,
    trail: f32,
}

impl Swarm {
    /// # Safety
    /// Needs the GL context current, with its state saved (`Saved`).
    pub unsafe fn new(
        gl: &Gl,
        compile: &mut dyn FnMut(&str, &str, &str) -> Option<Program>,
    ) -> Option<Self> {
        unsafe {
            let vertex = format!("#version 300 es\n{}", super::gpu::FULLSCREEN);
            let targets = compile(
                "swarm_targets.glsl",
                &vertex,
                &particles::formation_source(include_str!("shaders/swarm_targets.glsl")),
            )?;
            let Some(particles) = Particles::new(gl, compile, particles::SIDE) else {
                use glow::HasContext;
                gl.delete_program(targets.program);
                return None;
            };
            Some(Self {
                particles,
                targets,
                choreography: Choreography::new(0.0),
                seed: None,
                trail: 0.8,
            })
        }
    }

    /// Before the scene's own pass: this frame's shapes, then a step.
    ///
    /// # Safety
    /// Needs the GL context current, inside the renderer's saved state.
    pub unsafe fn before(
        &mut self,
        gl: &Gl,
        music: &Music,
        seed: f32,
        fresh: bool,
        prepare: &Prepare<'_>,
    ) {
        unsafe {
            if fresh || self.seed != Some(seed) {
                self.seed = Some(seed);
                self.choreography = Choreography::new(seed);
                self.particles.reset();
            }
            let cues = self
                .choreography
                .step(music, music.section.map(|section| section.index));
            self.trail = cues.trail;
            let form = |program: &Program| {
                prepare(program);
                super::gpu::set_vec4(gl, program, "uSwarmForm", cues.form);
                super::gpu::set_vec4(gl, program, "uSwarmStream", cues.forces.stream);
            };
            self.particles.form(gl, &self.targets, &form);
            self.particles.step(gl, &cues.forces, prepare);
        }
    }

    /// The scene's own pass: how long its trails last.
    ///
    /// # Safety
    /// Needs the GL context current, with `program` in use.
    pub unsafe fn bind(&self, gl: &Gl, program: &Program) {
        unsafe {
            set_f32(gl, program, "uSwarmTrail", self.trail);
        }
    }

    /// After the scene's own pass: the particles, onto `target`.
    ///
    /// # Safety
    /// Needs the GL context current, inside the renderer's saved state.
    pub unsafe fn after(&self, gl: &Gl, target: &Target, prepare: &Prepare<'_>) {
        unsafe {
            // Sized for 612 rows (the scene at 85% of 720p), larger or
            // smaller with the scene.
            let size = 2.6 * target.height as f32 / 612.0;
            self.particles.draw(gl, target, size, 0.55, prepare);
        }
    }

    pub fn delete(self, gl: &Gl) {
        use glow::HasContext;
        unsafe {
            gl.delete_program(self.targets.program);
        }
        self.particles.delete(gl);
    }
}

#[cfg(test)]
mod tests {
    use super::super::music::Parts;
    use super::*;

    fn music(time: f32, beats: f32) -> Music {
        Music {
            time,
            dt: 1.0 / 60.0,
            drive: 0.0,
            beats,
            bar: (beats / 4.0).fract(),
            beat_pulse: 0.0,
            bar_pulse: 0.0,
            kick: 0.0,
            accent: 0.0,
            bands: [0.0; 4],
            levels: [0.0; 8],
            energy: 0.6,
            tension: 0.0,
            drop: 0.0,
            intensity: 0.6,
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

    /// Play `seconds` of a steady 120 BPM song from `start`, 60 frames a
    /// second, `change` shaping each frame. The cues of every frame.
    fn play(
        choreography: &mut Choreography,
        start: f32,
        seconds: f32,
        mut change: impl FnMut(&mut Music),
    ) -> Vec<(f32, Cues)> {
        let frames = (seconds * 60.0) as usize;
        (0..frames)
            .map(|frame| {
                let time = start + frame as f32 / 60.0;
                let mut frame = music(time, time * 2.0);
                change(&mut frame);
                (time, choreography.step(&frame, Some(0)))
            })
            .collect()
    }

    #[test]
    fn the_same_seed_makes_the_same_moves() {
        let shapes = |seed: f32| {
            let mut choreography = Choreography::new(seed);
            play(&mut choreography, 0.0, 120.0, |_| {})
                .iter()
                .map(|(_, cues)| cues.form[1])
                .collect::<Vec<_>>()
        };
        assert_eq!(shapes(0.37), shapes(0.37));
        assert_ne!(shapes(0.37), shapes(0.81));
    }

    #[test]
    fn shapes_change_on_the_downbeat_after_a_phrase() {
        let mut choreography = Choreography::new(0.5);
        let frames = play(&mut choreography, 0.0, 70.0, |_| {});
        let mut changes = Vec::new();
        for pair in frames.windows(2) {
            let (_, before) = pair[0];
            let (time, after) = pair[1];
            if after.form[1] != before.form[1] {
                // Never the same shape twice in a row.
                assert_ne!(after.form[0], after.form[1]);
                assert_eq!(after.form[0], before.form[1]);
                changes.push(time);
            }
        }
        // 120 BPM: a bar is 2 s, a phrase of 8 bars 16 s.
        assert_eq!(changes.len(), 4, "{changes:?}");
        for (index, time) in changes.iter().enumerate() {
            let bars = time / 2.0;
            assert!((bars - bars.round()).abs() < 0.02, "{time} is no downbeat");
            assert!((time - 16.0 * (index + 1) as f32).abs() < 0.05, "{time}");
        }
    }

    #[test]
    fn a_new_section_changes_the_shape_at_its_first_downbeat() {
        let mut choreography = Choreography::new(0.2);
        let mut section = 0;
        let frames: Vec<(f32, Cues)> = (0..600)
            .map(|frame| {
                let time = frame as f32 / 60.0;
                if time > 5.3 {
                    section = 1;
                }
                (
                    time,
                    choreography.step(&music(time, time * 2.0), Some(section)),
                )
            })
            .collect();
        let changed = frames
            .windows(2)
            .find(|pair| pair[1].1.form[1] != pair[0].1.form[1])
            .map(|pair| pair[1].0);
        let changed = changed.expect("no change");
        assert!((changed - 6.0).abs() < 0.02, "{changed}");
    }

    #[test]
    fn a_drop_blows_the_shape_apart_until_the_next_downbeat() {
        let mut choreography = Choreography::new(0.7);
        // Land a drop on a downbeat, at 10 s (bar 5).
        let frames = play(&mut choreography, 0.0, 14.0, |frame| {
            frame.drop = if frame.time >= 10.0 {
                (-(frame.time - 10.0) / 2.0).exp()
            } else {
                0.0
            };
        });
        let at = |time: f32| {
            frames
                .iter()
                .find(|(t, _)| *t >= time - 1e-4)
                .map(|(_, cues)| *cues)
                .expect("no frame")
        };
        let landed = at(10.0);
        assert!(landed.forces.blast[2] > 2.0, "{landed:?}");
        assert_eq!(landed.form[3], 1.0);
        assert_eq!(landed.forces.force[0], 0.0, "nothing pulls while apart");
        // Still apart through the bar...
        assert_eq!(at(11.9).form[3], 1.0);
        // ...and back together on the next downbeat, pulling hard, into a
        // new shape, all at once.
        let back = at(12.0);
        assert_eq!(back.form[3], 0.0);
        assert_ne!(back.form[1], landed.form[1]);
        assert!(back.forces.force[0] > 40.0, "{back:?}");
        assert!(at(12.3).form[2] >= 1.0);
    }

    #[test]
    fn only_a_new_kick_blasts() {
        let mut choreography = Choreography::new(0.1);
        let frames = play(&mut choreography, 0.0, 2.0, |frame| {
            // A kick on each beat, falling away.
            frame.kick = (-(frame.beats.fract() * 0.5) * 12.0).exp();
        });
        let blasts = frames
            .iter()
            .filter(|(_, cues)| cues.forces.blast[2] > 0.0)
            .count();
        // Four beats in two seconds, the first on the first frame.
        assert_eq!(blasts, 4);
    }

    #[test]
    fn trails_last_as_long_at_any_frame_rate() {
        let mut fast = Choreography::new(0.3);
        let mut slow = Choreography::new(0.3);
        let a = fast.step(&music(0.0, 0.0), None);
        let a = a.trail * fast.step(&music(1.0 / 60.0, 0.0), None).trail;
        let _ = slow.step(&music(0.0, 0.0), None);
        let b = slow.step(&music(2.0 / 60.0, 0.0), None).trail;
        // Two frames at 60 and one at 30 keep the same light, near enough
        // (the first frame of each counts a sixtieth).
        assert!((a - b).abs() < 1e-3, "{a} vs {b}");
    }
}
