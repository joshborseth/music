//! What the visuals take from the cover: one strong color, in three shades,
//! and a small copy of the picture itself, ready to upload to the GPU.

pub type Rgb = [f32; 3];

/// The cover's side, in pixels, as the visuals draw it.
pub const COVER_SIDE: usize = 256;
/// Joshify's own green, for a song without a colorful cover.
const DEFAULT_COLOR: Rgb = [0.13, 0.83, 0.44];
pub const DEFAULT_COLORS: [Rgb; 3] = shades(DEFAULT_COLOR);
const HUES: usize = 24;
/// The cover's color is pushed at least this saturated, so it reads strong.
const MIN_SATURATION: f32 = 0.9;

/// The now-playing cover, decoded off the UI thread with the artwork.
pub struct Cover {
    /// One color in three shades, for the shaders' `uColorA`, `uColorB`, and
    /// `uColorC`: full strength, a little deeper, and deep. See `strong_color`.
    pub colors: [Rgb; 3],
    /// `COVER_SIDE` × `COVER_SIDE` RGBA pixels, row by row from the top.
    pub rgba: Vec<u8>,
}

impl Cover {
    pub fn new(image: &image::DynamicImage) -> Self {
        let side = COVER_SIDE as u32;
        let small = image
            .resize_exact(side, side, image::imageops::FilterType::Triangle)
            .to_rgba8();
        let pixels: Vec<Rgb> = small
            .pixels()
            .map(|pixel| [0, 1, 2].map(|channel| f32::from(pixel.0[channel]) / 255.0))
            .collect();
        Self {
            colors: shades(strong_color(&pixels)),
            rgba: small.into_raw(),
        }
    }
}

/// The color at full strength, a little deeper, and deep: the same hue
/// throughout, so the visuals never bring in a color the cover lacks.
const fn shades([red, green, blue]: Rgb) -> [Rgb; 3] {
    [
        [red, green, blue],
        [red * 0.75, green * 0.75, blue * 0.75],
        [red * 0.5, green * 0.5, blue * 0.5],
    ]
}

/// The cover's main color, made strong: the hue that covers the most of it,
/// weighed by how colorful each pixel is, at full brightness and at least
/// `MIN_SATURATION`. The hue is the average of the cover's own pixels near
/// it, not a rounded one, so a yellow title paints that same yellow. A grey
/// cover gets the app's green.
fn strong_color(pixels: &[Rgb]) -> Rgb {
    let colorful: Vec<(f32, f32, f32)> = pixels
        .iter()
        .map(|pixel| hsv(*pixel))
        .filter(|(_, sat, value)| *sat >= 0.25 && *value >= 0.2)
        .map(|(hue, sat, value)| (hue, sat, sat * value))
        .collect();
    let mut weight = [0.0f32; HUES];
    for (hue, _, strength) in &colorful {
        weight[bucket(*hue)] += strength;
    }
    let total: f32 = weight.iter().sum();
    if total < pixels.len() as f32 * 0.01 {
        return DEFAULT_COLOR;
    }
    // The heaviest run of three neighboring buckets, so a hue that sits on a
    // bucket's edge is not split in two.
    let around = |center: usize| (0..3).map(move |step| (center + HUES - 1 + step) % HUES);
    let peak = (0..HUES)
        .max_by(|a, b| {
            let sum = |center: usize| around(center).map(|b| weight[b]).sum::<f32>();
            sum(*a).total_cmp(&sum(*b))
        })
        .unwrap_or(0);
    let near: Vec<usize> = around(peak).collect();
    // The weighted average hue on the color wheel, and the average saturation.
    let (mut x, mut y, mut sat, mut sum) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for (hue, saturation, strength) in &colorful {
        if near.contains(&bucket(*hue)) {
            let angle = hue * std::f32::consts::TAU;
            x += angle.cos() * strength;
            y += angle.sin() * strength;
            sat += saturation * strength;
            sum += strength;
        }
    }
    let hue = (y.atan2(x) / std::f32::consts::TAU).rem_euclid(1.0);
    let sat = (sat / sum.max(1e-6)).clamp(MIN_SATURATION, 1.0);
    rgb(hue, sat, 1.0)
}

fn bucket(hue: f32) -> usize {
    ((hue * HUES as f32) as usize).min(HUES - 1)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cover_of(pixel: impl Fn(u32, u32) -> [u8; 3]) -> Cover {
        let image = image::RgbImage::from_fn(64, 64, |x, y| image::Rgb(pixel(x, y)));
        Cover::new(&image::DynamicImage::ImageRgb8(image))
    }

    fn hue_degrees(color: Rgb) -> f32 {
        hsv(color).0 * 360.0
    }

    #[test]
    fn a_grey_cover_with_a_yellow_title_paints_strong_yellow() {
        // Like "A Kid Named Cudi": black and white, with a yellow-green title
        // (#c8e632, hue 72°) over a tenth of it.
        let cover = cover_of(|x, y| {
            if y < 6 {
                [200, 230, 50]
            } else {
                let grey = ((x * 3 + y) % 200) as u8;
                [grey, grey, grey]
            }
        });
        let (hue, sat, value) = hsv(cover.colors[0]);
        assert!((hue * 360.0 - 72.0).abs() < 3.0, "{:?}", cover.colors);
        assert!(sat >= MIN_SATURATION && value == 1.0, "{:?}", cover.colors);
    }

    #[test]
    fn a_red_and_blue_cover_paints_only_the_bigger_color() {
        let cover = cover_of(|x, _| if x < 40 { [200, 20, 30] } else { [20, 40, 210] });
        let hue = hue_degrees(cover.colors[0]);
        assert!(hue > 350.0 || hue < 6.0, "{:?}", cover.colors);
    }

    #[test]
    fn a_dull_color_is_made_strong_in_its_own_hue() {
        // A muted teal, #5a8c8c (hue 180°, saturation 0.36).
        let cover = cover_of(|_, _| [90, 140, 140]);
        let (hue, sat, value) = hsv(cover.colors[0]);
        assert!((hue * 360.0 - 180.0).abs() < 1.0, "{:?}", cover.colors);
        assert!(sat >= MIN_SATURATION && value == 1.0, "{:?}", cover.colors);
    }

    #[test]
    fn a_hue_on_a_bucket_edge_is_not_rounded() {
        // Hue 45° sits exactly where two of the 24 buckets meet.
        let cover = cover_of(|_, _| [255, 191, 0]);
        assert!(
            (hue_degrees(cover.colors[0]) - 45.0).abs() < 1.0,
            "{:?}",
            cover.colors
        );
    }

    #[test]
    fn every_shade_keeps_the_one_hue() {
        let cover = cover_of(|_, _| [200, 20, 30]);
        let hue = hue_degrees(cover.colors[0]);
        for shade in cover.colors {
            assert!((hue_degrees(shade) - hue).abs() < 1.0, "{:?}", cover.colors);
        }
    }

    #[test]
    fn a_grey_cover_paints_with_the_app_green() {
        let cover = cover_of(|x, y| {
            let grey = ((x + y) * 2) as u8;
            [grey, grey, grey]
        });
        assert_eq!(cover.colors, DEFAULT_COLORS);
    }
}
