//! Plays a real song through the visuals' own listening and directing, off
//! the TV, and writes what the shaders would get each frame for the browser
//! lab (`apps/tv/visuals-lab`, its song page) to draw.
//!
//! The song's samples go through the same scope and FFT as on the TV, the
//! server's analysis through the same `Listener`, and the scenes are picked
//! by the same `Director`, so the lab shows what the TV would.
//!
//! ```sh
//! ffmpeg -i song.m4a -ac 1 -ar 44100 -f f32le song.f32
//! curl 'http://127.0.0.1:4310/tv/analysis?videoId=…' > song.json
//! VISUALS_SONG_PCM=song.f32 VISUALS_SONG_ANALYSIS=song.json \
//!   VISUALS_SONG_OUT=frames.json VISUALS_SONG_WINDOWS=30-34,61.5-66 \
//!   cargo test -p music-tv visuals::lab -- --ignored
//! ```
//!
//! The output has a timeline of the whole song (four points a second) and,
//! for each window, every frame: the music's values, the shot, and the
//! spectrum and waveform as hex, with the spectrum's history as it stood
//! when the window opened.

use std::fmt::Write as _;

use serde_json::{Value, json};

use super::director::{Director, Shot};
use super::music::{Listener, Music, Song};
use crate::audio::scope::SCOPE;
use crate::catalog::{Analysis, Score};

const RATE: u32 = 44_100;
const FPS: f64 = 60.0;

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn music_json(music: &Music) -> Value {
    json!({
        "time": music.time,
        "dt": music.dt,
        "drive": music.drive,
        "beats": music.beats,
        "bar": music.bar,
        "beatPulse": music.beat_pulse,
        "barPulse": music.bar_pulse,
        "kick": music.kick,
        "accent": music.accent,
        "bands": music.bands,
        "levels": music.levels,
        "energy": music.energy,
        "tension": music.tension,
        "drop": music.drop,
        "intensity": music.intensity,
        "beatSeconds": music.beat_seconds,
        "onBeat": music.on_beat,
        "onDownbeat": music.on_downbeat,
        "dropLanded": music.drop_landed,
        "section": music.section.map(|section| format!("{:?}", section.kind)),
        "parts": {
            "snare": music.parts.snare,
            "hat": music.parts.hat,
            "drums": music.parts.drums,
            "lead": music.parts.lead,
            "melody": music.parts.melody,
            "bass": music.parts.bass,
            "brightness": music.parts.brightness,
            "turn": music.parts.turn,
            "minor": music.parts.minor,
            "chordChange": music.parts.chord_change,
            "stop": music.parts.stop,
            "riser": music.parts.riser,
            "fill": music.parts.fill,
            "repeat": music.parts.repeat,
        },
        "ceiling": music.ceiling,
        "cue": {
            "until": music.parts.cue.until,
            "build": music.parts.cue.build,
            "strength": music.parts.cue.strength,
            "since": music.parts.cue.since,
            "landed": music.parts.cue.landed,
            "climax": music.parts.cue.climax,
            "strobe": music.parts.cue.strobe,
        },
    })
}

fn shot_json(shot: &Shot) -> Value {
    json!({
        "scene": shot.current.scene,
        "seed": shot.current.seed,
        "age": shot.current.age,
        "next": shot.next.map(|(next, progress)| json!({
            "scene": next.scene,
            "seed": next.seed,
            "age": next.age,
            "progress": progress,
        })),
        "kind": format!("{:?}", shot.kind),
    })
}

#[test]
#[ignore = "needs a song: see the module's docs"]
fn play_a_song_for_the_lab() {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("set {name}"));
    let pcm = std::fs::read(var("VISUALS_SONG_PCM")).expect("the song's samples");
    let samples: Vec<f32> = pcm
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect();
    let mut analysis: Analysis =
        serde_json::from_slice(&std::fs::read(var("VISUALS_SONG_ANALYSIS")).expect("analysis"))
            .expect("an analysis");
    analysis.score = analysis
        .score_image
        .take()
        .and_then(|image| Score::decode(&image));
    let windows: Vec<(f64, f64)> = std::env::var("VISUALS_SONG_WINDOWS")
        .unwrap_or_default()
        .split(',')
        .filter_map(|window| {
            let (start, end) = window.split_once('-')?;
            Some((start.trim().parse().ok()?, end.trim().parse().ok()?))
        })
        .collect();

    SCOPE.set_rate(RATE);
    let mut listener = Listener::new();
    let mut director = Director::new(0x5eed);
    let duration = samples.len() as f64 / f64::from(RATE);
    let dt = 1.0 / FPS;
    let mut written = 0usize;
    let mut timeline = Vec::new();
    let mut out_windows: Vec<Value> = windows
        .iter()
        .map(|(start, end)| json!({ "start": start, "end": end, "frames": [] }))
        .collect();
    let mut frame = 0u64;
    loop {
        let t = frame as f64 * dt;
        if t >= duration {
            break;
        }
        // What the device has played by now.
        let until = ((t * f64::from(RATE)) as usize).min(samples.len());
        if until > written {
            SCOPE.write(&samples[written..until], 1);
            written = until;
        }
        let music = listener.hear(
            dt as f32,
            Some(Song {
                analysis: &analysis,
                seconds: t,
                playing: true,
            }),
        );
        let shot = director.direct(&music, Some("song"));
        // At 60 frames a second, at most one new row a frame.
        let rows = u32::from(listener.take_history_changed());
        if frame.is_multiple_of(15) {
            timeline.push(json!({
                "t": t,
                "scene": shot.current.scene,
                "next": shot.next.map(|(next, progress)| (next.scene, progress)),
                "kind": format!("{:?}", shot.kind),
                "build": music.parts.cue.build,
                "climax": music.parts.cue.climax,
                "strobe": music.parts.cue.strobe,
                "energy": music.energy,
                "intensity": music.intensity,
                "tension": music.tension,
                "drop": music.drop,
                "kick": music.kick,
                "bass": music.bands[0],
                "level": music.bands[3],
                "section": music.section.map(|section| format!("{:?}", section.kind)),
            }));
        }
        for ((start, end), window) in windows.iter().zip(out_windows.iter_mut()) {
            if t < *start || t >= *end {
                continue;
            }
            let empty = window["frames"].as_array().is_none_or(Vec::is_empty);
            // The window opens with the history as it stands, this
            // frame's row included.
            let rows = if empty {
                window["history"] = Value::String(hex(&listener.history));
                0
            } else {
                rows
            };
            let frames = window["frames"].as_array_mut().expect("frames");
            frames.push(json!({
                "t": t,
                "music": music_json(&music),
                "shot": shot_json(&shot),
                "spectrum": hex(&listener.spectrum),
                "wave": hex(&listener.wave),
                "rows": rows,
                "historyAge": listener.history_age,
                "ahead": (listener.ahead_rate > 0.0).then(|| hex(&listener.ahead)),
                "aheadShift": listener.ahead_shift,
                "aheadRate": listener.ahead_rate,
            }));
        }
        frame += 1;
    }
    let out = json!({
        "videoId": analysis.video_id,
        "tempo": analysis.tempo,
        "duration": duration,
        "fps": FPS,
        "sections": analysis.sections.iter().map(|section| json!({
            "start": section.start_seconds,
            "end": section.end_seconds,
            "kind": format!("{:?}", section.kind),
            "energy": section.energy,
        })).collect::<Vec<_>>(),
        "drops": analysis.drops,
        "choreography": analysis.choreography,
        "timeline": timeline,
        "windows": out_windows,
    });
    std::fs::write(var("VISUALS_SONG_OUT"), out.to_string()).expect("written");
}

/// When each thing a song needs reaches the TV as it starts, in seconds:
/// the analysis, the cover's depth (Diorama), and the montage (Montage,
/// which then uploads a strip a frame).
#[derive(Debug, Clone, Copy)]
struct Arrivals {
    analysis: f64,
    depth: f64,
    montage: f64,
    /// Until this many seconds, the song's clock runs this far ahead: the
    /// session's position, before the TV's engine reports its own.
    lead: Option<(f64, f64)>,
}

/// Frames the montage takes to upload, a strip a frame.
const MONTAGE_UPLOAD_FRAMES: u32 = 8;

/// Play `analysis`'s song the way the TV starts one: frames of uneven
/// length, its content arriving as `arrivals` says, and the samples (if
/// any) heard as they play. Calls `frame` with the song's seconds, the
/// music, and each frame's shot.
fn replay(
    analysis: &Analysis,
    samples: Option<&[f32]>,
    song: &str,
    arrivals: Arrivals,
    mut frame: impl FnMut(f64, &Music, &Shot, &mut Director),
) {
    use super::director::{MONTAGE, SCENES, scene_index};
    let diorama = scene_index("Diorama");
    let mut listener = Listener::new();
    let mut director = Director::new(0x5eed);
    let mut real = 0.0f64;
    let mut written = 0usize;
    let mut montage_frames = 0u32;
    let mut count = 0u64;
    while real < analysis.duration_seconds {
        // The TV ran at about 45 frames a second: most on time, some late.
        let dt = match count % 9 {
            4 => 0.05,
            8 if count % 63 == 8 => 0.1,
            _ => 1.0 / FPS,
        };
        count += 1;
        real += dt;
        let seconds = match arrivals.lead {
            Some((until, lead)) if real < until => real + lead,
            _ => real,
        };
        if let Some(samples) = samples {
            let until = ((real * f64::from(RATE)) as usize).min(samples.len());
            if until > written {
                SCOPE.write(&samples[written..until], 1);
                written = until;
            }
        }
        let music = listener.hear(
            dt as f32,
            (real >= arrivals.analysis).then_some(Song {
                analysis,
                seconds,
                playing: true,
            }),
        );
        if real >= arrivals.montage {
            montage_frames += 1;
        }
        let mut available = [true; SCENES.len()];
        available[diorama] = real >= arrivals.depth;
        available[MONTAGE] = montage_frames > MONTAGE_UPLOAD_FRAMES;
        director.set_available(available);
        let shot = director.direct(&music, Some(song));
        frame(seconds, &music, &shot, &mut director);
    }
}

fn new_david_bowie() -> Analysis {
    serde_json::from_str(include_str!("fixtures/new-david-bowie.json")).expect("an analysis")
}

/// The ways a song started in the tests: its content on time, late as on
/// the TV, and its clock running ahead and then back.
const STARTS: [Arrivals; 7] = [
    Arrivals {
        analysis: 0.0,
        depth: 0.3,
        montage: 0.6,
        lead: None,
    },
    Arrivals {
        analysis: 0.4,
        depth: 0.5,
        montage: 0.9,
        lead: None,
    },
    // As on the TV.
    Arrivals {
        analysis: 5.0,
        depth: 5.2,
        montage: 5.4,
        lead: None,
    },
    Arrivals {
        analysis: 5.0,
        depth: 5.2,
        montage: 5.4,
        lead: Some((5.0, 1.5)),
    },
    Arrivals {
        analysis: 9.0,
        depth: 3.0,
        montage: 12.0,
        lead: None,
    },
    Arrivals {
        analysis: 23.0,
        depth: 1.0,
        montage: 2.0,
        lead: None,
    },
    // Into the next section and back across its start.
    Arrivals {
        analysis: 0.0,
        depth: 0.3,
        montage: 0.6,
        lead: Some((21.6, 0.6)),
    },
];

/// "new david bowie" started on the TV right after an update: its analysis
/// came 5 seconds in, the cover's depth and the montage with it, and its
/// scene changed every 4 to 8 seconds, though its sections change only at
/// 5.5, 22, and 33 seconds. However its content arrives, and when the
/// song's clock jumps back across a section's start, the scene changes
/// only where the music does: at a section's start, a drop or the climax
/// landing, a phrase, or once when the analysis comes mid-section.
#[test]
fn a_song_whose_content_arrives_late_changes_scene_only_where_the_music_does() {
    use super::director::SCENES;
    let analysis = new_david_bowie();
    let bar = 4.0 * 60.0 / analysis.tempo;
    // Within a bar of one of `times`.
    let near = |times: &mut dyn Iterator<Item = f64>, seconds: f64| {
        let mut times = times;
        Iterator::any(&mut times, |time: f64| {
            (time - 0.1..time + bar).contains(&seconds)
        })
    };
    let landings = || {
        analysis
            .sections
            .iter()
            .map(|section| section.start_seconds)
            .chain(analysis.drops.iter().copied())
            .chain(
                analysis
                    .choreography
                    .climax
                    .map(|climax| climax.land_seconds),
            )
    };
    let mut failures = Vec::new();
    for arrivals in STARTS {
        // Each song seeds its own picks (the TV seeds them with the queue
        // entry's id).
        for song in ["entry-1", "entry-2", "entry-3", "entry-4"] {
            let mut changes: Vec<(f64, usize)> = Vec::new();
            let mut reasons = Vec::new();
            let mut last = None;
            replay(
                &analysis,
                None,
                song,
                arrivals,
                |seconds, _, shot, director| {
                    let latest = shot.next.map_or(shot.current.scene, |(next, _)| next.scene);
                    if last.is_some_and(|last| last != latest) {
                        changes.push((seconds, latest));
                    }
                    last = Some(latest);
                    if let Some(change) = director.take_change() {
                        reasons.push(format!("{seconds:.2} {}", change.reason.label()));
                    }
                },
            );
            let log = changes
                .iter()
                .map(|(seconds, scene)| format!("{seconds:.2} {}", SCENES[*scene].name))
                .chain(std::iter::once(format!("reasons: {}", reasons.join(", "))))
                .collect::<Vec<_>>()
                .join(", ");
            // The analysis came mid-section: one change for it, within a
            // bar, unless the section was nearly over.
            let mid_section = analysis.sections.iter().any(|section| {
                section.start_seconds < arrivals.analysis
                    && arrivals.analysis < section.end_seconds - 8.0 * bar
            });
            let mut previous: Option<f64> = None;
            let mut for_analysis = 0;
            for &(seconds, _) in &changes {
                let at_landing = near(&mut landings(), seconds);
                let at_phrase =
                    previous.is_some_and(|previous| seconds - previous >= 16.0 * bar - 0.1);
                let at_analysis = mid_section
                    && (arrivals.analysis..arrivals.analysis + bar + 0.1).contains(&seconds);
                if at_analysis && !at_landing {
                    for_analysis += 1;
                }
                let soon = previous.is_some_and(|previous| seconds - previous < 4.0 * bar)
                    && !near(&mut analysis.drops.iter().copied(), seconds);
                if !(at_landing || at_phrase || at_analysis) || for_analysis > 1 || soon {
                    failures.push(format!("{arrivals:?} {song}: at {seconds:.2} s: {log}"));
                    break;
                }
                previous = Some(seconds);
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Play a real song the way the TV started "new david bowie", its analysis,
/// depth, and montage arriving 5 seconds in, and print every change of
/// scene with its reason:
///
/// ```sh
/// VISUALS_SONG_PCM=song.f32 VISUALS_SONG_ANALYSIS=song.json \
///   cargo test -p music-tv visuals::lab::replay -- --ignored --nocapture
/// ```
#[test]
#[ignore = "needs a song: see the module's docs"]
fn replay_a_song_started_as_on_the_tv() {
    use super::director::SCENES;
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("set {name}"));
    let pcm = std::fs::read(var("VISUALS_SONG_PCM")).expect("the song's samples");
    let samples: Vec<f32> = pcm
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect();
    let analysis: Analysis =
        serde_json::from_slice(&std::fs::read(var("VISUALS_SONG_ANALYSIS")).expect("analysis"))
            .expect("an analysis");
    SCOPE.set_rate(RATE);
    replay(
        &analysis,
        Some(&samples),
        "entry",
        STARTS[2],
        |seconds, music, _, director| {
            if let Some(change) = director.take_change() {
                println!(
                    "{seconds:6.2} s  {:8} {:12} {:18} section {:?}",
                    SCENES[change.scene].name,
                    format!("{:?}", change.kind),
                    change.reason.label(),
                    music.section.map(|section| section.index),
                );
            }
        },
    );
}
