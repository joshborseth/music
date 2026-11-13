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
use crate::catalog::Analysis;

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
    let analysis: Analysis =
        serde_json::from_slice(&std::fs::read(var("VISUALS_SONG_ANALYSIS")).expect("analysis"))
            .expect("an analysis");
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
        "timeline": timeline,
        "windows": out_windows,
    });
    std::fs::write(var("VISUALS_SONG_OUT"), out.to_string()).expect("written");
}
