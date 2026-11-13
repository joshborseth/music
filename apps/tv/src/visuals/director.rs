//! Picks the scene for each part of the song, like a VJ would.
//!
//! With the server's analysis, scenes change where the music does: at the
//! start of a section, on its first beat. A chorus that comes back gets the
//! same scene (and the same look) it had before, so the song's shape shows
//! on screen. A drop cuts hard, on the beat, to one of the wildest scenes.
//! A long section moves on at a phrase: every 16 bars from its start (24
//! when calm), never in its last 8 bars, where its own end is coming. Calm
//! parts get calm scenes: how wild a part looks is its intensity, which the
//! song's drive caps (`music.rs`), so a ballad never gets the tunnel.
//!
//! Without an analysis, scenes change when the music surges, or after a
//! while on a kick.

use std::collections::HashMap;

use super::music::{Music, SectionNow};

/// One scene the engine can draw.
pub struct SceneSpec {
    pub name: &'static str,
    /// The music it suits, 0 calm to 1 wild.
    pub energy: f32,
}

/// Every scene, in the order of `gpu::SCENE_SHADERS`.
pub const SCENES: [SceneSpec; 5] = [
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
];

/// Bars a scene stays within one section, calm and wild, counted from the
/// section's start so it moves on at a phrase.
const CALM_BARS: u32 = 24;
const BUSY_BARS: u32 = 16;
/// A section this close to its end keeps its scene: the next section
/// brings a new one soon enough.
const LAST_BARS: f32 = 8.0;
/// Without an analysis: seconds before a surge may change the scene, and
/// before a kick will.
const LIVE_MIN: f32 = 14.0;
const LIVE_MAX: f32 = 40.0;
/// The longest a dissolve from one scene to the next lasts (a long section
/// moving on takes half as long again).
const MOST_FADE: f32 = 1.2;

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
    pub current: Showing,
    /// The scene taking over, and how far (0 to 1).
    pub next: Option<(Showing, f32)>,
}

pub struct Director {
    current: Showing,
    next: Option<(Showing, f32, f32)>,
    /// The scene and look each group of sections got.
    by_group: HashMap<u32, (usize, f32)>,
    recent: Vec<usize>,
    section: Option<usize>,
    /// Bars since the section started.
    bars_in_section: u32,
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
            by_group: HashMap::new(),
            recent: Vec::new(),
            section: None,
            bars_in_section: 0,
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
    /// avoiding the last two where another fits nearly as well.
    fn pick(&mut self, target: f32) -> usize {
        // Before any song, nothing shows yet: every scene may come on.
        let latest = self.song.is_some().then(|| self.latest());
        let jitter: Vec<f32> = (0..SCENES.len()).map(|_| self.unit() * 0.12).collect();
        let fit = |scene: usize| (SCENES[scene].energy - target).abs() + jitter[scene];
        let recent: Vec<usize> = self.recent.iter().rev().take(2).copied().collect();
        // A recent scene costs a little, not everything: a calm song has
        // only a couple of scenes that suit it. One far wilder than the
        // music is a last resort.
        let cost = |scene: usize| {
            let energy = SCENES[scene].energy;
            fit(scene)
                + if recent.contains(&scene) { 0.15 } else { 0.0 }
                + if energy > target + 0.3 { 10.0 } else { 0.0 }
        };
        (0..SCENES.len())
            .filter(|scene| Some(*scene) != latest)
            .min_by(|a, b| cost(*a).total_cmp(&cost(*b)))
            .unwrap_or(self.current.scene)
    }

    /// Move to `scene` over `seconds` (0 cuts at once).
    fn change(&mut self, scene: usize, seed: f32, seconds: f32) {
        if scene == self.latest() {
            return;
        }
        if let Some((next, _, _)) = self.next.take() {
            // A change during a change: the one coming in is now current.
            self.current = next;
        }
        self.recent.push(self.current.scene);
        if self.recent.len() > 6 {
            self.recent.remove(0);
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

    /// The scene for a section: its group's scene if it had one before.
    fn for_section(&mut self, section: SectionNow, target: f32) -> (usize, f32) {
        if let Some(&chosen) = self.by_group.get(&section.group) {
            return chosen;
        }
        let chosen = (self.pick(target), self.unit());
        self.by_group.insert(section.group, chosen);
        chosen
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
            self.bars_in_section += 1;
        }
        // The intensity this section is heading for: the analysis knows it
        // at once, while `music.intensity` eases toward it.
        let aim = music.section.map_or(music.intensity, |section| {
            music.ceiling * super::music::section_intensity(section.kind, section.energy)
        });

        // Dissolves last two beats, at most 1.2 seconds: while one runs, both
        // scenes are drawn, taking turns.
        let fade = (music.beat_seconds * 2.0).clamp(0.4, MOST_FADE);
        let section_now = music.section.map(|section| section.index);
        if song != self.song.as_deref() {
            // A new song: its first section's scene, or one for what is
            // heard until the analysis comes. The very first song fades in
            // on it, with nothing before to dissolve from.
            let first_song = self.song.is_none();
            self.by_group.clear();
            self.section = section_now;
            self.bars_in_section = 0;
            if song.is_some() {
                let (scene, seed) = match music.section {
                    Some(section) => self.for_section(section, aim),
                    None => (self.pick(music.intensity.max(0.2)), self.unit()),
                };
                self.song = song.map(str::to_owned);
                if first_song {
                    self.current = Showing {
                        scene,
                        seed,
                        age: 0.0,
                    };
                    self.next = None;
                } else {
                    self.change(scene, seed, MOST_FADE);
                }
            } else {
                self.song = None;
            }
        } else if music.drop_landed {
            // As wild as this song gets: a piano piece's swell is no club
            // track's drop.
            let wild = aim.max(0.85 * music.ceiling);
            let (scene, seed) = match music.section {
                Some(section) => self.for_section(section, wild),
                None => (self.pick(wild), self.unit()),
            };
            self.section = section_now;
            self.bars_in_section = 0;
            self.change(scene, seed, 0.0);
        } else if section_now != self.section {
            let first = self.section.is_none();
            self.section = section_now;
            self.bars_in_section = 0;
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
                    let (scene, seed) = self.for_section(section, aim);
                    self.change(scene, seed, fade);
                }
            }
        } else if let Some(section) = music.section {
            let every = if aim < 0.4 { CALM_BARS } else { BUSY_BARS };
            let bar_seconds = music.beat_seconds * 4.0;
            if music.on_downbeat
                && self.bars_in_section > 0
                && self.bars_in_section.is_multiple_of(every)
                && section.left > bar_seconds * LAST_BARS
            {
                let scene = self.pick(aim);
                let seed = self.unit();
                self.change(scene, seed, fade * 1.5);
            }
        } else {
            let age = self.current.age;
            if (music.surge && age > LIVE_MIN) || (music.on_downbeat && age > LIVE_MAX) {
                let scene = self.pick(music.intensity);
                let seed = self.unit();
                self.change(scene, seed, fade);
            }
        }

        Shot {
            current: self.current,
            next: self
                .next
                .map(|(next, progress, _)| (next, progress.clamp(0.0, 1.0))),
        }
    }

    /// Move on to the next scene now, whatever the music: for screenshots.
    #[cfg(feature = "screenshots")]
    pub fn skip(&mut self) {
        let scene = (self.latest() + 1) % SCENES.len();
        let seed = self.unit();
        self.change(scene, seed, 0.0);
    }
}

#[cfg(test)]
mod tests {
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
        for _ in 0..200 {
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
    fn a_drop_cuts_at_once_to_a_wild_scene() {
        let mut director = Director::new(3);
        settle(
            &mut director,
            &music(section(0, SectionKind::Intro, 0, 0.2)),
        );
        let mut landing = music(section(1, SectionKind::Drop, 1, 1.0));
        landing.drop_landed = true;
        let shot = director.direct(&landing, Some("song"));
        assert!(shot.next.is_none());
        assert!(
            SCENES[shot.current.scene].energy >= 0.7,
            "{}",
            SCENES[shot.current.scene].name
        );
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
}
