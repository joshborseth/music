//! The last moments of audio sent to the device, for the visuals.
//!
//! The device callback writes a mono copy of every sample it plays; the
//! screen reads the newest ones. Plain atomics, so the real-time callback
//! never locks or allocates.
//!
//! What the device has been handed is heard a little later: Android's
//! buffers, and any TV or soundbar processing after them. The callback
//! reports that delay, and readers get the samples being heard now.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Samples kept: a power of two, enough for an analysis window plus the
/// longest output delay (about 370 ms at 44.1 kHz).
pub const LENGTH: usize = 16_384;
/// The longest delay believed: anything longer is a bad reading.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const MAX_LATENCY: Duration = Duration::from_millis(250);

pub struct Scope {
    samples: [AtomicU32; LENGTH],
    /// Samples written since the app started.
    written: AtomicU64,
    rate: AtomicU32,
    /// When audio was last written, in ms since the epoch.
    written_at: AtomicU64,
    /// How long after it is written a sample is heard, in microseconds.
    latency_us: AtomicU32,
}

pub static SCOPE: Scope = Scope {
    samples: [const { AtomicU32::new(0) }; LENGTH],
    written: AtomicU64::new(0),
    rate: AtomicU32::new(44_100),
    written_at: AtomicU64::new(0),
    latency_us: AtomicU32::new(0),
};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

impl Scope {
    pub fn set_rate(&self, rate: u32) {
        self.rate.store(rate, Ordering::Relaxed);
    }

    pub fn rate(&self) -> u32 {
        self.rate.load(Ordering::Relaxed)
    }

    /// Record how long the device takes to play what it is handed now.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub fn set_latency(&self, latency: Duration) {
        let latency = latency.min(MAX_LATENCY);
        self.latency_us
            .store(latency.as_micros() as u32, Ordering::Relaxed);
    }

    /// How long after it is written a sample is heard.
    pub fn latency(&self) -> Duration {
        Duration::from_micros(u64::from(self.latency_us.load(Ordering::Relaxed)))
    }

    /// Record interleaved frames as mono.
    pub fn write(&self, interleaved: &[f32], channels: usize) {
        if interleaved.is_empty() || channels == 0 {
            return;
        }
        let start = self.written.load(Ordering::Relaxed);
        let mut index = start;
        for frame in interleaved.chunks_exact(channels) {
            let mono = frame.iter().sum::<f32>() / channels as f32;
            self.samples[index as usize % LENGTH].store(mono.to_bits(), Ordering::Relaxed);
            index += 1;
        }
        self.written.store(index, Ordering::Release);
        self.written_at.store(now_ms(), Ordering::Relaxed);
    }

    /// Copy `out.len()` samples, oldest first, ending with the one heard
    /// `ahead` from now: what the device was handed but has yet to play
    /// is already here, up to its whole delay. Returns false when nothing
    /// has played for a moment (paused or stopped).
    pub fn read(&self, out: &mut [f32], ahead: Duration) -> bool {
        let written = self.written.load(Ordering::Acquire);
        let fresh = now_ms().saturating_sub(self.written_at.load(Ordering::Relaxed)) < 250;
        let delay =
            (self.latency().saturating_sub(ahead).as_secs_f64() * f64::from(self.rate())) as u64;
        debug_assert!(out.len() as u64 + delay <= LENGTH as u64);
        let count = out.len() as u64;
        let end = written.saturating_sub(delay);
        let start = end.saturating_sub(count);
        out.fill(0.0);
        let skipped = out.len() - (end - start) as usize;
        for (slot, index) in out[skipped..].iter_mut().zip(start..end) {
            *slot = f32::from_bits(self.samples[index as usize % LENGTH].load(Ordering::Relaxed));
        }
        fresh && end >= count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> Scope {
        Scope {
            samples: [const { AtomicU32::new(0) }; LENGTH],
            written: AtomicU64::new(0),
            rate: AtomicU32::new(1000),
            written_at: AtomicU64::new(0),
            latency_us: AtomicU32::new(0),
        }
    }

    #[test]
    fn reads_what_is_heard_or_a_little_ahead() {
        let scope = scope();
        // A ramp: sample n holds n.
        let ramp: Vec<f32> = (0..2000).map(|n| n as f32).collect();
        scope.write(&ramp, 1);
        // Handed over up to 1999, heard 100 ms (100 samples) later.
        scope.set_latency(Duration::from_millis(100));
        let mut out = [0.0; 4];
        assert!(scope.read(&mut out, Duration::ZERO));
        assert_eq!(out, [1896.0, 1897.0, 1898.0, 1899.0]);
        // 40 ms ahead of what is heard.
        scope.read(&mut out, Duration::from_millis(40));
        assert_eq!(out, [1936.0, 1937.0, 1938.0, 1939.0]);
        // Never past what the device was handed.
        scope.read(&mut out, Duration::from_millis(400));
        assert_eq!(out, [1996.0, 1997.0, 1998.0, 1999.0]);
    }
}
