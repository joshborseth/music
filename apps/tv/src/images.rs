//! Downloads and decodes artwork off the UI thread. The server relays every
//! image, so the TV needs no TLS.

use slint::{Color, Rgba8Pixel, SharedPixelBuffer};

use crate::view::relayed_artwork_url;

/// A decoded image, plus for the now-playing cover a blurred copy and a
/// dark tint of its average color for the background.
pub struct Decoded {
    pub pixels: SharedPixelBuffer<Rgba8Pixel>,
    pub backdrop: Option<SharedPixelBuffer<Rgba8Pixel>>,
    pub tint: Option<Color>,
}

pub async fn load(
    http: &reqwest::Client,
    server: &str,
    url: &str,
    pixels: u32,
    hero: bool,
) -> Result<Decoded, String> {
    let relayed = relayed_artwork_url(server, url, pixels);
    let response = http
        .get(&relayed)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| error.to_string())?;
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || decode(&bytes, pixels, hero))
        .await
        .map_err(|error| error.to_string())?
}

fn buffer(image: &image::RgbaImage) -> SharedPixelBuffer<Rgba8Pixel> {
    SharedPixelBuffer::<Rgba8Pixel>::clone_from_slice(image.as_raw(), image.width(), image.height())
}

fn decode(bytes: &[u8], pixels: u32, hero: bool) -> Result<Decoded, String> {
    let image = image::load_from_memory(bytes).map_err(|error| error.to_string())?;
    let image = if image.width() > pixels || image.height() > pixels {
        image.thumbnail(pixels, pixels)
    } else {
        image
    };
    let rgba = image.to_rgba8();
    if !hero {
        return Ok(Decoded {
            pixels: buffer(&rgba),
            backdrop: None,
            tint: None,
        });
    }
    let (mut red, mut green, mut blue, mut count) = (0u64, 0u64, 0u64, 0u64);
    for pixel in rgba.pixels().step_by(7) {
        red += u64::from(pixel[0]);
        green += u64::from(pixel[1]);
        blue += u64::from(pixel[2]);
        count += 1;
    }
    let darken = |sum: u64| ((sum / count.max(1)) as f32 * 0.5) as u8;
    let tint = Color::from_rgb_u8(darken(red), darken(green), darken(blue));
    // A tiny, blurred copy: scaled up across the screen it reads as a soft glow.
    let small = image.resize_exact(48, 48, image::imageops::FilterType::Triangle);
    let backdrop = image::imageops::blur(&small.to_rgba8(), 5.0);
    Ok(Decoded {
        pixels: buffer(&rgba),
        backdrop: Some(buffer(&backdrop)),
        tint: Some(tint),
    })
}
