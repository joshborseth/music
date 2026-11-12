//! Music for TV: the session's player and now-playing screen, for Android TV.
//!
//! The server (`apps/server`) owns the queue. This app connects to its
//! session WebSocket, plays audio when the server makes it the active device,
//! and shows what is playing either way.

mod audio;
pub mod catalog;
mod controller;
#[cfg(target_os = "android")]
mod crash_report;
pub mod protocol;
mod screen;
mod session;
mod view;

use tokio::sync::mpsc::unbounded_channel;

use controller::{Controller, UiAction};
use protocol::{ClientMessage, DeviceKind};

slint::include_modules!();

/// The id the server knows this TV by; it wakes the TV under the same id.
const DEVICE_ID: &str = "tv";
const DEVICE_NAME: &str = "TV";

/// Set `MUSIC_SERVER_URL` when building to point at another server.
const SERVER_URL: &str = match option_env!("MUSIC_SERVER_URL") {
    Some(url) => url,
    None => "http://192.168.1.67:4310",
};

/// Build the window, start the session and the engine, and run until closed.
pub fn run() -> Result<(), slint::PlatformError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("music-io")
        .enable_all()
        .build()
        .expect("start the async runtime");
    let handle = runtime.handle().clone();

    let app = App::new()?;
    app.set_server(SERVER_URL.trim_start_matches("http://").into());

    let (actions, action_receiver) = unbounded_channel();
    let send = move |action: UiAction| {
        let _ = actions.send(action);
    };
    app.on_toggle_play({
        let send = send.clone();
        move || send(UiAction::PlayPause)
    });
    app.on_seek_by({
        let send = send.clone();
        move |delta| send(UiAction::SeekBy(f64::from(delta)))
    });
    app.on_next({
        let send = send.clone();
        move || send(UiAction::Next)
    });
    app.on_previous(move || send(UiAction::Previous));

    let (events, event_receiver) = unbounded_channel();
    let engine = audio::Engine::spawn(SERVER_URL.to_owned(), handle.clone(), events);

    let (inbound, inbound_receiver) = unbounded_channel();
    let outbound = session::spawn(
        &handle,
        format!("{}/session", SERVER_URL.replacen("http", "ws", 1)),
        ClientMessage::Hello {
            device_id: DEVICE_ID.to_owned(),
            name: DEVICE_NAME.to_owned(),
            kind: DeviceKind::Tv,
            player: None,
        },
        inbound,
    );

    let screen = screen::Screen::new(SERVER_URL.to_owned(), app.as_weak(), handle.clone());
    let controller = Controller::new(DEVICE_ID.to_owned(), engine, outbound);
    handle.spawn(controller.run(
        inbound_receiver,
        event_receiver,
        action_receiver,
        move |view| screen.render(view),
    ));

    let result = app.run();
    runtime.shutdown_background();
    result
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
fn android_main(app: slint::android::AndroidApp) {
    use slint::android::android_activity::WindowManagerFlags;

    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("music-tv"),
    );
    crash_report::install(SERVER_URL);
    app.set_window_flags(
        WindowManagerFlags::KEEP_SCREEN_ON | WindowManagerFlags::FULLSCREEN,
        WindowManagerFlags::empty(),
    );
    slint::android::init(app).expect("initialize Slint for Android");
    if let Err(error) = run() {
        log::error!("Music stopped: {error}");
    }
}
