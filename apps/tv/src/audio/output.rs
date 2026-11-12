//! The audio device. Decoded samples go into a lock-free ring buffer that the
//! device callback drains; the callback never locks or allocates.
//!
//! On Android this is AAudio through cpal. Elsewhere (tests on the dev box) a
//! thread drains the ring in real time, so the engine runs the same way.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use rtrb::{Consumer, Producer, RingBuffer};

use super::decode::CHANNELS;

/// State shared with the device callback.
#[derive(Default)]
pub struct Shared {
    /// Samples (not frames) handed to the device since the output opened.
    pub played_samples: AtomicU64,
    pub paused: AtomicBool,
    /// The engine bumps `flush_request`; the callback empties the ring and
    /// copies it to `flush_done`.
    pub flush_request: AtomicU32,
    pub flush_done: AtomicU32,
}

pub struct Output {
    pub rate: u32,
    pub producer: Producer<f32>,
    pub shared: Arc<Shared>,
    _device: Device,
}

/// How much decoded audio the ring holds: enough to ride out a busy CPU,
/// small enough that a seek or skip never plays stale audio.
const RING_SECONDS: f64 = 0.5;

/// Fill `out` from the ring. Runs on the device's real-time thread.
fn render(consumer: &mut Consumer<f32>, shared: &Shared, out: &mut [f32]) {
    let request = shared.flush_request.load(Ordering::Acquire);
    if request != shared.flush_done.load(Ordering::Relaxed) {
        let pending = consumer.slots();
        if let Ok(chunk) = consumer.read_chunk(pending) {
            chunk.commit_all();
        }
        shared.flush_done.store(request, Ordering::Release);
    }
    if shared.paused.load(Ordering::Relaxed) {
        out.fill(0.0);
        return;
    }
    let wanted = out.len() - out.len() % CHANNELS;
    let available = consumer.slots().min(wanted);
    let available = available - available % CHANNELS;
    if let Ok(chunk) = consumer.read_chunk(available) {
        let (first, second) = chunk.as_slices();
        out[..first.len()].copy_from_slice(first);
        out[first.len()..first.len() + second.len()].copy_from_slice(second);
        chunk.commit_all();
    }
    super::scope::SCOPE.write(&out[..available], CHANNELS);
    out[available..].fill(0.0);
    shared
        .played_samples
        .fetch_add(available as u64, Ordering::Release);
}

impl Output {
    pub fn open(rate: u32) -> Result<Self, String> {
        super::scope::SCOPE.set_rate(rate);
        let capacity = (f64::from(rate) * RING_SECONDS) as usize * CHANNELS;
        let (producer, consumer) = RingBuffer::new(capacity);
        let shared = Arc::new(Shared::default());
        let device = Device::start(rate, consumer, shared.clone())?;
        Ok(Self {
            rate,
            producer,
            shared,
            _device: device,
        })
    }

    pub fn played_frames(&self) -> u64 {
        self.shared.played_samples.load(Ordering::Acquire) / CHANNELS as u64
    }

    pub fn set_paused(&self, paused: bool) {
        self.shared.paused.store(paused, Ordering::Relaxed);
    }

    /// Drop everything queued, waiting (briefly) for the callback to do it.
    pub fn flush(&self) {
        let request = self.shared.flush_request.fetch_add(1, Ordering::AcqRel) + 1;
        for _ in 0..200 {
            if self.shared.flush_done.load(Ordering::Acquire) == request {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        log::warn!("audio device did not flush in time");
    }
}

/// Owns the AAudio stream; dropping it stops the device.
#[cfg(target_os = "android")]
struct Device {
    _stream: cpal::Stream,
}

#[cfg(target_os = "android")]
impl Device {
    fn start(rate: u32, mut consumer: Consumer<f32>, shared: Arc<Shared>) -> Result<Self, String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        let device = cpal::default_host()
            .default_output_device()
            .ok_or("no audio output device")?;
        let config = cpal::StreamConfig {
            channels: CHANNELS as u16,
            sample_rate: rate,
            buffer_size: cpal::BufferSize::Default,
        };
        let stream = device
            .build_output_stream::<f32, _, _>(
                config,
                move |out, _| render(&mut consumer, &shared, out),
                |error| log::error!("audio device error: {error}"),
                None,
            )
            .map_err(|error| format!("could not open audio output: {error}"))?;
        stream
            .play()
            .map_err(|error| format!("could not start audio output: {error}"))?;
        Ok(Self { _stream: stream })
    }
}

/// Stands in for the device off Android: drains the ring in real time.
#[cfg(not(target_os = "android"))]
struct Device {
    stop: Arc<AtomicBool>,
}

#[cfg(not(target_os = "android"))]
impl Device {
    fn start(rate: u32, mut consumer: Consumer<f32>, shared: Arc<Shared>) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let tick = std::time::Duration::from_millis(5);
        let mut buffer = vec![0.0; (rate as usize / 200) * CHANNELS];
        std::thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                render(&mut consumer, &shared, &mut buffer);
                std::thread::sleep(tick);
            }
        });
        Ok(Self { stop })
    }
}

#[cfg(not(target_os = "android"))]
impl Drop for Device {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}
