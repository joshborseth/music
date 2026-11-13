//! Renders the real screens to PNG files on a computer, with Slint's
//! software renderer, so the design can be checked without a TV:
//!
//! ```sh
//! MUSIC_SERVER_URL=http://127.0.0.1:3105 \
//!   cargo run -p music-tv --features screenshots --example screens -- <out-dir>
//! ```
//!
//! The screens load the catalog and artwork from that server like the TV
//! does, but never open a session: the queue is made up here, so trying it
//! can't disturb what is playing in the house.
//!
//! The software renderer draws a gradient with more than two stops as one
//! band per pair of stops, and neighbouring bands both paint the pixel
//! column where they meet. So a faint vertical line shows at every middle
//! stop of a see-through gradient: at 46% of the width behind the lyrics,
//! and at 55% over the browse pages. It is not in the app: the TV draws
//! with Skia, which blends the stops smoothly.

use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use slint::platform::software_renderer::{MinimalSoftwareWindow, RepaintBufferType};
use slint::platform::{EventLoopProxy, Platform, WindowAdapter};
use slint::{ComponentHandle, PhysicalSize, Rgb8Pixel};

use crate::protocol::{QueueEntry, QueueTrack};
use crate::view::View;
use crate::{App, ui};

type Job = Box<dyn FnOnce() + Send>;

#[derive(Clone, Default)]
struct Queue(Arc<Mutex<VecDeque<Job>>>);

impl EventLoopProxy for Queue {
    fn quit_event_loop(&self) -> Result<(), slint::EventLoopError> {
        Ok(())
    }

    fn invoke_from_event_loop(&self, event: Job) -> Result<(), slint::EventLoopError> {
        self.0.lock().unwrap().push_back(event);
        Ok(())
    }
}

struct Headless {
    window: Rc<MinimalSoftwareWindow>,
    queue: Queue,
    start: Instant,
}

impl Platform for Headless {
    fn create_window_adapter(&self) -> Result<Rc<dyn WindowAdapter>, slint::PlatformError> {
        Ok(self.window.clone())
    }

    fn duration_since_start(&self) -> Duration {
        self.start.elapsed()
    }

    fn new_event_loop_proxy(&self) -> Option<Box<dyn EventLoopProxy>> {
        Some(Box::new(self.queue.clone()))
    }
}

/// One step of a screenshot script.
pub enum Step {
    Session(View),
    Key(&'static str),
    /// OK held long enough to open the menu.
    Hold,
    Wait(Duration),
    /// Rest on the now-playing screen. Its visuals need the GPU, so the
    /// screenshots show the cover backdrop in their place.
    Rest,
    Shot(&'static str),
}

struct Runner {
    window: Rc<MinimalSoftwareWindow>,
    queue: Queue,
    app: App,
    width: u32,
    height: u32,
    out: std::path::PathBuf,
}

impl Runner {
    fn pump(&self, duration: Duration) {
        let until = Instant::now() + duration;
        loop {
            let jobs: Vec<Job> = self.queue.0.lock().unwrap().drain(..).collect();
            for job in jobs {
                job();
            }
            slint::platform::update_timers_and_animations();
            if Instant::now() >= until {
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    fn key(&self, text: &str, pressed: bool, repeat: bool) {
        ui::with(|ui| ui.key(text, pressed, repeat));
    }

    fn shot(&self, name: &str) {
        self.window.request_redraw();
        let mut buffer = vec![Rgb8Pixel::default(); (self.width * self.height) as usize];
        self.window.draw_if_needed(|renderer| {
            renderer.render(&mut buffer, self.width as usize);
        });
        let bytes: Vec<u8> = buffer
            .iter()
            .flat_map(|pixel| [pixel.r, pixel.g, pixel.b])
            .collect();
        let path = self.out.join(format!("{name}.png"));
        image::save_buffer(
            &path,
            &bytes,
            self.width,
            self.height,
            image::ColorType::Rgb8,
        )
        .expect("write the screenshot");
        println!("{}", path.display());
    }
}

/// Run `steps` against the real UI, saving each `Shot` as a PNG in `out`.
pub fn run(server: &str, out: &std::path::Path, steps: Vec<Step>) {
    let window = MinimalSoftwareWindow::new(RepaintBufferType::NewBuffer);
    let queue = Queue::default();
    slint::platform::set_platform(Box::new(Headless {
        window: window.clone(),
        queue: queue.clone(),
        start: Instant::now(),
    }))
    .expect("set the headless platform");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("start the async runtime");

    // Something for the visualizer: a chord with a kick, in real time.
    let feeding = Arc::new(std::sync::atomic::AtomicBool::new(true));
    {
        let feeding = feeding.clone();
        std::thread::spawn(move || {
            let rate = 44_100.0f32;
            crate::audio::scope::SCOPE.set_rate(rate as u32);
            let mut t = 0u64;
            while feeding.load(std::sync::atomic::Ordering::Relaxed) {
                let frames: Vec<f32> = (0..441)
                    .flat_map(|_| {
                        let time = t as f32 / rate;
                        t += 1;
                        let kick = (-(time % 0.5) * 18.0).exp()
                            * (2.0 * std::f32::consts::PI * 55.0 * time).sin();
                        let chord = [110.0, 220.0, 330.0, 440.0, 660.0, 1320.0, 2640.0, 5280.0]
                            .iter()
                            .enumerate()
                            .map(|(index, hz)| {
                                (2.0 * std::f32::consts::PI * hz * time).sin() * 0.25
                                    / (index as f32 + 1.0)
                            })
                            .sum::<f32>();
                        let sample = 0.6 * kick + chord;
                        [sample, sample]
                    })
                    .collect();
                crate::audio::scope::SCOPE.write(&frames, 2);
                std::thread::sleep(Duration::from_millis(10));
            }
        });
    }

    let (width, height) = (1920, 1080);
    let app = App::new().expect("create the window");
    window.set_size(PhysicalSize::new(width, height));
    app.show().expect("show the window");
    crate::dress(&app, server);
    let (actions, mut action_receiver) = tokio::sync::mpsc::unbounded_channel();
    runtime.spawn(async move { while action_receiver.recv().await.is_some() {} });
    let clock = crate::view::PlayClock::default();
    ui::Ui::install(
        &app,
        server.to_owned(),
        runtime.handle().clone(),
        actions,
        clock.clone(),
        ui::Hooks {
            open_update_settings: Box::new(|| {}),
            check_for_updates: Box::new(|| {}),
            install_update: Box::new(|| {}),
        },
    );
    let runner = Runner {
        window,
        queue,
        app,
        width,
        height,
        out: out.to_owned(),
    };
    runner.pump(Duration::from_millis(200));
    for step in steps {
        match step {
            Step::Session(view) => {
                let entry_id = view.current_entry().map(|entry| entry.entry_id.clone());
                clock.set(entry_id.as_deref(), view.position_seconds, false);
                ui::with(|ui| ui.on_session(view));
                runner.pump(Duration::from_millis(50));
            }
            Step::Key(text) => {
                runner.key(text, true, false);
                runner.key(text, false, false);
                runner.pump(Duration::from_millis(60));
            }
            Step::Hold => {
                let ok: slint::SharedString = slint::platform::Key::Return.into();
                runner.key(&ok, true, false);
                runner.pump(Duration::from_millis(500));
                runner.key(&ok, true, true);
                runner.key(&ok, false, false);
                runner.pump(Duration::from_millis(60));
            }
            Step::Wait(duration) => runner.pump(duration),
            Step::Rest => {
                ui::with(ui::Ui::rest);
                runner.pump(Duration::from_millis(60));
            }
            Step::Shot(name) => {
                runner.pump(Duration::from_millis(400));
                runner.shot(name);
            }
        }
    }
    feeding.store(false, std::sync::atomic::Ordering::Relaxed);
    drop(runner.app);
    runtime.shutdown_background();
}

/// A made-up queue of songs with real artwork, for screenshots.
pub fn sample_view(tracks: Vec<QueueTrack>, current: usize, here: bool) -> View {
    let duration = tracks
        .get(current)
        .and_then(|track| track.duration_seconds)
        .unwrap_or(200.0);
    View {
        connected: true,
        queue: tracks
            .into_iter()
            .enumerate()
            .map(|(index, track)| QueueEntry {
                entry_id: format!("e{index}"),
                track,
                autoplay: false,
            })
            .collect(),
        current: Some(current),
        playing: true,
        position_seconds: (duration * 0.38).floor(),
        duration_seconds: duration,
        here,
        player_name: (!here).then(|| "Josh's iPhone".to_owned()),
        loading: false,
        notice: String::new(),
        utc_offset_minutes: None,
        repeat: crate::protocol::RepeatMode::Off,
        shuffle: false,
    }
}
