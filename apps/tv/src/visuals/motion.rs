//! Values a scene would otherwise work out again at every pixel: where Ink
//! pours, how Tunnel and Terrain sway, how the picture shakes. They change
//! once a frame, so they are worked out here once a frame and sent as
//! uniforms. A TV's GPU has no time to spare for the same sines a million
//! times over.
//!
//! The lab (`apps/tv/visuals-lab/lab.ts`, `motion`) works out the same
//! values; keep the two in step.

use std::f32::consts::PI;

use super::music::Music;

/// Ink's pourers.
pub const POURERS: usize = 3;

/// One frame's values for one scene showing (some depend on its seed).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Motion {
    /// Ink: each pourer's place, size, and how much it pours (`uPour`).
    pub pour: [[f32; 4]; POURERS],
    /// Tunnel: how it bends (x, y), and the cosine and sine of its spin
    /// (`uTurn`).
    pub turn: [f32; 4],
    /// Terrain: the eye's x and height, and the cosine and sine of its
    /// roll (`uFlight`).
    pub flight: [f32; 4],
    /// The whole picture's shake as a drop builds (`uShake`).
    pub shake: [f32; 2],
}

impl Motion {
    /// The values for a scene with look `seed`, in `music`'s frame.
    pub fn new(music: &Music, seed: f32) -> Self {
        let drive = music.drive;

        // Ink: three pourers circling, each fed by its slice of the music.
        let mut pour = [[0.0; 4]; POURERS];
        for (index, pourer) in pour.iter_mut().enumerate() {
            let i = index as f32;
            let phase = drive * (0.21 + 0.07 * i) + i * 2.1 + seed * 5.0;
            let level = music.bands[index];
            let first = if index == 0 { 1.0 } else { 0.0 };
            *pourer = [
                0.55 * (phase * 1.3).sin(),
                0.32 * phase.cos(),
                0.025 + 0.05 * level + 0.06 * music.beat_pulse * first,
                0.02 + 0.22 * level + 0.35 * music.kick * first,
            ];
        }

        let spin = drive * 0.05 + 0.15 * (music.beats * PI * 0.25).sin();
        let turn = [
            (drive * 0.23).sin() * 0.08,
            (drive * 0.17).cos() * 0.08,
            spin.cos(),
            spin.sin(),
        ];

        let bob = 0.04 * music.beat_pulse * music.energy - 0.12 * music.drop;
        let roll = 0.04 * (drive * 0.09).sin();
        let flight = [
            0.12 * (drive * 0.11).sin(),
            0.62 + bob + 0.15 * music.tension,
            roll.cos(),
            roll.sin(),
        ];

        let shake = music.tension * music.tension * 0.006;
        let shake = [
            (smooth_noise(music.time * 23.0) - 0.5) * shake,
            (smooth_noise(music.time * 27.0 + 57.0) - 0.5) * shake,
        ];

        Self {
            pour,
            turn,
            flight,
            shake,
        }
    }
}

/// A well-mixed 32-bit hash. The lab's `hash` is the same.
pub fn hash(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

/// 0 to 1 from a hash.
pub fn unit(x: u32) -> f64 {
    f64::from(hash(x) >> 8) / f64::from(1u32 << 24)
}

/// Smooth noise along a line, 0 to 1: a new random value at each whole
/// number, eased between.
fn smooth_noise(x: f32) -> f32 {
    let i = x.floor();
    let f = x - i;
    let f = f * f * (3.0 - 2.0 * f);
    let at = i as i64 as u32;
    let (a, b) = (unit(at) as f32, unit(at.wrapping_add(1)) as f32);
    a + (b - a) * f
}

#[cfg(test)]
mod tests {
    use super::*;

    fn music() -> Music {
        Music {
            time: 12.0,
            dt: 1.0 / 60.0,
            drive: 9.0,
            beats: 20.5,
            bar: 0.3,
            beat_pulse: 0.4,
            bar_pulse: 0.1,
            kick: 0.6,
            accent: 0.0,
            bands: [0.7, 0.5, 0.3, 0.5],
            levels: [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
            energy: 0.8,
            tension: 0.5,
            drop: 0.4,
            intensity: 0.7,
            ceiling: 1.0,
            beat_seconds: 0.5,
            on_beat: false,
            on_downbeat: false,
            drop_landed: false,
            surge: false,
            section: None,
            live: true,
            analyzed: true,
        }
    }

    #[test]
    fn the_tunnel_turns_and_terrain_flies_within_bounds() {
        for step in 0..400 {
            let motion = Motion::new(
                &Music {
                    drive: step as f32 * 0.37,
                    beats: step as f32 * 0.21,
                    ..music()
                },
                0.3,
            );
            let [x, y, cos, sin] = motion.turn;
            assert!(x.abs() <= 0.08 && y.abs() <= 0.08);
            assert!((cos * cos + sin * sin - 1.0).abs() < 1e-4);
            assert!(
                (0.4..0.9).contains(&motion.flight[1]),
                "{:?}",
                motion.flight
            );
        }
    }

    #[test]
    fn smooth_noise_is_smooth_and_in_range() {
        let mut last = smooth_noise(100.0);
        for step in 1..2000 {
            let value = smooth_noise(100.0 + step as f32 * 0.01);
            assert!((0.0..=1.0).contains(&value));
            assert!((value - last).abs() < 0.03, "{value} after {last}");
            last = value;
        }
    }

    #[test]
    fn hash_matches_the_lab() {
        // The lab's `hash` gives these for the same inputs.
        assert_eq!(hash(0), 0);
        assert_eq!(hash(1), 0x6889_90c0);
    }
}
