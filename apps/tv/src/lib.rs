//! Music for TV: the session's player and now-playing screen, for Android TV.
//!
//! The server (`apps/server`) owns the queue. This app connects to its
//! session WebSocket, plays audio when the server makes it the active device,
//! and shows what is playing either way.

#[cfg(target_os = "android")]
mod android_jni;
mod audio;
pub mod catalog;
mod controller;
#[cfg(target_os = "android")]
mod crash_report;
mod images;
mod local_time;
pub mod lyrics;
pub mod nav;
pub mod protocol;
mod qr;
#[cfg(feature = "screenshots")]
pub mod screenshots;
mod session;
mod ui;
pub mod update;
pub mod view;
mod visualizer;
mod visuals;
mod volume;

use tokio::sync::mpsc::unbounded_channel;

use controller::Controller;
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
    dress(&app, SERVER_URL);

    let (update_status, mut update_statuses) = unbounded_channel();
    let updater = update::Updater::spawn(SERVER_URL.to_owned(), &handle, update_status);
    handle.spawn(async move {
        while let Some(status) = update_statuses.recv().await {
            let _ = slint::invoke_from_event_loop(move || {
                ui::with(|ui| ui.on_update_status(&status));
            });
        }
    });

    let (actions, action_receiver) = unbounded_channel();
    let clock = view::PlayClock::default();
    ui::Ui::install(
        &app,
        SERVER_URL.to_owned(),
        handle.clone(),
        actions,
        clock.clone(),
        ui::Hooks {
            open_update_settings: Box::new({
                let updater = updater.clone();
                move || updater.open_permission_settings()
            }),
            set_quiet: Box::new(move |quiet| updater.set_quiet(quiet)),
        },
    );
    app.on_key(|text, pressed, repeat| {
        ui::with(|ui| ui.key(&text, pressed, repeat)).unwrap_or(false)
    });

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

    let volume = volume::Volume::spawn(outbound.clone());
    let controller = Controller::new(DEVICE_ID.to_owned(), engine, outbound, volume, clock);
    handle.spawn(
        controller.run(inbound_receiver, event_receiver, action_receiver, |view| {
            let _ = slint::invoke_from_event_loop(move || {
                ui::with(|ui| ui.on_session(view));
            });
        }),
    );

    let result = app.run();
    runtime.shutdown_background();
    result
}

/// Set what never changes: the logo, and the QR code guests scan.
fn dress(app: &App, server: &str) {
    if let Some(logo) = logo() {
        app.set_logo(logo);
    }
    let join_url = format!("{server}/");
    if let Some((size, pixels)) = qr::pixels(&join_url) {
        app.set_qr(slint::Image::from_rgba8(
            slint::SharedPixelBuffer::clone_from_slice(&pixels, size, size),
        ));
    }
    app.set_qr_url(
        join_url
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .into(),
    );
}

/// The logo mark for the top bar and the welcome screen.
fn logo() -> Option<slint::Image> {
    let decoded = image::load_from_memory(include_bytes!("../ui/images/logo-mark.png"))
        .ok()?
        .to_rgba8();
    Some(slint::Image::from_rgba8(
        slint::SharedPixelBuffer::clone_from_slice(
            decoded.as_raw(),
            decoded.width(),
            decoded.height(),
        ),
    ))
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
