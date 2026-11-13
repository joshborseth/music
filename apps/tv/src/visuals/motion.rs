//! Values a scene would otherwise work out again at every pixel: where Ink
//! pours, how Tunnel and Terrain sway, how the picture shakes, and how the
//! screen pass punches, glows, flashes, and darkens its corners. They change
//! once a frame, so they are worked out here once a frame and sent as
//! uniforms. A TV's GPU has no time to spare for the same sines a million
//! times over.
//!
//! The lab (`apps/tv/visuals-lab/lab.ts`, `motion` and `screenLook`) works
//! out the same values; keep the two in step.

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

/// One frame's values for the picture (`final.glsl`): the same at every
/// one of its pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Screen {
    /// How large the picture is read: below 1 punches in on the kick and
    /// as a drop lands (`uPunch`).
    pub punch: f32,
    /// How much further the edges punch in than the middle, like a lens
    /// thumped (`uBulge`).
    pub bulge: f32,
    /// How bright the light is: above 1 on the kick and through a drop
    /// (`uLift`).
    pub lift: f32,
    /// How far the colors split, at the corners, as a drop builds and
    /// lands (`uSplit`).
    pub split: f32,
    /// How strong the glow is (`uGlow`).
    pub glow: f32,
    /// The flash in the cover's color the moment a drop lands (`uFlash`).
    pub flash: [f32; 3],
    /// The vignette: where its dark starts and where it ends, from the
    /// middle out, and how dark its corners are, closing in as a drop
    /// builds (`uVignette`).
    pub vignette: [f32; 3],
}

/// How hard the beat hits the picture, 0 to 1: the kick, which the
/// analysis already makes as hard as the music is loud and wild, softened
/// further in a calm part, so a ballad's beat only nods.
pub fn hit(music: &Music) -> f32 {
    music.kick * (0.3 + 0.7 * smoothstep(0.3, 0.85, music.intensity))
}

impl Screen {
    /// The values for `music`'s frame, flashing in `color`, the cover's.
    pub fn new(music: &Music, color: [f32; 3]) -> Self {
        let drop = music.drop;
        let tension = music.tension;
        let hit = hit(music);
        // The flash is over in about a beat; the drop's light stays up
        // through its two bars, falling away.
        let flash = drop.powi(8) * 0.8;
        Self {
            punch: 1.0 - 0.05 * hit - 0.05 * drop,
            bulge: 0.08 * hit + 0.08 * drop * drop,
            lift: 1.0 + 0.4 * hit + 0.45 * drop,
            split: 0.006 * drop * drop * drop,
            glow: 0.3 + 0.5 * music.energy + 0.8 * hit + 0.7 * drop,
            flash: color.map(|channel| (channel + 0.3 * (1.0 - channel)) * flash),
            vignette: [
                1.05 - 0.4 * tension,
                0.25 - 0.1 * tension,
                0.55 - 0.25 * tension,
            ],
        }
    }
}

fn smoothstep(from: f32, to: f32, x: f32) -> f32 {
    let t = ((x - from) / (to - from)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
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
    fn the_screen_punches_flashes_and_closes_in_with_the_drop() {
        let quiet = Screen::new(
            &Music {
                kick: 0.0,
                drop: 0.0,
                tension: 0.0,
                ..music()
            },
            [1.0, 0.5, 0.0],
        );
        assert_eq!(quiet.punch, 1.0);
        assert_eq!(quiet.bulge, 0.0);
        assert_eq!(quiet.lift, 1.0);
        assert_eq!(quiet.split, 0.0);
        assert_eq!(quiet.flash, [0.0; 3]);
        assert_eq!(quiet.vignette, [1.05, 0.25, 0.55]);
        let landing = Screen::new(
            &Music {
                drop: 1.0,
                tension: 1.0,
                ..music()
            },
            [1.0, 0.5, 0.0],
        );
        assert!(landing.punch < 0.93);
        assert!(landing.lift > 1.4);
        assert!((landing.split - 0.006).abs() < 1e-6);
        // The cover's color, a third of the way to white.
        let expected = [1.0, 0.65, 0.3].map(|channel: f32| channel * 0.8);
        for (got, want) in landing.flash.iter().zip(expected) {
            assert!((got - want).abs() < 1e-5, "{:?}", landing.flash);
        }
        assert!(landing.vignette[2] < quiet.vignette[2]);
    }

    #[test]
    fn the_beat_hits_wild_music_hard_and_calm_music_softly() {
        let beat = |intensity: f32| {
            Screen::new(
                &Music {
                    kick: 0.8,
                    drop: 0.0,
                    tension: 0.0,
                    intensity,
                    ..music()
                },
                [1.0, 0.5, 0.0],
            )
        };
        let (wild, calm) = (beat(0.95), beat(0.3));
        // A wild part's kick punches in by a few percent and lifts the
        // light by a third; a calm part's by a third as much.
        assert!(wild.punch < 0.965 && wild.lift > 1.3, "{wild:?}");
        assert!(calm.punch > 0.985 && calm.lift < 1.1, "{calm:?}");
        assert!(wild.glow > calm.glow + 0.3);
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
