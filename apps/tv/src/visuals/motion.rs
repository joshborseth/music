//! Values a scene would otherwise work out again at every pixel: where
//! Chrome's blobs and camera are, where Ink pours, how Tunnel and Terrain
//! sway, how the picture shakes. They change once a frame, so they are
//! worked out here once a frame and sent as uniforms. A TV's GPU has no
//! time to spare for the same sines a million times over.
//!
//! The lab (`apps/tv/visuals-lab/lab.ts`, `motion`) works out the same
//! values; keep the two in step.

use std::f32::consts::PI;

use super::music::Music;

/// Chrome's blobs.
pub const BLOBS: usize = 5;
/// Ink's pourers.
pub const POURERS: usize = 3;
/// How far past its blobs Chrome's glow shows (`chrome.glsl`): at 0.2 it
/// is under 1% of its brightest.
const GLOW_REACH: f32 = 0.2;
/// The most Chrome's skin ripples out (`chrome.glsl`, `ripple`).
const RIPPLE_REACH: f32 = 0.065;

/// One frame's values for one scene showing (some depend on its seed).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Motion {
    /// Chrome: each blob's centre and radius (`uBlobs`).
    pub blobs: [[f32; 4]; BLOBS],
    /// Chrome: how far the blobs melt into each other (`uMelt`).
    pub melt: f32,
    /// Chrome: how much bigger than each blob a ball must be to hold its
    /// share of the shape, with melting, ripples, and glow (`uMargin`).
    /// A ray marches only through these balls.
    pub margin: f32,
    /// Chrome: the camera: where it is, then its right, up, and forward
    /// (`uCamera`).
    pub camera: [[f32; 3]; 4],
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

        // Chrome: blobs orbit, gathering on each bar's first beat.
        let gather = (1.0 - music.bar.fract()).powi(2) * 0.6 + 0.4 - 0.4 * music.drop;
        let spread = (0.55 + 0.25 * music.intensity + 1.1 * music.drop) * (1.0 - 0.35 * gather);
        let mut blobs = [[0.0; 4]; BLOBS];
        for (index, blob) in blobs.iter_mut().enumerate() {
            let i = index as f32;
            let centre = [
                (drive * (0.31 + i * 0.07) + i * 1.9).sin() * spread,
                (drive * (0.27 + i * 0.05) + i * 2.7).cos() * 0.7 * spread,
                (drive * (0.19 + i * 0.09) + i * 0.8).sin() * spread,
            ];
            let radius = 0.27 + 0.16 * music.levels[index] + 0.05 * music.kick;
            *blob = [centre[0], centre[1], centre[2], radius];
        }
        let melt = 0.35 - 0.2 * music.drop;
        // Each blob melting into the others swells the shape by up to a
        // quarter of `melt` past them; four in a row, by up to `melt`.
        let margin = melt + RIPPLE_REACH + GLOW_REACH;

        let punch = 1.0 + 0.06 * music.kick;
        let (sin, cos) = (drive * 0.07).sin_cos();
        let distance = 2.5 / punch;
        let eye = [sin * distance, 0.0, -cos * distance];
        let forward = normalize([-eye[0], -eye[1], -eye[2]]);
        // cross(up, forward), with up = (0, 1, 0).
        let right = normalize([forward[2], 0.0, -forward[0]]);
        let up = cross(forward, right);

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
            blobs,
            melt,
            margin,
            camera: [eye, right, up, forward],
            pour,
            turn,
            flight,
            shake,
        }
    }
}

fn length(v: [f32; 3]) -> f32 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn normalize(v: [f32; 3]) -> [f32; 3] {
    let length = length(v).max(1e-6);
    [v[0] / length, v[1] / length, v[2] / length]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
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

    /// The shape `chrome.glsl` marches: the blobs melted together.
    fn shape(motion: &Motion, p: [f32; 3]) -> f32 {
        let mut d = 1e3;
        for blob in motion.blobs {
            let sphere = length([p[0] - blob[0], p[1] - blob[1], p[2] - blob[2]]) - blob[3];
            let h = (0.5 + 0.5 * (sphere - d) / motion.melt).clamp(0.0, 1.0);
            d = sphere + (d - sphere) * h - motion.melt * h * (1.0 - h);
        }
        d
    }

    #[test]
    fn the_margin_holds_the_melted_shape() {
        // Wherever the shape (and its ripples) comes near, some blob's
        // grown ball holds the spot: calm, and as a drop lands.
        for drop in [0.0, 0.4, 1.0] {
            let motion = Motion::new(&Music { drop, ..music() }, 0.3);
            for x in -30..=30 {
                for y in -30..=30 {
                    for z in -30..=30 {
                        let p = [x as f32 * 0.1, y as f32 * 0.1, z as f32 * 0.1];
                        if shape(&motion, p) - RIPPLE_REACH > GLOW_REACH {
                            continue;
                        }
                        let held = motion.blobs.iter().any(|blob| {
                            let away = length([p[0] - blob[0], p[1] - blob[1], p[2] - blob[2]]);
                            away < blob[3] + motion.margin
                        });
                        assert!(held, "{p:?} is outside every ball");
                    }
                }
            }
        }
    }

    #[test]
    fn the_camera_looks_at_the_middle_square_on() {
        let [eye, right, up, forward] = Motion::new(&music(), 0.3).camera;
        let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        let toward = normalize([-eye[0], -eye[1], -eye[2]]);
        assert!((dot(toward, forward) - 1.0).abs() < 1e-5);
        assert!(dot(right, forward).abs() < 1e-5);
        assert!(dot(up, forward).abs() < 1e-5);
        assert!(dot(up, right).abs() < 1e-5);
        assert!(up[1] > 0.9, "the camera stays upright: {up:?}");
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
