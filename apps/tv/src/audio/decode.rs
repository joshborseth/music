//! Turns one song's MP4/AAC bytes into interleaved stereo `f32` samples.

use std::sync::Arc;

use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::{Time, TimeBase};

use super::source::{StreamingSource, TrackData};

/// Every song is played as two channels; mono is duplicated, extra channels dropped.
pub const CHANNELS: usize = 2;

pub struct TrackDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    pub rate: u32,
    /// Frames still to drop after an accurate seek landed before the target.
    skip_until_ts: Option<i64>,
    scratch: Vec<f32>,
}

impl TrackDecoder {
    /// Open a song and position it at `start_seconds`.
    pub fn open(data: Arc<TrackData>, start_seconds: f64) -> Result<Self, String> {
        let source = MediaSourceStream::new(
            Box::new(StreamingSource::new(data)),
            MediaSourceStreamOptions::default(),
        );
        let mut hint = Hint::new();
        hint.with_extension("m4a");
        let format = symphonia::default::get_probe()
            .probe(
                &hint,
                source,
                FormatOptions::default(),
                MetadataOptions::default(),
            )
            .map_err(|error| format!("unreadable audio: {error}"))?;
        let track = format
            .default_track(TrackType::Audio)
            .ok_or("no audio track")?;
        let params = track
            .codec_params
            .as_ref()
            .and_then(|params| params.audio())
            .ok_or("no audio codec parameters")?;
        let rate = params.sample_rate.ok_or("unknown sample rate")?;
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(params, &AudioDecoderOptions::default())
            .map_err(|error| format!("unsupported codec: {error}"))?;
        let track_id = track.id;
        let time_base = track.time_base;

        let mut this = Self {
            format,
            decoder,
            track_id,
            time_base,
            rate,
            skip_until_ts: None,
            scratch: Vec::new(),
        };
        if start_seconds > 0.5 {
            this.seek(start_seconds)?;
        }
        Ok(this)
    }

    fn seek(&mut self, seconds: f64) -> Result<(), String> {
        let time = Time::try_from_secs_f64(seconds).ok_or("bad seek time")?;
        let seeked = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time,
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|error| format!("seek failed: {error}"))?;
        self.decoder.reset();
        self.skip_until_ts = Some(seeked.required_ts.get());
        Ok(())
    }

    /// Frames to drop from a packet starting at `pts` with `frames` frames.
    fn frames_to_skip(&mut self, pts: i64, frames: usize) -> usize {
        let Some(target) = self.skip_until_ts else {
            return 0;
        };
        if pts >= target {
            self.skip_until_ts = None;
            return 0;
        }
        let ticks = (target - pts) as f64;
        let frames_per_tick = match self.time_base {
            Some(base) => {
                f64::from(base.numer.get()) / f64::from(base.denom.get()) * f64::from(self.rate)
            }
            None => 1.0,
        };
        let skip = (ticks * frames_per_tick).round() as usize;
        if skip < frames {
            self.skip_until_ts = None;
        }
        skip.min(frames)
    }

    /// Decode the next packet and append its samples to `out`.
    /// Returns `Ok(false)` at the end of the song.
    pub fn decode_into(&mut self, out: &mut Vec<f32>) -> Result<bool, String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(packet)) => packet,
                Ok(None) => return Ok(false),
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    return Ok(false);
                }
                Err(error) => return Err(format!("read failed: {error}")),
            };
            if packet.track_id != self.track_id {
                continue;
            }
            let pts = packet.pts.get();
            let buffer = match self.decoder.decode(&packet) {
                Ok(buffer) => buffer,
                // A damaged packet: skip it like every player does.
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(error) => return Err(format!("decode failed: {error}")),
            };
            let channels = buffer.spec().channels().count().max(1);
            let frames = buffer.frames();
            if frames == 0 {
                continue;
            }
            self.scratch.resize(buffer.samples_interleaved(), 0.0);
            buffer.copy_to_slice_interleaved(&mut self.scratch[..]);
            let skip = self.frames_to_skip(pts, frames);
            out.reserve((frames - skip) * CHANNELS);
            for frame in self.scratch.chunks_exact(channels).skip(skip) {
                let left = frame[0];
                let right = if channels > 1 { frame[1] } else { left };
                out.push(left);
                out.push(right);
            }
            return Ok(true);
        }
    }
}
