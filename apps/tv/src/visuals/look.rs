//! What the visuals take from the cover: three vivid colors and a small copy
//! of the picture itself.

use std::sync::Arc;

use super::canvas::Rgb;

/// The cover's side, in pixels, as the visuals draw it.
pub const COVER_SIDE: usize = 96;
/// Joshify's own green, lime, and teal, for a song without a colorful cover.
const DEFAULT_COLORS: [Rgb; 3] = [[0.13, 0.83, 0.44], [0.72, 0.96, 0.25], [0.05, 0.72, 0.78]];
const HUES: usize = 24;

/// The now-playing cover, decoded off the UI thread with the artwork.
pub struct Cover {
    pub colors: [Rgb; 3],
    /// `COVER_SIDE` × `COVER_SIDE` pixels, row by row.
    pub pixels: Vec<Rgb>,
}

impl Cover {
    pub fn new(image: &image::DynamicImage) -> Self {
        let side = COVER_SIDE as u32;
        let small = image
            .resize_exact(side, side, image::imageops::FilterType::Triangle)
            .to_rgb8();
        let pixels: Vec<Rgb> = small
            .pixels()
            .map(|pixel| pixel.0.map(|channel| f32::from(channel) / 255.0))
            .collect();
        Self {
            colors: vivid_colors(&pixels),
            pixels,
        }
    }
}

/// The cover's three strongest hues at full brightness. Hues are weighed by
/// how much of the cover is that color and how colorful it is. A cover
/// with one hue gets a neighbor and its opposite, for contrast; a grey one
/// gets the app's colors.
fn vivid_colors(pixels: &[Rgb]) -> [Rgb; 3] {
    let mut weight = [0.0f32; HUES];
    let mut saturation = [0.0f32; HUES];
    for pixel in pixels {
        let (hue, sat, value) = hsv(*pixel);
        if sat < 0.25 || value < 0.2 {
            continue;
        }
        let bucket = ((hue * HUES as f32) as usize).min(HUES - 1);
        weight[bucket] += sat * value;
        saturation[bucket] += sat * sat * value;
    }
    let total: f32 = weight.iter().sum();
    if total < pixels.len() as f32 * 0.01 {
        return DEFAULT_COLORS;
    }
    let mut picked: Vec<usize> = Vec::new();
    while picked.len() < 3 {
        let best = (0..HUES)
            .filter(|bucket| {
                picked.iter().all(|other| {
                    let apart = bucket.abs_diff(*other);
                    apart.min(HUES - apart) >= 4
                })
            })
            .filter(|bucket| weight[*bucket] > total * 0.04)
            .max_by(|a, b| weight[*a].total_cmp(&weight[*b]));
        match best {
            Some(bucket) => picked.push(bucket),
            None => break,
        }
    }
    let color = |bucket: usize, shift: f32| {
        let hue = (bucket as f32 + 0.5) / HUES as f32 + shift;
        let sat = (saturation[bucket] / weight[bucket].max(1e-6)).clamp(0.7, 1.0);
        rgb(hue.rem_euclid(1.0), sat, 1.0)
    };
    let first = picked[0];
    [
        color(first, 0.0),
        picked
            .get(1)
            .map_or_else(|| color(first, 0.15), |b| color(*b, 0.0)),
        picked
            .get(2)
            .map_or_else(|| color(first, 0.5), |b| color(*b, 0.0)),
    ]
}

fn hsv([red, green, blue]: Rgb) -> (f32, f32, f32) {
    let max = red.max(green).max(blue);
    let min = red.min(green).min(blue);
    let chroma = max - min;
    if chroma <= 0.0 {
        return (0.0, 0.0, max);
    }
    let hue = if max == red {
        ((green - blue) / chroma).rem_euclid(6.0)
    } else if max == green {
        (blue - red) / chroma + 2.0
    } else {
        (red - green) / chroma + 4.0
    };
    (hue / 6.0, chroma / max, max)
}

fn rgb(hue: f32, sat: f32, value: f32) -> Rgb {
    let channel = |n: f32| {
        let k = (n + hue * 6.0).rem_euclid(6.0);
        value - value * sat * k.min(4.0 - k).clamp(0.0, 1.0)
    };
    [channel(5.0), channel(3.0), channel(1.0)]
}

/// The colors a scene paints with: a loop through the cover's three colors.
pub struct Look {
    ramp: [Rgb; RAMP],
    pub cover: Option<Arc<Cover>>,
}

const RAMP: usize = 256;

impl Look {
    pub fn new(cover: Option<Arc<Cover>>) -> Self {
        let colors = cover.as_ref().map_or(DEFAULT_COLORS, |cover| cover.colors);
        let mut ramp = [[0.0; 3]; RAMP];
        for (index, slot) in ramp.iter_mut().enumerate() {
            let position = index as f32 / RAMP as f32 * 3.0;
            let from = position as usize % 3;
            let to = (from + 1) % 3;
            let blend = position.fract();
            let blend = blend * blend * (3.0 - 2.0 * blend);
            for channel in 0..3 {
                slot[channel] = colors[from][channel] * (1.0 - blend) + colors[to][channel] * blend;
            }
        }
        Self { ramp, cover }
    }

    /// A color along the loop; `t` wraps every 1.
    #[inline]
    pub fn color(&self, t: f32) -> Rgb {
        let index = (t.rem_euclid(1.0) * RAMP as f32) as usize;
        self.ramp[index.min(RAMP - 1)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cover_of(pixel: impl Fn(u32, u32) -> [u8; 3]) -> Cover {
        let image = image::RgbImage::from_fn(64, 64, |x, y| image::Rgb(pixel(x, y)));
        Cover::new(&image::DynamicImage::ImageRgb8(image))
    }

    #[test]
    fn a_red_and_blue_cover_paints_red_and_blue() {
        let cover = cover_of(|x, _| if x < 40 { [200, 20, 30] } else { [20, 40, 210] });
        let [first, second, _] = cover.colors;
        assert!(first[0] > 0.9 && first[2] < 0.35, "{first:?}");
        assert!(second[2] > 0.9 && second[0] < 0.35, "{second:?}");
    }

    #[test]
    fn a_grey_cover_paints_with_the_app_colors() {
        let cover = cover_of(|x, y| {
            let grey = ((x + y) * 2) as u8;
            [grey, grey, grey]
        });
        assert_eq!(cover.colors, DEFAULT_COLORS);
    }

    #[test]
    fn the_color_loop_wraps() {
        let look = Look::new(None);
        assert_eq!(look.color(0.25), look.color(1.25));
        assert_eq!(look.color(-0.75), look.color(0.25));
    }
}
