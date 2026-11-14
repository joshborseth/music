//! The sung words, drawn into the scenes: not captions (the lyrics panel
//! shows the lines), but type that lives in the picture, a word at a time.
//!
//! The server times each word and sends every distinct word of the song as
//! a signed distance field in one atlas (`catalog::Words`). Once a frame,
//! [`Reader::frame`] works out from the song's clock which words show and
//! where: the word sung now, the next one, and the one before (which the
//! scenes scatter, fly past, or let bleed away). The scenes read them
//! through `wordField` in `helpers.glsl`, one texture read and only inside
//! a word's box.
//!
//! The words keep out of the app's own: beside the lyrics (`Room::Side`)
//! they sit in the band under the lyrics on the right, where no line runs
//! and the song's cover is not; with the song alone in the middle
//! (`Room::Centre`) they take the sides of the screen, a line on the left,
//! the next on the right. A hook line (its words come back in the song) is
//! drawn large, and the song's most repeated phrase larger still. While the
//! controls or the queue show, the words make way.
//!
//! The browser lab keeps the same choice and placing (`visuals-lab/words.ts`).

use std::sync::Arc;

use glow::HasContext;

use crate::catalog::{Glyph, Word, Words};

/// A word shows this early, so it lands with its sound.
const LEAD: f64 = 0.04;
/// Seconds a word takes to come in.
const FADE_IN: f32 = 0.08;
/// A word stays this long after its singing ends, if no word follows, then
/// fades over `FADE_OUT`.
const LINGER: f64 = 0.6;
const FADE_OUT: f32 = 0.5;
/// The next word is given this far ahead, for scenes that gather it.
const AHEAD: f64 = 1.5;
/// Seconds the words take to make way, or to come back.
const ROOM_FADE: f32 = 0.35;

/// Where the words may go, beside the app's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Room {
    /// The controls or the queue show: no words.
    #[default]
    Hidden,
    /// The lyrics run on the right, the song on the left: the band under
    /// the lyrics.
    Side,
    /// The song alone in the middle: the sides of the screen.
    Centre,
}

/// Which word of a frame: what `uWordRect[i]` and the rest hold.
pub const NOW: usize = 0;
pub const NEXT: usize = 1;
pub const BEFORE: usize = 2;

/// What the scenes get each frame (`helpers.glsl`, THE WORDS).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Frame {
    /// Each word's rectangle in the atlas, in texture units: x, y (top),
    /// width, height. Zero when there is no such word.
    pub rects: [[f32; 4]; 3],
    /// Where each word sits, in `centered()` units: its middle, then half
    /// its width and height.
    pub boxes: [[f32; 4]; 3],
    /// For each: seconds since it started (the word before: since the one
    /// now started; the next: negative until it starts), how far through
    /// it is (0 to 1), how big a hook it is (0, a hook line 0.6, the
    /// phrase 1), and how much it shows (0 to 1).
    pub times: [[f32; 4]; 3],
    /// The atlas's width and height in pixels, its field's spread, and 1
    /// when any word shows.
    pub atlas: [f32; 4],
}

/// Picks and places the words each frame, and fades them when they make way.
#[derive(Debug, Default)]
pub struct Reader {
    /// Where the words show now, and how much (0 to 1).
    shown: Room,
    fade: f32,
}

impl Reader {
    /// The words at `seconds` into the song, in `room`, on a screen
    /// `aspect` times as wide as tall; `dt` seconds since the last frame.
    pub fn frame(
        &mut self,
        words: Option<&Words>,
        seconds: Option<f64>,
        room: Room,
        aspect: f32,
        dt: f32,
    ) -> Frame {
        let step = dt / ROOM_FADE;
        if room != self.shown {
            self.fade = (self.fade - step).max(0.0);
            if self.fade == 0.0 {
                self.shown = room;
            }
        } else if room != Room::Hidden {
            self.fade = (self.fade + step).min(1.0);
        }
        let (Some(words), Some(seconds)) = (words, seconds) else {
            return Frame::default();
        };
        if self.shown == Room::Hidden || self.fade == 0.0 {
            return Frame::default();
        }
        frame_at(words, seconds, self.shown, aspect, ease(self.fade))
    }
}

fn ease(x: f32) -> f32 {
    x * x * (3.0 - 2.0 * x)
}

/// The words at `seconds`, in `room`, showing `shown` (0 to 1).
pub fn frame_at(words: &Words, seconds: f64, room: Room, aspect: f32, shown: f32) -> Frame {
    let Some(atlas) = words.atlas.as_ref().filter(|_| !words.pixels.is_empty()) else {
        return Frame::default();
    };
    let drawable = |index: usize| {
        words.words[index]
            .glyph
            .and_then(|glyph| atlas.glyphs.get(glyph))
            .map(|glyph| (index, glyph))
    };
    // The last word started by now (a moment early), and those around it
    // that can be drawn.
    let started = words
        .words
        .partition_point(|word| word.start_seconds - LEAD <= seconds);
    let now = (0..started).rev().find_map(drawable);
    let next = (started..words.words.len()).find_map(drawable);
    let before = now.and_then(|(index, _)| (0..index).rev().find_map(drawable));

    let mut frame = Frame {
        atlas: [atlas.width as f32, atlas.height as f32, atlas.spread, 0.0],
        ..Frame::default()
    };
    let size = (atlas.width as f32, atlas.height as f32);
    let mut place = |slot: usize, word: &Word, glyph: &Glyph, time: [f32; 4]| {
        if time[3] <= 0.0 {
            return;
        }
        frame.rects[slot] = [
            glyph.x / size.0,
            glyph.y / size.1,
            glyph.width / size.0,
            glyph.height / size.1,
        ];
        frame.boxes[slot] = word_box(room, word, glyph, atlas.cap_height, atlas.spread, aspect);
        frame.times[slot] = time;
    };
    if let Some((index, glyph)) = now {
        let word = &words.words[index];
        let age = seconds - word.start_seconds;
        let length = (word.end_seconds - word.start_seconds).max(0.05);
        let coming = ((age + LEAD) as f32 / FADE_IN).clamp(0.0, 1.0);
        let gone = ((seconds - word.end_seconds - LINGER) as f32 / FADE_OUT).clamp(0.0, 1.0);
        place(
            NOW,
            word,
            glyph,
            [
                age as f32,
                (age / length).clamp(0.0, 1.0) as f32,
                hook_level(word),
                shown * coming * (1.0 - gone),
            ],
        );
        if let Some((before_index, before_glyph)) = before {
            let previous = &words.words[before_index];
            // Only a word that still showed when this one came.
            let showed = word.start_seconds - previous.end_seconds < LINGER + f64::from(FADE_OUT);
            place(
                BEFORE,
                previous,
                before_glyph,
                [
                    age as f32,
                    1.0,
                    hook_level(previous),
                    if showed { shown } else { 0.0 },
                ],
            );
        }
    }
    if let Some((index, glyph)) = next {
        let word = &words.words[index];
        let age = seconds - word.start_seconds;
        if age > -AHEAD {
            place(
                NEXT,
                word,
                glyph,
                [age as f32, 0.0, hook_level(word), shown],
            );
        }
    }
    frame.atlas[3] = if frame.times.iter().any(|time| time[3] > 0.0) {
        1.0
    } else {
        0.0
    };
    frame
}

/// How big a hook `word` is: 1 for the song's phrase, 0.6 for a hook line.
fn hook_level(word: &Word) -> f32 {
    if word.phrase {
        1.0
    } else if word.hook {
        0.6
    } else {
        0.0
    }
}

/// Where a word sits in `room`, in `centered()` units (the screen's height
/// is 1, x runs ±`aspect` / 2): its middle, then half its width and height.
/// Its capitals are as tall as its hook level asks, no wider than the room
/// allows, their middle on the room's middle.
pub fn word_box(
    room: Room,
    word: &Word,
    glyph: &Glyph,
    cap: f32,
    spread: f32,
    aspect: f32,
) -> [f32; 4] {
    let level = hook_level(word);
    // The room's middle (screen fractions, y down from the top), its
    // widest, and the capitals' height, plain and for the phrase.
    let (middle, widest, plain, phrase) = match room {
        // Under the lyrics: from their left edge to the right of the
        // screen, from under their last line to the bottom.
        Room::Side | Room::Hidden => ((0.675, 0.88), 0.56, 0.085, 0.13),
        // A line on the left of the song, the next on its right.
        Room::Centre => {
            let x = if word.line.is_multiple_of(2) {
                0.15
            } else {
                0.85
            };
            ((x, 0.47), 0.22, 0.11, 0.2)
        }
    };
    let height = plain + (phrase - plain) * level;
    let mut scale = height / cap.max(1.0);
    let ink = (glyph.width - 2.0 * spread).max(1.0) * scale;
    if ink > widest * aspect {
        scale *= widest * aspect / ink;
    }
    let x = (middle.0 - 0.5) * aspect;
    let cap_middle = 0.5 - middle.1;
    // From the rectangle's top: its middle, and the capitals' middle.
    let below = glyph.height / 2.0 - (glyph.baseline - cap / 2.0);
    [
        x,
        cap_middle - below * scale,
        glyph.width * scale / 2.0,
        glyph.height * scale / 2.0,
    ]
}

/// The atlas on the GPU, uploaded once a song.
pub struct WordsTexture {
    texture: glow::Texture,
    shown: Option<Arc<Words>>,
}

impl WordsTexture {
    /// # Safety
    /// A current GL context, its state saved by the caller.
    pub unsafe fn new(gl: &glow::Context) -> Option<Self> {
        unsafe {
            let texture = gl.create_texture().ok()?;
            gl.bind_texture(glow::TEXTURE_2D, Some(texture));
            Self::upload(gl, 1, 1, &[0]);
            for (name, value) in [
                (glow::TEXTURE_MIN_FILTER, glow::LINEAR),
                (glow::TEXTURE_MAG_FILTER, glow::LINEAR),
                (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE),
                (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE),
            ] {
                gl.tex_parameter_i32(glow::TEXTURE_2D, name, value as i32);
            }
            Some(Self {
                texture,
                shown: None,
            })
        }
    }

    unsafe fn upload(gl: &glow::Context, width: i32, height: i32, pixels: &[u8]) {
        unsafe {
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
            gl.tex_image_2d(
                glow::TEXTURE_2D,
                0,
                glow::R8 as i32,
                width,
                height,
                0,
                glow::RED,
                glow::UNSIGNED_BYTE,
                glow::PixelUnpackData::Slice(Some(pixels)),
            );
        }
    }

    /// Whether `words`' atlas is the one uploaded.
    pub fn shows(&self, words: Option<&Arc<Words>>) -> bool {
        match (words, &self.shown) {
            (Some(new), Some(old)) => Arc::ptr_eq(new, old),
            (None, None) => true,
            _ => false,
        }
    }

    pub fn texture(&self) -> glow::Texture {
        self.texture
    }

    /// Show `words`' atlas from now on; nothing changes if it already shows.
    ///
    /// # Safety
    /// A current GL context, its state saved by the caller.
    pub unsafe fn set(&mut self, gl: &glow::Context, words: Option<&Arc<Words>>) {
        if self.shows(words) {
            return;
        }
        self.shown = words.cloned();
        let Some((atlas, words)) = words.and_then(|words| words.atlas.as_ref().zip(Some(words)))
        else {
            return;
        };
        let (width, height) = (atlas.width as i32, atlas.height as i32);
        if words.pixels.len() != (width * height) as usize {
            return;
        }
        unsafe {
            gl.bind_texture(glow::TEXTURE_2D, Some(self.texture));
            Self::upload(gl, width, height, &words.pixels);
        }
    }

    /// # Safety
    /// A current GL context.
    pub unsafe fn delete(self, gl: &glow::Context) {
        unsafe { gl.delete_texture(self.texture) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{WordAtlas, WordLine};

    fn word(start: f64, end: f64, glyph: Option<usize>, line: usize) -> Word {
        Word {
            start_seconds: start,
            end_seconds: end,
            text: String::new(),
            line,
            glyph,
            hook: line == 1,
            phrase: false,
        }
    }

    fn glyph(x: f32) -> Glyph {
        Glyph {
            text: String::new(),
            x,
            y: 0.0,
            width: 100.0,
            height: 60.0,
            baseline: 46.0,
        }
    }

    fn song() -> Words {
        Words {
            video_id: "abc".into(),
            phrase: None,
            lines: vec![
                WordLine {
                    start_seconds: 1.0,
                    end_seconds: 2.0,
                    hook: false,
                },
                WordLine {
                    start_seconds: 5.0,
                    end_seconds: 6.0,
                    hook: true,
                },
            ],
            words: vec![
                word(1.0, 1.4, Some(0), 0),
                word(1.4, 1.8, None, 0),
                word(1.8, 2.0, Some(1), 0),
                word(5.0, 6.0, Some(0), 1),
            ],
            atlas: Some(WordAtlas {
                width: 400,
                height: 100,
                cap_height: 32.0,
                spread: 8.0,
                png: String::new(),
                glyphs: vec![glyph(0.0), glyph(200.0)],
            }),
            pixels: vec![0; 400 * 100],
        }
    }

    fn at(seconds: f64, room: Room) -> Frame {
        frame_at(&song(), seconds, room, 16.0 / 9.0, 1.0)
    }

    #[test]
    fn nothing_shows_before_the_singing_but_the_next_word() {
        let frame = at(0.0, Room::Side);
        assert_eq!(frame.times[NOW][3], 0.0);
        assert!(frame.times[NEXT][3] > 0.0);
        assert!((frame.times[NEXT][0] + 1.0).abs() < 1e-6);
        assert_eq!(frame.atlas[3], 1.0);
        // Too far ahead for the next word too.
        assert_eq!(at(-1.0, Room::Side).atlas[3], 0.0);
    }

    #[test]
    fn the_word_sung_now_its_progress_and_the_one_after() {
        let frame = at(1.2, Room::Side);
        assert_eq!(frame.rects[NOW], [0.0, 0.0, 0.25, 0.6]);
        assert!((frame.times[NOW][0] - 0.2).abs() < 1e-6);
        assert!((frame.times[NOW][1] - 0.5).abs() < 1e-6);
        assert_eq!(frame.times[NOW][3], 1.0);
        // The next drawable word, past the one the font can't draw.
        assert_eq!(frame.rects[NEXT][0], 0.5);
    }

    #[test]
    fn a_word_the_font_lacks_leaves_the_one_before_showing() {
        let frame = at(1.6, Room::Side);
        assert_eq!(frame.rects[NOW][0], 0.0);
        assert!((frame.times[NOW][0] - 0.6).abs() < 1e-6);
    }

    #[test]
    fn the_word_before_scatters_from_when_this_one_came() {
        let frame = at(1.9, Room::Side);
        assert_eq!(frame.rects[NOW][0], 0.5);
        assert_eq!(frame.rects[BEFORE][0], 0.0);
        assert!((frame.times[BEFORE][0] - 0.1).abs() < 1e-6);
        assert_eq!(frame.times[BEFORE][3], 1.0);
        // After a long rest, the word before had gone long since.
        assert_eq!(at(5.1, Room::Side).times[BEFORE][3], 0.0);
    }

    #[test]
    fn a_word_lingers_then_fades_in_a_long_rest() {
        assert_eq!(at(2.3, Room::Side).times[NOW][3], 1.0);
        let fading = at(2.85, Room::Side).times[NOW][3];
        assert!(fading > 0.0 && fading < 1.0, "{fading}");
        assert_eq!(at(3.5, Room::Side).times[NOW][3], 0.0);
    }

    #[test]
    fn beside_the_lyrics_words_sit_under_them_on_the_right() {
        let aspect = 16.0 / 9.0;
        let [x, y, half_width, half_height] = at(1.2, Room::Side).boxes[NOW];
        // Within the band under the lyrics: right of 38% of the width,
        // below 79% of the height.
        assert!(x - half_width > (0.38 - 0.5) * aspect - 0.05);
        assert!(x + half_width < 0.5 * aspect);
        assert!(y + half_height * 0.6 < 0.5 - 0.79, "{y} {half_height}");
        assert!(y > -0.5);
        // A hook line is drawn larger.
        let hook = at(5.2, Room::Side).boxes[NOW];
        assert!(hook[3] > half_height * 1.3);
    }

    #[test]
    fn with_the_song_alone_lines_take_turns_left_and_right() {
        let left = at(1.2, Room::Centre).boxes[NOW];
        let right = at(5.2, Room::Centre).boxes[NOW];
        assert!(left[0] < -0.5 && right[0] > 0.5);
    }

    #[test]
    fn capitals_sit_on_the_rooms_middle_whatever_the_rectangle() {
        let mut word = word(0.0, 1.0, Some(0), 0);
        word.hook = false;
        let tall = Glyph {
            height: 80.0,
            baseline: 66.0,
            ..glyph(0.0)
        };
        let short = glyph(0.0);
        for glyph in [tall, short] {
            let [_, y, _, half_height] = word_box(Room::Side, &word, &glyph, 32.0, 8.0, 1.6);
            let scale = 2.0 * half_height / glyph.height;
            let top = y + half_height;
            let cap_middle = top - (glyph.baseline - 16.0) * scale;
            assert!((cap_middle - (0.5 - 0.88)).abs() < 1e-5, "{cap_middle}");
        }
    }

    #[test]
    fn the_words_make_way_and_come_back() {
        let song = song();
        let mut reader = Reader::default();
        let frame =
            |reader: &mut Reader, room| reader.frame(Some(&song), Some(1.2), room, 16.0 / 9.0, 0.1);
        for _ in 0..10 {
            frame(&mut reader, Room::Side);
        }
        assert_eq!(frame(&mut reader, Room::Side).times[NOW][3], 1.0);
        let leaving = frame(&mut reader, Room::Hidden).times[NOW][3];
        assert!(leaving > 0.0 && leaving < 1.0);
        for _ in 0..10 {
            frame(&mut reader, Room::Hidden);
        }
        assert_eq!(frame(&mut reader, Room::Hidden).atlas[3], 0.0);
        // Moving rooms, they go and come back in the new place.
        for _ in 0..20 {
            frame(&mut reader, Room::Centre);
        }
        assert!(frame(&mut reader, Room::Centre).boxes[NOW][0] < 0.0);
    }
}
