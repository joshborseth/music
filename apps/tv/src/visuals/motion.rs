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
/// Chrome's lens: a point `d` ahead of the camera and `x` across shows
/// `x * FOCAL / d` from the middle of the picture, in `centered()` units.
const FOCAL: f32 = 1.6;

/// One frame's values for one scene showing (some depend on its seed).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Motion {
    /// Chrome: each blob as the camera sees it: its centre on the
    /// picture, in `centered()` units, and its radius there (`uBlobs`).
    pub blobs: [[f32; 3]; BLOBS],
    /// Chrome: how far the blobs melt into each other, on the picture
    /// (`uMelt`).
    pub melt: f32,
    /// Chrome: the camera: where it is, then its right, up, and forward
    /// (`uCamera`). The room the metal reflects turns with it.
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

        // Chrome: the camera circles the middle, pushing in on the kick.
        let punch = 1.0 + 0.06 * music.kick;
        let (sin, cos) = (drive * 0.07).sin_cos();
        let distance = 2.5 / punch;
        let eye = [sin * distance, 0.0, -cos * distance];
        let forward = normalize([-eye[0], -eye[1], -eye[2]]);
        // cross(up, forward), with up = (0, 1, 0).
        let right = normalize([forward[2], 0.0, -forward[0]]);
        let up = cross(forward, right);

        // Chrome: blobs orbit, gathering on each bar's first beat, and are
        // seen through the camera. A blob flung past the camera on a drop
        // shrinks away before it gets there.
        let gather = (1.0 - music.bar.fract()).powi(2) * 0.6 + 0.4 - 0.4 * music.drop;
        let spread = (0.55 + 0.25 * music.intensity + 1.1 * music.drop) * (1.0 - 0.35 * gather);
        let mut blobs = [[0.0; 3]; BLOBS];
        for (index, blob) in blobs.iter_mut().enumerate() {
            let i = index as f32;
            let centre = [
                (drive * (0.31 + i * 0.07) + i * 1.9).sin() * spread,
                (drive * (0.27 + i * 0.05) + i * 2.7).cos() * 0.7 * spread,
                (drive * (0.19 + i * 0.09) + i * 0.8).sin() * spread,
            ];
            let radius = 0.27 + 0.16 * music.levels[index] + 0.05 * music.kick;
            *blob = project(centre, radius, [eye, right, up, forward]);
        }
        // As far as the old 3D shape melted, seen at the middle's distance.
        let melt = (0.35 - 0.2 * music.drop) * FOCAL / distance;

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
            camera: [eye, right, up, forward],
            pour,
            turn,
            flight,
            shake,
        }
    }
}

/// A ball at `centre` with `radius` as `camera` (where it is, then its
/// right, up, and forward) sees it: its centre on the picture and its
/// radius there. Nothing shows of a ball at or behind the camera.
fn project(centre: [f32; 3], radius: f32, [eye, right, up, forward]: [[f32; 3]; 4]) -> [f32; 3] {
    let away = [centre[0] - eye[0], centre[1] - eye[1], centre[2] - eye[2]];
    let ahead = dot(away, forward);
    // Shrink away between 0.6 and 0.2 ahead, rather than fill the screen.
    let near = ((ahead - 0.2) / 0.4).clamp(0.0, 1.0);
    let ahead = ahead.max(0.2);
    [
        dot(away, right) * FOCAL / ahead,
        dot(away, up) * FOCAL / ahead,
        radius * FOCAL / ahead * near * near * (3.0 - 2.0 * near),
    ]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
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

    #[test]
    fn blobs_show_where_the_camera_sees_them() {
        let camera = Motion::new(&music(), 0.3).camera;
        let [eye, right, up, forward] = camera;
        // The middle of the scene, straight ahead: the middle of the picture.
        let [x, y, radius] = project([0.0, 0.0, 0.0], 0.3, camera);
        assert!(x.abs() < 1e-5 && y.abs() < 1e-5, "{x} {y}");
        let distance = length(eye);
        assert!((radius - 0.3 * FOCAL / distance).abs() < 1e-5);
        // Up and to the right of it shows up and to the right.
        let moved = [
            right[0] * 0.2 + up[0] * 0.1,
            right[1] * 0.2 + up[1] * 0.1,
            right[2] * 0.2 + up[2] * 0.1,
        ];
        let [x, y, _] = project(moved, 0.3, camera);
        assert!((x - 0.2 * FOCAL / distance).abs() < 1e-4, "{x}");
        assert!((y - 0.1 * FOCAL / distance).abs() < 1e-4, "{y}");
        // Nearer is bigger, and a ball behind the camera shows nothing.
        let nearer = [-forward[0], -forward[1], -forward[2]];
        assert!(project(nearer, 0.3, camera)[2] > radius);
        let behind = [
            eye[0] - forward[0],
            eye[1] - forward[1],
            eye[2] - forward[2],
        ];
        assert_eq!(project(behind, 0.3, camera)[2], 0.0);
    }

    #[test]
    fn blobs_stay_finite_as_a_drop_flings_them() {
        for drop in [0.0, 0.5, 1.0] {
            for step in 0..400 {
                let motion = Motion::new(
                    &Music {
                        drop,
                        drive: step as f32 * 0.37,
                        ..music()
                    },
                    0.3,
                );
                for [x, y, radius] in motion.blobs {
                    assert!(x.is_finite() && y.is_finite() && radius.is_finite());
                    assert!((0.0..10.0).contains(&radius), "{radius}");
                }
                assert!(motion.melt > 0.05 && motion.melt < 0.5, "{}", motion.melt);
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
