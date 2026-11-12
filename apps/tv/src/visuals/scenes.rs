//! The scenes. Each frame, a scene warps the last picture and paints the
//! music on top. They all share one canvas, so switching scenes melts the
//! old picture into the new one instead of cutting.

use std::f32::consts::{PI, TAU};

use super::canvas::{ASPECT, Canvas, Rgb, cos, sin, sin_cos};
use super::look::{COVER_SIDE, Look};
use super::{Audio, WAVE};
use crate::visualizer::BARS;

pub trait Scene: Send {
    fn draw(&mut self, canvas: &mut Canvas, audio: &Audio, look: &Look);

    /// Only shown when the song has a cover.
    fn needs_cover(&self) -> bool {
        false
    }
}

/// Every scene, in the order they take turns.
pub fn all() -> Vec<Box<dyn Scene>> {
    vec![
        Box::new(Tunnel),
        Box::new(Mandala),
        Box::new(Warp::new()),
        Box::new(Melt),
        Box::new(Bloom),
        Box::new(Plasma),
        Box::new(Scope),
    ]
}

fn scaled(color: Rgb, amount: f32) -> Rgb {
    color.map(|channel| channel * amount)
}

/// Turn and zoom toward the center: `zoom` under 1 pushes the picture out.
fn spin(canvas: &mut Canvas, keep: Rgb, zoom: f32, turn: f32) {
    let (s, c) = sin_cos(turn);
    canvas.warp(keep, |p| {
        ((p.x * c - p.y * s) * zoom, (p.x * s + p.y * c) * zoom)
    });
}

/// The waveform bent into a ring, flying out of the screen.
struct Tunnel;

impl Scene for Tunnel {
    fn draw(&mut self, canvas: &mut Canvas, audio: &Audio, look: &Look) {
        let zoom = 0.955 - audio.bass * 0.035 - audio.beat * 0.03;
        spin(canvas, [0.93, 0.94, 0.95], zoom, 0.004 + audio.mid * 0.02);
        let radius = 0.26 + audio.bass * 0.16 + audio.beat * 0.1;
        let points = 180;
        let mut last = None;
        for index in 0..=points {
            // Mirrored, so the ring closes without a seam.
            let half = index.min(points - index);
            let wave = audio.wave[half * (WAVE - 1) * 2 / points];
            let angle = index as f32 / points as f32 * TAU + audio.drive * 0.4;
            let r = radius + wave * 0.2;
            let here = (r * cos(angle), r * sin(angle));
            let color = look.color(index as f32 / points as f32 + audio.time * 0.05);
            if let Some(from) = last {
                canvas.line(from, here, scaled(color, 0.7 + audio.level));
            }
            last = Some(here);
        }
        if audio.kick {
            canvas.glow(
                0.0,
                0.0,
                0.25,
                scaled(look.color(audio.time * 0.05 + 0.5), 0.6),
            );
        }
    }
}

/// Comets folded into a six-way kaleidoscope.
struct Mandala;

const FOLDS: usize = 6;

impl Scene for Mandala {
    fn draw(&mut self, canvas: &mut Canvas, audio: &Audio, look: &Look) {
        let zoom = 0.975 - audio.bass * 0.03;
        spin(
            canvas,
            [0.88, 0.89, 0.92],
            zoom,
            0.006 + audio.treble * 0.02,
        );
        let wedge = TAU / FOLDS as f32;
        let turn = audio.drive * 0.12;
        let mirrored = |canvas: &mut Canvas, x: f32, y: f32, radius: f32, color: Rgb| {
            let (r, a) = (x.hypot(y), y.atan2(x));
            for fold in 0..FOLDS {
                for side in [1.0, -1.0] {
                    let angle = side * a + fold as f32 * wedge + turn;
                    canvas.glow(r * cos(angle), r * sin(angle), radius, color);
                }
            }
        };
        let groups = 4;
        for group in 0..groups {
            let bands = &audio.bands[group * BARS / groups..(group + 1) * BARS / groups];
            let energy = bands.iter().sum::<f32>() / bands.len() as f32;
            let seed = group as f32 * 1.7;
            let x = 0.75 * sin(audio.drive * (0.5 + group as f32 * 0.17) + seed);
            let y = 0.55 * sin(audio.drive * (0.63 + group as f32 * 0.21) + seed * 2.0);
            let color = look.color(group as f32 / groups as f32 + audio.time * 0.03);
            mirrored(
                canvas,
                x,
                y,
                0.02 + energy * 0.05,
                scaled(color, 0.12 + energy * 0.6),
            );
        }
        // The waveform as a spoke in every fold.
        let points = 48;
        for index in 0..points {
            let along = index as f32 / points as f32;
            let wave = audio.wave[index * (WAVE - 1) / points];
            let (x, y) = (0.12 + along * 0.85, wave * 0.18);
            mirrored(
                canvas,
                x,
                y,
                0.008,
                scaled(look.color(along + 0.5), 0.15 + audio.level * 0.3),
            );
        }
    }
}

/// Stars rushing past, faster with the music; bursts of sparks on each kick.
struct Warp {
    stars: Vec<[f32; 4]>,
    sparks: Vec<Spark>,
    random: Random,
}

struct Spark {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    life: f32,
    color: Rgb,
}

impl Warp {
    fn new() -> Self {
        let mut random = Random(0x9e37_79b9);
        let stars = (0..420)
            .map(|_| {
                [
                    random.signed() * 2.0,
                    random.signed() * 2.0,
                    random.unit() + 0.02,
                    random.unit(),
                ]
            })
            .collect();
        Self {
            stars,
            sparks: Vec::new(),
            random,
        }
    }
}

impl Scene for Warp {
    fn draw(&mut self, canvas: &mut Canvas, audio: &Audio, look: &Look) {
        spin(canvas, [0.8, 0.8, 0.84], 0.985, audio.mid * 0.01);
        let speed = audio.dt * (0.12 + audio.level * 0.7 + audio.beat * 1.2);
        let project = |star: &[f32; 4]| (star[0] / star[2] * 0.35, star[1] / star[2] * 0.35);
        for star in &mut self.stars {
            let from = project(star);
            star[2] -= speed;
            if star[2] <= 0.03 || from.0.abs() > ASPECT * 1.2 || from.1.abs() > 1.2 {
                *star = [
                    self.random.signed() * 2.0,
                    self.random.signed() * 2.0,
                    1.0,
                    self.random.unit(),
                ];
                continue;
            }
            let to = project(star);
            let near = (1.0 - star[2]).powi(2);
            let color = look.color(star[3] * 0.4 + audio.time * 0.03);
            canvas.line(from, to, scaled(color, 0.25 + near * 1.6));
        }
        if audio.kick {
            let count = 60 + (audio.bass * 80.0) as usize;
            let hue = self.random.unit();
            for _ in 0..count {
                let angle = self.random.unit() * TAU;
                let speed = 0.4 + self.random.unit() * 1.4;
                self.sparks.push(Spark {
                    x: 0.0,
                    y: 0.0,
                    vx: speed * cos(angle),
                    vy: speed * sin(angle),
                    life: 1.0,
                    color: look.color(hue + self.random.unit() * 0.25),
                });
            }
        }
        let drag = 0.94f32.powf(audio.dt * 30.0);
        for spark in &mut self.sparks {
            spark.x += spark.vx * audio.dt;
            spark.y += spark.vy * audio.dt;
            spark.vx *= drag;
            spark.vy *= drag;
            spark.life -= audio.dt * 0.7;
            canvas.glow(
                spark.x,
                spark.y,
                0.012,
                scaled(spark.color, spark.life.max(0.0) * 1.5),
            );
        }
        self.sparks.retain(|spark| spark.life > 0.0);
    }
}

/// The cover, stirred into a whirlpool.
struct Melt;

impl Scene for Melt {
    fn needs_cover(&self) -> bool {
        true
    }

    fn draw(&mut self, canvas: &mut Canvas, audio: &Audio, look: &Look) {
        let swirl = 0.05 * sin(audio.drive * 0.25) + audio.mid * 0.07 + 0.02;
        let zoom = 0.972 - audio.bass * 0.03 - audio.beat * 0.025;
        canvas.warp([0.965, 0.965, 0.97], |p| {
            let bend = swirl * (1.3 - p.r).max(0.0).powi(2);
            let (s, c) = sin_cos(bend);
            ((p.x * c - p.y * s) * zoom, (p.x * s + p.y * c) * zoom)
        });
        if let Some(cover) = &look.cover {
            let side = 0.5 + audio.bass * 0.25 + audio.beat * 0.12;
            let angle = sin(audio.drive * 0.1) * 0.6;
            canvas.stamp(
                &cover.pixels,
                COVER_SIDE,
                side,
                angle,
                0.3 + audio.beat * 0.3,
            );
        }
        let points = 120;
        let radius = 0.42 + audio.bass * 0.2;
        let mut last = None;
        for index in 0..=points {
            let half = index.min(points - index);
            let wave = audio.wave[half * (WAVE - 1) * 2 / points];
            let angle = index as f32 / points as f32 * TAU - audio.drive * 0.3;
            let r = radius + wave.abs() * 0.15;
            let here = (r * cos(angle), r * sin(angle));
            if let Some(from) = last {
                canvas.line(
                    from,
                    here,
                    scaled(look.color(audio.time * 0.04), 0.3 + audio.level * 0.5),
                );
            }
            last = Some(here);
        }
    }
}

/// The spectrum as petals, mirrored left and right, blooming outward.
struct Bloom;

impl Scene for Bloom {
    fn draw(&mut self, canvas: &mut Canvas, audio: &Audio, look: &Look) {
        let zoom = 0.97 - audio.bass * 0.025;
        spin(
            canvas,
            [0.86, 0.87, 0.9],
            zoom,
            -(0.008 + audio.treble * 0.025),
        );
        let inner = 0.1 + audio.beat * 0.06;
        for (band, level) in audio.bands.iter().enumerate() {
            let along = (band as f32 + 0.5) / BARS as f32;
            let color = scaled(
                look.color(along * 0.8 + audio.time * 0.04),
                0.18 + level * 0.7,
            );
            let outer = inner + level * 0.8;
            for side in [1.0, -1.0] {
                let angle = PI / 2.0 + side * along * PI + audio.drive * 0.25;
                let (s, c) = sin_cos(angle);
                canvas.line((inner * c, inner * s), (outer * c, outer * s), color);
                canvas.glow(outer * c, outer * s, 0.01 + level * 0.02, color);
            }
        }
    }
}

/// Rippling bands of color, faster and brighter with the music.
struct Plasma;

impl Scene for Plasma {
    fn draw(&mut self, canvas: &mut Canvas, audio: &Audio, look: &Look) {
        let t = audio.drive * 1.4;
        let pulse = audio.bass * 3.0 + audio.beat * 1.5;
        let shift = audio.time * 0.04;
        let bright = 0.3 + audio.mid * 0.6 + audio.beat * 0.4;
        canvas.wash(0.45, |p| {
            let v = sin(p.x * 2.6 + t)
                + sin(p.y * 3.4 - t * 1.3)
                + sin(p.r * 7.0 - t * 2.1 - pulse)
                + sin((p.x + p.y) * 2.2 + t * 0.7);
            let rings = 0.5 + 0.5 * sin(v * PI);
            scaled(
                look.color(v * 0.12 + shift),
                bright * (0.25 + rings * rings),
            )
        });
        let points = 160;
        let mut last = None;
        for index in 0..=points {
            let along = index as f32 / points as f32;
            let wave = audio.wave[index * (WAVE - 1) / points];
            let here = ((along * 2.0 - 1.0) * ASPECT, wave * 0.45);
            if let Some(from) = last {
                canvas.line(
                    from,
                    here,
                    scaled(look.color(along + 0.33 + shift), 0.8 + audio.level),
                );
            }
            last = Some(here);
        }
    }
}

/// The waveform against itself a moment later, like an oscilloscope in X-Y
/// mode, sinking into the middle as it changes color.
struct Scope;

const LAG: usize = 37;

impl Scene for Scope {
    fn draw(&mut self, canvas: &mut Canvas, audio: &Audio, look: &Look) {
        let turn = 0.015 * sin(audio.drive * 0.2);
        spin(canvas, [0.95, 0.9, 0.93], 1.025 + audio.beat * 0.02, turn);
        let size = 0.75 + audio.beat * 0.25;
        let (s, c) = sin_cos(PI / 4.0 + audio.drive * 0.15);
        let mut last = None;
        for index in 0..WAVE - LAG {
            let (x, y) = (audio.wave[index] * size, audio.wave[index + LAG] * size);
            let here = (x * c - y * s, x * s + y * c);
            if let Some(from) = last {
                let color = look.color(index as f32 / WAVE as f32 * 0.5 + audio.time * 0.05);
                canvas.line(from, here, scaled(color, 0.35 + audio.level * 0.4));
            }
            last = Some(here);
        }
    }
}

/// xorshift: plenty for scattering stars.
struct Random(u32);

impl Random {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }

    fn unit(&mut self) -> f32 {
        (self.next() >> 8) as f32 / (1 << 24) as f32
    }

    fn signed(&mut self) -> f32 {
        self.unit() * 2.0 - 1.0
    }
}
