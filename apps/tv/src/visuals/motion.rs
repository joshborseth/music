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
            // The second pours on each snare and drifts with the tune, the
            // third spits on each hi-hat.
            let parts = &music.parts;
            let (lifted, hits) = match index {
                1 => (0.25 * (parts.melody - 0.5) * parts.lead, 0.25 * parts.snare),
                2 => (0.0, 0.2 * parts.hat),
                _ => (0.0, 0.0),
            };
            *pourer = [
                0.55 * (phase * 1.3).sin(),
                0.32 * phase.cos() + lifted,
                0.025 + 0.05 * level + 0.06 * music.beat_pulse * first,
                0.02 + 0.22 * level + 0.35 * music.kick * first + hits,
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

        // A drum fill rattles the picture, harder on its snares; a build
        // shakes it more and more toward its landing, which jolts it.
        let parts = &music.parts;
        let (build, land) = build_and_landing(music);
        let shake = music.tension * music.tension * 0.006
            + parts.fill * 0.003 * (0.5 + parts.snare)
            + build * build * 0.012
            + land * land * 0.014;
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
    /// builds, to tunnel vision before a landing (`uVignette`).
    pub vignette: [f32; 3],
    /// How far the colors drain toward the cover's deep shade through a
    /// build, 0 to 1 (`uCueDrain`).
    pub drain: f32,
    /// The inhale, the half beat before a landing: the picture all but
    /// black, a silhouette, 0 to 1 (`uCueInhale`).
    pub inhale: f32,
    /// The glitch layer: how much (rows and blocks torn sideways, the
    /// colors split apart), a new random pattern each sixteenth note, and
    /// how far the colors are posterized, each 0 to 1 (`uGlitch`,
    /// `uGlitchSeed`, `uGlitchPosterize`).
    pub glitch: f32,
    pub glitch_seed: f32,
    pub posterize: f32,
    /// True when the scene should not draw this frame, so its last frame
    /// repeats: a stutter, or the picture frozen while the music stops.
    pub hold: bool,
}

/// How far into a build the music is, as the screen shows it (eased, as
/// big as its landing, gentler in a calm song), and how hard the latest
/// landing still hits, 1 on its frame and gone in about a beat; each 0
/// to 1.
pub fn build_and_landing(music: &Music) -> (f32, f32) {
    let cue = &music.parts.cue;
    let wild = 0.35 + 0.65 * smoothstep(0.35, 0.9, music.ceiling);
    let build = cue.build * cue.build * cue.strength * wild;
    let land = if cue.since < super::cues::FAR {
        cue.landed * wild * (-cue.since / (0.9 * music.beat_seconds.max(0.2))).exp()
    } else {
        0.0
    };
    (build, land)
}

/// The fastest bright flashes may come, a second: no faster, for comfort.
const MOST_FLASHES: f32 = 3.0;

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
        let hit = hit(music);
        let parts = &music.parts;
        let cue = &parts.cue;
        let beat = music.beat_seconds.max(0.1);
        let wild = smoothstep(0.35, 0.9, music.ceiling);
        let (build, land) = build_and_landing(music);
        let tension = music.tension.max(build);
        // The bar before a landing counts in eighths, its last bar in
        // sixteenths: a pulse that quickens into the hit.
        let bar = 4.0 * beat;
        let coming = cue.until < super::cues::FAR;
        let last_bar = if coming && cue.until < bar {
            1.0 - cue.until / bar
        } else {
            0.0
        };
        let rate = if !coming || cue.until >= 2.0 * bar {
            1.0
        } else if cue.until >= bar {
            2.0
        } else {
            4.0
        };
        let quicken = (-(music.beats * rate).rem_euclid(1.0) * 5.0).exp() * build;
        // The half beat before the landing: an inhale, the screen all but
        // black, then the hit.
        let half = 0.5 * beat;
        let inhale = if coming && cue.until < half {
            smoothstep(half, 0.55 * half, cue.until)
                * (0.4 + 0.6 * cue.strength)
                * (0.3 + 0.7 * wild)
        } else {
            0.0
        };
        let climax = cue.climax * wild;

        // Strobing, on the strong beats of the bars it fits: bright on the
        // first and third, dim on the second and fourth, so it alternates
        // rather than flashing black and white. At most `MOST_FLASHES`
        // bright flashes a second: at a fast tempo, only the first beat.
        let mut strobe_flash = 0.0;
        let mut strobe_dim = 0.0;
        if cue.strobe && wild > 0.3 {
            let in_bar = ((music.bar * 4.0).floor() as i32).rem_euclid(4);
            let pulse = (-(music.beats.rem_euclid(1.0)) * beat * 16.0).exp() * wild;
            let bright_every = if 2.0 / (4.0 * beat) > MOST_FLASHES {
                4
            } else {
                2
            };
            if in_bar % bright_every == 0 {
                strobe_flash = pulse * 0.5;
            } else if in_bar % 2 == 1 {
                strobe_dim = pulse * 0.55;
            }
        }

        // The glitch layer: a drum fill tears the picture, the build's
        // last bar more and more, and the climax in bursts, on the last
        // beat of each two bars and now and then on others.
        let beat_index = music.beats.floor() as i64;
        let burst = if beat_index.rem_euclid(8) == 7 || unit(beat_index as u32 ^ 0x9e37) < 0.18 {
            (-(music.beats.rem_euclid(1.0)) * 2.5).exp()
        } else {
            0.0
        };
        let fill = parts.fill * smoothstep(0.4, 0.8, music.intensity);
        let edge = last_bar * cue.strength;
        let glitch = (fill * 0.55).max(edge * 0.85).max(climax * burst * 0.8) * (0.3 + 0.7 * wild);
        let sixteenth = (music.beats * 4.0).floor() as i64;
        let posterize = (edge * edge * 0.8).max(climax * burst * 0.6) * wild;
        // The picture repeats a frame (the scene doesn't draw): frozen
        // while the music stops, every other eighth through a fill, and
        // every other sixteenth through a wild build's last bar.
        let hold = parts.stop > 0.5
            || (fill > 0.5 && (music.beats * 2.0).rem_euclid(2.0) >= 1.0)
            || (edge > 0.0 && wild > 0.5 && sixteenth.rem_euclid(2) == 1);

        // When the music stops dead, the light goes with it.
        let held = 1.0 - 0.8 * parts.stop;
        // The climax is the biggest version of everything.
        let big = 1.0 + 0.25 * climax;
        // The flash is over in about a beat; the drop's light stays up
        // through its two bars, falling away. A landing flashes too, as
        // big as it is.
        let flash = (drop.powi(8) * 0.8).max(land.powi(3) * 0.95) * big + strobe_flash;
        Self {
            // Through a build the camera pushes in, pulsing faster; the
            // landing snaps it back and punches.
            punch: 1.0
                - (0.05 * hit + 0.05 * drop + 0.16 * build + 0.025 * quicken + 0.07 * land) * big,
            bulge: (0.08 * hit + 0.08 * drop * drop + 0.3 * land * land) * big,
            lift: (1.0 + 0.4 * hit + 0.45 * drop + 0.5 * land + 0.35 * build + 0.3 * quicken)
                * held
                * big
                * (1.0 - strobe_dim),
            // Each snare splits the colors a hair, in wild music.
            split: (0.006 * drop * drop * drop
                + 0.0015 * parts.snare * music.intensity
                + 0.01 * land * land)
                * big,
            // The glow swells a little on each new chord, and more each
            // time a part of the song comes back.
            glow: (0.3
                + 0.5 * music.energy
                + 0.8 * hit
                + 0.7 * drop
                + 0.15 * parts.chord_change
                + 0.6 * land)
                * held
                * big
                * (1.0 + 0.1 * parts.repeat.min(3.0)),
            flash: color.map(|channel| (channel + 0.3 * (1.0 - channel)) * flash),
            // Tunnel vision through a build: the dark closes in from the
            // corners to all but the middle.
            vignette: [
                (1.05 - 0.4 * tension - 0.25 * build).max(0.5),
                (0.25 - 0.1 * tension - 0.12 * build).max(0.14),
                (0.55 - 0.25 * tension - 0.25 * build).max(0.08),
            ],
            drain: 0.75 * build,
            inhale,
            glitch,
            glitch_seed: unit(sixteenth as u32 ^ 0x51ed) as f32,
            posterize,
            hold,
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
    use super::super::music::Parts;
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
            parts: Parts::default(),
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

    /// The music `until` seconds before a full-strength landing, eight
    /// bars into its build, at 120 BPM.
    fn building(until: f32) -> Music {
        use super::super::cues::Cues;
        let build_seconds = 16.0;
        let mut frame = Music {
            kick: 0.0,
            drop: 0.0,
            tension: 0.0,
            beats: 100.0 - until / 0.5,
            ..music()
        };
        frame.parts.cue = Cues {
            until,
            build: (1.0 - until / build_seconds).max(0.0),
            strength: 1.0,
            ..Cues::default()
        };
        frame
    }

    #[test]
    fn a_build_pushes_in_drains_and_closes_in_then_inhales_and_lands() {
        let color = [1.0, 0.5, 0.0];
        let quiet = Screen::new(&building(super::super::cues::FAR), color);
        let early = Screen::new(&building(12.0), color);
        let late = Screen::new(&building(2.0), color);
        // The camera pushes in, the colors drain, the corners close in.
        assert!(late.punch < early.punch && early.punch <= quiet.punch);
        assert!(late.drain > 0.5 && early.drain < 0.1, "{late:?}");
        assert!(late.vignette[2] < quiet.vignette[2] - 0.2);
        assert_eq!(late.inhale, 0.0);
        // The last half beat: all but black.
        let inhale = Screen::new(&building(0.1), color);
        assert!(inhale.inhale > 0.9, "{inhale:?}");
        // The landing frame: a flash in the cover's color and a punch.
        let mut landed = building(super::super::cues::FAR);
        landed.parts.cue.since = 0.0;
        landed.parts.cue.landed = 1.0;
        let hit = Screen::new(&landed, color);
        assert!(hit.flash[0] > 0.8 && hit.flash[2] > 0.2, "{hit:?}");
        assert!(hit.punch < 0.95 && hit.bulge > 0.25 && hit.inhale == 0.0);
        // A beat later it has mostly passed.
        landed.parts.cue.since = 0.5;
        assert!(Screen::new(&landed, color).flash[0] < 0.3);
    }

    #[test]
    fn the_last_bar_glitches_and_stutters_and_a_ballad_barely_does() {
        let wild = (0..32)
            .map(|step| Screen::new(&building(2.0 - (step + 1) as f32 / 16.0), [1.0; 3]))
            .collect::<Vec<_>>();
        assert!(wild.iter().all(|look| look.glitch > 0.0));
        let held = wild.iter().filter(|look| look.hold).count();
        assert!((12..=20).contains(&held), "{held} of 32 frames held");
        let mut ballad = building(0.6);
        ballad.ceiling = super::super::music::intensity_ceiling(0.05);
        let calm = Screen::new(&ballad, [1.0; 3]);
        assert!(calm.glitch < wild[22].glitch * 0.5 && !calm.hold);
    }

    #[test]
    fn strobing_alternates_and_never_flashes_bright_more_than_three_times_a_second() {
        use super::super::cues::Cues;
        for bpm in [90.0, 128.0, 174.0, 240.0] {
            let beat = 60.0 / bpm;
            let mut bright = Vec::new();
            let mut dimmed = false;
            let mut was_bright = false;
            for frame in 0..(60 * 4) {
                let t = frame as f32 / 60.0;
                let beats = t / beat;
                let mut strobing = Music {
                    kick: 0.0,
                    drop: 0.0,
                    beats,
                    bar: (beats / 4.0).fract(),
                    beat_seconds: beat,
                    ..music()
                };
                strobing.parts.cue = Cues {
                    strobe: true,
                    ..Cues::default()
                };
                let look = Screen::new(&strobing, [1.0, 0.5, 0.0]);
                let is_bright = look.flash[0] > 0.25;
                if is_bright && !was_bright {
                    bright.push(t);
                }
                was_bright = is_bright;
                dimmed |= look.lift < 0.8;
            }
            assert!(dimmed, "{bpm} BPM never dims");
            assert!(!bright.is_empty(), "{bpm} BPM never flashes");
            for pair in bright.windows(2) {
                assert!(
                    pair[1] - pair[0] >= 1.0 / 3.0 - 0.02,
                    "{bpm} BPM: {bright:?}"
                );
            }
        }
    }

    #[test]
    fn the_picture_freezes_while_the_music_stops() {
        let mut stopped = music();
        stopped.parts.stop = 1.0;
        assert!(Screen::new(&stopped, [1.0; 3]).hold);
        assert!(!Screen::new(&music(), [1.0; 3]).hold);
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
