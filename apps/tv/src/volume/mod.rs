//! The TV's own volume: Android's music stream, the one the remote's volume
//! keys change.
//!
//! A thread reports it to the session (`Volume`) when the app connects and
//! whenever it changes, however it changed, so phones can show it. When a
//! phone moves its volume slider, the server passes that on (`SetVolume`)
//! and the thread sets it; Android then shows its own volume bar on the TV.
//! Android only tells Java code about volume changes, so the thread looks
//! every [`POLL_INTERVAL`].
//!
//! Some TVs hand volume to another device (a sound bar over HDMI) and fix
//! their own. Then the thread reports `null`, and phones show no slider.
//!
//! Reading and setting is Android only (`android.rs`). Elsewhere nothing
//! runs and the TV reports no volume.

#[cfg(target_os = "android")]
mod android;

use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;

use crate::protocol::ClientMessage;

/// How often the thread looks for changes made with the remote.
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// A dragged slider asks again and again. The thread reports once no new
/// level came for this long, instead of after each one, because every report
/// sends the whole session to every device.
const SETTLE: Duration = Duration::from_millis(250);

/// Android's volume for one stream, in its own steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Steps {
    pub current: i32,
    pub min: i32,
    pub max: i32,
}

impl Steps {
    /// Where `current` sits between `min` and `max`, from 0 to 1.
    pub fn level(self) -> f64 {
        if self.max <= self.min {
            return 0.0;
        }
        f64::from(self.current.clamp(self.min, self.max) - self.min)
            / f64::from(self.max - self.min)
    }

    /// The step nearest `level` (0 to 1).
    pub fn step_for(self, level: f64) -> i32 {
        if !level.is_finite() || self.max <= self.min {
            return self.current;
        }
        let range = f64::from(self.max - self.min);
        // NOTE: the cast is in range: level is clamped to 0..=1.
        self.min + (level.clamp(0.0, 1.0) * range).round() as i32
    }
}

/// What the volume thread needs from the device. Android's lives in
/// `android.rs`; tests use a fake.
pub(crate) trait Platform: Send + 'static {
    /// The music stream's volume, or `None` when the TV fixed it.
    fn read(&mut self) -> Result<Option<Steps>, String>;
    /// Set the music stream to `step`, showing Android's volume bar.
    fn set(&mut self, step: i32) -> Result<(), String>;
}

enum Request {
    /// Set the volume to this level (0 to 1).
    Set(f64),
    /// Report the volume even if it did not change: the session reconnected.
    Report,
}

/// Talks to the volume thread. Does nothing where the volume can't be read.
#[derive(Clone)]
pub struct Volume {
    requests: Option<Sender<Request>>,
}

impl Volume {
    /// Start watching the volume, reporting it through `outbound`.
    pub fn spawn(outbound: UnboundedSender<ClientMessage>) -> Self {
        #[cfg(target_os = "android")]
        {
            Self::spawn_with(android::Android::new(), outbound)
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = outbound;
            Self { requests: None }
        }
    }

    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    fn spawn_with(platform: impl Platform, outbound: UnboundedSender<ClientMessage>) -> Self {
        let (requests, receiver) = channel();
        let spawned = std::thread::Builder::new()
            .name("music-volume".into())
            .spawn(move || {
                run(platform, &receiver, |message| {
                    let _ = outbound.send(message);
                });
            });
        match spawned {
            Ok(_) => Self {
                requests: Some(requests),
            },
            Err(error) => {
                log::error!("volume: could not start its thread: {error}");
                Self { requests: None }
            }
        }
    }

    /// Change the volume, as a phone asked.
    pub fn set(&self, level: f64) {
        self.request(Request::Set(level));
    }

    /// Tell the session the volume again, after the connection came back.
    pub fn report(&self) {
        self.request(Request::Report);
    }

    fn request(&self, request: Request) {
        if let Some(requests) = &self.requests {
            let _ = requests.send(request);
        }
    }
}

/// The thread: apply requests, and report each new volume. Returns when
/// every [`Volume`] is gone.
fn run(mut platform: impl Platform, requests: &Receiver<Request>, send: impl Fn(ClientMessage)) {
    // The level last sent (`Some(None)`: sent as fixed).
    let mut reported: Option<Option<f64>> = None;
    let mut last_error: Option<String> = None;
    let mut settling = false;
    loop {
        let wait = if settling { SETTLE } else { POLL_INTERVAL };
        let first = match requests.recv_timeout(wait) {
            Ok(request) => Some(request),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        // A dragged slider sends many levels; only the latest matters.
        let mut set_to = None;
        for request in first.into_iter().chain(requests.try_iter()) {
            match request {
                Request::Set(level) => set_to = Some(level),
                Request::Report => reported = None,
            }
        }
        let result = apply(&mut platform, set_to);
        settling = set_to.is_some();
        match result {
            Ok(_) if settling => last_error = None,
            Ok(level) => {
                last_error = None;
                if reported != Some(level) {
                    send(ClientMessage::Volume { level });
                    reported = Some(level);
                }
            }
            Err(error) => {
                // NOTE: the same failure would repeat every poll.
                if last_error.as_ref() != Some(&error) {
                    log::warn!("volume: {error}");
                    last_error = Some(error);
                }
            }
        }
    }
}

/// Set the volume if asked, and read what it is now.
fn apply(platform: &mut impl Platform, set_to: Option<f64>) -> Result<Option<f64>, String> {
    let Some(steps) = platform.read()? else {
        return Ok(None);
    };
    let Some(level) = set_to else {
        return Ok(Some(steps.level()));
    };
    let step = steps.step_for(level);
    if step == steps.current {
        return Ok(Some(steps.level()));
    }
    platform.set(step)?;
    Ok(platform.read()?.map(Steps::level))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Clone)]
    struct Fake {
        steps: Arc<Mutex<Option<Steps>>>,
        sets: Arc<Mutex<Vec<i32>>>,
    }

    impl Fake {
        fn new(current: i32, max: i32) -> Self {
            Self {
                steps: Arc::new(Mutex::new(Some(Steps {
                    current,
                    min: 0,
                    max,
                }))),
                sets: Arc::default(),
            }
        }
    }

    impl Platform for Fake {
        fn read(&mut self) -> Result<Option<Steps>, String> {
            Ok(*self.steps.lock().unwrap())
        }

        fn set(&mut self, step: i32) -> Result<(), String> {
            self.sets.lock().unwrap().push(step);
            if let Some(steps) = self.steps.lock().unwrap().as_mut() {
                steps.current = step;
            }
            Ok(())
        }
    }

    #[test]
    fn levels_run_from_min_to_max() {
        let steps = Steps {
            current: 5,
            min: 0,
            max: 15,
        };
        assert!((steps.level() - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(steps.step_for(0.0), 0);
        assert_eq!(steps.step_for(1.0), 15);
        assert_eq!(steps.step_for(0.5), 8);
        assert_eq!(steps.step_for(2.0), 15);
        assert_eq!(steps.step_for(f64::NAN), 5);
        let offset = Steps {
            current: 1,
            min: 1,
            max: 11,
        };
        assert_eq!(offset.level(), 0.0);
        assert_eq!(offset.step_for(0.5), 6);
    }

    #[test]
    fn sets_the_nearest_step_and_reports_it() {
        let mut fake = Fake::new(10, 100);
        assert_eq!(apply(&mut fake, Some(0.424)), Ok(Some(0.42)));
        assert_eq!(*fake.sets.lock().unwrap(), vec![42]);
        // Already there: Android is not asked again.
        assert_eq!(apply(&mut fake, Some(0.42)), Ok(Some(0.42)));
        assert_eq!(fake.sets.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_fixed_volume_is_reported_as_none() {
        let mut fake = Fake::new(3, 15);
        *fake.steps.lock().unwrap() = None;
        assert_eq!(apply(&mut fake, Some(0.5)), Ok(None));
        assert!(fake.sets.lock().unwrap().is_empty());
    }

    #[test]
    fn reports_changes_from_the_remote_and_again_after_reconnecting() {
        let fake = Fake::new(10, 100);
        let (outbound, mut sent) = tokio::sync::mpsc::unbounded_channel();
        let volume = Volume::spawn_with(fake.clone(), outbound);
        let next = |sent: &mut tokio::sync::mpsc::UnboundedReceiver<ClientMessage>| {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(message) = sent.try_recv() {
                    return message;
                }
                assert!(std::time::Instant::now() < deadline, "no report");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        assert_eq!(next(&mut sent), ClientMessage::Volume { level: Some(0.1) });

        fake.steps.lock().unwrap().as_mut().unwrap().current = 20;
        assert_eq!(next(&mut sent), ClientMessage::Volume { level: Some(0.2) });

        volume.set(0.3);
        assert_eq!(next(&mut sent), ClientMessage::Volume { level: Some(0.3) });

        volume.report();
        assert_eq!(next(&mut sent), ClientMessage::Volume { level: Some(0.3) });
        drop(volume);
    }
}
