//! Downloads and decodes artwork off the UI thread. The server relays every
//! image, so the TV needs no TLS.
//!
//! Covers come out square with their corners already cut (artists' photos
//! as circles), so they look the same under every renderer: the software
//! renderer the screenshots use can't clip an image to a rounded shape.

use std::sync::Arc;

use slint::{Color, Rgba8Pixel, SharedPixelBuffer};

use crate::view::relayed_artwork_url;
use crate::visuals::Cover;

/// How much of a cover's corners is cut, as a share of its width. The same
/// as `Metrics.corner` in `ui/app.slint`, so boxes around a cover match it.
pub const CORNER: f32 = 0.06;

/// The shape a cover is cut to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Shape {
    /// A square with rounded corners: albums, playlists, songs.
    Rounded,
    /// A circle: artists.
    Round,
}

/// A decoded image, plus for the now-playing cover a blurred copy, a dark
/// tint of its average color for the background, and what the now-playing
/// visuals paint with.
pub struct Decoded {
    pub pixels: SharedPixelBuffer<Rgba8Pixel>,
    pub backdrop: Option<SharedPixelBuffer<Rgba8Pixel>>,
    pub tint: Option<Color>,
    pub cover: Option<Arc<Cover>>,
}

pub async fn load(
    http: &reqwest::Client,
    server: &str,
    url: &str,
    pixels: u32,
    shape: Shape,
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
    tokio::task::spawn_blocking(move || decode(&bytes, pixels, shape, hero))
        .await
        .map_err(|error| error.to_string())?
}

fn buffer(image: &image::RgbaImage) -> SharedPixelBuffer<Rgba8Pixel> {
    SharedPixelBuffer::<Rgba8Pixel>::clone_from_slice(image.as_raw(), image.width(), image.height())
}

/// The middle square of `image`, as the screen's `image-fit: cover` shows it.
fn square(image: image::DynamicImage) -> image::DynamicImage {
    let (width, height) = (image.width(), image.height());
    if width == height {
        return image;
    }
    let side = width.min(height);
    image.crop_imm((width - side) / 2, (height - side) / 2, side, side)
}

/// Make the corners of `image` see-through, `radius` pixels round, with a
/// soft one-pixel edge. A radius of half the width cuts a circle.
pub fn cut_corners(image: &mut image::RgbaImage, radius: f32) {
    let (width, height) = (image.width() as f32, image.height() as f32);
    let radius = radius.clamp(0.0, width.min(height) / 2.0);
    if radius <= 0.0 {
        return;
    }
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
        // How far the pixel is outside the square inset by `radius`.
        let dx = px - px.clamp(radius, width - radius);
        let dy = py - py.clamp(radius, height - radius);
        if dx == 0.0 && dy == 0.0 {
            continue;
        }
        let coverage = (radius - dx.hypot(dy) + 0.5).clamp(0.0, 1.0);
        pixel[3] = (f32::from(pixel[3]) * coverage).round() as u8;
    }
}

fn shaped(image: &image::DynamicImage, shape: Shape) -> image::RgbaImage {
    let mut rgba = image.to_rgba8();
    let radius = match shape {
        Shape::Rounded => rgba.width() as f32 * CORNER,
        Shape::Round => rgba.width() as f32 / 2.0,
    };
    cut_corners(&mut rgba, radius);
    rgba
}

fn decode(bytes: &[u8], pixels: u32, shape: Shape, hero: bool) -> Result<Decoded, String> {
    let image = square(image::load_from_memory(bytes).map_err(|error| error.to_string())?);
    let image = if image.width() > pixels {
        image.thumbnail(pixels, pixels)
    } else {
        image
    };
    let shown = shaped(&image, shape);
    if !hero {
        return Ok(Decoded {
            pixels: buffer(&shown),
            backdrop: None,
            tint: None,
            cover: None,
        });
    }
    let rgba = image.to_rgba8();
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
        pixels: buffer(&shown),
        backdrop: Some(buffer(&backdrop)),
        tint: Some(tint),
        // The visuals paint with the whole cover, corners and all.
        cover: Some(Arc::new(Cover::new(&image))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn white(side: u32) -> image::RgbaImage {
        image::RgbaImage::from_pixel(side, side, image::Rgba([255, 255, 255, 255]))
    }

    #[test]
    fn cuts_rounded_corners() {
        let mut image = white(100);
        cut_corners(&mut image, 100.0 * CORNER);
        assert_eq!(image.get_pixel(0, 0)[3], 0, "the corner is gone");
        assert_eq!(image.get_pixel(99, 99)[3], 0);
        assert_eq!(image.get_pixel(50, 0)[3], 255, "the edges stay");
        assert_eq!(image.get_pixel(0, 50)[3], 255);
        assert_eq!(image.get_pixel(50, 50)[3], 255);
        // A soft edge along the curve, not a jagged one.
        let edge = image.get_pixel(1, 2)[3];
        assert!(edge > 0 && edge < 255, "{edge}");
    }

    #[test]
    fn cuts_a_circle() {
        let mut image = white(100);
        cut_corners(&mut image, 50.0);
        assert_eq!(image.get_pixel(50, 50)[3], 255);
        assert!(image.get_pixel(50, 0)[3] > 200, "the top of the circle");
        assert_eq!(image.get_pixel(10, 10)[3], 0, "outside it");
        assert_eq!(image.get_pixel(90, 90)[3], 0);
    }

    #[test]
    fn crops_to_the_middle_square() {
        let wide = image::DynamicImage::ImageRgba8(image::RgbaImage::new(160, 90));
        let cropped = square(wide);
        assert_eq!((cropped.width(), cropped.height()), (90, 90));
    }
}
