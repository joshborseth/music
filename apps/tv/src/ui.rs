//! The UI thread's half of the app: turns remote keys into [`Nav`] moves,
//! runs the effects they ask for, and draws the result into the Slint
//! window.
//!
//! Everything here lives on the UI thread in a thread-local, so Slint
//! callbacks, timers, and results from the async runtime (delivered with
//! `invoke_from_event_loop`) all reach it through [`with`]. Drawing diffs
//! into long-lived models, so moving the selection only touches the rows
//! that changed.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::rc::Rc;
use std::time::{Duration, Instant};

use slint::platform::Key as SlintKey;
use slint::{Color, ComponentHandle, Image, Model, ModelRc, SharedString, Timer, TimerMode, VecModel};
use tokio::sync::mpsc::UnboundedSender;

use crate::catalog::{self, Card, CardKind, CollectionKind, LikeRequest};
use crate::controller::UiAction;
use crate::local_time::LocalTime;
use crate::nav::{
    self, COLLECTION_BUTTONS, CONTROLS, CollectionButton, Control, Effect, Focus, IDLE_BUTTONS,
    IdleButton, KEY_COLUMNS, KEYBOARD, Key, Load, Nav, Panel, PlayMode, RowRef, Tab, WIDE_KEYS,
};
use crate::protocol::Placement;
use crate::view::{View, clock};
use crate::visualizer::{Analyzer, BARS};
use crate::{
    App, ButtonData, CardData, HintData, KeyData, MenuItemData, RowData, ShelfData, UpNextData,
};

/// Image sizes, in pixels, for each place artwork appears.
const CARD_PIXELS: u32 = 360;
const ROW_PIXELS: u32 = 160;
const COVER_PIXELS: u32 = 540;
const HERO_PIXELS: u32 = 720;
const IMAGE_CACHE: usize = 260;

/// OK held this long opens the options menu.
const HOLD: Duration = Duration::from_millis(450);
const SEARCH_DELAY: Duration = Duration::from_millis(380);
/// No key for this long shows the screensaver.
const SAVER_AFTER: Duration = Duration::from_secs(150);
const SAVER_MOVE: Duration = Duration::from_secs(14);
const FRAME: Duration = Duration::from_millis(33);
const TICK: Duration = Duration::from_millis(100);
const UP_NEXT: usize = 3;

thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
}

/// Run `f` with the UI state, if the window is up and nothing else has it.
pub fn with<R>(f: impl FnOnce(&mut Ui) -> R) -> Option<R> {
    UI.with(|cell| {
        let mut borrowed = cell.try_borrow_mut().ok()?;
        borrowed.as_mut().map(f)
    })
}

/// Hand a result from the async runtime to the UI thread.
fn deliver(done: impl FnOnce(&mut Ui) + Send + 'static) {
    let _ = slint::invoke_from_event_loop(move || {
        with(|ui| {
            done(ui);
            ui.render();
        });
    });
}

struct Hero {
    url: String,
    image: Image,
    backdrop: Option<Image>,
    tint: Color,
}

struct Models {
    controls: Rc<VecModel<ButtonData>>,
    up_next: Rc<VecModel<UpNextData>>,
    bars: Rc<VecModel<f32>>,
    queue_rows: Rc<VecModel<RowData>>,
    idle_buttons: Rc<VecModel<ButtonData>>,
    shelves: Rc<VecModel<ShelfData>>,
    shelf_cards: Vec<Rc<VecModel<CardData>>>,
    shelf_titles: Vec<String>,
    offsets: Rc<VecModel<i32>>,
    keys: Rc<VecModel<KeyData>>,
    col_buttons: Rc<VecModel<ButtonData>>,
    col_rows: Rc<VecModel<RowData>>,
    menu_items: Rc<VecModel<MenuItemData>>,
    hints: Rc<VecModel<HintData>>,
}

impl Models {
    fn new() -> Self {
        Self {
            controls: Rc::default(),
            up_next: Rc::default(),
            bars: Rc::new(VecModel::from(vec![0.0; BARS])),
            queue_rows: Rc::default(),
            idle_buttons: Rc::default(),
            shelves: Rc::default(),
            shelf_cards: Vec::new(),
            shelf_titles: Vec::new(),
            offsets: Rc::default(),
            keys: Rc::default(),
            col_buttons: Rc::default(),
            col_rows: Rc::default(),
            menu_items: Rc::default(),
            hints: Rc::default(),
        }
    }

    fn attach(&self, app: &App) {
        app.set_controls(ModelRc::from(self.controls.clone()));
        app.set_up_next(ModelRc::from(self.up_next.clone()));
        app.set_bars(ModelRc::from(self.bars.clone()));
        app.set_queue_rows(ModelRc::from(self.queue_rows.clone()));
        app.set_idle_buttons(ModelRc::from(self.idle_buttons.clone()));
        app.set_shelves(ModelRc::from(self.shelves.clone()));
        app.set_shelf_offsets(ModelRc::from(self.offsets.clone()));
        app.set_keys(ModelRc::from(self.keys.clone()));
        app.set_col_buttons(ModelRc::from(self.col_buttons.clone()));
        app.set_col_rows(ModelRc::from(self.col_rows.clone()));
        app.set_menu_items(ModelRc::from(self.menu_items.clone()));
        app.set_hints(ModelRc::from(self.hints.clone()));
    }

    /// Show these shelves, rebuilding only when the set of shelves changes.
    fn sync_shelves(&mut self, shelves: Vec<(String, Vec<CardData>)>) {
        let titles: Vec<String> = shelves.iter().map(|(title, _)| title.clone()).collect();
        let same = titles == self.shelf_titles
            && shelves
                .iter()
                .zip(&self.shelf_cards)
                .all(|((_, cards), model)| cards.len() == model.row_count());
        if same {
            for ((_, cards), model) in shelves.into_iter().zip(&self.shelf_cards) {
                sync(model, cards);
            }
            return;
        }
        self.shelf_cards = shelves
            .iter()
            .map(|(_, cards)| Rc::new(VecModel::from(cards.clone())))
            .collect();
        self.shelf_titles = titles;
        let rows: Vec<ShelfData> = shelves
            .iter()
            .zip(&self.shelf_cards)
            .map(|((title, _), cards)| ShelfData {
                title: title.into(),
                cards: ModelRc::from(cards.clone()),
            })
            .collect();
        self.shelves.set_vec(rows);
    }
}

/// Make `model` hold `rows`, touching only the rows that differ.
fn sync<T: Clone + PartialEq + 'static>(model: &VecModel<T>, rows: Vec<T>) {
    if model.row_count() != rows.len() {
        model.set_vec(rows);
        return;
    }
    for (index, row) in rows.into_iter().enumerate() {
        if model.row_data(index).as_ref() != Some(&row) {
            model.set_row_data(index, row);
        }
    }
}

/// What the screen's updater hooks do; filled in by `lib.rs`.
pub struct Hooks {
    pub open_update_settings: Box<dyn Fn()>,
}

pub struct Ui {
    app: slint::Weak<App>,
    nav: Nav,
    runtime: tokio::runtime::Handle,
    catalog: catalog::Client,
    http: reqwest::Client,
    server: String,
    actions: UnboundedSender<UiAction>,
    hooks: Hooks,
    update_status: String,
    models: Models,
    images: HashMap<(String, u32), Image>,
    image_order: VecDeque<(String, u32)>,
    image_pending: HashSet<(String, u32)>,
    hero: Option<Hero>,
    hero_pending: Option<String>,
    analyzer: Analyzer,
    bars_timer: Timer,
    tick_timer: Timer,
    ok_down: Option<Instant>,
    ok_held: bool,
    /// The app let Android have the last Back press, so it lets the release go too.
    back_released_to_android: bool,
    last_input: Instant,
    saver: bool,
    saver_moved: Instant,
    pending_search: Option<(String, Instant)>,
    shown_clock: String,
    shown_notice: String,
}

impl Ui {
    /// Create the UI state for `app` and start its timers.
    pub fn install(
        app: &App,
        server: String,
        runtime: tokio::runtime::Handle,
        actions: UnboundedSender<UiAction>,
        hooks: Hooks,
    ) {
        let models = Models::new();
        models.attach(app);
        let now = Instant::now();
        let mut ui = Ui {
            app: app.as_weak(),
            nav: Nav::new(),
            runtime,
            catalog: catalog::Client::new(server.clone()),
            http: reqwest::Client::new(),
            server,
            actions,
            hooks,
            update_status: String::new(),
            models,
            images: HashMap::new(),
            image_order: VecDeque::new(),
            image_pending: HashSet::new(),
            hero: None,
            hero_pending: None,
            analyzer: Analyzer::new(),
            bars_timer: Timer::default(),
            tick_timer: Timer::default(),
            ok_down: None,
            ok_held: false,
            back_released_to_android: false,
            last_input: now,
            saver: false,
            saver_moved: now,
            pending_search: None,
            shown_clock: String::new(),
            shown_notice: String::new(),
        };
        ui.tick_timer.start(TimerMode::Repeated, TICK, || {
            with(Ui::tick);
        });
        let effects = ui.nav.start();
        UI.with(|cell| *cell.borrow_mut() = Some(ui));
        with(|ui| {
            ui.run(effects);
            ui.render();
        });
    }

    // INPUT

    /// A key from the window. Returns whether the app used it.
    pub fn key(&mut self, text: &str, pressed: bool, repeat: bool) -> bool {
        let now = Instant::now();
        let Some(key) = map_key(text) else { return false };
        if pressed {
            self.last_input = now;
        }
        if self.saver {
            if pressed && !repeat {
                self.saver = false;
                self.ok_down = None;
                self.render();
            }
            return true;
        }
        if key == Key::Ok {
            match (pressed, repeat) {
                (true, false) => {
                    self.ok_down = Some(now);
                    self.ok_held = false;
                }
                (true, true) => {
                    if self
                        .ok_down
                        .is_some_and(|at| !self.ok_held && now.duration_since(at) >= HOLD)
                    {
                        self.ok_held = true;
                        self.dispatch(Key::Hold, now);
                    }
                }
                (false, _) => {
                    if self.ok_down.take().is_some() && !self.ok_held {
                        self.dispatch(Key::Ok, now);
                    }
                }
            }
            return true;
        }
        if key == Key::Back {
            if pressed {
                self.back_released_to_android = !self.dispatch(Key::Back, now);
                return !self.back_released_to_android;
            }
            return !self.back_released_to_android;
        }
        if pressed {
            self.dispatch(key, now)
        } else {
            true
        }
    }

    fn dispatch(&mut self, key: Key, now: Instant) -> bool {
        let (used, effects) = self.nav.key(key, now);
        self.run(effects);
        self.render();
        used
    }

    // SESSION AND UPDATES

    pub fn on_session(&mut self, view: View) {
        let effects = self.nav.on_session(view);
        self.run(effects);
        self.render();
    }

    /// Show the updater's state in the top bar; ask for permission once.
    pub fn on_update_status(&mut self, status: String, needs_permission: bool) {
        self.update_status = status;
        if needs_permission {
            self.nav.ask_update_permission();
        }
        self.render();
    }

    // EFFECTS

    fn spawn<T: Send + 'static>(
        &self,
        future: impl Future<Output = T> + Send + 'static,
        done: impl FnOnce(&mut Ui, T) + Send + 'static,
    ) {
        self.runtime.spawn(async move {
            let value = future.await;
            deliver(move |ui| done(ui, value));
        });
    }

    fn run(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Session(action) => {
                    let _ = self.actions.send(action);
                }
                Effect::LoadHome => {
                    let catalog = self.catalog.clone();
                    self.spawn(async move { catalog.home().await }, |ui, result| {
                        ui.nav.on_home(result);
                    });
                }
                Effect::LoadLibrary => {
                    let catalog = self.catalog.clone();
                    self.spawn(async move { catalog.library().await }, |ui, result| {
                        ui.nav.on_library(result);
                    });
                }
                Effect::Search(query) => self.pending_search = Some((query, Instant::now())),
                Effect::LoadCollection { tab, kind, id } => {
                    let catalog = self.catalog.clone();
                    let wanted = id.clone();
                    self.spawn(
                        async move { catalog.collection(kind, &wanted).await },
                        move |ui, result| ui.nav.on_collection(tab, kind, &id, result),
                    );
                }
                Effect::PlayCollection { kind, id, mode } => {
                    let catalog = self.catalog.clone();
                    self.spawn(
                        async move { catalog.collection(kind, &id).await },
                        move |ui, result| match result {
                            Ok(collection) if !collection.tracks.is_empty() => {
                                let tracks = collection.tracks;
                                let _ = ui.actions.send(match mode {
                                    PlayMode::Play => UiAction::PlayTracks { tracks, start: 0 },
                                    PlayMode::Shuffle => UiAction::PlayTracks {
                                        tracks: nav::shuffled(tracks, Instant::now()),
                                        start: 0,
                                    },
                                    PlayMode::Next => UiAction::Enqueue {
                                        tracks,
                                        placement: Placement::Next,
                                    },
                                    PlayMode::Last => UiAction::Enqueue {
                                        tracks,
                                        placement: Placement::Last,
                                    },
                                });
                            }
                            Ok(_) => ui.nav.on_failure("There's nothing to play there", Instant::now()),
                            Err(message) => ui.nav.on_failure(&message, Instant::now()),
                        },
                    );
                }
                Effect::LoadLyrics(video_id) => {
                    let catalog = self.catalog.clone();
                    let wanted = video_id.clone();
                    self.spawn(
                        async move { catalog.lyrics(&wanted).await },
                        move |ui, result| ui.nav.on_lyrics(&video_id, result),
                    );
                }
                Effect::LoadLiked(video_id) => {
                    let catalog = self.catalog.clone();
                    let wanted = video_id.clone();
                    self.spawn(
                        async move { catalog.liked(&wanted).await },
                        move |ui, result| {
                            if let Ok(liked) = result {
                                ui.nav.on_liked(&video_id, liked);
                            }
                        },
                    );
                }
                Effect::SetLiked { track, liked } => {
                    let catalog = self.catalog.clone();
                    let request = LikeRequest { track, liked };
                    self.spawn(
                        async move { catalog.set_liked(&request).await },
                        |ui, result| {
                            if let Err(message) = result {
                                ui.nav.on_failure(&message, Instant::now());
                            }
                        },
                    );
                }
                Effect::OpenUpdateSettings => (self.hooks.open_update_settings)(),
            }
        }
    }

    // TIMERS

    fn tick(&mut self) {
        let now = Instant::now();
        let mut changed = false;
        if let Some((query, at)) = &self.pending_search
            && now.duration_since(*at) >= SEARCH_DELAY
        {
            let query = query.clone();
            self.pending_search = None;
            let catalog = self.catalog.clone();
            let wanted = query.clone();
            self.spawn(
                async move { catalog.search(&wanted).await },
                move |ui, result| ui.nav.on_search(&query, result),
            );
        }
        let saver_due = !self.saver
            && self.nav.menu.is_none()
            && now.duration_since(self.last_input) >= SAVER_AFTER;
        if saver_due {
            self.saver = true;
            self.saver_moved = now - SAVER_MOVE;
            changed = true;
        }
        if self.saver && now.duration_since(self.saver_moved) >= SAVER_MOVE {
            self.saver_moved = now;
            let (x, y) = wander(now);
            if let Some(app) = self.app.upgrade() {
                app.set_saver_x(x);
                app.set_saver_y(y);
            }
        }
        let clock = LocalTime::now().clock();
        let notice = self.notice_text(now);
        if clock != self.shown_clock || notice != self.shown_notice {
            changed = true;
        }
        if changed {
            self.render();
        }
        self.update_bars();
    }

    fn bars_wanted(&self) -> bool {
        self.nav.tab == Tab::NowPlaying
            && self.nav.session.here
            && self.nav.session.playing
            && !self.saver
    }

    /// Run the visualizer only while it can show something.
    fn update_bars(&mut self) {
        let wanted = self.bars_wanted();
        if (wanted || self.analyzer.is_moving()) && !self.bars_timer.running() {
            self.bars_timer.start(TimerMode::Repeated, FRAME, || {
                with(Ui::frame);
            });
        }
        if let Some(app) = self.app.upgrade() {
            app.set_bars_visible(wanted || self.analyzer.is_moving());
        }
    }

    fn frame(&mut self) {
        let levels = *self.analyzer.frame();
        for (index, level) in levels.iter().enumerate() {
            if self.models.bars.row_data(index) != Some(*level) {
                self.models.bars.set_row_data(index, *level);
            }
        }
        if !self.bars_wanted() && !self.analyzer.is_moving() {
            self.bars_timer.stop();
            if let Some(app) = self.app.upgrade() {
                app.set_bars_visible(false);
            }
        }
    }

    // IMAGES

    /// A decoded image for `url` at `pixels`, loading it if needed.
    fn image(&mut self, url: Option<&str>, pixels: u32) -> Option<Image> {
        let url = url?;
        let key = (url.to_owned(), pixels);
        if let Some(image) = self.images.get(&key) {
            return Some(image.clone());
        }
        if self.image_pending.insert(key.clone()) {
            let http = self.http.clone();
            let server = self.server.clone();
            let wanted = url.to_owned();
            self.spawn(
                async move { crate::images::load(&http, &server, &wanted, pixels, false).await },
                move |ui, result| {
                    ui.image_pending.remove(&key);
                    match result {
                        Ok(decoded) => {
                            ui.images.insert(key.clone(), Image::from_rgba8(decoded.pixels));
                            ui.image_order.push_back(key);
                            while ui.image_order.len() > IMAGE_CACHE {
                                if let Some(old) = ui.image_order.pop_front() {
                                    ui.images.remove(&old);
                                }
                            }
                        }
                        Err(error) => log::warn!("artwork failed: {error}"),
                    }
                },
            );
        }
        None
    }

    /// Load the now-playing cover, with its backdrop and tint.
    fn want_hero(&mut self, url: Option<&str>) {
        let Some(url) = url else {
            self.hero = None;
            return;
        };
        if self.hero.as_ref().is_some_and(|hero| hero.url == url)
            || self.hero_pending.as_deref() == Some(url)
        {
            return;
        }
        self.hero_pending = Some(url.to_owned());
        let http = self.http.clone();
        let server = self.server.clone();
        let wanted = url.to_owned();
        let fetching = wanted.clone();
        self.spawn(
            async move { crate::images::load(&http, &server, &fetching, HERO_PIXELS, true).await },
            move |ui, result| {
                if ui.hero_pending.as_deref() != Some(wanted.as_str()) {
                    return;
                }
                ui.hero_pending = None;
                match result {
                    Ok(decoded) => {
                        ui.hero = Some(Hero {
                            url: wanted,
                            image: Image::from_rgba8(decoded.pixels),
                            backdrop: decoded.backdrop.map(Image::from_rgba8),
                            tint: decoded.tint.unwrap_or(Color::from_rgb_u8(0x1b, 0x15, 0x30)),
                        });
                    }
                    Err(error) => log::warn!("cover failed: {error}"),
                }
            },
        );
    }

    // DRAWING

    fn notice_text(&self, now: Instant) -> String {
        self.nav
            .notice(now)
            .map(str::to_owned)
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| self.nav.session.notice.clone())
    }

    pub fn render(&mut self) {
        let Some(app) = self.app.upgrade() else { return };
        let now = Instant::now();
        let nav = &self.nav;
        let time = LocalTime::now();
        self.shown_clock = time.clock();
        self.shown_notice = self.notice_text(now);
        app.set_clock(self.shown_clock.clone().into());
        app.set_notice(self.shown_notice.clone().into());
        app.set_saver(self.saver);
        app.set_tab(nav.tab.index() as i32);
        app.set_tabs_focused(nav.focus == Focus::Tabs && nav.menu.is_none());
        let status = if nav.session.connected {
            self.update_status.clone()
        } else {
            "Reconnecting…".to_owned()
        };
        app.set_status(status.into());

        let page = match nav.tab {
            Tab::NowPlaying if nav.session.is_idle() => 1,
            Tab::NowPlaying => 0,
            _ if nav.collection().is_some() => 4,
            Tab::Search => 3,
            _ => 2,
        };
        app.set_page(page);
        self.draw_player(&app);
        match page {
            1 => self.draw_idle(),
            2 => self.draw_shelves(&app, time),
            3 => self.draw_search(&app),
            4 => self.draw_collection(&app),
            _ => {}
        }
        self.draw_menu(&app);
        self.draw_hints(page);
        self.update_bars();
    }

    fn content_focused(&self) -> bool {
        self.nav.focus == Focus::Content && self.nav.menu.is_none()
    }

    fn draw_player(&mut self, app: &App) {
        let session = self.nav.session.clone();
        let entry = session.current_entry().cloned();
        let track = entry.as_ref().map(|entry| entry.track.clone());
        self.want_hero(track.as_ref().and_then(|track| track.artwork_url.as_deref()));
        let hero = self.hero.as_ref().filter(|hero| {
            track.as_ref().and_then(|track| track.artwork_url.as_deref()) == Some(hero.url.as_str())
        });
        app.set_has_artwork(hero.is_some());
        app.set_has_backdrop(hero.is_some_and(|hero| hero.backdrop.is_some()));
        if let Some(hero) = hero {
            app.set_artwork(hero.image.clone());
            if let Some(backdrop) = &hero.backdrop {
                app.set_backdrop(backdrop.clone());
            }
            app.set_tint(hero.tint);
        } else {
            app.set_tint(Color::from_rgb_u8(0x1b, 0x15, 0x30));
        }
        let title = track.as_ref().map(|track| track.title.clone()).unwrap_or_default();
        app.set_track_title(title.into());
        app.set_artists(track.as_ref().map(|t| t.artists.clone()).unwrap_or_default().into());
        app.set_album(
            track
                .as_ref()
                .and_then(|track| track.album.clone())
                .unwrap_or_default()
                .into(),
        );
        app.set_playing(session.playing);
        app.set_loading(session.loading);
        app.set_position_text(clock(session.position_seconds).into());
        app.set_duration_text(clock(session.duration_seconds).into());
        app.set_progress(if session.duration_seconds > 0.0 {
            (session.position_seconds / session.duration_seconds) as f32
        } else {
            0.0
        });
        let place = match (&session.player_name, session.here) {
            (_, true) => "THIS TV".to_owned(),
            (Some(name), false) => name.to_uppercase(),
            (None, false) => "NO DEVICE".to_owned(),
        };
        let place = if session.playing {
            format!("PLAYING ON {place}")
        } else {
            format!("PAUSED · {place}")
        };
        app.set_where(place.into());

        let liked = self
            .nav
            .liked
            .as_ref()
            .is_some_and(|(id, liked)| *liked && Some(id) == track.as_ref().map(|t| &t.video_id));
        let selectable = self.content_focused()
            && self.nav.tab == Tab::NowPlaying
            && self.nav.panel == Panel::None;
        let controls = CONTROLS
            .iter()
            .enumerate()
            .map(|(index, control)| {
                let (icon, label, active) = match control {
                    Control::Previous => ("previous", "", false),
                    Control::PlayPause if !session.here && session.player_name.is_some() => {
                        ("play", "", false)
                    }
                    Control::PlayPause if session.playing => ("pause", "", false),
                    Control::PlayPause => ("play", "", false),
                    Control::Next => ("next", "", false),
                    Control::Like => (if liked { "heart" } else { "heart-outline" }, "", liked),
                    Control::Queue => ("queue", "Queue", self.nav.panel == Panel::Queue),
                    Control::Lyrics => ("lyrics", "Lyrics", self.nav.panel == Panel::Lyrics),
                };
                ButtonData {
                    icon: icon.into(),
                    label: label.into(),
                    selected: selectable && self.nav.control == index,
                    active,
                    primary: *control == Control::PlayPause,
                }
            })
            .collect();
        sync(&self.models.controls, controls);

        let next: Vec<_> = session
            .current
            .map(|index| session.queue.iter().skip(index + 1).take(UP_NEXT).cloned().collect())
            .unwrap_or_default();
        let up_next = next
            .iter()
            .map(|entry| {
                let image = self.image(entry.track.artwork_url.as_deref(), ROW_PIXELS);
                UpNextData {
                    title: entry.track.title.clone().into(),
                    artists: entry.track.artists.clone().into(),
                    has_image: image.is_some(),
                    image: image.unwrap_or_default(),
                }
            })
            .collect();
        sync(&self.models.up_next, up_next);

        // Panels
        app.set_panel(match self.nav.panel {
            Panel::None => 0,
            Panel::Queue => 1,
            Panel::Lyrics => 2,
        });
        if self.nav.panel == Panel::Queue {
            let selectable = self.nav.focus == Focus::Content && self.nav.menu.is_none();
            let rows = session
                .queue
                .iter()
                .enumerate()
                .map(|(index, entry)| {
                    let near = index + 12 >= self.nav.queue_top
                        && index <= self.nav.queue_top + nav::QUEUE_ROWS_VISIBLE + 12;
                    let image = if near {
                        self.image(entry.track.artwork_url.as_deref(), ROW_PIXELS)
                    } else {
                        None
                    };
                    RowData {
                        kind: "track".into(),
                        title: entry.track.title.clone().into(),
                        subtitle: entry.track.artists.clone().into(),
                        detail: entry
                            .track
                            .duration_seconds
                            .map(clock)
                            .unwrap_or_default()
                            .into(),
                        number: SharedString::default(),
                        has_image: image.is_some(),
                        image: image.unwrap_or_default(),
                        round: false,
                        selected: selectable && index == self.nav.queue_row,
                        current: Some(index) == session.current,
                    }
                })
                .collect();
            sync(&self.models.queue_rows, rows);
            app.set_queue_top(self.nav.queue_top as i32);
            let left = session.current.map_or(0, |index| session.queue.len() - index - 1);
            app.set_queue_summary(
                match left {
                    0 => "This is the last song".to_owned(),
                    1 => "1 song after this one".to_owned(),
                    count => format!("{count} songs after this one"),
                }
                .into(),
            );
        }
        let (lyrics, note) = match &self.nav.lyrics {
            Some((id, load)) if Some(id) == track.as_ref().map(|t| &t.video_id) => match load {
                Load::Loaded(Some(text)) => (text.clone(), String::new()),
                Load::Loaded(None) => (String::new(), "No lyrics for this song.".to_owned()),
                Load::Failed(message) => (String::new(), message.clone()),
                _ => (String::new(), "Loading lyrics…".to_owned()),
            },
            _ => (String::new(), "Loading lyrics…".to_owned()),
        };
        app.set_lyrics(lyrics.into());
        app.set_lyrics_note(note.into());
    }

    fn draw_idle(&mut self) {
        let selectable = self.content_focused();
        let buttons = IDLE_BUTTONS
            .iter()
            .enumerate()
            .map(|(index, button)| {
                let (icon, label) = match button {
                    IdleButton::Browse => ("home", "Browse music"),
                    IdleButton::Search => ("search", "Search"),
                };
                ButtonData {
                    icon: icon.into(),
                    label: label.into(),
                    selected: selectable && self.nav.idle_button == index,
                    active: false,
                    primary: false,
                }
            })
            .collect();
        sync(&self.models.idle_buttons, buttons);
    }

    fn card_data(&mut self, card: &Card, selected: bool) -> CardData {
        let image = self.image(card.artwork_url.as_deref(), CARD_PIXELS);
        CardData {
            title: card.title.clone().into(),
            subtitle: card.subtitle.clone().into(),
            has_image: image.is_some(),
            image: image.unwrap_or_default(),
            round: card.kind == CardKind::Artist,
            selected,
            playable: card.track.is_some(),
        }
    }

    /// Fill the shelf models from a tab's shelves, and say if they are
    /// loading or failed.
    fn draw_shelf_models(&mut self, app: &App, tab: Tab, selectable: bool) {
        let Some(browse) = self.nav.browse(tab) else { return };
        let shelves = browse.shelves.clone();
        app.set_page_loading(shelves.content == Load::Loading);
        app.set_page_message(match &shelves.content {
            Load::Failed(message) => message.clone().into(),
            _ => SharedString::default(),
        });
        let selected = shelves.selected();
        let found = shelves.content.loaded().cloned().unwrap_or_default();
        let mut rows = Vec::with_capacity(found.len());
        for (row, shelf) in found.iter().enumerate() {
            let offset = shelves.offsets.get(row).copied().unwrap_or(0);
            let cards = shelf
                .cards
                .iter()
                .enumerate()
                .map(|(column, card)| {
                    // Load artwork for what's on screen and just past it.
                    let near = column + 2 >= offset && column <= offset + 9;
                    let is_selected = selectable && selected == Some((row, column));
                    if near || self.images.contains_key(&(card.artwork_url.clone().unwrap_or_default(), CARD_PIXELS)) {
                        self.card_data(card, is_selected)
                    } else {
                        CardData {
                            title: card.title.clone().into(),
                            subtitle: card.subtitle.clone().into(),
                            round: card.kind == CardKind::Artist,
                            selected: is_selected,
                            playable: card.track.is_some(),
                            ..CardData::default()
                        }
                    }
                })
                .collect();
            rows.push((shelf.title.clone(), cards));
        }
        self.models.sync_shelves(rows);
        sync(
            &self.models.offsets,
            shelves.offsets.iter().map(|offset| *offset as i32).collect(),
        );
        app.set_shelf_top(shelves.row as i32);
    }

    fn draw_shelves(&mut self, app: &App, time: LocalTime) {
        let tab = self.nav.tab;
        let selectable = self.content_focused();
        self.draw_shelf_models(app, tab, selectable);
        let (title, subtitle) = match tab {
            Tab::Library => ("Your library", "Liked songs and the playlists you made"),
            _ => (time.greeting(), "Pick something to play on this TV"),
        };
        app.set_page_title(title.into());
        app.set_page_subtitle(subtitle.into());
    }

    fn draw_search(&mut self, app: &App) {
        let search = self.nav.search.clone();
        let in_keyboard = self.content_focused() && !search.in_results;
        app.set_query(search.query.clone().into());
        app.set_keyboard_focused(in_keyboard);
        let mut keys: Vec<KeyData> = KEYBOARD
            .chars()
            .enumerate()
            .map(|(index, character)| KeyData {
                label: character.to_ascii_uppercase().to_string().into(),
                icon: SharedString::default(),
                span: 1,
                selected: in_keyboard && search.key == index,
            })
            .collect();
        keys.extend(WIDE_KEYS.iter().enumerate().map(|(index, label)| KeyData {
            label: (*label).into(),
            icon: if *label == "Delete" { "backspace".into() } else { SharedString::default() },
            span: 2,
            selected: in_keyboard && search.key == KEYBOARD.len() + index,
        }));
        debug_assert_eq!(KEYBOARD.len() % KEY_COLUMNS, 0);
        sync(&self.models.keys, keys);
        let selectable = self.content_focused() && search.in_results;
        self.draw_shelf_models(app, Tab::Search, selectable);
        if search.query.trim().is_empty() {
            app.set_page_loading(false);
            app.set_page_message(SharedString::default());
        }
    }

    fn draw_collection(&mut self, app: &App) {
        let Some(page) = self.nav.collection().cloned() else { return };
        let focused = self.content_focused();
        let current_video = self
            .nav
            .session
            .current_entry()
            .map(|entry| entry.track.video_id.clone());
        app.set_page_loading(page.content == Load::Loading);
        app.set_page_message(match &page.content {
            Load::Failed(message) => message.clone().into(),
            _ => SharedString::default(),
        });
        app.set_col_kind(
            match page.kind {
                CollectionKind::Album => "ALBUM",
                CollectionKind::Playlist => "PLAYLIST",
                CollectionKind::MyPlaylist => "YOUR PLAYLIST",
                CollectionKind::Artist => "ARTIST",
            }
            .into(),
        );
        app.set_col_round(page.kind == CollectionKind::Artist);
        let collection = page.content.loaded().cloned();
        app.set_col_title(collection.as_ref().map(|c| c.title.clone()).unwrap_or_default().into());
        app.set_col_subtitle(
            collection.as_ref().map(|c| c.subtitle.clone()).unwrap_or_default().into(),
        );
        app.set_col_description(
            collection
                .as_ref()
                .and_then(|c| c.description.clone())
                .map(|text| text.replace('\n', " "))
                .unwrap_or_default()
                .into(),
        );
        let cover = self.image(
            collection.as_ref().and_then(|c| c.artwork_url.as_deref()),
            COVER_PIXELS,
        );
        app.set_col_has_artwork(cover.is_some());
        app.set_col_artwork(cover.unwrap_or_default());
        let has_tracks = collection.as_ref().is_some_and(|c| !c.tracks.is_empty());
        let buttons = if has_tracks {
            COLLECTION_BUTTONS
                .iter()
                .enumerate()
                .map(|(index, button)| {
                    let (icon, label) = match button {
                        CollectionButton::Play => ("play", "Play"),
                        CollectionButton::Shuffle => ("shuffle", "Shuffle"),
                        CollectionButton::Queue => ("queue", "Queue"),
                    };
                    ButtonData {
                        icon: icon.into(),
                        label: label.into(),
                        selected: focused && !page.in_list && page.button == index,
                        active: false,
                        primary: false,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        sync(&self.models.col_buttons, buttons);
        let Some(collection) = collection else {
            sync(&self.models.col_rows, Vec::new());
            return;
        };
        let numbered = page.kind == CollectionKind::Album;
        let rows = page
            .rows()
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let selected = focused && page.in_list && page.row == index;
                let near = index + 12 >= page.top && index <= page.top + 24;
                match *row {
                    RowRef::Track(track_index) => {
                        let track = &collection.tracks[track_index];
                        let image = if numbered || !near {
                            None
                        } else {
                            self.image(track.artwork_url.as_deref(), ROW_PIXELS)
                        };
                        RowData {
                            kind: "track".into(),
                            title: track.title.clone().into(),
                            subtitle: if numbered && track.artists == collection.subtitle {
                                SharedString::default()
                            } else {
                                track.artists.clone().into()
                            },
                            detail: track.duration_seconds.map(clock).unwrap_or_default().into(),
                            number: if numbered {
                                (track_index + 1).to_string().into()
                            } else {
                                SharedString::default()
                            },
                            has_image: image.is_some(),
                            image: image.unwrap_or_default(),
                            round: false,
                            selected,
                            current: current_video.as_deref() == Some(track.video_id.as_str()),
                        }
                    }
                    RowRef::Header(shelf) => RowData {
                        kind: "header".into(),
                        title: collection.shelves[shelf].title.clone().into(),
                        ..RowData::default()
                    },
                    RowRef::Card(shelf, card) => {
                        let card = &collection.shelves[shelf].cards[card];
                        let image = if near {
                            self.image(card.artwork_url.as_deref(), ROW_PIXELS)
                        } else {
                            None
                        };
                        RowData {
                            kind: "link".into(),
                            title: card.title.clone().into(),
                            subtitle: card.subtitle.clone().into(),
                            detail: SharedString::default(),
                            number: SharedString::default(),
                            has_image: image.is_some(),
                            image: image.unwrap_or_default(),
                            round: card.kind == CardKind::Artist,
                            selected,
                            current: false,
                        }
                    }
                }
            })
            .collect();
        sync(&self.models.col_rows, rows);
        app.set_col_top(page.top as i32);
    }

    fn draw_menu(&mut self, app: &App) {
        let Some(menu) = &self.nav.menu else {
            app.set_menu_open(false);
            return;
        };
        app.set_menu_open(true);
        app.set_menu_title(menu.title.clone().into());
        app.set_menu_subtitle(menu.subtitle.clone().into());
        let items = menu
            .items
            .iter()
            .enumerate()
            .map(|(index, action)| MenuItemData {
                icon: action.icon().into(),
                label: action.label().into(),
                selected: index == menu.selected,
            })
            .collect();
        sync(&self.models.menu_items, items);
    }

    fn draw_hints(&mut self, page: i32) {
        let search_keyboard = page == 3 && !self.nav.search.in_results;
        let hints: &[(&str, &str)] = match page {
            2 => &[("OK", "Play or open"), ("Hold OK", "More options"), ("Back", "Menu bar")],
            3 if search_keyboard => &[("OK", "Type"), ("▶", "Results"), ("Back", "Menu bar")],
            3 => &[("OK", "Play or open"), ("Hold OK", "More options"), ("◀", "Keyboard")],
            4 => &[("OK", "Play"), ("Hold OK", "More options"), ("Back", "Go back")],
            _ => &[],
        };
        sync(
            &self.models.hints,
            hints
                .iter()
                .map(|(key, label)| HintData {
                    key: (*key).into(),
                    label: (*label).into(),
                })
                .collect(),
        );
    }
}

/// The remote's keys as Slint names them.
fn map_key(text: &str) -> Option<Key> {
    let is = |key: SlintKey| SharedString::from(key).as_str() == text;
    if is(SlintKey::UpArrow) {
        Some(Key::Up)
    } else if is(SlintKey::DownArrow) {
        Some(Key::Down)
    } else if is(SlintKey::LeftArrow) {
        Some(Key::Left)
    } else if is(SlintKey::RightArrow) {
        Some(Key::Right)
    } else if is(SlintKey::Return) {
        Some(Key::Ok)
    } else if is(SlintKey::Back) || is(SlintKey::Escape) {
        Some(Key::Back)
    } else if is(SlintKey::Backspace) {
        Some(Key::Backspace)
    } else {
        let mut characters = text.chars();
        match (characters.next(), characters.next()) {
            (Some(character), None) if character.is_alphanumeric() || character == ' ' => {
                Some(Key::Char(character))
            }
            _ => None,
        }
    }
}

/// Somewhere new for the screensaver, from the clock.
fn wander(now: Instant) -> (f32, f32) {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
        ^ now.elapsed().as_nanos() as u64;
    let x = (seed % 1000) as f32 / 1000.0;
    let y = ((seed / 1000) % 1000) as f32 / 1000.0;
    (0.08 + x * 0.84, 0.1 + y * 0.8)
}
