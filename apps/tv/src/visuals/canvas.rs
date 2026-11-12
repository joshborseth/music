//! A small floating-point picture that the scenes paint into and that the
//! screen stretches over the whole TV. Each frame usually starts from the
//! last one, warped and dimmed (feedback), which is where the trails and
//! tunnels come from. Light adds up, and a soft curve turns it into pixels,
//! so overlapping strokes glow white instead of clipping.

use std::f32::consts::{PI, TAU};

use slint::{Rgba8Pixel, SharedPixelBuffer};

pub const WIDTH: usize = 480;
pub const HEIGHT: usize = 270;
/// Half the height in pixels: one canvas unit.
const UNIT: f32 = HEIGHT as f32 / 2.0;
/// The right edge in canvas units.
pub const ASPECT: f32 = WIDTH as f32 / HEIGHT as f32;

pub type Rgb = [f32; 3];

/// Brightness the tone curve maps to almost white.
const TONE_RANGE: f32 = 3.0;
const TONE_STEPS: usize = 1024;

/// A pixel's place in canvas units: the center is 0, y runs from -1 at the
/// top to 1 at the bottom, and x from -`ASPECT` to `ASPECT`. `r` is its
/// distance from the center.
#[derive(Clone, Copy)]
pub struct Point {
    pub x: f32,
    pub y: f32,
    pub r: f32,
}

pub struct Canvas {
    pixels: Vec<Rgb>,
    previous: Vec<Rgb>,
    points: Vec<Point>,
    tone: Vec<u8>,
}

impl Default for Canvas {
    fn default() -> Self {
        Self::new()
    }
}

impl Canvas {
    pub fn new() -> Self {
        let points = (0..WIDTH * HEIGHT)
            .map(|index| {
                let x = ((index % WIDTH) as f32 + 0.5 - WIDTH as f32 / 2.0) / UNIT;
                let y = ((index / WIDTH) as f32 + 0.5 - UNIT) / UNIT;
                Point {
                    x,
                    y,
                    r: x.hypot(y),
                }
            })
            .collect();
        let tone = (0..TONE_STEPS)
            .map(|step| {
                let light = step as f32 / (TONE_STEPS - 1) as f32 * TONE_RANGE;
                ((1.0 - (-1.8 * light).exp()) * 255.0).round() as u8
            })
            .collect();
        Self {
            pixels: vec![[0.0; 3]; WIDTH * HEIGHT],
            previous: vec![[0.0; 3]; WIDTH * HEIGHT],
            points,
            tone,
        }
    }

    /// Replace every pixel with the last frame's pixel at `source(point)`,
    /// dimmed by `keep` per channel. Places off the canvas are black.
    pub fn warp(&mut self, keep: Rgb, source: impl Fn(Point) -> (f32, f32) + Sync) {
        std::mem::swap(&mut self.pixels, &mut self.previous);
        let previous = &self.previous;
        in_parts(&mut self.pixels, &self.points, |pixels, points| {
            for (pixel, point) in pixels.iter_mut().zip(points) {
                let (x, y) = source(*point);
                let [red, green, blue] = sample(
                    previous,
                    x * UNIT + WIDTH as f32 / 2.0 - 0.5,
                    y * UNIT + UNIT - 0.5,
                );
                *pixel = [red * keep[0], green * keep[1], blue * keep[2]];
            }
        });
    }

    /// Mix `amount` of `paint(point)` into every pixel.
    pub fn wash(&mut self, amount: f32, paint: impl Fn(Point) -> Rgb + Sync) {
        let keep = 1.0 - amount;
        in_parts(&mut self.pixels, &self.points, |pixels, points| {
            for (pixel, point) in pixels.iter_mut().zip(points) {
                let color = paint(*point);
                for channel in 0..3 {
                    pixel[channel] = pixel[channel] * keep + color[channel] * amount;
                }
            }
        });
    }

    /// Add light at one point, shared between the four nearest pixels.
    #[inline]
    pub fn spark(&mut self, x: f32, y: f32, color: Rgb) {
        let column = x * UNIT + WIDTH as f32 / 2.0 - 0.5;
        let row = y * UNIT + UNIT - 0.5;
        if !(column >= 0.0 && row >= 0.0) {
            return;
        }
        let (left, top) = (column as usize, row as usize);
        if left + 1 >= WIDTH || top + 1 >= HEIGHT {
            return;
        }
        let (across, down) = (column - left as f32, row - top as f32);
        let index = top * WIDTH + left;
        for (offset, weight) in [
            (0, (1.0 - across) * (1.0 - down)),
            (1, across * (1.0 - down)),
            (WIDTH, (1.0 - across) * down),
            (WIDTH + 1, across * down),
        ] {
            let pixel = &mut self.pixels[index + offset];
            for channel in 0..3 {
                pixel[channel] += color[channel] * weight;
            }
        }
    }

    /// A thin line of light. `color` is its brightness per pixel of length.
    pub fn line(&mut self, from: (f32, f32), to: (f32, f32), color: Rgb) {
        let length = (to.0 - from.0).hypot(to.1 - from.1) * UNIT;
        if !length.is_finite() {
            return;
        }
        let steps = (length / 0.7).ceil().clamp(1.0, 2000.0) as usize;
        let share = length / steps as f32;
        let color = color.map(|channel| channel * share.min(1.0));
        for step in 0..steps {
            let t = step as f32 / steps as f32;
            self.spark(
                from.0 + (to.0 - from.0) * t,
                from.1 + (to.1 - from.1) * t,
                color,
            );
        }
    }

    /// A soft round blob of light, `radius` in canvas units.
    pub fn glow(&mut self, x: f32, y: f32, radius: f32, color: Rgb) {
        let reach = (radius * UNIT).max(0.5);
        let center_column = x * UNIT + WIDTH as f32 / 2.0 - 0.5;
        let center_row = y * UNIT + UNIT - 0.5;
        let first_column = (center_column - reach).floor().max(0.0) as usize;
        let last_column = ((center_column + reach).ceil() as isize).min(WIDTH as isize - 1);
        let first_row = (center_row - reach).floor().max(0.0) as usize;
        let last_row = ((center_row + reach).ceil() as isize).min(HEIGHT as isize - 1);
        if last_column < first_column as isize || last_row < first_row as isize {
            return;
        }
        for row in first_row..=last_row as usize {
            for column in first_column..=last_column as usize {
                let distance =
                    (column as f32 - center_column).hypot(row as f32 - center_row) / reach;
                if distance >= 1.0 {
                    continue;
                }
                let weight = (1.0 - distance * distance).powi(2);
                let pixel = &mut self.pixels[row * WIDTH + column];
                for channel in 0..3 {
                    pixel[channel] += color[channel] * weight;
                }
            }
        }
    }

    /// Lay a square picture over the canvas, turned by `angle`, `side` canvas
    /// units across, mixed in by `amount`.
    pub fn stamp(
        &mut self,
        picture: &[Rgb],
        picture_side: usize,
        side: f32,
        angle: f32,
        amount: f32,
    ) {
        let half = side / 2.0 * std::f32::consts::SQRT_2;
        let reach = (half * UNIT).ceil() as usize + 1;
        let (center_column, center_row) = (WIDTH / 2, HEIGHT / 2);
        let (sin, cos) = sin_cos(-angle);
        let scale = picture_side as f32 / side;
        let keep = 1.0 - amount;
        for row in center_row.saturating_sub(reach)..(center_row + reach).min(HEIGHT) {
            for column in center_column.saturating_sub(reach)..(center_column + reach).min(WIDTH) {
                let index = row * WIDTH + column;
                let point = self.points[index];
                let u = (point.x * cos - point.y * sin) * scale + picture_side as f32 / 2.0 - 0.5;
                let v = (point.x * sin + point.y * cos) * scale + picture_side as f32 / 2.0 - 0.5;
                if u < 0.0
                    || v < 0.0
                    || u > (picture_side - 1) as f32
                    || v > (picture_side - 1) as f32
                {
                    continue;
                }
                let color = sample_square(picture, picture_side, u, v);
                let pixel = &mut self.pixels[index];
                for channel in 0..3 {
                    pixel[channel] = pixel[channel] * keep + color[channel] * amount;
                }
            }
        }
    }

    /// How bright the picture is on average, 0 for black.
    #[cfg(test)]
    pub fn brightness(&self) -> f32 {
        self.pixels
            .iter()
            .map(|pixel| pixel.iter().sum::<f32>())
            .sum::<f32>()
            / (self.pixels.len() * 3) as f32
    }

    /// The picture as screen pixels.
    pub fn to_pixels(&self) -> SharedPixelBuffer<Rgba8Pixel> {
        let mut buffer = SharedPixelBuffer::<Rgba8Pixel>::new(WIDTH as u32, HEIGHT as u32);
        let scale = (TONE_STEPS - 1) as f32 / TONE_RANGE;
        let tone = |light: f32| {
            let step = (light * scale) as usize;
            self.tone[step.min(TONE_STEPS - 1)]
        };
        in_parts(buffer.make_mut_slice(), &self.pixels, |outs, pixels| {
            for (out, pixel) in outs.iter_mut().zip(pixels) {
                *out = Rgba8Pixel {
                    r: tone(pixel[0].max(0.0)),
                    g: tone(pixel[1].max(0.0)),
                    b: tone(pixel[2].max(0.0)),
                    a: 255,
                };
            }
        });
        buffer
    }
}

/// Threads that share each whole-canvas pass, counting the painter itself.
/// TVs have four cores; this leaves one for the UI and one for the audio.
const PARTS: usize = 2;

/// Run `work` over matching pieces of `out` and `input` on `PARTS` threads.
fn in_parts<A: Send, B: Sync>(out: &mut [A], input: &[B], work: impl Fn(&mut [A], &[B]) + Sync) {
    let size = out.len().div_ceil(PARTS).max(1);
    std::thread::scope(|scope| {
        let mut pieces = out.chunks_mut(size).zip(input.chunks(size));
        let mine = pieces.next();
        let work = &work;
        for (out, input) in pieces {
            // If no thread can start, that piece keeps an old picture for a frame.
            let started = std::thread::Builder::new().spawn_scoped(scope, move || work(out, input));
            if let Err(error) = started {
                log::warn!("visuals thread failed: {error}");
            }
        }
        if let Some((out, input)) = mine {
            work(out, input);
        }
    });
}

/// The canvas between pixel centers; black off its edges.
#[inline]
fn sample(pixels: &[Rgb], column: f32, row: f32) -> Rgb {
    if !(column >= 0.0 && row >= 0.0) {
        return [0.0; 3];
    }
    let (left, top) = (column as usize, row as usize);
    if left + 1 >= WIDTH || top + 1 >= HEIGHT {
        return [0.0; 3];
    }
    blend4(
        pixels,
        top * WIDTH + left,
        WIDTH,
        column - left as f32,
        row - top as f32,
    )
}

#[inline]
fn sample_square(pixels: &[Rgb], side: usize, u: f32, v: f32) -> Rgb {
    let (left, top) = ((u as usize).min(side - 2), (v as usize).min(side - 2));
    blend4(
        pixels,
        top * side + left,
        side,
        u - left as f32,
        v - top as f32,
    )
}

#[inline]
fn blend4(pixels: &[Rgb], index: usize, stride: usize, across: f32, down: f32) -> Rgb {
    let (a, b) = (pixels[index], pixels[index + 1]);
    let (c, d) = (pixels[index + stride], pixels[index + stride + 1]);
    let mut out = [0.0; 3];
    for channel in 0..3 {
        let upper = a[channel] + (b[channel] - a[channel]) * across;
        let lower = c[channel] + (d[channel] - c[channel]) * across;
        out[channel] = upper + (lower - upper) * down;
    }
    out
}

/// A fast sine, within 0.001, for per-pixel work.
#[inline]
pub fn sin(x: f32) -> f32 {
    // Into -0.5..0.5 turns, without `round`, which is a library call on
    // some targets.
    let mut t = x * (1.0 / TAU);
    t -= t as i32 as f32;
    if t > 0.5 {
        t -= 1.0;
    } else if t < -0.5 {
        t += 1.0;
    }
    let y = 8.0 * t - 16.0 * t * t.abs();
    0.225 * (y * y.abs() - y) + y
}

#[inline]
pub fn cos(x: f32) -> f32 {
    sin(x + PI / 2.0)
}

#[inline]
pub fn sin_cos(x: f32) -> (f32, f32) {
    (sin(x), cos(x))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fast_sine_is_close() {
        for step in -2000..2000 {
            let x = step as f32 * 0.01;
            assert!((sin(x) - x.sin()).abs() < 0.0015, "sin({x})");
            assert!((cos(x) - x.cos()).abs() < 0.0015, "cos({x})");
        }
    }

    #[test]
    fn a_warp_moves_light_and_dims_it() {
        let mut canvas = Canvas::new();
        canvas.glow(0.5, 0.0, 0.05, [1.0; 3]);
        let before = canvas.brightness();
        // Each pixel shows what was 0.5 to its right: the blob moves left.
        canvas.warp([0.5; 3], |point| (point.x + 0.5, point.y));
        assert!((canvas.brightness() - before * 0.5).abs() < before * 0.05);
        let center = canvas.pixels[HEIGHT / 2 * WIDTH + WIDTH / 2];
        assert!(center[0] > 0.3, "{center:?}");
    }

    #[test]
    fn drawing_off_the_edge_is_ignored() {
        let mut canvas = Canvas::new();
        canvas.line((-9.0, -9.0), (9.0, 9.0), [1.0; 3]);
        canvas.glow(5.0, 5.0, 0.3, [1.0; 3]);
        canvas.spark(f32::NAN, 0.0, [1.0; 3]);
        canvas.line((f32::NAN, 0.0), (0.0, 0.0), [1.0; 3]);
        assert!(canvas.brightness() > 0.0);
    }

    #[test]
    fn light_turns_into_pixels_without_clipping_harshly() {
        let mut canvas = Canvas::new();
        canvas.pixels[0] = [0.0, 0.5, 40.0];
        let pixels = canvas.to_pixels();
        let first = pixels.as_slice()[0];
        assert_eq!((first.r, first.a), (0, 255));
        assert!((150..230).contains(&first.g), "{}", first.g);
        assert!(first.b > 250);
    }
}
