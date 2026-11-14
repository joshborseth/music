//! What the visuals know about the music in one frame.
//!
//! Two sources meet here. The server's analysis of the song (beats, bars,
//! sections, drops) is known before the song plays, so the visuals can land
//! exactly on the beat and start building before a drop. The audio heard
//! right now (the TV's own output, read back from the scope) gives the
//! texture: the spectrum, the waveform, the kick as it hits.
//!
//! Until the analysis arrives, or when the server could not make one, the
//! beat is guessed from the kick drum.

use crate::catalog::{Analysis, Score, SectionKind};
use crate::visualizer::{Analyzer, BARS};

/// Bands in the spectrum the shaders get.
pub const BANDS: usize = BARS;
/// Samples of the waveform the shaders get.
pub const WAVE: usize = 512;
/// Rows of spectrum history (`uHistory`), and how many are added a second:
/// four seconds of music in all, as `terrain.glsl` expects.
pub const HISTORY_ROWS: usize = 128;
pub const HISTORY_RATE: f32 = 32.0;
/// Coarse bands for `uLevels`.
pub const LEVELS: usize = 8;

/// How long the build-up before a drop lasts, in bars.
const BUILD_BARS: f64 = 4.0;
/// How long a drop's aftershock lasts, in bars.
const DROP_BARS: f64 = 2.0;
/// Seconds between the made-up beats while nothing plays.
const CALM_BEAT: f32 = 2.6;
/// How long after it is drawn a frame shows: it goes to the screen on the
/// next refresh or the one after. The song's timeline is read this far
/// ahead of what is heard, so a beat lands on screen as it is heard. The
/// scope reads its samples this far ahead too (`visualizer.rs`).
pub const SHOW_AHEAD: f64 = 0.035;
/// The loudness curve is averaged over this many seconds each side of now:
/// enough to smooth out each beat's own swell, and no lag, as the curve
/// is known ahead.
const ENERGY_SPAN: f64 = 0.4;
/// How fast `intensity` follows the section: within a beat or two, so a
/// chorus coming in looks bigger at once.
const INTENSITY_RATE: f32 = 2.5;

/// The score's columns (`TvScore` in `packages/shared/src/tv.ts`): the
/// spectrum, then the drums, kick, snare, hi-hat, bass, lead, melody, and
/// brightness.
pub const SCORE_COLUMNS: usize = 32;
const SPECTRUM_COLUMNS: usize = 24;
const BASS_COLUMN: usize = SPECTRUM_COLUMNS + 4;
const LEAD_COLUMN: usize = SPECTRUM_COLUMNS + 5;
const MELODY_COLUMN: usize = SPECTRUM_COLUMNS + 6;
const BRIGHTNESS_COLUMN: usize = SPECTRUM_COLUMNS + 7;
/// Rows of the score the GPU sees at once: at the server's 20 a second, a
/// little under half a second behind and six ahead.
pub const AHEAD_ROWS: usize = 128;
pub const AHEAD_BEHIND: usize = 8;
/// How far each semitone the key moves turns the colors, and each step
/// round the circle of fifths a chord lies from the key, in turns.
const KEY_TURN: f32 = 20.0 / 360.0;
const CHORD_TURN: f32 = 5.0 / 360.0;

/// The section playing now, as the director needs it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SectionNow {
    pub index: usize,
    pub kind: SectionKind,
    pub group: u32,
    pub energy: f32,
    /// Seconds until it ends.
    pub left: f32,
}

/// What the server's analysis tells apart in the song, this frame: each
/// drum, the tune, the harmony, and the moments a VJ would cue. All 0
/// without an analysis.
#[derive(Debug, Clone, Copy, Default)]
pub struct Parts {
    /// The snare (or clap) and the hi-hat, 1 on each hit and falling away.
    pub snare: f32,
    pub hat: f32,
    /// How much the song is driven by drums, 0 to 1: a club track's kick
    /// on every beat is 1, a ballad with none 0.
    pub drums: f32,
    /// How clearly a lead melody stands out, its height across the song's
    /// own range (held while it rests), the bass, and how bright the sound
    /// is, all 0 to 1, from the score.
    pub lead: f32,
    pub melody: f32,
    pub bass: f32,
    pub brightness: f32,
    /// How far the harmony turns the cover's colors, in turns of the color
    /// wheel: a key change turns them a long way, each chord a little,
    /// both eased.
    pub turn: f32,
    /// 1 while the chord is minor, eased; and 1 on each change of chord,
    /// falling away.
    pub minor: f32,
    pub chord_change: f32,
    /// 1 while the music stops dead, easing in and out; and true on the
    /// frame it comes back.
    pub stop: f32,
    pub stop_ended: bool,
    /// How far through a riser, 0 to 1, squared; 1 through a drum fill.
    pub riser: f32,
    pub fill: f32,
    /// How many times this section's part has come before: a chorus sung
    /// the third time is 2.
    pub repeat: f32,
}

/// The music in one frame: what the shaders get as uniforms, and the
/// moments the director acts on.
#[derive(Debug, Clone)]
pub struct Music {
    pub time: f32,
    pub dt: f32,
    pub drive: f32,
    /// Beats since the song started, with the fraction into this one.
    pub beats: f32,
    /// How far into the bar, 0 to 1.
    pub bar: f32,
    pub beat_pulse: f32,
    pub bar_pulse: f32,
    pub kick: f32,
    pub accent: f32,
    /// Bass, mids, treble, and all together, 0 to 1.
    pub bands: [f32; 4],
    pub levels: [f32; LEVELS],
    pub energy: f32,
    pub tension: f32,
    pub drop: f32,
    pub intensity: f32,
    /// The most intense this song gets (`intensity_ceiling`); 1 without
    /// an analysis.
    pub ceiling: f32,
    /// Seconds per beat.
    pub beat_seconds: f32,

    /// A beat, a bar, a drop started on this frame.
    pub on_beat: bool,
    pub on_downbeat: bool,
    pub drop_landed: bool,
    /// The music surged (live guess, without an analysis).
    pub surge: bool,
    pub section: Option<SectionNow>,
    /// True while music plays on this TV.
    pub live: bool,
    /// True when the beat comes from the server's analysis.
    pub analyzed: bool,
    pub parts: Parts,
}

/// Where the song is, for the timeline: the analysis and the position
/// heard now, in seconds.
pub struct Song<'a> {
    pub analysis: &'a Analysis,
    pub seconds: f64,
    pub playing: bool,
}

/// Listens to the TV's output and follows the song's timeline.
pub struct Listener {
    analyzer: Analyzer,
    /// The newest bands, waveform and history, as bytes for the textures.
    pub spectrum: [u8; BANDS],
    pub wave: [u8; WAVE],
    pub history: Vec<u8>,
    /// 0 to 1: time since the last history row, in rows.
    pub history_age: f32,
    history_changed: bool,

    // Live hearing.
    bass_average: f32,
    last_bass: f32,
    last_high: f32,
    high_average: f32,
    since_kick: f32,
    kick: f32,
    accent: f32,
    peak: f32,
    recent: f32,
    lately: f32,
    kick_rate: f32,
    since_surge: f32,
    calm: f32,
    levels: [f32; LEVELS],

    // The beat, guessed from kicks when there is no analysis.
    guess_beats: f64,
    guess_period: f64,
    kick_gaps: Vec<f64>,
    since_guess_kick: f64,

    /// The score around now (`AHEAD_ROWS` of `SCORE_COLUMNS`), the first
    /// row `AHEAD_BEHIND` rows before the one playing, for the GPU.
    pub ahead: Vec<u8>,
    /// How far into the row playing, 0 to 1, and the score's rows a
    /// second (0 when there is no score).
    pub ahead_shift: f32,
    pub ahead_rate: f32,
    ahead_row: Option<i64>,
    ahead_changed: bool,
    turn: f32,
    minor: f32,
    melody: f32,
    last_chord: Option<usize>,
    last_stop: Option<usize>,

    // The song's timeline.
    clock: Option<f64>,
    last_beats: f64,
    last_bar_count: f64,
    last_drop: Option<usize>,
    intensity: f32,
    energy: f32,
    drive: f32,
    time: f32,
}

impl Default for Listener {
    fn default() -> Self {
        Self::new()
    }
}

impl Listener {
    pub fn new() -> Self {
        Self {
            analyzer: Analyzer::new(),
            spectrum: [0; BANDS],
            wave: [128; WAVE],
            history: vec![0; BANDS * HISTORY_ROWS],
            history_age: 0.0,
            history_changed: true,
            bass_average: 0.0,
            last_bass: 0.0,
            last_high: 0.0,
            high_average: 0.0,
            since_kick: 1.0,
            kick: 0.0,
            accent: 0.0,
            peak: 0.3,
            recent: 0.0,
            lately: 0.0,
            kick_rate: 0.0,
            since_surge: 0.0,
            calm: 1.0,
            levels: [0.0; LEVELS],
            guess_beats: 0.0,
            guess_period: 0.5,
            kick_gaps: Vec::new(),
            since_guess_kick: 10.0,
            ahead: vec![0; SCORE_COLUMNS * AHEAD_ROWS],
            ahead_shift: 0.0,
            ahead_rate: 0.0,
            ahead_row: None,
            ahead_changed: true,
            turn: 0.0,
            minor: 0.0,
            melody: 0.5,
            last_chord: None,
            last_stop: None,
            clock: None,
            last_beats: 0.0,
            last_bar_count: 0.0,
            last_drop: None,
            intensity: 0.0,
            energy: 0.0,
            drive: 0.0,
            time: 0.0,
        }
    }

    /// True once since the history last changed (a new row to upload).
    pub fn take_history_changed(&mut self) -> bool {
        std::mem::take(&mut self.history_changed)
    }

    /// True once since the score around now last changed.
    pub fn take_ahead_changed(&mut self) -> bool {
        std::mem::take(&mut self.ahead_changed)
    }

    /// Forget the song's clock: a new song, or a seek.
    pub fn new_song(&mut self) {
        self.clock = None;
        self.last_drop = None;
        self.last_chord = None;
        self.last_stop = None;
        self.ahead_row = None;
    }

    /// Hear the next frame, `dt` seconds after the last.
    pub fn hear(&mut self, dt: f32, song: Option<Song<'_>>) -> Music {
        self.time += dt;
        let time = self.time;
        let mut bands = *self.analyzer.frame(SHOW_AHEAD);
        let live = self.analyzer.is_moving();
        self.calm = if live {
            0.0
        } else {
            (self.calm + dt * 0.5).min(1.0)
        };
        if self.calm > 0.0 {
            for (index, band) in bands.iter_mut().enumerate() {
                *band += self.calm * calm_band(index, time);
            }
        }
        let average = |range: std::ops::Range<usize>| {
            let length = range.len() as f32;
            bands[range].iter().sum::<f32>() / length
        };
        let bass = average(0..10);
        let mid = average(10..30);
        let treble = average(30..BANDS);
        let level = bass * 0.45 + mid * 0.35 + treble * 0.2;
        for (index, out) in self.levels.iter_mut().enumerate() {
            let size = BANDS / LEVELS;
            let target = average(index * size..(index + 1) * size);
            *out += (target - *out) * (dt * 20.0).min(1.0);
        }

        // The kick: the bass jumping above its recent average.
        self.since_kick += dt;
        let kicked = if live {
            bass > self.bass_average + 0.07
                && bass - self.last_bass > 0.03
                && self.since_kick > 0.22
        } else {
            self.calm > 0.5 && self.since_kick > CALM_BEAT
        };
        if kicked {
            self.since_kick = 0.0;
            self.kick = 1.0;
        } else {
            self.kick *= (-dt * 9.0).exp();
        }
        self.bass_average += (bass - self.bass_average) * (dt * 1.5).min(1.0);
        self.last_bass = bass;
        // A sharp hit: the highs jumping (snares, claps, stabs).
        let high = mid * 0.4 + treble * 0.6;
        if live && high > self.high_average + 0.08 && high - self.last_high > 0.05 {
            self.accent = 1.0;
        } else {
            self.accent *= (-dt * 12.0).exp();
        }
        self.high_average += (high - self.high_average) * (dt * 2.0).min(1.0);
        self.last_high = high;

        self.read_wave(dt, time);
        for (out, band) in self.spectrum.iter_mut().zip(bands) {
            *out = to_byte(band);
        }
        // Rows keep time even when frames are slow, so the landscape keeps
        // the grid's pace.
        self.history_age += dt * HISTORY_RATE;
        while self.history_age >= 1.0 {
            self.history_age -= 1.0;
            self.history
                .copy_within(0..BANDS * (HISTORY_ROWS - 1), BANDS);
            self.history[..BANDS].copy_from_slice(&self.spectrum);
            self.history_changed = true;
        }

        // The mood, and surges, as heard.
        self.recent += (level - self.recent) * (dt * 1.5).min(1.0);
        self.lately += (level - self.lately) * (dt * 0.1).min(1.0);
        let kicks = if kicked && live { 1.0 / dt } else { 0.0 };
        self.kick_rate += (kicks - self.kick_rate) * (dt * 0.1).min(1.0);
        self.since_surge += dt;
        let surge = live
            && self.since_surge > 6.0
            && self.recent > 0.28
            && self.recent > self.lately * 1.45 + 0.04;
        if surge {
            self.since_surge = 0.0;
        }
        let heard_intensity = if live {
            (self.lately * 1.7 + self.kick_rate * 0.22 - 0.15).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let heard_energy = (self.recent * 1.6).clamp(0.0, 1.0);

        let mut music = Music {
            time,
            dt,
            drive: 0.0,
            beats: 0.0,
            bar: 0.0,
            beat_pulse: 0.0,
            bar_pulse: 0.0,
            kick: self.kick,
            accent: self.accent,
            bands: [bass, mid, treble, level],
            levels: self.levels,
            energy: heard_energy,
            tension: 0.0,
            drop: 0.0,
            intensity: heard_intensity,
            ceiling: 1.0,
            beat_seconds: 0.5,
            on_beat: false,
            on_downbeat: false,
            drop_landed: false,
            surge,
            section: None,
            live,
            analyzed: false,
            parts: Parts::default(),
        };
        if song
            .as_ref()
            .is_none_or(|song| song.analysis.score.is_none())
            && self.ahead_rate != 0.0
        {
            self.ahead_rate = 0.0;
            self.ahead_row = None;
        }
        match song {
            Some(song) if !song.analysis.beats.is_empty() => self.follow(&mut music, &song, dt),
            _ => self.guess(&mut music, kicked, dt),
        }

        // The analysis knows where sections start, so its intensity is
        // followed quickly, and a drop lands at once. A guess from what is
        // heard moves slowly, so one loud bar doesn't change the mood.
        let (intensity_rate, energy_rate) = if music.analyzed {
            (INTENSITY_RATE, 10.0)
        } else {
            (0.7, 4.0)
        };
        if music.drop_landed {
            self.intensity = self.intensity.max(music.intensity);
        }
        self.intensity += (music.intensity - self.intensity) * (dt * intensity_rate).min(1.0);
        self.energy += (music.energy - self.energy) * (dt * energy_rate).min(1.0);
        music.intensity = self.intensity;
        music.energy = self.energy;
        // The scenes' clock: slow for calm music, quick for wild, with a
        // nudge on each beat.
        self.drive += dt
            * (0.25
                + 1.1 * music.intensity
                + 0.4 * music.energy
                + 0.3 * music.beat_pulse * music.intensity);
        music.drive = self.drive;
        music
    }

    /// The newest samples, scaled up so quiet songs move as much as loud ones.
    fn read_wave(&mut self, dt: f32, time: f32) {
        let samples = self.analyzer.samples();
        let newest = &samples[samples.len() - WAVE..];
        let peak = newest
            .iter()
            .fold(0.0f32, |peak, sample| peak.max(sample.abs()));
        self.peak = if peak > self.peak {
            peak
        } else {
            self.peak + (peak - self.peak) * (dt * 0.8).min(1.0)
        };
        let gain = 0.8 / self.peak.max(0.08);
        for (index, (out, sample)) in self.wave.iter_mut().zip(newest).enumerate() {
            let calm = self.calm * calm_wave(index, time);
            let value = (sample * gain * (1.0 - self.calm) + calm).clamp(-1.0, 1.0);
            *out = to_byte(value * 0.5 + 0.5);
        }
    }

    /// Follow the analyzed song: the beat, the bar, the section, the drops.
    fn follow(&mut self, music: &mut Music, song: &Song<'_>, dt: f32) {
        let analysis = song.analysis;
        // A steady clock that follows the reported position without jitter.
        let clock = match self.clock {
            Some(clock) if (song.seconds - clock).abs() < 0.3 => {
                let ran = if song.playing {
                    clock + f64::from(dt)
                } else {
                    clock
                };
                ran + (song.seconds - ran) * 0.1
            }
            _ => {
                self.last_beats = f64::NAN;
                song.seconds
            }
        };
        self.clock = Some(clock);
        // Where the song will be when this frame shows.
        let t = clock + SHOW_AHEAD;

        let (beats, beat_seconds) = position_in(&analysis.beats, t, 60.0 / analysis.tempo.max(1.0));
        let (bars, _) = position_in(&analysis.downbeats, t, 240.0 / analysis.tempo.max(1.0));
        let jumped = !self.last_beats.is_finite() || (beats - self.last_beats).abs() > 2.0;
        music.on_beat = !jumped && song.playing && beats.floor() > self.last_beats.floor();
        music.on_downbeat = !jumped && song.playing && bars.floor() > self.last_bar_count.floor();
        self.last_beats = beats;
        self.last_bar_count = bars;
        music.beats = beats as f32;
        music.bar = bars.rem_euclid(1.0) as f32;
        music.beat_seconds = beat_seconds as f32;
        music.beat_pulse = (-(beats.rem_euclid(1.0) * beat_seconds) as f32 * 9.0).exp();
        music.bar_pulse = (-(bars.rem_euclid(1.0) * beat_seconds * 4.0) as f32 * 5.0).exp();
        if !song.playing {
            music.beat_pulse *= 0.3;
            music.bar_pulse *= 0.3;
        }

        // The loudness the server measured, smoothed over the beat. What is
        // heard adds nothing here: it swells and falls with every beat, and
        // the beat has its own pulse.
        let curve = energy_around(analysis, t);
        music.energy = curve;

        let section = analysis
            .sections
            .iter()
            .position(|section| section.start_seconds <= t && t < section.end_seconds);
        music.section = section.map(|index| {
            let section = &analysis.sections[index];
            SectionNow {
                index,
                kind: section.kind,
                group: section.group,
                energy: section.energy,
                left: (section.end_seconds - t) as f32,
            }
        });
        // Section energies are loudness within the song, so a ballad's
        // loudest chorus scores as high as a club track's drop. The song's
        // drive (its hits and its grit, whatever the volume) caps how wild
        // its loudest part looks.
        let ceiling = intensity_ceiling(analysis.drive);
        music.ceiling = ceiling;
        music.intensity = ceiling
            * match music.section {
                Some(section) => section_intensity(section.kind, section.energy),
                None => curve,
            };

        // Drops: the build-up before, the hit, the aftershock.
        let bar_seconds = beat_seconds * 4.0;
        let landed = analysis.drops.iter().rposition(|drop| *drop <= t);
        if let Some(index) = landed {
            let since = t - analysis.drops[index];
            if since < bar_seconds * DROP_BARS * 3.0 {
                music.drop = (-(since / (bar_seconds * DROP_BARS)) as f32 * 1.6).exp();
            }
            music.drop_landed =
                song.playing && !jumped && self.last_drop != Some(index) && since < 0.25;
        }
        if music.drop_landed || jumped {
            self.last_drop = landed;
        }
        let build = bar_seconds * BUILD_BARS;
        let coming = analysis.drops.iter().find(|drop| **drop > t);
        if let Some(drop) = coming {
            let left = drop - t;
            if left < build {
                let built = (1.0 - left / build) as f32;
                music.tension = built * built;
            }
        } else if let Some(next) = section.and_then(|index| analysis.sections.get(index + 1)) {
            // A smaller lift into a louder section.
            let left = next.start_seconds - t;
            let here = section.map_or(0.0, |index| analysis.sections[index].energy);
            if left < bar_seconds * 2.0 && next.energy > here + 0.25 {
                let built = (1.0 - left / (bar_seconds * 2.0)) as f32;
                music.tension = built * built * 0.5;
            }
        }
        // A calm song's swells build and land gently: its "drop" is a
        // louder chorus, not a club track's.
        let wild = smoothstep(0.35, 0.9, ceiling);
        music.tension *= wild;
        music.drop *= wild;
        // Hits come from the analysis alone. Heard live, the bass and the
        // highs jump between the beats too (a bass line pumping between
        // kicks, an open hat), and a guess fires late by the time it is
        // sure: in house music it fired a quarter second early as often as
        // on the beat.
        let after = analysis.accents.partition_point(|accent| *accent <= t);
        music.accent = after.checked_sub(1).map_or(0.0, |index| {
            (-((t - analysis.accents[index]) as f32) * 14.0).exp()
        });
        // The kick: each beat, as hard as the music is loud and wild, and
        // hardest on the bar's first beat.
        let strength = smoothstep(0.15, 0.7, music.energy) * (0.35 + 0.65 * music.intensity);
        let bar_weight = 0.75 + 0.25 * music.bar_pulse.min(1.0);
        music.kick = (music.beat_pulse * strength * bar_weight).max(music.drop.powi(3));
        music.analyzed = true;
        self.follow_parts(
            music,
            analysis,
            t,
            dt,
            song.playing && !jumped,
            strength,
            wild,
        );
    }

    /// The parts of the song the analysis tells apart: real drum hits, the
    /// tune and the harmony, the stops, risers, and fills, and the score
    /// around now.
    #[allow(clippy::too_many_arguments)]
    fn follow_parts(
        &mut self,
        music: &mut Music,
        analysis: &Analysis,
        t: f64,
        dt: f32,
        running: bool,
        strength: f32,
        wild: f32,
    ) {
        let mut parts = music.parts;
        let since = |times: &[f64]| {
            let after = times.partition_point(|time| *time <= t);
            after
                .checked_sub(1)
                .map_or(f32::INFINITY, |index| (t - times[index]) as f32)
        };
        // The beat's pulse stands in for drums the analysis didn't find; in
        // a song driven by them, each real kick punches.
        let ratio = analysis.kicks.len() as f32 / analysis.beats.len().max(1) as f32;
        parts.drums = smoothstep(0.15, 0.6, ratio);
        let kick = (-since(&analysis.kicks) * 9.0).exp() * strength;
        music.kick = (music.kick * (1.0 - 0.6 * parts.drums)).max(kick * parts.drums);
        parts.snare = (-since(&analysis.snares) * 12.0).exp() * parts.drums;
        parts.hat = (-since(&analysis.hats) * 25.0).exp() * parts.drums;
        music.accent = music.accent.max(parts.snare * 0.8);

        if let Some(score) = &analysis.score {
            parts.lead = score.at(LEAD_COLUMN, t);
            let melody = score.at(MELODY_COLUMN, t);
            if melody > 0.0 && parts.lead > 0.1 {
                self.melody += (melody - self.melody) * (dt * 12.0).min(1.0);
            }
            parts.melody = self.melody;
            parts.bass = score.at(BASS_COLUMN, t);
            parts.brightness = score.at(BRIGHTNESS_COLUMN, t);
            self.fill_ahead(score, t);
        }

        // The harmony turns the colors: a key change a long way, and each
        // chord a little, by how far round the circle of fifths it lies.
        let key_at = |t: f64| {
            let after = analysis.keys.partition_point(|key| key.start_seconds <= t);
            analysis.keys.get(after.saturating_sub(1)).copied()
        };
        let first_key = analysis.keys.first().map_or(0, |key| key.tonic);
        let key = key_at(t);
        let tonic = key.map_or(0, |key| key.tonic);
        let semitones = (i32::from(tonic) - i32::from(first_key) + 18).rem_euclid(12) - 6;
        let chord_index = analysis
            .chords
            .partition_point(|chord| chord.start_seconds <= t)
            .checked_sub(1);
        let chord = chord_index.map(|index| analysis.chords[index]);
        let (fifths, minor) = match chord {
            Some(chord) => match chord.root {
                Some(root) => {
                    let steps = ((i32::from(root) - i32::from(tonic)) * 7 + 18).rem_euclid(12) - 6;
                    (steps as f32, if chord.minor { 1.0 } else { 0.0 })
                }
                None => (0.0, self.minor),
            },
            None => (0.0, 0.0),
        };
        let aim = semitones as f32 * KEY_TURN + fifths * CHORD_TURN;
        self.turn += (aim - self.turn) * (dt * 5.0).min(1.0);
        self.minor += (minor - self.minor) * (dt * 5.0).min(1.0);
        parts.turn = self.turn;
        parts.minor = self.minor;
        if chord_index != self.last_chord {
            if self.last_chord.is_some() {
                parts.chord_change = 1.0;
            }
            self.last_chord = chord_index;
        }
        parts.chord_change = parts.chord_change.max(chord.map_or(0.0, |chord| {
            (-((t - chord.start_seconds) as f32) * 4.0).exp()
        }));

        // Stops: the screen holds its breath, and the music coming back
        // lands like a drop.
        let in_stop = analysis
            .stops
            .iter()
            .position(|stop| stop.start_seconds <= t && t < stop.end_seconds);
        let ended = analysis
            .stops
            .iter()
            .rposition(|stop| stop.end_seconds <= t);
        parts.stop = match in_stop {
            Some(index) => {
                let stop = analysis.stops[index];
                ((t - stop.start_seconds) / 0.06).min(1.0) as f32
            }
            None => ended.map_or(0.0, |index| {
                (1.0 - (t - analysis.stops[index].end_seconds) / 0.15).max(0.0) as f32
            }),
        };
        if let Some(index) = ended {
            let stop = analysis.stops[index];
            let back = (t - stop.end_seconds) as f32;
            parts.stop_ended = running && self.last_stop != Some(index) && back < 0.25;
            if parts.stop_ended || !running {
                self.last_stop = Some(index);
            }
            if stop.end_seconds - stop.start_seconds >= 0.3 {
                music.drop = music.drop.max((-back * 1.2).exp() * 0.8 * wild.max(0.4));
                music.drop_landed |= parts.stop_ended;
            }
        }

        let within = |spans: &[crate::catalog::Span]| {
            spans
                .iter()
                .find(|span| span.start_seconds <= t && t < span.end_seconds)
                .map(|span| {
                    ((t - span.start_seconds) / (span.end_seconds - span.start_seconds)) as f32
                })
        };
        if let Some(progress) = within(&analysis.risers) {
            parts.riser = progress * progress;
            music.tension = music.tension.max(parts.riser * (0.4 + 0.5 * wild));
        }
        parts.fill = if within(&analysis.fills).is_some() {
            1.0
        } else {
            0.0
        };

        if let Some(section) = music.section {
            parts.repeat = analysis.sections[..section.index]
                .iter()
                .filter(|before| before.group == section.group)
                .count() as f32;
            // Each time a part comes back, it comes back a little bigger.
            music.intensity = (music.intensity + 0.06 * parts.repeat.min(3.0)).min(music.ceiling);
        }
        music.parts = parts;
    }

    /// Copy the score's rows around `t` for the GPU, when a new row starts.
    fn fill_ahead(&mut self, score: &Score, t: f64) {
        let position = t * score.rate;
        let first = position.floor() as i64 - AHEAD_BEHIND as i64;
        self.ahead_shift = (position - position.floor()) as f32;
        self.ahead_rate = score.rate as f32;
        if self.ahead_row == Some(first) {
            return;
        }
        self.ahead_row = Some(first);
        self.ahead_changed = true;
        for (index, out) in self.ahead.chunks_exact_mut(SCORE_COLUMNS).enumerate() {
            let row = first + index as i64;
            let source = usize::try_from(row)
                .ok()
                .filter(|row| *row < score.rows)
                .map(|row| &score.pixels[row * score.columns..(row + 1) * score.columns]);
            match source {
                Some(source) => {
                    let n = SCORE_COLUMNS.min(source.len());
                    out[..n].copy_from_slice(&source[..n]);
                    out[n..].fill(0);
                }
                None => out.fill(0),
            }
        }
    }

    /// Without an analysis: a beat that follows the kick drum.
    fn guess(&mut self, music: &mut Music, kicked: bool, dt: f32) {
        self.since_guess_kick += f64::from(dt);
        if kicked && music.live {
            let gap = self.since_guess_kick;
            self.since_guess_kick = 0.0;
            if (0.25..1.5).contains(&gap) {
                self.kick_gaps.push(gap);
                if self.kick_gaps.len() > 8 {
                    self.kick_gaps.remove(0);
                }
                let mut sorted = self.kick_gaps.clone();
                sorted.sort_by(f64::total_cmp);
                let mut period = sorted[sorted.len() / 2];
                // Keep the tempo between 75 and 160 beats a minute.
                while period > 0.8 {
                    period /= 2.0;
                }
                while period < 0.375 {
                    period *= 2.0;
                }
                self.guess_period = period;
            }
            // Pull the beat onto the kick.
            let phase = self.guess_beats.rem_euclid(1.0);
            self.guess_beats += if phase > 0.5 { 1.0 - phase } else { -phase };
        }
        let period = if music.live {
            self.guess_period
        } else {
            f64::from(CALM_BEAT)
        };
        let before = self.guess_beats;
        self.guess_beats += f64::from(dt) / period;
        music.on_beat = self.guess_beats.floor() > before.floor();
        music.on_downbeat = music.on_beat && (self.guess_beats.floor() as i64).rem_euclid(4) == 0;
        music.beats = self.guess_beats as f32;
        music.bar = (self.guess_beats / 4.0).rem_euclid(1.0) as f32;
        music.beat_seconds = period as f32;
        music.beat_pulse = (-(self.guess_beats.rem_euclid(1.0) * period) as f32 * 9.0).exp();
        music.bar_pulse =
            (-((self.guess_beats / 4.0).rem_euclid(1.0) * period * 4.0) as f32 * 5.0).exp();
        if !music.live {
            music.beat_pulse *= 0.4;
            music.bar_pulse *= 0.4;
        }
    }
}

/// How far along a list of times (beats or bars) `t` is: the count before
/// it plus the fraction into the next, and that gap in seconds. Before the
/// first and after the last, it carries on at `period`.
fn position_in(times: &[f64], t: f64, period: f64) -> (f64, f64) {
    let after = times.partition_point(|time| *time <= t);
    if times.is_empty() {
        return (t / period, period);
    }
    if after == 0 {
        let first = times[0];
        return ((t - first) / period, period);
    }
    let index = after - 1;
    let start = times[index];
    let gap = match times.get(index + 1) {
        Some(next) => (next - start).max(0.05),
        None if index > 0 => (start - times[index - 1]).max(0.05),
        None => period,
    };
    (index as f64 + (t - start) / gap, gap)
}

/// The loudness curve at `t`, averaged over `ENERGY_SPAN` each side.
fn energy_around(analysis: &Analysis, t: f64) -> f32 {
    let curve = &analysis.energy;
    let Some(last) = curve.len().checked_sub(1) else {
        return 0.5;
    };
    let step = analysis.energy_step_seconds.max(0.01);
    let index = |seconds: f64| ((seconds / step).round().max(0.0) as usize).min(last);
    let (from, to) = (index(t - ENERGY_SPAN), index(t + ENERGY_SPAN));
    curve[from..=to].iter().sum::<f32>() / (to - from + 1) as f32
}

/// The most intense a song with `drive` (0 to 1, see `Analysis::drive`)
/// looks, at its loudest: a piano ballad tops out among the calm scenes,
/// a club track reaches the wildest.
pub fn intensity_ceiling(drive: f32) -> f32 {
    0.4 + 0.6 * smoothstep(0.0, 0.7, drive)
}

/// How wild a section should look: its energy, nudged by what it is.
pub fn section_intensity(kind: SectionKind, energy: f32) -> f32 {
    match kind {
        SectionKind::Intro | SectionKind::Outro | SectionKind::Breakdown => energy * 0.6,
        SectionKind::Chorus => energy.max(0.6),
        SectionKind::Drop => energy.max(0.85),
        SectionKind::Verse | SectionKind::Bridge => energy,
    }
    .clamp(0.0, 1.0)
}

fn smoothstep(from: f32, to: f32, x: f32) -> f32 {
    let t = ((x - from) / (to - from)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn to_byte(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// A soft, slowly rolling spectrum for while nothing plays.
fn calm_band(band: usize, time: f32) -> f32 {
    let along = band as f32 / BANDS as f32;
    let swell = 0.5 + 0.5 * (time * 0.35 + along * 5.0).sin();
    (0.06 + 0.12 * swell) * (1.0 - along * 0.6)
}

/// A slow, gently folding wave for while nothing plays.
fn calm_wave(index: usize, time: f32) -> f32 {
    let along = index as f32 / WAVE as f32 * std::f32::consts::TAU;
    0.35 * (along + time * 0.8).sin() + 0.15 * (along * 3.0 - time * 1.3).sin()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Section;

    /// A 120 BPM song: an intro, a four-bar build, and a drop at 16 s.
    fn song() -> Analysis {
        let beats: Vec<f64> = (0..64).map(|beat| beat as f64 * 0.5).collect();
        Analysis {
            video_id: "a".into(),
            duration_seconds: 32.0,
            tempo: 120.0,
            downbeats: beats.iter().step_by(4).copied().collect(),
            beats,
            sections: vec![
                Section {
                    start_seconds: 0.0,
                    end_seconds: 16.0,
                    kind: SectionKind::Intro,
                    group: 0,
                    energy: 0.3,
                },
                Section {
                    start_seconds: 16.0,
                    end_seconds: 32.0,
                    kind: SectionKind::Drop,
                    group: 1,
                    energy: 1.0,
                },
            ],
            drops: vec![16.0],
            accents: vec![],
            energy_step_seconds: 1.0,
            energy: (0..33)
                .map(|second| if second < 16 { 0.3 } else { 1.0 })
                .collect(),
            drive: 0.8,
            kicks: vec![],
            snares: vec![],
            hats: vec![],
            chords: vec![],
            keys: vec![],
            stops: vec![],
            risers: vec![],
            fills: vec![],
            score_image: None,
            score: None,
        }
    }

    fn play(listener: &mut Listener, analysis: &Analysis, from: f64, to: f64) -> Vec<Music> {
        let dt = 1.0 / 60.0;
        let mut frames = Vec::new();
        let mut t = from;
        while t < to {
            frames.push(listener.hear(
                dt as f32,
                Some(Song {
                    analysis,
                    seconds: t,
                    playing: true,
                }),
            ));
            t += dt;
        }
        frames
    }

    /// `song()` with its parts: a kick on every beat, a stop, a key a step
    /// up from 8 s, and a score whose lead column counts rows.
    fn song_with_parts() -> Analysis {
        use crate::catalog::{Chord, Key, Score, Span};
        let mut analysis = song();
        analysis.kicks = analysis.beats.clone();
        analysis.stops = vec![Span {
            start_seconds: 10.0,
            end_seconds: 10.6,
        }];
        analysis.keys = vec![
            Key {
                start_seconds: 0.0,
                tonic: 9,
                minor: true,
            },
            Key {
                start_seconds: 8.0,
                tonic: 11,
                minor: true,
            },
        ];
        analysis.chords = vec![Chord {
            start_seconds: 0.0,
            root: Some(9),
            minor: true,
        }];
        let rows = 32 * 20;
        let mut pixels = vec![0u8; rows * SCORE_COLUMNS];
        for row in 0..rows {
            pixels[row * SCORE_COLUMNS + LEAD_COLUMN] = (row % 256) as u8;
        }
        analysis.score = Some(Score {
            rate: 20.0,
            columns: SCORE_COLUMNS,
            rows,
            pixels,
        });
        analysis
    }

    #[test]
    fn real_kicks_punch_and_the_key_turns_the_colors() {
        let analysis = song_with_parts();
        let mut listener = Listener::new();
        let frames = play(&mut listener, &analysis, 4.0, 7.0);
        let last = frames.last().unwrap();
        assert!(last.parts.drums > 0.9);
        assert!(last.parts.minor > 0.9);
        assert!(last.parts.turn.abs() < 1e-3);
        let frames = play(&mut listener, &analysis, 7.0, 9.5);
        // Two semitones up, less a little: A minor now lies two steps of
        // fifths below the new key, B.
        let turn = frames.last().unwrap().parts.turn;
        assert!(
            (turn - (2.0 * KEY_TURN - 2.0 * CHORD_TURN)).abs() < 0.01,
            "{turn}"
        );
    }

    #[test]
    fn a_stop_holds_its_breath_then_lands() {
        let analysis = song_with_parts();
        let mut listener = Listener::new();
        let frames = play(&mut listener, &analysis, 9.0, 11.5);
        let at = |seconds: f64| &frames[((seconds - 9.0) * 60.0) as usize];
        assert!(at(10.3).parts.stop > 0.95);
        assert!(at(9.5).parts.stop == 0.0);
        assert_eq!(frames.iter().filter(|m| m.parts.stop_ended).count(), 1);
        assert!(at(10.7).drop > 0.3);
        assert!(
            at(10.7).drop_landed || at(10.65).drop_landed || frames.iter().any(|m| m.drop_landed)
        );
    }

    #[test]
    fn the_score_around_now_goes_to_the_gpu() {
        let analysis = song_with_parts();
        let mut listener = Listener::new();
        play(&mut listener, &analysis, 2.0, 3.0);
        assert!(listener.take_ahead_changed());
        assert_eq!(listener.ahead_rate, 20.0);
        // The first row is `AHEAD_BEHIND` before the one playing.
        let first = listener.ahead[LEAD_COLUMN] as i64;
        let playing = ((3.0 - 1.0 / 60.0 + SHOW_AHEAD) * 20.0).floor() as i64;
        assert!(
            (first - (playing - AHEAD_BEHIND as i64)).abs() <= 1,
            "{first} {playing}"
        );
        assert_eq!(
            listener.ahead[SCORE_COLUMNS + LEAD_COLUMN] as i64,
            first + 1
        );
    }

    #[test]
    fn the_beat_lands_on_the_analyzed_beats() {
        let analysis = song();
        let mut listener = Listener::new();
        let frames = play(&mut listener, &analysis, 1.0, 3.0);
        let beats: Vec<f32> = frames
            .iter()
            .filter(|m| m.on_beat)
            .map(|m| m.time)
            .collect();
        // Beats at 1.5, 2.0 and 2.5 s of song time (and 3.0, depending on
        // rounding at the end).
        assert!((3..=4).contains(&beats.len()), "{beats:?}");
        for pair in beats.windows(2) {
            assert!((pair[1] - pair[0] - 0.5).abs() < 0.03, "{beats:?}");
        }
        assert!(frames.iter().filter(|m| m.on_downbeat).count() == 1);
    }

    #[test]
    fn a_beat_is_drawn_just_ahead_of_when_it_is_heard() {
        let analysis = song();
        let mut listener = Listener::new();
        let dt = 1.0 / 60.0;
        let frames = play(&mut listener, &analysis, 1.0, 3.0);
        let mut seen = 0;
        for (index, frame) in frames.iter().enumerate() {
            if !frame.on_beat {
                continue;
            }
            seen += 1;
            // The frame drawn at heard time `t` shows SHOW_AHEAD later.
            let heard = 1.0 + index as f64 * dt;
            let shown = heard + SHOW_AHEAD;
            let beat = (shown * 2.0).floor() / 2.0;
            assert!(
                (0.0..dt + 1e-6).contains(&(shown - beat)),
                "beat {beat} shows at {shown}"
            );
        }
        assert!(seen >= 3);
    }

    #[test]
    fn the_kick_lands_on_the_beat_and_is_gone_between() {
        let analysis = song();
        let mut listener = Listener::new();
        // In the drop, loud: a beat every 30 frames.
        let frames = play(&mut listener, &analysis, 19.0, 22.0);
        let on: Vec<&Music> = frames.iter().filter(|m| m.on_beat).collect();
        assert!(on.len() >= 5);
        for frame in &on {
            assert!(frame.kick > 0.6, "kick on the beat {}", frame.kick);
        }
        let between: Vec<f32> = frames
            .iter()
            .filter(|m| (m.beats.fract() - 0.5).abs() < 0.05)
            .map(|m| m.kick)
            .collect();
        assert!(between.iter().all(|kick| *kick < 0.2), "{between:?}");
    }

    #[test]
    fn energy_follows_the_song_without_the_beats_swell() {
        let mut analysis = song();
        // Loudness swelling and falling every tenth of a second, as each
        // beat's own hit does in the curve.
        analysis.energy_step_seconds = 0.1;
        analysis.energy = (0..320)
            .map(|step| if step % 2 == 0 { 0.5 } else { 0.7 })
            .collect();
        let mut listener = Listener::new();
        let frames = play(&mut listener, &analysis, 4.0, 8.0);
        for frame in &frames[60..] {
            assert!((frame.energy - 0.6).abs() < 0.04, "{}", frame.energy);
        }
    }

    #[test]
    fn a_ballads_chorus_stays_calm_and_a_club_tracks_drop_goes_wild() {
        let mut ballad = song();
        ballad.drive = 0.05;
        let mut club = song();
        club.drive = 0.8;
        let peak = |analysis: &Analysis| {
            let mut listener = Listener::new();
            play(&mut listener, analysis, 18.0, 24.0)
                .last()
                .map_or(0.0, |music| music.intensity)
        };
        assert!(peak(&ballad) < 0.45, "{}", peak(&ballad));
        assert!(peak(&club) > 0.85, "{}", peak(&club));
    }

    #[test]
    fn a_drop_builds_then_lands_once() {
        let analysis = song();
        let mut listener = Listener::new();
        // Heard time: the frame drawn at 15.95 s shows at 15.985 s.
        let before = play(&mut listener, &analysis, 6.0, 15.95);
        assert!(before[0].tension == 0.0);
        let last = before.last().unwrap();
        assert!(last.tension > 0.9, "tension {}", last.tension);
        let after = play(&mut listener, &analysis, 15.95, 20.0);
        assert_eq!(after.iter().filter(|m| m.drop_landed).count(), 1);
        assert!(after[1].drop > 0.9);
        assert!(after.last().unwrap().drop < 0.5);
        assert_eq!(after[5].section.unwrap().kind, SectionKind::Drop);
    }

    #[test]
    fn a_seek_does_not_fire_beats_or_drops() {
        let analysis = song();
        let mut listener = Listener::new();
        play(&mut listener, &analysis, 2.0, 3.0);
        let jumped = play(&mut listener, &analysis, 16.1, 16.15);
        assert!(!jumped[0].on_beat && !jumped[0].drop_landed);
    }

    #[test]
    fn position_carries_on_past_the_ends() {
        let times = [1.0, 2.0, 3.0];
        assert_eq!(position_in(&times, 2.5, 1.0), (1.5, 1.0));
        assert_eq!(position_in(&times, 0.5, 1.0), (-0.5, 1.0));
        assert_eq!(position_in(&times, 4.0, 1.0), (3.0, 1.0));
    }
}
