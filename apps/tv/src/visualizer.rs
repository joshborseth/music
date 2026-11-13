//! Turns the audio this TV plays into band levels for the visuals: a
//! windowed FFT of the newest samples, grouped into log-spaced bands, with a
//! fast rise and a slow fall so the levels move like a meter.

use std::f32::consts::PI;

use crate::audio::scope::SCOPE;

pub const BARS: usize = 48;
const WINDOW: usize = 2048;
const LOWEST_HZ: f32 = 40.0;
const HIGHEST_HZ: f32 = 14_000.0;
/// Levels below this (dB relative to full scale) draw as empty.
const FLOOR_DB: f32 = -64.0;
const CEILING_DB: f32 = -8.0;

pub struct Analyzer {
    samples: Vec<f32>,
    window: Vec<f32>,
    real: Vec<f32>,
    imaginary: Vec<f32>,
    levels: [f32; BARS],
}

impl Default for Analyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl Analyzer {
    pub fn new() -> Self {
        let window = (0..WINDOW)
            .map(|index| 0.5 - 0.5 * (2.0 * PI * index as f32 / (WINDOW - 1) as f32).cos())
            .collect();
        Self {
            samples: vec![0.0; WINDOW],
            window,
            real: vec![0.0; WINDOW],
            imaginary: vec![0.0; WINDOW],
            levels: [0.0; BARS],
        }
    }

    /// The bars for this frame, each 0 to 1, as heard `show_ahead` seconds
    /// from now, when the frame shows: the window is centred there. They
    /// fall to nothing while no audio plays.
    pub fn frame(&mut self, show_ahead: f64) -> &[f32; BARS] {
        let half_window = WINDOW as f64 / 2.0 / f64::from(SCOPE.rate().max(1));
        let ahead = std::time::Duration::from_secs_f64(show_ahead + half_window);
        let fresh = SCOPE.read(&mut self.samples, ahead);
        if fresh {
            let rate = SCOPE.rate() as f32;
            let target = self.spectrum(rate);
            for (level, target) in self.levels.iter_mut().zip(target) {
                *level = if target > *level {
                    *level + (target - *level) * 0.65
                } else {
                    *level * 0.86 + target * 0.14
                };
            }
        } else {
            for level in &mut self.levels {
                *level *= 0.82;
            }
        }
        &self.levels
    }

    /// The newest samples the last frame analyzed, oldest first.
    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    /// True while any bar is still visible.
    pub fn is_moving(&self) -> bool {
        self.levels.iter().any(|level| *level > 0.005)
    }

    fn spectrum(&mut self, rate: f32) -> [f32; BARS] {
        for index in 0..WINDOW {
            self.real[index] = self.samples[index] * self.window[index];
            self.imaginary[index] = 0.0;
        }
        fft(&mut self.real, &mut self.imaginary);
        let bin_hz = rate / WINDOW as f32;
        let mut bars = [0.0; BARS];
        let ratio = HIGHEST_HZ / LOWEST_HZ;
        for (bar, out) in bars.iter_mut().enumerate() {
            let low = LOWEST_HZ * ratio.powf(bar as f32 / BARS as f32);
            let high = LOWEST_HZ * ratio.powf((bar + 1) as f32 / BARS as f32);
            let first = ((low / bin_hz) as usize).max(1);
            let last = ((high / bin_hz) as usize).max(first).min(WINDOW / 2 - 1);
            let mut peak = 0.0f32;
            for bin in first..=last {
                let magnitude = (self.real[bin].powi(2) + self.imaginary[bin].powi(2)).sqrt();
                peak = peak.max(magnitude);
            }
            // A Hann window halves the amplitude; scale to full scale.
            let amplitude = peak * 4.0 / WINDOW as f32;
            // Tilt up the highs so a typical song fills the bars evenly.
            let tilt = 1.0 + bar as f32 / BARS as f32 * 3.0;
            let db = 20.0 * (amplitude * tilt).max(1e-9).log10();
            *out = ((db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)).clamp(0.0, 1.0);
        }
        bars
    }
}

/// In-place radix-2 FFT. `real.len()` must be a power of two.
fn fft(real: &mut [f32], imaginary: &mut [f32]) {
    let n = real.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            real.swap(i, j);
            imaginary.swap(i, j);
        }
    }
    let mut size = 2;
    while size <= n {
        let angle = -2.0 * PI / size as f32;
        let (step_sin, step_cos) = angle.sin_cos();
        for start in (0..n).step_by(size) {
            let (mut w_real, mut w_imaginary) = (1.0f32, 0.0f32);
            for k in 0..size / 2 {
                let (a, b) = (start + k, start + k + size / 2);
                let t_real = real[b] * w_real - imaginary[b] * w_imaginary;
                let t_imaginary = real[b] * w_imaginary + imaginary[b] * w_real;
                real[b] = real[a] - t_real;
                imaginary[b] = imaginary[a] - t_imaginary;
                real[a] += t_real;
                imaginary[a] += t_imaginary;
                let next = w_real * step_cos - w_imaginary * step_sin;
                w_imaginary = w_real * step_sin + w_imaginary * step_cos;
                w_real = next;
            }
        }
        size <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_pure_tone_in_the_right_bin() {
        let n = 1024;
        let mut real: Vec<f32> = (0..n)
            .map(|index| (2.0 * PI * 64.0 * index as f32 / n as f32).sin())
            .collect();
        let mut imaginary = vec![0.0; n];
        fft(&mut real, &mut imaginary);
        let peak = (0..n / 2)
            .max_by(|a, b| {
                let magnitude = |i: usize| real[i].hypot(imaginary[i]);
                magnitude(*a).total_cmp(&magnitude(*b))
            })
            .unwrap();
        assert_eq!(peak, 64);
    }

    #[test]
    fn a_loud_tone_lights_its_bar_and_silence_fades() {
        let mut analyzer = Analyzer::new();
        analyzer.samples = (0..WINDOW)
            .map(|index| 0.8 * (2.0 * PI * 1000.0 * index as f32 / 44_100.0).sin())
            .collect();
        let bars = analyzer.spectrum(44_100.0);
        let loudest = (0..BARS)
            .max_by(|a, b| bars[*a].total_cmp(&bars[*b]))
            .unwrap();
        let ratio = HIGHEST_HZ / LOWEST_HZ;
        let center = LOWEST_HZ * ratio.powf((loudest as f32 + 0.5) / BARS as f32);
        assert!(
            (700.0..1400.0).contains(&center),
            "loudest band centers on {center} Hz"
        );
        assert!(bars[loudest] > 0.8);
        assert!(bars[0] < 0.2);
    }
}
