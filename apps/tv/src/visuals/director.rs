//! Picks the scene for each part of the song, like a VJ would.
//!
//! With the server's analysis, scenes change where the music does: at the
//! start of a section, on its first beat. A chorus that comes back gets the
//! same scene (and the same look) it had before, so the song's shape shows
//! on screen. A drop cuts hard, on the beat, to one of the wildest scenes.
//! A long section moves on every 16 bars. Calm parts get calm scenes.
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
    /// Only shown when the song has a cover.
    pub needs_cover: bool,
}

/// Every scene, in the order of `gpu::SCENE_SHADERS`.
pub const SCENES: [SceneSpec; 8] = [
    SceneSpec {
        name: "Liquid",
        energy: 0.12,
        needs_cover: true,
    },
    SceneSpec {
        name: "Ink",
        energy: 0.3,
        needs_cover: false,
    },
    SceneSpec {
        name: "Kaleido",
        energy: 0.45,
        needs_cover: false,
    },
    SceneSpec {
        name: "Terrain",
        energy: 0.65,
        needs_cover: false,
    },
    SceneSpec {
        name: "Chrome",
        energy: 0.9,
        needs_cover: false,
    },
    SceneSpec {
        name: "Tunnel",
        energy: 0.85,
        needs_cover: false,
    },
    SceneSpec {
        name: "Halo",
        energy: 0.75,
        needs_cover: false,
    },
    SceneSpec {
        name: "Particles",
        energy: 0.55,
        needs_cover: true,
    },
];

/// Bars a scene stays within one section, calm and wild.
const CALM_BARS: u32 = 24;
const BUSY_BARS: u32 = 16;
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
    bars_here: u32,
    random: u32,
    song: Option<String>,
}

impl Director {
    pub fn new(seed: u32) -> Self {
        let mut director = Self {
            current: Showing {
                scene: 1,
                seed: 0.0,
                age: 0.0,
            },
            next: None,
            by_group: HashMap::new(),
            recent: Vec::new(),
            section: None,
            bars_here: 0,
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

    /// The best scene for music this intense, avoiding the latest few.
    fn pick(&mut self, target: f32, has_cover: bool) -> usize {
        let latest = self.latest();
        let jitter: Vec<f32> = (0..SCENES.len()).map(|_| self.unit() * 0.18).collect();
        let fit = |scene: usize| (SCENES[scene].energy - target).abs() + jitter[scene];
        let usable = |scene: usize| has_cover || !SCENES[scene].needs_cover;
        let recent: Vec<usize> = self.recent.iter().rev().take(2).copied().collect();
        let choose = |avoid: &dyn Fn(usize) -> bool| {
            (0..SCENES.len())
                .filter(|scene| usable(*scene) && *scene != latest && !avoid(*scene))
                .min_by(|a, b| fit(*a).total_cmp(&fit(*b)))
        };
        choose(&|scene| recent.contains(&scene))
            .or_else(|| choose(&|_| false))
            .unwrap_or(latest)
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
        self.bars_here = 0;
        if seconds <= 0.0 {
            self.current = showing;
        } else {
            self.next = Some((showing, 0.0, seconds));
        }
    }

    /// The scene for a section: its group's scene if it had one before.
    fn for_section(&mut self, section: SectionNow, has_cover: bool, wild: bool) -> (usize, f32) {
        if let Some(&(scene, seed)) = self.by_group.get(&section.group)
            && (has_cover || !SCENES[scene].needs_cover)
        {
            return (scene, seed);
        }
        let target = if wild {
            0.9
        } else {
            super::music::section_intensity(section.kind, section.energy)
        };
        let chosen = (self.pick(target, has_cover), self.unit());
        self.by_group.insert(section.group, chosen);
        chosen
    }

    /// Decide this frame's shot.
    pub fn direct(&mut self, music: &Music, song: Option<&str>, has_cover: bool) -> Shot {
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
            self.bars_here += 1;
        }

        // Dissolves last two beats, at most 1.2 seconds: while one runs, both
        // scenes are drawn, taking turns.
        let fade = (music.beat_seconds * 2.0).clamp(0.4, MOST_FADE);
        if song != self.song.as_deref() {
            self.song = song.map(str::to_owned);
            self.by_group.clear();
            self.section = None;
            if song.is_some() {
                let scene = self.pick(music.intensity.max(0.3), has_cover);
                let seed = self.unit();
                self.change(scene, seed, MOST_FADE);
            }
        } else if music.drop_landed {
            let (scene, seed) = match music.section {
                Some(section) => self.for_section(section, has_cover, true),
                None => (self.pick(0.9, has_cover), self.unit()),
            };
            self.section = music.section.map(|section| section.index);
            self.change(scene, seed, 0.0);
        } else if music.section.map(|section| section.index) != self.section {
            self.section = music.section.map(|section| section.index);
            if let Some(section) = music.section {
                let (scene, seed) = self.for_section(section, has_cover, false);
                self.change(scene, seed, fade);
            }
        } else if music.analyzed {
            let limit = if music.intensity < 0.4 {
                CALM_BARS
            } else {
                BUSY_BARS
            };
            if music.on_downbeat && self.bars_here >= limit {
                let scene = self.pick(music.intensity, has_cover);
                let seed = self.unit();
                self.change(scene, seed, fade * 1.5);
            }
        } else {
            let age = self.current.age;
            if (music.surge && age > LIVE_MIN) || (music.on_downbeat && age > LIVE_MAX) {
                let scene = self.pick(music.intensity, has_cover);
                let seed = self.unit();
                self.change(scene, seed, fade);
            }
        }
        if !has_cover && SCENES[self.latest()].needs_cover {
            let scene = self.pick(music.intensity, false);
            let seed = self.unit();
            self.change(scene, seed, 0.6);
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
        })
    }

    /// Run until any change of scene has finished.
    fn settle(director: &mut Director, frame: &Music) -> Shot {
        let mut shot = director.direct(frame, Some("song"), true);
        for _ in 0..200 {
            shot = director.direct(frame, Some("song"), true);
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
        let shot = director.direct(&landing, Some("song"), true);
        assert!(shot.next.is_none());
        assert!(
            SCENES[shot.current.scene].energy >= 0.75,
            "{}",
            SCENES[shot.current.scene].name
        );
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
    fn cover_scenes_wait_for_a_cover() {
        let mut director = Director::new(5);
        for index in 0..20 {
            let frame = music(section(
                index,
                SectionKind::Verse,
                index as u32,
                index as f32 / 20.0,
            ));
            let shot = director.direct(&frame, Some("song"), false);
            assert!(!SCENES[shot.current.scene].needs_cover);
            if let Some((next, _)) = shot.next {
                assert!(!SCENES[next.scene].needs_cover);
            }
        }
    }
}
