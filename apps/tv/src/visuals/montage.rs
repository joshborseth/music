//! Montage: the song's own pictures, cut to the beat like a VJ cutting
//! its official video live.
//!
//! The server sends a montage per song (`GET /tv/montage`): key frames of
//! the music video, or the artist's photos and covers when it has none,
//! packed into one JPEG atlas. `MontageAtlas` decodes it off the UI thread;
//! `gpu.rs` uploads it as `uMontage` (texture unit 9) and draws the scene
//! (`shaders/montage.glsl`) only once the song playing has one.
//!
//! `Cutter` decides, once a frame, which picture shows and how: hard cuts
//! on the beat, a bar apart in calm music (with a slow pan and zoom across
//! the picture, Ken Burns), every two beats, every beat when it is
//! intense, every half beat through a drum fill and the two bars after a
//! drop lands, which slam through the busiest pictures. Dark, calm
//! pictures suit calm music and busy, bright ones the loudest, as the
//! server measured them. Each cut also picks the grade the shader puts on
//! the picture: a duotone or tritone in the cover's colors, a halftone or a
//! posterized print, sometimes split into strips of different pictures.
//!
//! The lab (`visuals-lab/montage.ts`) works out the same.

use crate::catalog::{Montage, MontageSource};

use super::motion::{hash, unit};
use super::music::Music;

/// The grades `montage.glsl` knows, in its numbering.
pub const DUOTONE: f32 = 0.0;
pub const TRITONE: f32 = 1.0;
pub const HALFTONE: f32 = 2.0;
pub const POSTER: f32 = 3.0;

/// Cuts never come closer than this, in seconds, whatever the tempo.
const SHORTEST_CUT: f32 = 0.16;
/// A cut lights the picture up at most this often: a flash a third of a
/// second apart at the most (photosensitivity).
const FLASH_EVERY: f32 = 0.34;
/// Beats of cutting at every half beat after a drop lands.
const BURST_BEATS: f32 = 8.0;

/// A song's montage, decoded: RGB pixels for the GPU and what the cutter
/// needs to know about each picture.
pub struct MontageAtlas {
    pub video_id: String,
    pub width: u32,
    pub height: u32,
    /// `width` × `height` RGBA, row by row from the top.
    pub rgba: Vec<u8>,
    pub columns: u32,
    pub rows: u32,
    /// A cell's width over its height: 16:9 for a video, 1 for covers.
    pub cell_aspect: f32,
    pub pictures: Vec<Picture>,
}

/// What the cutter knows about one picture.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Picture {
    pub brightness: f32,
    /// Where it stands among the montage's pictures, 0 (the darkest, the
    /// calmest) to 1.
    pub bright_rank: f32,
    pub busy_rank: f32,
}

impl MontageAtlas {
    /// Decode the server's montage and its JPEG; an error if they don't fit.
    pub fn decode(montage: &Montage, jpeg: &[u8]) -> Result<Self, String> {
        let image = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)
            .map_err(|error| error.to_string())?
            .into_rgba8();
        let (width, height) = (image.width(), image.height());
        if width != montage.columns * montage.cell_width
            || height != montage.rows * montage.cell_height
            || montage.frames.is_empty()
            || montage.frames.len() > (montage.columns * montage.rows) as usize
        {
            return Err(format!(
                "a {width}×{height} atlas for {} pictures in {}×{} cells of {}×{}",
                montage.frames.len(),
                montage.columns,
                montage.rows,
                montage.cell_width,
                montage.cell_height
            ));
        }
        Ok(Self {
            video_id: montage.video_id.clone(),
            width,
            height,
            rgba: image.into_raw(),
            columns: montage.columns,
            rows: montage.rows,
            cell_aspect: match montage.source {
                MontageSource::Video => montage.cell_width as f32 / montage.cell_height as f32,
                MontageSource::Artist => 1.0,
            },
            pictures: pictures(montage),
        })
    }
}

/// Each picture's light and its ranks among the montage's.
pub fn pictures(montage: &Montage) -> Vec<Picture> {
    let rank = |value: fn(&crate::catalog::MontageFrame) -> f32| {
        let values: Vec<f32> = montage.frames.iter().map(value).collect();
        let last = (values.len().max(2) - 1) as f32;
        values
            .iter()
            .map(|mine| values.iter().filter(|other| *other < mine).count() as f32 / last)
            .collect::<Vec<f32>>()
    };
    let bright = rank(|frame| frame.brightness);
    let busy = rank(|frame| frame.busyness);
    montage
        .frames
        .iter()
        .enumerate()
        .map(|(index, frame)| Picture {
            brightness: frame.brightness,
            bright_rank: bright[index],
            busy_rank: busy[index],
        })
        .collect()
}

/// One cut: the picture, how the camera moves across it, and its grade.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cut {
    pub picture: usize,
    /// `Music::time` when it came on.
    pub at: f32,
    /// Seconds the camera takes from `from` to `to` (x, y, zoom).
    pub length: f32,
    pub from: [f32; 3],
    pub to: [f32; 3],
    /// How hard it lands, 0 to 1: lights up and punches in.
    pub strength: f32,
    pub look: f32,
    /// Strips across the screen, each a different picture: 1 to 3.
    pub strips: f32,
}

impl Cut {
    /// The camera at `time`: x, y (in the picture's units) and zoom.
    pub fn camera(&self, time: f32) -> [f32; 3] {
        let t = ((time - self.at) / self.length.max(0.1)).clamp(0.0, 1.0);
        let eased = t * t * (3.0 - 2.0 * t);
        [0, 1, 2].map(|i| self.from[i] + (self.to[i] - self.from[i]) * eased)
    }
}

/// The montage's uniforms for one frame (`montage.glsl`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct MontageShot {
    /// Columns, rows, pictures, a cell's aspect.
    pub grid: [f32; 4],
    /// The picture showing and the one before: index, x, y, zoom.
    pub a: [f32; 4],
    pub b: [f32; 4],
    /// Seconds since the cut, how hard it landed, the grade, the strips.
    pub cut: [f32; 4],
    /// The echo of past frames, how far blacks are crushed, how much the
    /// spectrum is cut into the picture, how much of its own color shows.
    pub mix: [f32; 4],
    /// How much the light of the picture showing and of the one before is
    /// raised or lowered, so every picture grades at about the same level;
    /// then half a texel of the atlas in a cell's units, across and down.
    pub tone: [f32; 4],
}

/// Decides each frame which picture shows: see the module's notes.
pub struct Cutter {
    seed: u32,
    current: Option<Cut>,
    previous: Option<Cut>,
    recent: Vec<usize>,
    cuts: u32,
    last_beats: f32,
    burst_until: f32,
    last_flash: f32,
    song: Option<String>,
}

impl Default for Cutter {
    fn default() -> Self {
        Self::new()
    }
}

impl Cutter {
    pub fn new() -> Self {
        Self {
            seed: 1,
            current: None,
            previous: None,
            recent: Vec::new(),
            cuts: 0,
            last_beats: 0.0,
            burst_until: f32::NEG_INFINITY,
            last_flash: f32::NEG_INFINITY,
            song: None,
        }
    }

    /// A random number for this cut, 0 to 1, the same each time the song
    /// plays.
    fn random(&self, salt: u32) -> f32 {
        unit(
            hash(self.seed)
                .wrapping_add(self.cuts.wrapping_mul(7919))
                .wrapping_add(salt),
        ) as f32
    }

    /// How many beats apart cuts come now; none while the music stops.
    fn pace(&self, music: &Music) -> Option<f32> {
        if music.parts.stop > 0.5 {
            return None;
        }
        Some(
            if music.beats < self.burst_until || music.parts.fill > 0.5 {
                0.5
            } else if music.intensity > 0.72 || music.drop > 0.25 {
                1.0
            } else if music.intensity > 0.45 {
                2.0
            } else if music.intensity > 0.2 {
                4.0
            } else {
                8.0
            },
        )
    }

    /// This frame's shot of `atlas`, cutting when the beat says to.
    pub fn update(&mut self, music: &Music, atlas: &MontageAtlas) -> MontageShot {
        if self.song.as_deref() != Some(atlas.video_id.as_str()) {
            *self = Self {
                seed: atlas
                    .video_id
                    .bytes()
                    .fold(17u32, |sum, byte| hash(sum ^ u32::from(byte))),
                song: Some(atlas.video_id.clone()),
                last_beats: music.beats,
                ..Self::new()
            };
        }
        if music.drop_landed {
            self.burst_until = music.beats + BURST_BEATS;
        }
        let since_cut = self
            .current
            .map_or(f32::INFINITY, |cut| music.time - cut.at);
        let crossed = self.pace(music).is_some_and(|pace| {
            (music.beats / pace).floor() != (self.last_beats / pace).floor()
                && music.beats > self.last_beats
        });
        // Long past its pace (no beat heard), a picture moves on anyway.
        let stale = since_cut > 12.0 && music.parts.stop < 0.5;
        if self.current.is_none()
            || ((crossed || music.drop_landed || stale) && since_cut >= SHORTEST_CUT)
        {
            self.cut(music, atlas);
        }
        self.last_beats = music.beats;
        self.shot(music, atlas)
    }

    fn cut(&mut self, music: &Music, atlas: &MontageAtlas) {
        let count = atlas.pictures.len();
        if count == 0 {
            return;
        }
        let burst = music.beats < self.burst_until;
        let intensity = music.intensity.clamp(0.0, 1.0);
        let target = if burst { 1.0 } else { intensity };
        // Pictures shown lately cost more the more lately, so a song of a
        // few pictures still runs through them all.
        let remember = (count / 2).clamp(1, 16);
        let mut best = 0;
        let mut best_cost = f32::INFINITY;
        for (index, picture) in atlas.pictures.iter().enumerate() {
            let fit = (picture.busy_rank - (0.25 + 0.75 * target)).abs()
                + 0.6 * (picture.bright_rank - (0.35 + 0.55 * target)).abs();
            let lately = self
                .recent
                .iter()
                .rev()
                .take(remember)
                .position(|shown| *shown == index)
                .map_or(0.0, |ago| 2.0 - ago as f32 / remember as f32);
            let cost = 1.5 * fit + lately + 0.3 * self.random(index as u32 + 1);
            if cost < best_cost {
                best_cost = cost;
                best = index;
            }
        }
        let pace = self.pace(music).unwrap_or(4.0);
        let calm = pace >= 4.0;
        let length = (pace * music.beat_seconds.max(0.2)).max(0.5);
        let zoom_from = if calm {
            1.05 + 0.1 * self.random(101)
        } else {
            1.12 + 0.08 * self.random(101)
        };
        let zoom_to = if calm {
            zoom_from + 0.12 + 0.1 * self.random(102)
        } else {
            zoom_from + 0.03
        };
        // The camera stays inside the picture: half of what the zoom hides.
        let reach =
            |zoom: f32, salt: u32| (self.random(salt) * 2.0 - 1.0) * (1.0 - 1.0 / zoom) * 0.5;
        let from = [reach(zoom_from, 103), reach(zoom_from, 104), zoom_from];
        let to = [reach(zoom_to, 105), reach(zoom_to, 106), zoom_to];
        let flash = music.time - self.last_flash >= FLASH_EVERY;
        if flash {
            self.last_flash = music.time;
        }
        let strength = if !flash {
            0.0
        } else if burst || music.drop_landed {
            1.0
        } else {
            (0.25 + 0.75 * intensity) * if calm { 0.4 } else { 1.0 }
        };
        let group = music.section.map_or(0, |section| section.group);
        let base = if hash(self.seed ^ group.wrapping_mul(31)).is_multiple_of(2) {
            DUOTONE
        } else {
            TRITONE
        };
        let (look, strips) = if burst {
            (
                [HALFTONE, POSTER, TRITONE, DUOTONE][(self.cuts % 4) as usize],
                [1.0, 2.0, 3.0, 1.0, 2.0][(self.cuts % 5) as usize],
            )
        } else if intensity > 0.6 {
            let look = match self.cuts % 6 {
                2 => HALFTONE,
                5 => POSTER,
                _ => base,
            };
            let strips = if self.random(107) < 0.18 { 2.0 } else { 1.0 };
            (look, strips)
        } else if intensity > 0.4 && self.cuts % 5 == 4 {
            (POSTER, 1.0)
        } else {
            (base, 1.0)
        };
        self.previous = self.current;
        self.current = Some(Cut {
            picture: best,
            at: music.time,
            length,
            from,
            to,
            strength,
            look,
            strips,
        });
        self.recent.push(best);
        if self.recent.len() > 32 {
            self.recent.remove(0);
        }
        self.cuts = self.cuts.wrapping_add(1);
    }

    fn shot(&self, music: &Music, atlas: &MontageAtlas) -> MontageShot {
        let Some(current) = self.current else {
            return MontageShot::default();
        };
        let previous = self.previous.unwrap_or(current);
        let camera = |cut: &Cut| {
            let [x, y, zoom] = cut.camera(music.time);
            [cut.picture as f32, x, y, zoom]
        };
        let intensity = music.intensity.clamp(0.0, 1.0);
        let burst = music.beats < self.burst_until;
        let echo =
            (0.32 - 0.26 * intensity + 0.5 * music.parts.fill + if burst { 0.1 } else { 0.0 })
                .clamp(0.0, 0.85);
        // The spectrum is cut in every other bar, and all through a burst.
        let bars_on = burst || (music.beats / 4.0).floor().rem_euclid(2.0) < 1.0;
        let spectrum = if bars_on {
            ((intensity - 0.55) * 2.5).clamp(0.0, 1.0) * (0.5 + 0.5 * music.energy)
        } else {
            0.0
        };
        // Each picture's light is evened out toward the same level, a little
        // brighter the louder the music.
        let target = 0.26 + 0.08 * intensity;
        let gain = |cut: &Cut| {
            let light = atlas
                .pictures
                .get(cut.picture)
                .map_or(target, |picture| picture.brightness);
            (target / light.max(0.03)).clamp(0.7, 2.2)
        };
        MontageShot {
            grid: [
                atlas.columns as f32,
                atlas.rows as f32,
                atlas.pictures.len() as f32,
                atlas.cell_aspect,
            ],
            a: camera(&current),
            b: camera(&previous),
            cut: [
                music.time - current.at,
                current.strength,
                current.look,
                current.strips,
            ],
            mix: [
                echo,
                0.04 + 0.16 * intensity,
                spectrum,
                0.5 - 0.36 * intensity,
            ],
            tone: [
                gain(&current),
                gain(&previous),
                0.5 * atlas.columns as f32 / atlas.width as f32,
                0.5 * atlas.rows as f32 / atlas.height as f32,
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::music::Parts;
    use super::*;
    use crate::catalog::MontageFrame;

    fn montage(frames: &[(f32, f32)]) -> Montage {
        Montage {
            video_id: "song".to_owned(),
            source: MontageSource::Video,
            music_video_id: Some("video".to_owned()),
            columns: 8,
            rows: frames.len().div_ceil(8) as u32,
            cell_width: 320,
            cell_height: 180,
            frames: frames
                .iter()
                .map(|(brightness, busyness)| MontageFrame {
                    seconds: Some(1.0),
                    color: [*brightness; 3],
                    brightness: *brightness,
                    busyness: *busyness,
                })
                .collect(),
            atlas_path: "/tv/montage.jpg?videoId=song".to_owned(),
        }
    }

    fn atlas(frames: &[(f32, f32)]) -> MontageAtlas {
        let montage = montage(frames);
        MontageAtlas {
            video_id: montage.video_id.clone(),
            width: montage.columns * 320,
            height: montage.rows * 180,
            rgba: Vec::new(),
            columns: montage.columns,
            rows: montage.rows,
            cell_aspect: 16.0 / 9.0,
            pictures: pictures(&montage),
        }
    }

    fn music(beats: f32, intensity: f32) -> Music {
        Music {
            time: beats * 0.5,
            dt: 1.0 / 60.0,
            drive: 0.0,
            beats,
            bar: (beats / 4.0).fract(),
            beat_pulse: 0.0,
            bar_pulse: 0.0,
            kick: 0.0,
            accent: 0.0,
            bands: [0.0; 4],
            levels: [0.0; 8],
            energy: intensity,
            tension: 0.0,
            drop: 0.0,
            intensity,
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

    /// The beats (to the nearest 60th of a beat) at which `cutter` cuts
    /// while `shape` gives the music.
    fn cuts_over(
        atlas: &MontageAtlas,
        beats: f32,
        shape: impl Fn(f32) -> Music,
    ) -> (Cutter, Vec<f32>) {
        let mut cutter = Cutter::new();
        let mut cuts = Vec::new();
        for step in 0..(beats * 30.0) as u32 {
            let before = cutter.cuts;
            cutter.update(&shape(step as f32 / 30.0), atlas);
            if cutter.cuts != before {
                cuts.push(step as f32 / 30.0);
            }
        }
        (cutter, cuts)
    }

    fn mixed_atlas() -> MontageAtlas {
        let frames: Vec<(f32, f32)> = (0..24)
            .map(|i| ((i % 6) as f32 / 6.0 + 0.05, (i % 4) as f32 / 4.0 + 0.1))
            .collect();
        atlas(&frames)
    }

    #[test]
    fn ranks_pictures_by_light_and_detail() {
        let pictures = pictures(&montage(&[(0.1, 0.9), (0.5, 0.1), (0.3, 0.5)]));
        assert_eq!(pictures[0].bright_rank, 0.0);
        assert_eq!(pictures[1].bright_rank, 1.0);
        assert_eq!(pictures[2].bright_rank, 0.5);
        assert_eq!(pictures[0].busy_rank, 1.0);
        assert_eq!(pictures[1].busy_rank, 0.0);
    }

    #[test]
    fn cuts_on_the_bar_when_calm_and_on_the_beat_when_intense() {
        let atlas = mixed_atlas();
        let (_, calm) = cuts_over(&atlas, 16.0, |beats| music(beats, 0.3));
        // The first picture at once, then one each bar.
        assert_eq!(calm, vec![0.0, 4.0, 8.0, 12.0]);
        let (_, intense) = cuts_over(&atlas, 6.0, |beats| music(beats, 0.9));
        assert_eq!(intense, vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0]);
    }

    #[test]
    fn a_drop_slams_through_pictures_every_half_beat() {
        let atlas = mixed_atlas();
        let (_, cuts) = cuts_over(&atlas, 12.0, |beats| {
            let mut music = music(beats, 0.9);
            music.drop_landed = (beats - 2.0).abs() < 1e-3;
            music
        });
        let after: Vec<f32> = cuts.into_iter().filter(|beat| *beat >= 2.0).collect();
        assert_eq!(after[..5], [2.0, 2.5, 3.0, 3.5, 4.0]);
        // The burst lasts two bars, then it is every beat again.
        assert!(after.contains(&9.5) && !after.contains(&10.5) && after.contains(&11.0));
    }

    #[test]
    fn holds_while_the_music_stops() {
        let atlas = mixed_atlas();
        let (_, cuts) = cuts_over(&atlas, 8.0, |beats| {
            let mut music = music(beats, 0.9);
            music.parts.stop = if beats >= 2.0 { 1.0 } else { 0.0 };
            music
        });
        assert_eq!(cuts, vec![0.0, 1.0]);
    }

    #[test]
    fn calm_music_gets_dark_pictures_and_loud_music_busy_ones() {
        // Half dark and calm, half bright and busy.
        let frames: Vec<(f32, f32)> = (0..16)
            .map(|i| {
                let step = i as f32 * 0.005;
                if i % 2 == 0 {
                    (0.05 + step, 0.05 + step)
                } else {
                    (0.5 + step, 0.85 + step)
                }
            })
            .collect();
        let atlas = atlas(&frames);
        let shown = |intensity: f32| {
            let mut cutter = Cutter::new();
            (0..6)
                .map(|cut| {
                    let shot = cutter.update(&music(cut as f32 * 8.0 + 0.01, intensity), &atlas);
                    shot.a[0] as usize
                })
                .collect::<Vec<usize>>()
        };
        assert!(
            shown(0.1).iter().all(|index| index % 2 == 0),
            "{:?}",
            shown(0.1)
        );
        assert!(
            shown(0.95).iter().all(|index| index % 2 == 1),
            "{:?}",
            shown(0.95)
        );
    }

    #[test]
    fn runs_through_the_pictures_before_showing_one_again() {
        let atlas = mixed_atlas();
        let (cutter, _) = cuts_over(&atlas, 12.0, |beats| music(beats, 0.9));
        let shown = &cutter.recent;
        assert_eq!(shown.len(), 12);
        for (index, picture) in shown.iter().enumerate() {
            let earlier = &shown[index.saturating_sub(8)..index];
            assert!(!earlier.contains(picture), "{shown:?}");
        }
    }

    #[test]
    fn the_camera_stays_inside_the_picture() {
        let atlas = mixed_atlas();
        let mut cutter = Cutter::new();
        for step in 0..2000 {
            let shot = cutter.update(
                &music(step as f32 / 20.0, (step % 300) as f32 / 300.0),
                &atlas,
            );
            for camera in [shot.a, shot.b] {
                let [_, x, y, zoom] = camera;
                let room = (1.0 - 1.0 / zoom) * 0.5 + 1e-4;
                assert!(
                    zoom >= 1.0 && x.abs() <= room && y.abs() <= room,
                    "{camera:?}"
                );
            }
            assert!(shot.cut[3] >= 1.0 && shot.cut[3] <= 3.0);
        }
    }

    #[test]
    fn decodes_an_atlas_and_refuses_one_that_does_not_fit() {
        let montage = montage(&[(0.2, 0.3), (0.4, 0.5)]);
        let image = image::RgbImage::from_pixel(640, 180, image::Rgb([200, 30, 60]));
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        let mut fits = montage.clone();
        fits.columns = 2;
        let atlas = MontageAtlas::decode(&fits, &jpeg).unwrap();
        assert_eq!(
            (atlas.width, atlas.height, atlas.rgba.len()),
            (640, 180, 640 * 180 * 4)
        );
        assert!((atlas.cell_aspect - 16.0 / 9.0).abs() < 1e-6);
        assert!(MontageAtlas::decode(&montage, &jpeg).is_err());
    }
}
