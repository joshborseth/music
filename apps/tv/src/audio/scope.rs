//! The last moments of audio sent to the device, for the visualizer.
//!
//! The device callback writes a mono copy of every sample it plays; the
//! screen reads the newest ones. Plain atomics, so the real-time callback
//! never locks or allocates.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Samples kept: a power of two, more than one analysis window.
pub const LENGTH: usize = 4096;

pub struct Scope {
    samples: [AtomicU32; LENGTH],
    /// Samples written since the app started.
    written: AtomicU64,
    rate: AtomicU32,
    /// When audio was last written, in ms since the epoch.
    written_at: AtomicU64,
}

pub static SCOPE: Scope = Scope {
    samples: [const { AtomicU32::new(0) }; LENGTH],
    written: AtomicU64::new(0),
    rate: AtomicU32::new(44_100),
    written_at: AtomicU64::new(0),
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

    /// Copy the newest `out.len()` samples, oldest first. Returns false when
    /// nothing has played for a moment (paused or stopped).
    pub fn read(&self, out: &mut [f32]) -> bool {
        let end = self.written.load(Ordering::Acquire);
        let fresh = now_ms().saturating_sub(self.written_at.load(Ordering::Relaxed)) < 250;
        let count = out.len().min(LENGTH) as u64;
        let start = end.saturating_sub(count);
        for (slot, index) in out.iter_mut().zip(start..end) {
            *slot = f32::from_bits(self.samples[index as usize % LENGTH].load(Ordering::Relaxed));
        }
        fresh && end >= count
    }
}
