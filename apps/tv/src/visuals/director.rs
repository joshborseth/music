//! Picks the scene for each part of the song, like a VJ would.
//!
//! With the server's analysis, scenes change where the music does: at the
//! start of a section, on its first beat. A chorus that comes back gets the
//! same scene (and the same look) it had before, so the song's shape shows
//! on screen. A drop cuts hard, on the beat, to one of the wildest scenes.
//! A scene that has shown a while moves on at a phrase, counted in bars
//! from when it came on, so it can't hold through a run of sections that
//! share it (a chorus sung twice in a row): every 16 bars, or when calm
//! the first 16-bar phrase past 45 seconds (32 bars at most tempos), and
//! every 8 bars (or at a section's start) once it has shown for two
//! minutes. Never in a section's last 8 bars, where its own end is coming,
//! and never back to the scene just before. A new pick prefers scenes the
//! song hasn't shown yet, while any suit the music, so a song of a few
//! sections doesn't show two scenes twice each. Calm parts get calm
//! scenes: how wild a part looks is its intensity, which the song's drive
//! caps (`music.rs`), so a ballad never gets the tunnel.
//!
//! Each song seeds the picks, so a song shows the same scenes, in the same
//! looks, every time it plays. When the music stops dead and comes back,
//! it cuts as on a drop (`music.rs` lands one there).
//!
//! Without an analysis, scenes change when the music surges, or after a
//! while on a kick.
//!
//! Each change destroys the old scene's last frame, frozen, while the new
//! scene shows through (`final.glsl`), in the way the moment asks for, over
//! a number of beats: a drop shatters it on its beat, a riser's end rushes
//! through it, a chorus coming back datamoshes into its scene, a part
//! falling quieter melts it away, and a calm change wipes it slowly. The
//! server's choreography names the kind for each section's start
//! (`cues.rs`); without one, it is guessed from how the intensity moves.
//!
//! The climax (the song's biggest stretch, from the choreography) gets one
//! of the wildest scenes the song may show (the song's seed picks which,
//! among those near the wildest), and keeps it to its end. Only scenes
//! the renderer can draw now are picked (`set_available`): some need
//! content that loads with each song.

use std::collections::HashMap;

use super::music::{Music, SectionNow};
use crate::catalog::TransitionKind;

/// One scene the engine can draw.
pub struct SceneSpec {
    pub name: &'static str,
    /// The music it suits, 0 calm to 1 wild.
    pub energy: f32,
}

/// Every scene, in the order of `gpu::SCENE_SHADERS`.
pub const SCENES: [SceneSpec; 11] = [
    SceneSpec {
        name: "Silk",
        energy: 0.1,
    },
    SceneSpec {
        name: "Ink",
        energy: 0.32,
    },
    SceneSpec {
        name: "Terrain",
        energy: 0.55,
    },
    SceneSpec {
        name: "Halo",
        energy: 0.72,
    },
    SceneSpec {
        name: "Tunnel",
        energy: 0.92,
    },
    SceneSpec {
        name: "Aurora",
        energy: 0.2,
    },
    SceneSpec {
        name: "Stars",
        energy: 0.82,
    },
    SceneSpec {
        name: "Swarm",
        energy: 0.8,
    },
    SceneSpec {
        name: "Coral",
        energy: 0.4,
    },
    SceneSpec {
        name: "Diorama",
        energy: 0.6,
    },
    // The song's own pictures, cut to the beat (montage.rs): only once the
    // song's montage has loaded (`Renderer::can_draw`).
    SceneSpec {
        name: "Montage",
        energy: 0.75,
    },
];

/// The scene that shows the song's own pictures (`montage.rs`).
pub const MONTAGE: usize = scene_index("Montage");

/// The place in `SCENES` of the scene called `name`, worked out when the
/// code compiles, so code can name a scene instead of counting to it.
pub const fn scene_index(name: &str) -> usize {
    let name = name.as_bytes();
    let mut index = 0;
    while index < SCENES.len() {
        let other = SCENES[index].name.as_bytes();
        if other.len() == name.len() {
            let mut at = 0;
            while at < name.len() && other[at] == name[at] {
                at += 1;
            }
            if at == name.len() {
                return index;
            }
        }
        index += 1;
    }
    panic!("no scene by that name");
}

/// A phrase, in bars: a scene that has shown a while moves on at the end
/// of one, counted from when it came on.
const PHRASE_BARS: u32 = 16;
/// Seconds a scene shows before it moves on when the music is calm; busy
/// music moves on at its first phrase.
const CALM_SECONDS: f32 = 45.0;
/// Seconds after which a scene moves on at half a phrase: one that has
/// held this long found every phrase near a section's end.
const LONGEST_SECONDS: f32 = 120.0;
/// A section this close to its end keeps its scene: the next section
/// brings a new one soon enough.
const LAST_BARS: f32 = 8.0;
/// Without an analysis: seconds before a surge may change the scene, and
/// before a kick will.
const LIVE_MIN: f32 = 14.0;
const LIVE_MAX: f32 = 40.0;
/// How long a new song's scene takes to melt in over the last song's.
const NEW_SONG_SECONDS: f32 = 1.6;
/// The shortest and longest a change of scene lasts, however fast or slow
/// the beat.
const SHORTEST_CHANGE: f32 = 0.35;
const LONGEST_CHANGE: f32 = 4.0;
/// The climax may show a scene this much wilder than the song's ceiling,
/// and no more: a ballad's climax stays calm.
const CLIMAX_REACH: f32 = 0.1;
/// The climax picks among the scenes this close to the wildest it may
/// show, so it isn't always the same one (Tunnel, Stars, and Swarm).
const CLIMAX_BAND: f32 = 0.15;

/// A scene showing, and the look it was given.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Showing {
    pub scene: usize,
    pub seed: f32,
    /// Seconds since it came on.
    pub age: f32,
}

/// What to draw this frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shot {
    /// The scene showing; while another takes over, the one leaving, whose
    /// last frame stays frozen.
    pub current: Showing,
    /// The scene taking over, and how far (0 to 1).
    pub next: Option<(Showing, f32)>,
    /// How the scene taking over destroys the frozen one (`Cut` when none
    /// is).
    pub kind: TransitionKind,
}

/// The beats each kind of change takes when nothing says otherwise.
fn usual_beats(kind: TransitionKind) -> f32 {
    match kind {
        TransitionKind::Cut => 0.0,
        TransitionKind::Shatter | TransitionKind::ZoomThrough => 2.0,
        TransitionKind::Melt | TransitionKind::Datamosh | TransitionKind::Wipe => 4.0,
    }
}

pub struct Director {
    current: Showing,
    /// The scene taking over: how far, over how many seconds, and how.
    next: Option<(Showing, f32, f32)>,
    kind: TransitionKind,
    /// The scenes the renderer can draw now, in the order of `SCENES`.
    available: [bool; SCENES.len()],
    /// The intensity the section before aimed for, to tell a part rising
    /// from one falling.
    aim: f32,
    /// True once the climax has its scene, until it ends.
    in_climax: bool,
    /// The scene and look each group of sections got.
    by_group: HashMap<u32, (usize, f32)>,
    recent: Vec<usize>,
    /// Every scene this song has shown, so it moves on to new ones while
    /// others fit.
    shown: Vec<usize>,
    section: Option<usize>,
    /// Bars since the latest scene came on.
    bars_on_scene: u32,
    random: u32,
    song: Option<String>,
}

impl Director {
    pub fn new(seed: u32) -> Self {
        let mut director = Self {
            current: Showing {
                scene: 0,
                seed: 0.0,
                age: 0.0,
            },
            next: None,
            kind: TransitionKind::Cut,
            available: [true; SCENES.len()],
            aim: 0.0,
            in_climax: false,
            by_group: HashMap::new(),
            recent: Vec::new(),
            shown: Vec::new(),
            section: None,
            bars_on_scene: 0,
            random: seed | 1,
            song: None,
        };
        director.current.seed = director.unit();
        director
    }

    fn unit(&mut self) -> f32 {
        self.random ^= self.random << 13;
        self.random ^= self.random >> 17;
        self.random ^= self.random << 5;
        (self.random >> 8) as f32 / (1 << 24) as f32
    }

    /// The scene playing now, or the one taking over.
    fn latest(&self) -> usize {
        self.next
            .map_or(self.current.scene, |(next, _, _)| next.scene)
    }

    /// The best scene for music this intense, other than the one showing,
    /// avoiding those this song has shown, the last two most, where
    /// another fits nearly as well.
    fn pick(&mut self, target: f32) -> usize {
        self.pick_avoiding(target, None)
    }

    /// As `pick`, and not `avoid` either unless nothing else suits.
    fn pick_avoiding(&mut self, target: f32, avoid: Option<usize>) -> usize {
        // Before any song, nothing shows yet: every scene may come on.
        let latest = self.song.is_some().then(|| self.latest());
        let jitter: Vec<f32> = (0..SCENES.len()).map(|_| self.unit() * 0.12).collect();
        let fit = |scene: usize| (SCENES[scene].energy - target).abs() + jitter[scene];
        let recent: Vec<usize> = self.recent.iter().rev().take(2).copied().collect();
        // A scene this song has shown costs a little, a recent one a little
        // more, not everything: a calm song has only a few scenes that
        // suit it, and a chorus coming back keeps its own. One far wilder
        // than the music is a last resort.
        let cost = |scene: usize| {
            let energy = SCENES[scene].energy;
            fit(scene)
                + if self.shown.contains(&scene) {
                    0.3
                } else {
                    0.0
                }
                + if recent.contains(&scene) { 0.15 } else { 0.0 }
                + if Some(scene) == avoid { 1.0 } else { 0.0 }
                + if energy > target + 0.3 { 10.0 } else { 0.0 }
        };
        (0..SCENES.len())
            .filter(|scene| Some(*scene) != latest && self.available[*scene])
            .min_by(|a, b| cost(*a).total_cmp(&cost(*b)))
            .unwrap_or(self.current.scene)
    }

    /// Only these scenes may be picked from now on: the renderer can draw
    /// them (their shader compiled, and any content they need has loaded).
    pub fn set_available(&mut self, available: [bool; SCENES.len()]) {
        self.available = available;
    }

    /// One of the wildest scenes that may show now, for the climax: the
    /// song's ceiling caps it, so a ballad's climax is wild for a ballad.
    fn wildest(&mut self, ceiling: f32) -> Option<usize> {
        let allowed: Vec<usize> = (0..SCENES.len())
            .filter(|scene| self.available[*scene])
            .filter(|scene| SCENES[*scene].energy <= ceiling + CLIMAX_REACH)
            .collect();
        let top = allowed
            .iter()
            .map(|scene| SCENES[*scene].energy)
            .max_by(f32::total_cmp)?;
        let near: Vec<usize> = allowed
            .into_iter()
            .filter(|scene| SCENES[*scene].energy >= top - CLIMAX_BAND)
            .collect();
        let at = ((self.unit() * near.len() as f32) as usize).min(near.len() - 1);
        Some(near[at])
    }

    /// Move to `scene` the way `kind` does, over `beats` beats of
    /// `beat_seconds`.
    fn change_by(
        &mut self,
        scene: usize,
        seed: f32,
        kind: TransitionKind,
        beats: f32,
        beat_seconds: f32,
    ) {
        let seconds = if kind == TransitionKind::Cut {
            0.0
        } else {
            (beats * beat_seconds).clamp(SHORTEST_CHANGE, LONGEST_CHANGE)
        };
        self.change(scene, seed, seconds, kind);
    }

    /// Move to `scene` over `seconds` (0 cuts at once), the way `kind` does.
    fn change(&mut self, scene: usize, seed: f32, seconds: f32, kind: TransitionKind) {
        if scene == self.latest() {
            return;
        }
        self.kind = kind;
        if let Some((next, _, _)) = self.next.take() {
            // A change during a change: the one coming in is now current.
            self.current = next;
        }
        self.recent.push(self.current.scene);
        if self.recent.len() > 6 {
            self.recent.remove(0);
        }
        self.bars_on_scene = 0;
        if !self.shown.contains(&scene) {
            self.shown.push(scene);
        }
        let showing = Showing {
            scene,
            seed,
            age: 0.0,
        };
        if seconds <= 0.0 {
            self.current = showing;
        } else {
            self.next = Some((showing, 0.0, seconds));
        }
    }

    /// Move on from a scene that has shown a while, within a section of
    /// `group`, to a new one that is not the one before it either. The
    /// rest of the section, and any after it in its group, keep it.
    fn move_on(&mut self, group: u32, target: f32, kind: TransitionKind, music: &Music) {
        let before = self.recent.last().copied();
        let scene = self.pick_avoiding(target, before);
        let seed = self.unit();
        self.by_group.insert(group, (scene, seed));
        self.change_by(scene, seed, kind, usual_beats(kind), music.beat_seconds);
    }

    /// How a scene that has shown a while moves on: a slow wipe in calm
    /// music, a datamosh in busy music.
    fn moving_on(target: f32) -> TransitionKind {
        if target >= 0.6 {
            TransitionKind::Datamosh
        } else {
            TransitionKind::Wipe
        }
    }

    /// The scene for a section: its group's scene if it had one before
    /// (and it can still be drawn).
    fn for_section(&mut self, section: SectionNow, target: f32) -> (usize, f32) {
        if let Some(&chosen) = self.by_group.get(&section.group)
            && self.available[chosen.0]
        {
            return chosen;
        }
        let chosen = (self.pick(target), self.unit());
        self.by_group.insert(section.group, chosen);
        chosen
    }

    /// The scene for a section, or for the climax landing in it: the
    /// wildest scene the song may show, which its group keeps.
    fn for_moment(&mut self, music: &Music, section: SectionNow, target: f32) -> (usize, f32) {
        if music.parts.cue.climax > 0.0
            && !self.in_climax
            && let Some(scene) = self.wildest(music.ceiling)
        {
            self.in_climax = true;
            let chosen = match self.by_group.get(&section.group) {
                Some(&(held, seed)) if held == scene => (held, seed),
                _ => (scene, self.unit()),
            };
            self.by_group.insert(section.group, chosen);
            return chosen;
        }
        self.for_section(section, target)
    }

    /// How a section starts: as the choreography says, or else by how
    /// the intensity moves: up rushes through, down melts, a part coming
    /// back datamoshes, the rest wipe (slowly when calm).
    fn section_change(
        &self,
        music: &Music,
        section: SectionNow,
        aim: f32,
    ) -> (TransitionKind, f32) {
        if let Some((kind, beats)) = music.parts.cue.transition {
            return (kind, beats);
        }
        let kind = if aim > self.aim + 0.2 {
            TransitionKind::ZoomThrough
        } else if aim < self.aim - 0.15 {
            TransitionKind::Melt
        } else if self.by_group.contains_key(&section.group) {
            TransitionKind::Datamosh
        } else {
            TransitionKind::Wipe
        };
        let calm = kind == TransitionKind::Wipe && aim < 0.4;
        (kind, if calm { 8.0 } else { usual_beats(kind) })
    }

    /// Decide this frame's shot.
    pub fn direct(&mut self, music: &Music, song: Option<&str>) -> Shot {
        let dt = music.dt;
        self.current.age += dt;
        if let Some((next, progress, seconds)) = &mut self.next {
            next.age += dt;
            *progress += dt / *seconds;
            if *progress >= 1.0 {
                self.current = *next;
                self.next = None;
            }
        }
        if music.on_downbeat {
            self.bars_on_scene += 1;
        }
        // The intensity this section is heading for: the analysis knows it
        // at once, while `music.intensity` eases toward it.
        let aim = music.section.map_or(music.intensity, |section| {
            music.ceiling * super::music::section_intensity(section.kind, section.energy)
        });
        if self.in_climax && music.parts.cue.climax <= 0.0 {
            self.in_climax = false;
        }

        let beat = music.beat_seconds;
        let section_now = music.section.map(|section| section.index);
        if song != self.song.as_deref() {
            // A new song: its first section's scene, or one for what is
            // heard until the analysis comes. The very first song fades in
            // on it, with nothing before to change from; later ones melt
            // the last song's scene away.
            let first_song = self.song.is_none();
            self.by_group.clear();
            self.shown.clear();
            self.in_climax = false;
            // The song picks its own scenes and looks: the same each time
            // it plays, its own beside every other song.
            if let Some(id) = song {
                let folded = id.bytes().fold(0x811c_9dc5u32, |sum, byte| {
                    (sum ^ u32::from(byte)).wrapping_mul(0x0100_0193)
                });
                self.random = super::motion::hash(folded) | 1;
            }
            self.section = section_now;
            if song.is_some() {
                let (scene, seed) = match music.section {
                    Some(section) => self.for_section(section, aim),
                    None => (self.pick(music.intensity.max(0.2)), self.unit()),
                };
                self.song = song.map(str::to_owned);
                if first_song {
                    self.shown.push(scene);
                    self.current = Showing {
                        scene,
                        seed,
                        age: 0.0,
                    };
                    self.next = None;
                    self.bars_on_scene = 0;
                } else {
                    self.change(scene, seed, NEW_SONG_SECONDS, TransitionKind::Melt);
                }
            } else {
                self.song = None;
            }
        } else if music.drop_landed {
            // As wild as this song gets: a piano piece's swell is no club
            // track's drop. The old picture shatters on the drop's beat.
            let wild = aim.max(0.85 * music.ceiling);
            let shatter = TransitionKind::Shatter;
            // The climax landing on this drop wins over everything else,
            // even a stop ending on the same frame (`for_moment`).
            let climax_lands = music.parts.cue.climax > 0.0 && !self.in_climax;
            match music.section {
                // The music came back after a stop, within a section that
                // already has its scene: move on, as if it were new.
                Some(section)
                    if music.parts.stop_ended
                        && !climax_lands
                        && !self.in_climax
                        && section_now == self.section
                        && section.left > beat * 4.0 * 4.0 =>
                {
                    self.move_on(section.group, wild, shatter, music);
                }
                Some(section) => {
                    let (scene, seed) = self.for_moment(music, section, wild);
                    self.change_by(scene, seed, shatter, usual_beats(shatter), beat);
                }
                None => {
                    let (scene, seed) = (self.pick(wild), self.unit());
                    self.change_by(scene, seed, shatter, usual_beats(shatter), beat);
                }
            }
            self.section = section_now;
            self.aim = aim;
        } else if section_now != self.section {
            let first = self.section.is_none();
            self.section = section_now;
            if let Some(section) = music.section {
                // The analysis arrived after the song started: keep the
                // scene showing if it suits this section.
                if first
                    && self.current.age < 8.0
                    && (SCENES[self.latest()].energy - aim).abs() < 0.2
                    && !self.by_group.contains_key(&section.group)
                {
                    let seed = self.current.seed;
                    self.by_group.insert(section.group, (self.latest(), seed));
                } else {
                    let (kind, beats) = self.section_change(music, section, aim);
                    let (scene, seed) = self.for_moment(music, section, aim);
                    if scene == self.latest()
                        && self.next.is_none()
                        && self.current.age >= LONGEST_SECONDS
                        && !self.in_climax
                    {
                        // Held for minutes through sections that share it,
                        // none with a phrase far enough from its end: a
                        // section's start is a phrase too.
                        self.move_on(section.group, aim, kind, music);
                    } else {
                        self.change_by(scene, seed, kind, beats, beat);
                    }
                }
            }
            self.aim = aim;
        } else if let Some(section) = music.section
            && music.on_downbeat
            && self.next.is_none()
            && !self.in_climax
        {
            // A scene that has shown a while moves on at a phrase (the
            // climax keeps its scene to its end).
            let shown = self.current.age;
            let phrase = if shown >= LONGEST_SECONDS {
                PHRASE_BARS / 2
            } else {
                PHRASE_BARS
            };
            let due = aim >= 0.4 || shown >= CALM_SECONDS;
            let bar_seconds = beat * 4.0;
            if due
                && self.bars_on_scene > 0
                && self.bars_on_scene.is_multiple_of(phrase)
                && section.left > bar_seconds * LAST_BARS
            {
                self.move_on(section.group, aim, Self::moving_on(aim), music);
            }
        } else if music.section.is_none() {
            let age = self.current.age;
            if (music.surge && age > LIVE_MIN) || (music.on_downbeat && age > LIVE_MAX) {
                let scene = self.pick(music.intensity);
                let seed = self.unit();
                let kind = if music.surge {
                    TransitionKind::ZoomThrough
                } else {
                    TransitionKind::Wipe
                };
                self.change_by(scene, seed, kind, usual_beats(kind), beat);
            }
        }

        Shot {
            current: self.current,
            next: self
                .next
                .map(|(next, progress, _)| (next, progress.clamp(0.0, 1.0))),
            kind: if self.next.is_some() {
                self.kind
            } else {
                TransitionKind::Cut
            },
        }
    }

    /// Move on to the next scene now, whatever the music: for screenshots.
    #[cfg(feature = "screenshots")]
    pub fn skip(&mut self) {
        let scene = (self.latest() + 1) % SCENES.len();
        let seed = self.unit();
        self.change(scene, seed, 0.0, TransitionKind::Cut);
    }
}

#[cfg(test)]
mod tests {
    use super::super::music::Parts;
    use super::*;
    use crate::catalog::SectionKind;

    fn music(section: Option<SectionNow>) -> Music {
        Music {
            time: 0.0,
            dt: 1.0 / 60.0,
            drive: 0.0,
            beats: 0.0,
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
            section,
            live: true,
            analyzed: true,
            parts: Parts::default(),
        }
    }

    fn section(index: usize, kind: SectionKind, group: u32, energy: f32) -> Option<SectionNow> {
        Some(SectionNow {
            index,
            kind,
            group,
            energy,
            left: 60.0,
        })
    }

    /// Run until any change of scene has finished.
    fn settle(director: &mut Director, frame: &Music) -> Shot {
        let mut shot = director.direct(frame, Some("song"));
        for _ in 0..300 {
            shot = director.direct(frame, Some("song"));
        }
        shot
    }

    #[test]
    fn a_returning_chorus_gets_its_scene_back() {
        let mut director = Director::new(7);
        settle(
            &mut director,
            &music(section(0, SectionKind::Verse, 0, 0.4)),
        );
        let chorus = settle(
            &mut director,
            &music(section(1, SectionKind::Chorus, 1, 0.9)),
        )
        .current;
        settle(
            &mut director,
            &music(section(2, SectionKind::Verse, 0, 0.4)),
        );
        let again = settle(
            &mut director,
            &music(section(3, SectionKind::Chorus, 1, 0.9)),
        )
        .current;
        assert_eq!((chorus.scene, chorus.seed), (again.scene, again.seed));
        assert!(
            SCENES[chorus.scene].energy >= 0.5,
            "{}",
            SCENES[chorus.scene].name
        );
    }

    #[test]
    fn a_song_shows_new_scenes_before_any_comes_back() {
        // Sections of a song, each its own group: while scenes that suit
        // are left, none shows twice. "Too Long" showed Silk and Ink twice.
        for seed in 1..30 {
            // A calm song has four scenes that suit it, a wild one more.
            let songs: [(&[f32], f32); 2] = [
                (&[0.2, 0.42, 0.77, 1.0], 0.4),
                (&[0.3, 0.6, 0.9, 0.5, 1.0], 1.0),
            ];
            for (energies, ceiling) in songs {
                let mut director = Director::new(seed);
                let mut seen = Vec::new();
                for (index, &energy) in energies.iter().enumerate() {
                    let mut frame = music(section(index, SectionKind::Verse, index as u32, energy));
                    frame.ceiling = ceiling;
                    let scene = settle(&mut director, &frame).current.scene;
                    assert!(
                        !seen.contains(&scene),
                        "seed {seed}: {} again after {:?}",
                        SCENES[scene].name,
                        seen.iter()
                            .map(|scene: &usize| SCENES[*scene].name)
                            .collect::<Vec<_>>()
                    );
                    seen.push(scene);
                }
            }
        }
    }

    #[test]
    fn a_drop_shatters_into_a_wild_scene_on_its_beat() {
        let mut director = Director::new(3);
        let before = settle(
            &mut director,
            &music(section(0, SectionKind::Intro, 0, 0.2)),
        )
        .current;
        let mut landing = music(section(1, SectionKind::Drop, 1, 1.0));
        landing.drop_landed = true;
        let shot = director.direct(&landing, Some("song"));
        // The old scene stays, frozen, while the new one shatters it from
        // this very frame, over two beats.
        assert_eq!(shot.kind, TransitionKind::Shatter);
        assert_eq!(shot.current.scene, before.scene);
        let (next, progress) = shot.next.expect("a change");
        assert!(progress < 0.05, "{progress}");
        assert!(
            SCENES[next.scene].energy >= 0.7,
            "{}",
            SCENES[next.scene].name
        );
        let mut frames = 1;
        let mut after = landing.clone();
        after.drop_landed = false;
        while director.direct(&after, Some("song")).next.is_some() {
            frames += 1;
        }
        // Two beats of half a second, at 60 frames a second.
        assert!((59..=61).contains(&frames), "{frames} frames");
    }

    #[test]
    fn each_section_changes_the_way_the_choreography_says() {
        use super::super::cues::Cues;
        let mut director = Director::new(6);
        settle(
            &mut director,
            &music(section(0, SectionKind::Verse, 0, 0.6)),
        );
        let mut chorus = music(section(1, SectionKind::Chorus, 1, 0.9));
        chorus.parts.cue = Cues {
            transition: Some((TransitionKind::Datamosh, 4.0)),
            ..Cues::default()
        };
        let shot = director.direct(&chorus, Some("song"));
        assert_eq!(shot.kind, TransitionKind::Datamosh);
        let frames = 1
            + (0..400)
                .take_while(|_| director.direct(&chorus, Some("song")).next.is_some())
                .count();
        assert!((119..=121).contains(&frames), "{frames} frames");
        // Without a plan: falling quieter melts, rising rushes through.
        let shot = director.direct(
            &music(section(2, SectionKind::Breakdown, 2, 0.2)),
            Some("song"),
        );
        assert_eq!(shot.kind, TransitionKind::Melt);
        settle(
            &mut director,
            &music(section(2, SectionKind::Breakdown, 2, 0.2)),
        );
        let shot = director.direct(&music(section(3, SectionKind::Drop, 3, 1.0)), Some("song"));
        assert_eq!(shot.kind, TransitionKind::ZoomThrough);
    }

    #[test]
    fn only_scenes_the_renderer_can_draw_are_picked() {
        for seed in 1..20 {
            let mut director = Director::new(seed);
            // Halo, Tunnel, and Stars are still loading.
            let mut available = [true; SCENES.len()];
            for name in ["Halo", "Tunnel", "Stars"] {
                available[SCENES.iter().position(|scene| scene.name == name).unwrap()] = false;
            }
            director.set_available(available);
            for (index, (kind, energy)) in [
                (SectionKind::Intro, 0.2),
                (SectionKind::Drop, 1.0),
                (SectionKind::Verse, 0.6),
                (SectionKind::Drop, 1.0),
            ]
            .into_iter()
            .enumerate()
            {
                let mut frame = music(section(index, kind, index as u32, energy));
                frame.drop_landed = kind == SectionKind::Drop;
                let shot = settle(&mut director, &frame);
                assert!(
                    available[shot.current.scene],
                    "seed {seed}: {}",
                    SCENES[shot.current.scene].name
                );
            }
        }
    }

    #[test]
    fn the_climax_gets_one_of_the_wildest_scenes_and_keeps_it() {
        use super::super::cues::Cues;
        let wild = |scene: usize| SCENES[scene].energy >= 0.92 - CLIMAX_BAND;
        let mut director = Director::new(2);
        settle(
            &mut director,
            &music(section(0, SectionKind::Verse, 0, 0.7)),
        );
        let mut climax = music(section(1, SectionKind::Chorus, 1, 1.0));
        climax.parts.cue = Cues {
            climax: 1.0,
            transition: Some((TransitionKind::Shatter, 2.0)),
            ..Cues::default()
        };
        let shot = settle(&mut director, &climax);
        let chosen = shot.current.scene;
        assert!(wild(chosen), "{}", SCENES[chosen].name);
        // A phrase later, it is still the climax's scene.
        for _ in 0..40 {
            let mut downbeat = climax.clone();
            downbeat.on_downbeat = true;
            director.direct(&downbeat, Some("song"));
            let shot = settle(&mut director, &climax);
            assert_eq!(shot.current.scene, chosen);
        }
        // A ballad's climax is wild for a ballad, no more.
        let mut director = Director::new(2);
        let ceiling = super::super::music::intensity_ceiling(0.05);
        let mut verse = music(section(0, SectionKind::Verse, 0, 0.7));
        verse.ceiling = ceiling;
        settle(&mut director, &verse);
        climax.ceiling = ceiling;
        let shot = settle(&mut director, &climax);
        assert!(
            SCENES[shot.current.scene].energy < 0.6,
            "{}",
            SCENES[shot.current.scene].name
        );
    }

    #[test]
    fn songs_climax_on_different_wild_scenes() {
        use super::super::cues::Cues;
        // Each song seeds the picks, so the songs differ, not the TVs.
        let mut seen = std::collections::HashSet::new();
        for song in 0..40 {
            let song = format!("song {song}");
            let mut director = Director::new(1);
            let mut play = |frame: &Music| {
                let mut shot = director.direct(frame, Some(&song));
                for _ in 0..300 {
                    shot = director.direct(frame, Some(&song));
                }
                shot
            };
            play(&music(section(0, SectionKind::Verse, 0, 0.7)));
            let mut climax = music(section(1, SectionKind::Chorus, 1, 1.0));
            climax.parts.cue = Cues {
                climax: 1.0,
                transition: Some((TransitionKind::Shatter, 2.0)),
                ..Cues::default()
            };
            seen.insert(SCENES[play(&climax).current.scene].name);
        }
        for name in ["Tunnel", "Stars", "Swarm"] {
            assert!(seen.contains(name), "{name} never: {seen:?}");
        }
    }

    #[test]
    fn the_music_coming_back_after_a_stop_shatters_into_a_new_scene() {
        let mut director = Director::new(12);
        let verse = music(section(0, SectionKind::Verse, 0, 0.8));
        let before = settle(&mut director, &verse).current.scene;
        let mut back = verse.clone();
        back.drop_landed = true;
        back.parts.stop_ended = true;
        let shot = director.direct(&back, Some("song"));
        assert_eq!(shot.kind, TransitionKind::Shatter);
        assert_ne!(shot.next.expect("a change").0.scene, before);
    }

    #[test]
    fn the_climax_wins_over_a_stop_ending_on_its_drop() {
        use super::super::cues::Cues;
        let wild = |scene: usize| SCENES[scene].energy >= 0.92 - CLIMAX_BAND;
        for seed in 1..20 {
            let mut director = Director::new(seed);
            // The climax lands within a section that already has its scene,
            // on the very frame the music comes back after a stop.
            let verse = music(section(0, SectionKind::Chorus, 0, 0.8));
            settle(&mut director, &verse);
            let mut back = verse.clone();
            back.drop_landed = true;
            back.parts.stop_ended = true;
            back.parts.cue = Cues {
                climax: 1.0,
                ..Cues::default()
            };
            let shot = director.direct(&back, Some("song"));
            let scene = shot.next.map_or(shot.current.scene, |(next, _)| next.scene);
            assert!(wild(scene), "{seed}: {}", SCENES[scene].name);
            assert!(director.in_climax, "{seed}");
        }
    }

    #[test]
    fn a_calm_songs_drop_stays_calm() {
        for seed in 1..20 {
            let mut director = Director::new(seed);
            let mut verse = music(section(0, SectionKind::Verse, 0, 0.4));
            verse.ceiling = super::super::music::intensity_ceiling(0.05);
            settle(&mut director, &verse);
            let mut landing = music(section(1, SectionKind::Drop, 1, 1.0));
            landing.ceiling = verse.ceiling;
            landing.drop_landed = true;
            let shot = director.direct(&landing, Some("song"));
            assert!(
                SCENES[shot.current.scene].energy < 0.6,
                "seed {seed}: {}",
                SCENES[shot.current.scene].name
            );
        }
    }

    #[test]
    fn calm_sections_get_calm_scenes() {
        let mut director = Director::new(11);
        let shot = settle(
            &mut director,
            &music(section(0, SectionKind::Intro, 0, 0.2)),
        );
        assert!(
            SCENES[shot.current.scene].energy <= 0.35,
            "{}",
            SCENES[shot.current.scene].name
        );
    }

    #[test]
    fn a_ballads_loudest_chorus_stays_calm() {
        // A piano song: its chorus is its loudest part, but its drive caps
        // how wild it may look.
        for seed in 1..20 {
            let mut director = Director::new(seed);
            for (index, kind, energy) in [
                (0, SectionKind::Verse, 0.5),
                (1, SectionKind::Chorus, 1.0),
                (2, SectionKind::Verse, 0.6),
                (3, SectionKind::Chorus, 1.0),
            ] {
                let mut frame = music(section(index, kind, index as u32, energy));
                frame.ceiling = super::super::music::intensity_ceiling(0.05);
                let shot = settle(&mut director, &frame);
                assert!(
                    SCENES[shot.current.scene].energy < 0.6,
                    "seed {seed}: {}",
                    SCENES[shot.current.scene].name
                );
            }
        }
    }

    #[test]
    fn the_first_section_picks_once() {
        // The song starts with its analysis: straight into the scene the
        // first section gets, not a guess and then a second change.
        let mut director = Director::new(9);
        let intro = music(section(0, SectionKind::Intro, 0, 0.2));
        let first = director.direct(&intro, Some("song"));
        assert!(first.next.is_none());
        assert!(SCENES[first.current.scene].energy <= 0.35);
        let mut changes = 0;
        let mut latest = first.current.scene;
        for _ in 0..300 {
            let shot = director.direct(&intro, Some("song"));
            let now = shot.next.map_or(shot.current.scene, |(next, _)| next.scene);
            if now != latest {
                changes += 1;
                latest = now;
            }
        }
        assert_eq!(changes, 0);
    }

    #[test]
    fn a_long_section_moves_on_at_a_phrase_and_not_near_its_end() {
        let mut director = Director::new(4);
        let verse = |left: f32| {
            let mut frame = music(section(0, SectionKind::Verse, 0, 0.8));
            frame.section = frame.section.map(|section| SectionNow { left, ..section });
            frame
        };
        settle(&mut director, &verse(60.0));
        let downbeat = |director: &mut Director, left: f32| {
            let mut frame = verse(left);
            frame.on_downbeat = true;
            let shot = director.direct(&frame, Some("song"));
            settle(director, &verse(left));
            shot
        };
        let start = director.direct(&verse(60.0), Some("song")).current.scene;
        // Bars 1 to 15: no change.
        for _ in 1..16 {
            let shot = downbeat(&mut director, 50.0);
            assert_eq!(shot.current.scene, start);
            assert!(shot.next.is_none());
        }
        // Bar 16, with plenty of the section left: a new scene.
        let shot = downbeat(&mut director, 50.0);
        assert!(shot.next.is_some());
        let moved = settle(&mut director, &verse(40.0)).current.scene;
        // Bar 32, but the section ends within 8 bars: it stays.
        for _ in 17..32 {
            downbeat(&mut director, 40.0);
        }
        let shot = downbeat(&mut director, 10.0);
        assert!(shot.next.is_none());
        assert_eq!(shot.current.scene, moved);
    }

    /// One frame on the first beat of a bar, a bar of `bar_seconds` after
    /// the last, `at` bars into a section of `bars`.
    #[allow(clippy::too_many_arguments)]
    fn bar(
        director: &mut Director,
        index: usize,
        kind: SectionKind,
        group: u32,
        energy: f32,
        (at, bars): (u32, u32),
        bar_seconds: f32,
        ceiling: f32,
    ) -> Shot {
        let mut frame = music(section(index, kind, group, energy));
        frame.dt = bar_seconds;
        frame.beat_seconds = bar_seconds / 4.0;
        frame.on_downbeat = true;
        frame.ceiling = ceiling;
        frame.section = frame.section.map(|section| SectionNow {
            left: (bars - at) as f32 * bar_seconds,
            ..section
        });
        director.direct(&frame, Some("song"))
    }

    fn latest(shot: &Shot) -> usize {
        shot.next.map_or(shot.current.scene, |(next, _)| next.scene)
    }

    #[test]
    fn a_scene_shared_by_sections_in_a_row_moves_on_at_a_phrase() {
        // "Too Long" (Gonzales): at 70 BPM, a chorus of 8 bars, then the
        // same chorus for 20. Its scene held both, half the song; now it
        // moves on at its 16th bar, the second chorus's 8th.
        let ceiling = super::super::music::intensity_ceiling(0.023);
        let bar_seconds = 3.4;
        for seed in 1..30 {
            let mut director = Director::new(seed);
            let mut verse = 0;
            for at in 0..10 {
                let shot = bar(
                    &mut director,
                    0,
                    SectionKind::Verse,
                    0,
                    0.42,
                    (at, 10),
                    bar_seconds,
                    ceiling,
                );
                verse = latest(&shot);
            }
            let mut chorus = None;
            let mut moved = None;
            for (index, bars) in [(1, 8), (2, 20)] {
                for at in 0..bars {
                    let shot = bar(
                        &mut director,
                        index,
                        SectionKind::Chorus,
                        1,
                        if index == 1 { 0.77 } else { 1.0 },
                        (at, bars),
                        bar_seconds,
                        ceiling,
                    );
                    let now = latest(&shot);
                    let first = *chorus.get_or_insert(now);
                    if now != first && moved.is_none() {
                        moved = Some((index, at, now));
                    }
                }
            }
            let chorus = chorus.expect("a chorus");
            assert_ne!(chorus, verse, "seed {seed}");
            let Some((index, at, now)) = moved else {
                panic!("seed {seed}: {} held both choruses", SCENES[chorus].name);
            };
            assert_eq!((index, at), (2, 8), "seed {seed}");
            assert_ne!(now, verse, "seed {seed}: back to the scene before");
        }
    }

    #[test]
    fn a_calm_scene_moves_on_at_the_first_phrase_past_its_time() {
        // 120 BPM, calm: 16 bars is 32 seconds, too soon; 32 bars is 64.
        let mut director = Director::new(5);
        let mut changes = Vec::new();
        let mut last = None;
        for at in 0..60 {
            let shot = bar(
                &mut director,
                0,
                SectionKind::Intro,
                0,
                0.2,
                (at, 100),
                2.0,
                1.0,
            );
            let now = latest(&shot);
            if last.is_some_and(|last| last != now) {
                changes.push(at);
            }
            last = Some(now);
        }
        assert_eq!(changes, vec![32]);
    }

    #[test]
    fn a_scene_held_for_minutes_moves_on_where_a_section_starts() {
        // Calm sections of 12 bars, all one group: every 16-bar phrase
        // falls in a section's last 8 bars. After two minutes the scene
        // moves on anyway, at a section's start or its 8th bar, never near
        // a section's end.
        let mut director = Director::new(8);
        let mut changes = Vec::new();
        let mut last = None;
        for index in 0..12 {
            for at in 0..12 {
                let shot = bar(
                    &mut director,
                    index,
                    SectionKind::Verse,
                    0,
                    0.2,
                    (at, 12),
                    2.0,
                    1.0,
                );
                let now = latest(&shot);
                if last.is_some_and(|last| last != now) {
                    changes.push((index, at));
                }
                last = Some(now);
            }
        }
        assert!(!changes.is_empty());
        for (index, at) in &changes {
            assert!(*at <= 4, "section {index}, bar {at}");
        }
        let (index, at) = changes[0];
        let seconds = (index * 12 + at as usize) as f32 * 2.0;
        assert!((120.0..150.0).contains(&seconds), "{seconds} s");
    }
}
