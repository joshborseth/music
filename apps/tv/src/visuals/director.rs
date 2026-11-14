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

use std::collections::HashMap;

use super::music::{Music, SectionNow};

/// One scene the engine can draw.
pub struct SceneSpec {
    pub name: &'static str,
    /// The music it suits, 0 calm to 1 wild.
    pub energy: f32,
}

/// Every scene, in the order of `gpu::SCENE_SHADERS`.
pub const SCENES: [SceneSpec; 7] = [
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
];

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
    fn move_on(&mut self, group: u32, target: f32, seconds: f32) {
        let before = self.recent.last().copied();
        let scene = self.pick_avoiding(target, before);
        let seed = self.unit();
        self.by_group.insert(group, (scene, seed));
        self.change(scene, seed, seconds);
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
            self.bars_on_scene += 1;
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
            self.shown.clear();
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
            self.change(scene, seed, 0.0);
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
                    let (scene, seed) = self.for_section(section, aim);
                    if scene == self.latest()
                        && self.next.is_none()
                        && self.current.age >= LONGEST_SECONDS
                    {
                        // Held for minutes through sections that share it,
                        // none with a phrase far enough from its end: a
                        // section's start is a phrase too.
                        self.move_on(section.group, aim, fade * 1.5);
                    } else {
                        self.change(scene, seed, fade);
                    }
                }
            }
        } else if let Some(section) = music.section
            && music.on_downbeat
            && self.next.is_none()
        {
            // A scene that has shown a while moves on at a phrase.
            let shown = self.current.age;
            let phrase = if shown >= LONGEST_SECONDS {
                PHRASE_BARS / 2
            } else {
                PHRASE_BARS
            };
            let due = aim >= 0.4 || shown >= CALM_SECONDS;
            let bar_seconds = music.beat_seconds * 4.0;
            if due
                && self.bars_on_scene > 0
                && self.bars_on_scene.is_multiple_of(phrase)
                && section.left > bar_seconds * LAST_BARS
            {
                self.move_on(section.group, aim, fade * 1.5);
            }
        } else if music.section.is_none() {
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
