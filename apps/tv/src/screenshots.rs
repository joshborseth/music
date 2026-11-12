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
        let bytes: Vec<u8> = buffer.iter().flat_map(|pixel| [pixel.r, pixel.g, pixel.b]).collect();
        let path = self.out.join(format!("{name}.png"));
        image::save_buffer(&path, &bytes, self.width, self.height, image::ColorType::Rgb8)
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

    let (width, height) = (1920, 1080);
    let app = App::new().expect("create the window");
    window.set_size(PhysicalSize::new(width, height));
    app.show().expect("show the window");
    crate::dress(&app, server);
    let (actions, mut action_receiver) = tokio::sync::mpsc::unbounded_channel();
    runtime.spawn(async move { while action_receiver.recv().await.is_some() {} });
    ui::Ui::install(
        &app,
        server.to_owned(),
        runtime.handle().clone(),
        actions,
        ui::Hooks {
            open_update_settings: Box::new(|| {}),
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
            Step::Shot(name) => {
                runner.pump(Duration::from_millis(400));
                runner.shot(name);
            }
        }
    }
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
    }
}
