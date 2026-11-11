//! What the screen shows, as plain data. The controller rebuilds it a few
//! times a second and the screen only redraws when it changes.

#[derive(Debug, Clone, PartialEq)]
pub struct UpNextItem {
    pub title: String,
    pub artists: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct View {
    pub connected: bool,
    /// Nothing is queued: show the welcome screen.
    pub idle: bool,
    pub title: String,
    pub artists: String,
    pub album: String,
    pub artwork_url: Option<String>,
    pub duration_seconds: f64,
    pub position_seconds: f64,
    pub playing: bool,
    /// "Playing on iPhone" when another device is the player.
    pub elsewhere: String,
    pub notice: String,
    pub up_next: Vec<UpNextItem>,
}

impl View {
    pub fn idle(connected: bool, notice: String) -> Self {
        Self {
            connected,
            idle: true,
            title: String::new(),
            artists: String::new(),
            album: String::new(),
            artwork_url: None,
            duration_seconds: 0.0,
            position_seconds: 0.0,
            playing: false,
            elsewhere: String::new(),
            notice,
            up_next: Vec::new(),
        }
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
        Some(index) if url[index..].starts_with("=w") => {
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
fn percent_encode(text: &str) -> String {
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
            sized_artwork_url("https://i.ytimg.com/vi/x/hqdefault.jpg", 720),
            "https://i.ytimg.com/vi/x/hqdefault.jpg"
        );
    }
}
