//! Puts a [`View`] on the Slint window, and loads artwork off the UI thread.

use std::sync::{Arc, Mutex};

use slint::{Color, ModelRc, Rgba8Pixel, SharedPixelBuffer, SharedString, VecModel};

use crate::view::{View, clock, relayed_artwork_url};
use crate::{App, UpNextRow};

/// Artwork is decoded at this size: sharp on a 1080p TV, cheap to draw.
const ARTWORK_PIXELS: u32 = 720;
const DEFAULT_TINT: Color = Color::from_rgb_u8(0x24, 0x24, 0x2e);

pub struct Screen {
    server: String,
    app: slint::Weak<App>,
    runtime: tokio::runtime::Handle,
    client: reqwest::Client,
    artwork_url: Arc<Mutex<Option<String>>>,
}

impl Screen {
    pub fn new(server: String, app: slint::Weak<App>, runtime: tokio::runtime::Handle) -> Self {
        Self {
            server,
            app,
            runtime,
            client: reqwest::Client::new(),
            artwork_url: Arc::default(),
        }
    }

    pub fn render(&self, view: View) {
        self.load_artwork(view.artwork_url.clone());
        let _ = self.app.upgrade_in_event_loop(move |app| {
            app.set_connected(view.connected);
            app.set_idle(view.idle);
            app.set_track_title(view.title.into());
            app.set_artists(view.artists.into());
            app.set_album(view.album.into());
            app.set_playing(view.playing);
            app.set_elsewhere(view.elsewhere.into());
            app.set_notice(view.notice.into());
            app.set_position_text(clock(view.position_seconds).into());
            app.set_duration_text(clock(view.duration_seconds).into());
            app.set_progress(if view.duration_seconds > 0.0 {
                (view.position_seconds / view.duration_seconds) as f32
            } else {
                0.0
            });
            let rows: Vec<UpNextRow> = view
                .up_next
                .into_iter()
                .map(|item| UpNextRow {
                    title: SharedString::from(item.title),
                    artists: SharedString::from(item.artists),
                })
                .collect();
            app.set_up_next(ModelRc::new(VecModel::from(rows)));
        });
    }

    fn load_artwork(&self, url: Option<String>) {
        {
            let mut current = self.artwork_url.lock().unwrap();
            if *current == url {
                return;
            }
            current.clone_from(&url);
        }
        let Some(url) = url else {
            let _ = self.app.upgrade_in_event_loop(|app| {
                app.set_has_artwork(false);
                app.set_tint(DEFAULT_TINT);
            });
            return;
        };
        let app = self.app.clone();
        let client = self.client.clone();
        let wanted = self.artwork_url.clone();
        let relayed = relayed_artwork_url(&self.server, &url, ARTWORK_PIXELS);
        self.runtime.spawn(async move {
            let bytes = match fetch(&client, &relayed).await {
                Ok(bytes) => bytes,
                Err(error) => {
                    log::warn!("artwork download failed: {error}");
                    return;
                }
            };
            let Ok(Some((pixels, tint))) =
                tokio::task::spawn_blocking(move || decode(&bytes)).await
            else {
                return;
            };
            let _ = app.upgrade_in_event_loop(move |app| {
                if wanted.lock().unwrap().as_deref() != Some(url.as_str()) {
                    return;
                }
                app.set_artwork(slint::Image::from_rgba8(pixels));
                app.set_has_artwork(true);
                app.set_tint(tint);
            });
        });
    }
}

async fn fetch(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, reqwest::Error> {
    let response = client.get(url).send().await?.error_for_status()?;
    Ok(response.bytes().await?.to_vec())
}

/// Decode artwork, and pick a dark version of its average color for the background.
fn decode(bytes: &[u8]) -> Option<(SharedPixelBuffer<Rgba8Pixel>, Color)> {
    let image = image::load_from_memory(bytes).ok()?;
    let image = if image.width() > ARTWORK_PIXELS || image.height() > ARTWORK_PIXELS {
        image.thumbnail(ARTWORK_PIXELS, ARTWORK_PIXELS)
    } else {
        image
    };
    let rgba = image.to_rgba8();
    let (mut red, mut green, mut blue, mut count) = (0u64, 0u64, 0u64, 0u64);
    for pixel in rgba.pixels().step_by(7) {
        red += u64::from(pixel[0]);
        green += u64::from(pixel[1]);
        blue += u64::from(pixel[2]);
        count += 1;
    }
    let darken = |sum: u64| ((sum / count.max(1)) as f32 * 0.45) as u8;
    let tint = Color::from_rgb_u8(darken(red), darken(green), darken(blue));
    let buffer = SharedPixelBuffer::<Rgba8Pixel>::clone_from_slice(
        rgba.as_raw(),
        rgba.width(),
        rgba.height(),
    );
    Some((buffer, tint))
}
