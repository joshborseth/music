//! The session as the screen needs it, as plain data. The controller rebuilds
//! it a few times a second, and the screen only redraws when it changes.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::protocol::QueueEntry;

/// Where playback is, to the millisecond. The controller sets it each time it
/// rebuilds the view; the screen reads it many times a second to keep timed
/// lyrics in step without redrawing everything else.
#[derive(Debug, Clone, Default)]
pub struct PlayClock(Arc<Mutex<Option<ClockReading>>>);

#[derive(Debug, Clone)]
struct ClockReading {
    entry_id: String,
    seconds: f64,
    at: Instant,
    playing: bool,
}

impl PlayClock {
    pub fn set(&self, entry_id: Option<&str>, seconds: f64, playing: bool) {
        let reading = entry_id.map(|entry_id| ClockReading {
            entry_id: entry_id.to_owned(),
            seconds,
            at: Instant::now(),
            playing,
        });
        if let Ok(mut slot) = self.0.lock() {
            *slot = reading;
        }
    }

    /// Seconds into the current entry, or `None` when nothing is loaded.
    pub fn seconds(&self) -> Option<(String, f64)> {
        let slot = self.0.lock().ok()?;
        let reading = slot.as_ref()?;
        let elapsed = if reading.playing {
            reading.at.elapsed().as_secs_f64()
        } else {
            0.0
        };
        Some((reading.entry_id.clone(), reading.seconds + elapsed))
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct View {
    pub connected: bool,
    pub queue: Vec<QueueEntry>,
    /// Index of the current entry in `queue`.
    pub current: Option<usize>,
    pub playing: bool,
    /// Whole seconds, so the view only changes once a second.
    pub position_seconds: f64,
    pub duration_seconds: f64,
    /// This TV is the player.
    pub here: bool,
    /// The player's name when another device plays.
    pub player_name: Option<String>,
    /// This TV should be playing but has no audio yet.
    pub loading: bool,
    /// A message from the server, shown for a few seconds.
    pub notice: String,
    /// The house's UTC offset in minutes, for the clock. `None` until the
    /// server says, and then the TV's own time zone is used.
    pub utc_offset_minutes: Option<i32>,
    pub repeat: crate::protocol::RepeatMode,
    pub shuffle: bool,
}

impl View {
    pub fn current_entry(&self) -> Option<&QueueEntry> {
        self.current.and_then(|index| self.queue.get(index))
    }

    pub fn is_idle(&self) -> bool {
        self.current.is_none()
    }
}

/// `m:ss`, or `h:mm:ss` past an hour.
pub fn clock(seconds: f64) -> String {
    let total = seconds.max(0.0) as u64;
    let (hours, minutes, seconds) = (total / 3600, total / 60 % 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// Ask Google's image CDN for a size that suits a TV instead of a thumbnail.
fn sized_artwork_url(url: &str, pixels: u32) -> String {
    match url.rfind('=') {
        Some(index) if url[index..].starts_with("=w") || url[index..].starts_with("=s") => {
            format!("{}=w{pixels}-h{pixels}-l90-rj", &url[..index])
        }
        _ => url.to_owned(),
    }
}

/// Where to fetch artwork: the server relays it, so the TV needs no TLS.
pub fn relayed_artwork_url(server: &str, url: &str, pixels: u32) -> String {
    format!(
        "{server}/artwork?url={}",
        percent_encode(&sized_artwork_url(url, pixels))
    )
}

/// Encode everything but RFC 3986 unreserved characters.
pub fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_clock() {
        assert_eq!(clock(0.0), "0:00");
        assert_eq!(clock(61.9), "1:01");
        assert_eq!(clock(3725.0), "1:02:05");
    }

    #[test]
    fn relays_artwork_through_the_server() {
        assert_eq!(
            relayed_artwork_url(
                "http://192.168.1.67:4310",
                "https://lh3.googleusercontent.com/a-b=w120-h120",
                720
            ),
            "http://192.168.1.67:4310/artwork?url=https%3A%2F%2Flh3.googleusercontent.com%2Fa-b%3Dw720-h720-l90-rj"
        );
    }

    #[test]
    fn resizes_google_artwork() {
        assert_eq!(
            sized_artwork_url(
                "https://lh3.googleusercontent.com/abc=w120-h120-l90-rj",
                720
            ),
            "https://lh3.googleusercontent.com/abc=w720-h720-l90-rj"
        );
        assert_eq!(
            sized_artwork_url("https://lh3.googleusercontent.com/abc=s120", 300),
            "https://lh3.googleusercontent.com/abc=w300-h300-l90-rj"
        );
        assert_eq!(
            sized_artwork_url("https://i.ytimg.com/vi/x/hqdefault.jpg", 720),
            "https://i.ytimg.com/vi/x/hqdefault.jpg"
        );
    }
}
