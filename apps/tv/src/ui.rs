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
use std::sync::Arc;
use std::time::{Duration, Instant};

use slint::platform::Key as SlintKey;
use slint::{
    Color, ComponentHandle, Image, Model, ModelRc, SharedString, Timer, TimerMode, VecModel,
};
use tokio::sync::mpsc::UnboundedSender;

use crate::catalog::{self, Analysis, Card, CardKind, CollectionKind, LikeRequest};
use crate::controller::UiAction;
use crate::local_time::LocalTime;
use crate::lyrics::{self, RowKind};
use crate::nav::{
    self, COLLECTION_BUTTONS, CONTROLS, CollectionButton, Control, Effect, Focus, IDLE_BUTTONS,
    IdleButton, KEY_COLUMNS, KEYBOARD, Key, Load, Nav, Panel, PlayMode, RowRef, Tab, WIDE_KEYS,
};
use crate::protocol::Placement;
use crate::update::{self, UpdateStatus};
use crate::view::{PlayClock, View, clock};
use crate::visuals::{Cover, Screenshot, Stage, Visuals};
use crate::{
    App, ButtonData, CardData, HintData, KeyData, LyricRowData, MenuItemData, RowData, ShelfData,
    UpNextData,
};

/// Image sizes, in pixels, for each place artwork appears.
const CARD_PIXELS: u32 = 360;
const ROW_PIXELS: u32 = 160;
const COVER_PIXELS: u32 = 540;
const HERO_PIXELS: u32 = 720;
const IMAGE_CACHE: usize = 260;
/// A failed image is asked for again only after this long.
const IMAGE_RETRY: Duration = Duration::from_secs(30);

/// OK held this long opens the options menu.
const HOLD: Duration = Duration::from_millis(450);
const SEARCH_DELAY: Duration = Duration::from_millis(380);
/// The resting screens shift a little this often, so nothing burns in.
const DRIFT_EVERY: Duration = Duration::from_secs(40);
/// No key for this long with a song up returns to the now-playing screen.
const REST_AFTER: Duration = Duration::from_secs(60);
/// While the visuals show, the server is asked this often whether it wants
/// a picture of the screen (to check the visuals on a TV nobody can see).
const CAPTURE_POLL: Duration = Duration::from_secs(4);
/// A failed analysis is asked for again after this long, times the tries.
const ANALYSIS_RETRY: Duration = Duration::from_secs(8);
const ANALYSIS_TRIES: u32 = 6;
const TICK: Duration = Duration::from_millis(100);
const UP_NEXT: usize = 1;

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
    cover: Option<Arc<Cover>>,
}

struct Models {
    controls: Rc<VecModel<ButtonData>>,
    up_next: Rc<VecModel<UpNextData>>,
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
    lyric_rows: Rc<VecModel<LyricRowData>>,
}

impl Models {
    fn new() -> Self {
        Self {
            controls: Rc::default(),
            up_next: Rc::default(),
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
            lyric_rows: Rc::default(),
        }
    }

    fn attach(&self, app: &App) {
        app.set_controls(ModelRc::from(self.controls.clone()));
        app.set_up_next(ModelRc::from(self.up_next.clone()));
        app.set_queue_rows(ModelRc::from(self.queue_rows.clone()));
        app.set_idle_buttons(ModelRc::from(self.idle_buttons.clone()));
        app.set_shelves(ModelRc::from(self.shelves.clone()));
        app.set_shelf_offsets(ModelRc::from(self.offsets.clone()));
        app.set_keys(ModelRc::from(self.keys.clone()));
        app.set_col_buttons(ModelRc::from(self.col_buttons.clone()));
        app.set_col_rows(ModelRc::from(self.col_rows.clone()));
        app.set_menu_items(ModelRc::from(self.menu_items.clone()));
        app.set_hints(ModelRc::from(self.hints.clone()));
        app.set_lyric_rows(ModelRc::from(self.lyric_rows.clone()));
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
    /// Look for an update now, from the settings menu.
    pub check_for_updates: Box<dyn Fn()>,
    /// Tells the updater whether it may install: only while nothing plays here.
    pub set_quiet: Box<dyn Fn(bool)>,
}

/// The analysis of one song: asked for, arrived, or failed for now.
struct SongAnalysis {
    video_id: String,
    analysis: Option<Arc<Analysis>>,
    tries: u32,
    next_try: Instant,
    pending: bool,
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
    /// The updater's latest status, for the settings menu.
    update: Option<UpdateStatus>,
    /// Someone picked "Check for updates" and has not heard back yet.
    update_asked: bool,
    asked_update_permission: bool,
    models: Models,
    images: HashMap<(String, u32), Image>,
    image_order: VecDeque<(String, u32)>,
    image_pending: HashSet<(String, u32)>,
    image_failed: HashMap<(String, u32), Instant>,
    hero: Option<Hero>,
    hero_pending: Option<String>,
    hero_failed: Option<(String, Instant)>,
    tick_timer: Timer,
    /// The now-playing screen's visuals, drawn on the GPU.
    visuals: Visuals,
    /// The server's analysis of the song playing now, for the visuals.
    analysis: Option<SongAnalysis>,
    capture_timer: Timer,
    ok_down: Option<Instant>,
    ok_held: bool,
    /// The app let Android have the last Back press, so it lets the release go too.
    back_released_to_android: bool,
    last_input: Instant,
    drifted: Instant,
    pending_search: Option<(String, Instant)>,
    shown_clock: String,
    shown_notice: String,
    /// Where playback is, to the millisecond, for timed lyrics.
    clock: PlayClock,
    shown_lyric_rows: Vec<lyrics::Row>,
}

impl Ui {
    /// Create the UI state for `app` and start its timers.
    pub fn install(
        app: &App,
        server: String,
        runtime: tokio::runtime::Handle,
        actions: UnboundedSender<UiAction>,
        clock: PlayClock,
        hooks: Hooks,
    ) {
        let models = Models::new();
        models.attach(app);
        let now = Instant::now();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        let visuals = Visuals::install(app, clock.clone(), {
            let (http, server, runtime) = (http.clone(), server.clone(), runtime.clone());
            move |line: String| {
                let request = http.post(format!("{server}/tv-log")).body(line);
                runtime.spawn(async move {
                    let _ = request.send().await;
                });
            }
        });
        let mut ui = Ui {
            app: app.as_weak(),
            nav: Nav::new(),
            runtime,
            catalog: catalog::Client::new(server.clone()),
            http,
            server,
            actions,
            hooks,
            update_status: String::new(),
            update: None,
            update_asked: false,
            asked_update_permission: false,
            models,
            images: HashMap::new(),
            image_order: VecDeque::new(),
            image_pending: HashSet::new(),
            image_failed: HashMap::new(),
            hero: None,
            hero_pending: None,
            hero_failed: None,
            tick_timer: Timer::default(),
            visuals,
            analysis: None,
            capture_timer: Timer::default(),
            ok_down: None,
            ok_held: false,
            back_released_to_android: false,
            last_input: now,
            drifted: now,
            pending_search: None,
            shown_clock: String::new(),
            shown_notice: String::new(),
            clock,
            shown_lyric_rows: Vec::new(),
        };
        ui.tick_timer.start(TimerMode::Repeated, TICK, || {
            with(Ui::tick);
        });
        ui.capture_timer
            .start(TimerMode::Repeated, CAPTURE_POLL, || {
                with(Ui::poll_capture);
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
        let Some(key) = map_key(text) else {
            return false;
        };
        if pressed {
            self.last_input = now;
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
            // Holding Back must not count as pressing it again and again.
            if pressed && !repeat {
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
        let playing_here = view.here && view.playing && !view.is_idle();
        (self.hooks.set_quiet)(!playing_here);
        let effects = self.nav.on_session(view);
        self.run(effects);
        self.render();
    }

    /// Show the updater's state in the top bar; ask for permission once.
    /// Answer a check someone asked for.
    pub fn on_update_status(&mut self, status: &UpdateStatus) {
        self.update = Some(status.clone());
        self.update_status = match status {
            UpdateStatus::UpToDate | UpdateStatus::NeedsPermission => String::new(),
            UpdateStatus::Checking => "Checking for updates…".to_owned(),
            UpdateStatus::Downloading { percent } => format!("Downloading an update · {percent}%"),
            UpdateStatus::WaitingForQuiet => {
                "Update ready: installs when the music stops".to_owned()
            }
            UpdateStatus::Installing => "Installing an update…".to_owned(),
            UpdateStatus::Failed(_) => "Update failed".to_owned(),
        };
        let answer_asked = self.update_asked && *status != UpdateStatus::Checking;
        if answer_asked {
            self.update_asked = false;
            let now = Instant::now();
            match status {
                UpdateStatus::UpToDate => self.nav.say("Joshify is up to date", now),
                UpdateStatus::Downloading { .. } => self.nav.say("Downloading an update", now),
                UpdateStatus::Failed(_) => self.nav.say("Couldn't check for updates", now),
                _ => {}
            }
        }
        if *status == UpdateStatus::NeedsPermission
            && (answer_asked || !self.asked_update_permission)
        {
            self.asked_update_permission = true;
            self.nav.ask_update_permission();
        }
        self.render();
    }

    /// The settings menu's text: this build, and how updates stand.
    fn about(&self) -> String {
        let version = format!("Version {}.", update::describe_build(update::BUILD));
        if update::BUILD == update::DEV_BUILD {
            return format!("{version} A development build never updates itself.");
        }
        let updates = match &self.update {
            None | Some(UpdateStatus::Checking) => "Checking for updates…".to_owned(),
            Some(UpdateStatus::UpToDate) => "Up to date.".to_owned(),
            Some(UpdateStatus::Downloading { percent }) => {
                format!("Downloading an update ({percent}%).")
            }
            Some(UpdateStatus::WaitingForQuiet) => {
                "An update is ready. It installs when the music stops.".to_owned()
            }
            Some(UpdateStatus::Installing) => "Installing an update…".to_owned(),
            Some(UpdateStatus::NeedsPermission) => {
                "Updates need “Install unknown apps” turned on for Joshify.".to_owned()
            }
            Some(UpdateStatus::Failed(message)) => format!("The last update failed: {message}"),
        };
        format!("{version} {updates}")
    }

    /// "Check for updates": ask the updater, unless an update is already on
    /// its way, and say what happens.
    fn check_for_updates(&mut self) {
        let now = Instant::now();
        if update::BUILD == update::DEV_BUILD {
            self.nav
                .say("A development build never updates itself", now);
            return;
        }
        match self.update {
            Some(UpdateStatus::Downloading { .. }) => {
                self.nav.say("An update is downloading", now);
            }
            Some(UpdateStatus::WaitingForQuiet) => {
                self.nav.say("An update installs when the music stops", now);
            }
            Some(UpdateStatus::Installing) => self.nav.say("An update is installing", now),
            _ => {
                self.update_asked = true;
                (self.hooks.check_for_updates)();
                self.nav.say("Checking for updates…", now);
            }
        }
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
                            Ok(_) => ui
                                .nav
                                .on_failure("There's nothing to play there", Instant::now()),
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
                Effect::OpenSettings => {
                    let about = self.about();
                    self.nav.show_settings(about);
                }
                Effect::CheckForUpdates => self.check_for_updates(),
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
        if now.duration_since(self.last_input) >= REST_AFTER && self.nav.tab != Tab::NowPlaying {
            self.nav.rest();
            changed |= self.nav.tab == Tab::NowPlaying;
        }
        changed |= self.nav.settle(now);
        if now.duration_since(self.drifted) >= DRIFT_EVERY {
            self.drifted = now;
            let (x, y) = drift();
            if let Some(app) = self.app.upgrade() {
                app.set_drift_x(x);
                app.set_drift_y(y);
            }
        }
        let clock = LocalTime::now(self.nav.session.utc_offset_minutes).clock();
        let notice = self.notice_text(now);
        if clock != self.shown_clock || notice != self.shown_notice {
            changed = true;
        }
        if changed {
            self.render();
        }
        self.draw_lyric_rows();
        self.update_visuals();
    }

    /// Whether the screen shows the song playing now.
    fn on_stage(&self) -> bool {
        self.nav.tab == Tab::NowPlaying && !self.nav.session.is_idle()
    }

    // LYRICS

    /// The timed lyrics' rows right now, while the now-playing screen shows them.
    fn timed_lyric_rows(&self) -> Option<Vec<lyrics::Row>> {
        if !self.on_stage() || !self.nav.show_lyrics {
            return None;
        }
        let entry = self.nav.session.current_entry()?;
        let (video_id, load) = self.nav.lyrics.as_ref()?;
        let Load::Loaded(Some(song)) = load else {
            return None;
        };
        if *video_id != entry.track.video_id || song.lines.is_empty() {
            return None;
        }
        let seconds = match self.clock.seconds() {
            Some((entry_id, seconds)) if entry_id == entry.entry_id => seconds,
            _ => self.nav.session.position_seconds,
        };
        Some(lyrics::rows(&song.lines, seconds))
    }

    /// Redraw the timed lyrics only when a row changed.
    fn draw_lyric_rows(&mut self) {
        let rows = self.timed_lyric_rows().unwrap_or_default();
        if rows == self.shown_lyric_rows {
            return;
        }
        sync(
            &self.models.lyric_rows,
            rows.iter()
                .map(|row| LyricRowData {
                    text: row.text.as_str().into(),
                    kind: match row.kind {
                        RowKind::Past => 0,
                        RowKind::Active => 1,
                        RowKind::Next => 2,
                        RowKind::Rest => 3,
                        RowKind::Break => 4,
                    },
                    lit: row.lit as i32,
                })
                .collect(),
        );
        self.shown_lyric_rows = rows;
    }

    /// The visuals run while the now-playing screen shows.
    fn update_visuals(&mut self) {
        let Some(app) = self.app.upgrade() else {
            return;
        };
        let stage = if self.on_stage() {
            self.stage(app.get_lyrics_mode() != 0)
        } else {
            None
        };
        self.visuals.set_stage(&app, stage);
        app.set_has_visuals(self.visuals.drawing());
    }

    /// What the visuals need about the song playing now.
    fn stage(&mut self, side: bool) -> Option<Stage> {
        let entry = self.nav.session.current_entry()?.clone();
        let analysis = self.analysis_for(&entry.track.video_id);
        Some(Stage {
            entry_id: entry.entry_id,
            cover: self.current_cover(),
            analysis,
            playing: self.nav.session.playing,
            side,
        })
    }

    /// The server's analysis of `video_id`, asking for it when needed.
    fn analysis_for(&mut self, video_id: &str) -> Option<Arc<Analysis>> {
        let now = Instant::now();
        if self
            .analysis
            .as_ref()
            .is_none_or(|song| song.video_id != video_id)
        {
            self.analysis = Some(SongAnalysis {
                video_id: video_id.to_owned(),
                analysis: None,
                tries: 0,
                next_try: now,
                pending: false,
            });
        }
        let song = self.analysis.as_mut()?;
        let ask = song.analysis.is_none()
            && !song.pending
            && song.tries < ANALYSIS_TRIES
            && now >= song.next_try;
        let analysis = song.analysis.clone();
        if ask {
            song.pending = true;
            song.tries += 1;
            let catalog = self.catalog.clone();
            let wanted = video_id.to_owned();
            let video_id = video_id.to_owned();
            self.spawn(
                async move { catalog.analysis(&wanted).await },
                move |ui, result| ui.on_analysis(&video_id, result),
            );
        }
        analysis
    }

    fn on_analysis(&mut self, video_id: &str, result: Result<Analysis, String>) {
        let Some(song) = self
            .analysis
            .as_mut()
            .filter(|song| song.video_id == video_id)
        else {
            return;
        };
        song.pending = false;
        match result {
            Ok(analysis) => {
                log::info!(
                    "analysis of {video_id}: {:.0} BPM, {} sections, {} drops",
                    analysis.tempo,
                    analysis.sections.len(),
                    analysis.drops.len()
                );
                song.analysis = Some(Arc::new(analysis));
            }
            Err(message) => {
                log::info!("no analysis of {video_id} yet: {message}");
                song.next_try = Instant::now() + ANALYSIS_RETRY * song.tries;
            }
        }
        self.update_visuals();
    }

    /// Ask the server whether it wants a picture of the screen, and send one.
    fn poll_capture(&mut self) {
        if !self.visuals.drawing() {
            return;
        }
        let request = self.http.get(format!("{}/tv/capture", self.server));
        self.spawn(
            async move {
                request
                    .send()
                    .await
                    .is_ok_and(|response| response.status() == reqwest::StatusCode::OK)
            },
            |ui, wanted| {
                if wanted {
                    ui.send_screenshot();
                }
            },
        );
    }

    fn send_screenshot(&mut self) {
        let Some(app) = self.app.upgrade() else {
            return;
        };
        let (http, server, runtime) =
            (self.http.clone(), self.server.clone(), self.runtime.clone());
        self.visuals.capture(&app, move |screenshot: Screenshot| {
            runtime.spawn(async move {
                let Some(png) = tokio::task::spawn_blocking(move || encode_png(screenshot))
                    .await
                    .ok()
                    .flatten()
                else {
                    return;
                };
                let sent = http
                    .post(format!("{server}/tv/frame"))
                    .header("content-type", "image/png")
                    .body(png)
                    .send()
                    .await;
                if let Err(error) = sent {
                    log::warn!("could not send the screenshot: {error}");
                }
            });
        });
    }

    /// The decoded cover of the song playing now, if it has arrived.
    fn current_cover(&self) -> Option<Arc<Cover>> {
        let url = self
            .nav
            .session
            .current_entry()?
            .track
            .artwork_url
            .as_deref()?;
        let hero = self.hero.as_ref().filter(|hero| hero.url == url)?;
        hero.cover.clone()
    }

    /// Rest on the now-playing screen.
    #[cfg(feature = "screenshots")]
    pub fn rest(&mut self) {
        if !self.on_stage() {
            self.nav.rest();
            self.render();
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
        if self
            .image_failed
            .get(&key)
            .is_some_and(|at| at.elapsed() < IMAGE_RETRY)
        {
            return None;
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
                            ui.images
                                .insert(key.clone(), Image::from_rgba8(decoded.pixels));
                            ui.image_order.push_back(key);
                            while ui.image_order.len() > IMAGE_CACHE {
                                if let Some(old) = ui.image_order.pop_front() {
                                    ui.images.remove(&old);
                                }
                            }
                        }
                        Err(error) => {
                            log::warn!("artwork failed: {error}");
                            if ui.image_failed.len() > IMAGE_CACHE {
                                ui.image_failed.retain(|_, at| at.elapsed() < IMAGE_RETRY);
                            }
                            ui.image_failed.insert(key, Instant::now());
                        }
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
            || self
                .hero_failed
                .as_ref()
                .is_some_and(|(failed, at)| failed == url && at.elapsed() < IMAGE_RETRY)
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
                            tint: decoded.tint.unwrap_or(Color::from_rgb_u8(0x14, 0x20, 0x19)),
                            cover: decoded.cover,
                        });
                    }
                    Err(error) => {
                        log::warn!("cover failed: {error}");
                        ui.hero_failed = Some((wanted, Instant::now()));
                    }
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
        let Some(app) = self.app.upgrade() else {
            return;
        };
        let now = Instant::now();
        let nav = &self.nav;
        let time = LocalTime::now(nav.session.utc_offset_minutes);
        self.shown_clock = time.clock();
        self.shown_notice = self.notice_text(now);
        app.set_clock(self.shown_clock.clone().into());
        app.set_notice(self.shown_notice.clone().into());
        app.set_controls_shown(nav.controls_shown());
        app.set_tab(nav.tab.index() as i32);
        app.set_tabs_focused(nav.focus == Focus::Tabs && nav.menu.is_none());
        app.set_settings_focused(nav.focus == Focus::Settings && nav.menu.is_none());
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
        self.update_visuals();
    }

    fn content_focused(&self) -> bool {
        self.nav.focus == Focus::Content && self.nav.menu.is_none()
    }

    fn draw_player(&mut self, app: &App) {
        let session = self.nav.session.clone();
        let entry = session.current_entry().cloned();
        let track = entry.as_ref().map(|entry| entry.track.clone());
        self.want_hero(
            track
                .as_ref()
                .and_then(|track| track.artwork_url.as_deref()),
        );
        let hero = self.hero.as_ref().filter(|hero| {
            track
                .as_ref()
                .and_then(|track| track.artwork_url.as_deref())
                == Some(hero.url.as_str())
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
            app.set_tint(Color::from_rgb_u8(0x14, 0x20, 0x19));
        }
        let title = track
            .as_ref()
            .map(|track| track.title.clone())
            .unwrap_or_default();
        app.set_track_title(title.into());
        app.set_artists(
            track
                .as_ref()
                .map(|t| t.artists.clone())
                .unwrap_or_default()
                .into(),
        );
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

        let liked =
            self.nav.liked.as_ref().is_some_and(|(id, liked)| {
                *liked && Some(id) == track.as_ref().map(|t| &t.video_id)
            });
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
                        ("play", "Play here", false)
                    }
                    Control::PlayPause if session.playing => ("pause", "", false),
                    Control::PlayPause => ("play", "", false),
                    Control::Next => ("next", "", false),
                    Control::Like => (if liked { "heart" } else { "heart-outline" }, "", liked),
                    Control::Queue => ("queue", "Queue", self.nav.panel == Panel::Queue),
                    Control::Lyrics => ("lyrics", "Lyrics", self.nav.show_lyrics),
                };
                ButtonData {
                    icon: icon.into(),
                    label: label.into(),
                    selected: selectable && self.nav.control == index,
                    active,
                    primary: *control == Control::PlayPause && label.is_empty(),
                }
            })
            .collect();
        sync(&self.models.controls, controls);

        let next: Vec<_> = session
            .current
            .map(|index| {
                session
                    .queue
                    .iter()
                    .skip(index + 1)
                    .take(UP_NEXT)
                    .cloned()
                    .collect()
            })
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
            let after = session.current.map_or(0, |index| index + 1);
            let upcoming = session.queue.get(after..).unwrap_or_default();
            let autoplay = upcoming.iter().filter(|entry| entry.autoplay).count();
            app.set_queue_summary(queue_summary(upcoming.len(), autoplay).into());
        }
        // The lyrics beside the song: none (the song takes the middle), timed,
        // or plain text that scrolls with the song.
        let song = match &self.nav.lyrics {
            Some((id, Load::Loaded(Some(song))))
                if self.nav.show_lyrics
                    && Some(id) == track.as_ref().map(|t| &t.video_id)
                    && !song.text.trim().is_empty() =>
            {
                Some(song)
            }
            _ => None,
        };
        app.set_lyrics_mode(match song {
            None => 0,
            Some(song) if !song.lines.is_empty() => 1,
            Some(_) => 2,
        });
        app.set_lyrics(
            song.map(|song| song.text.clone())
                .unwrap_or_default()
                .into(),
        );
        self.draw_lyric_rows();
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
        let Some(browse) = self.nav.browse(tab) else {
            return;
        };
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
                    if near
                        || self.images.contains_key(&(
                            card.artwork_url.clone().unwrap_or_default(),
                            CARD_PIXELS,
                        ))
                    {
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
            shelves
                .offsets
                .iter()
                .map(|offset| *offset as i32)
                .collect(),
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
            icon: if *label == "Delete" {
                "backspace".into()
            } else {
                SharedString::default()
            },
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
        let Some(page) = self.nav.collection().cloned() else {
            return;
        };
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
        app.set_col_title(
            collection
                .as_ref()
                .map(|c| c.title.clone())
                .unwrap_or_default()
                .into(),
        );
        // "Artist" under the ARTIST label says nothing new.
        let subtitle = collection
            .as_ref()
            .map(|c| c.subtitle.clone())
            .filter(|subtitle| !subtitle.eq_ignore_ascii_case(page.kind.as_str()))
            .unwrap_or_default();
        app.set_col_subtitle(subtitle.into());
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
                    // Only Play has a label, so all three fit beside the cover.
                    let (icon, label) = match button {
                        CollectionButton::Play => ("play", "Play"),
                        CollectionButton::Shuffle => ("shuffle", ""),
                        CollectionButton::Queue => ("queue", ""),
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
            2 => &[
                ("OK", "Play or open"),
                ("Hold OK", "More options"),
                ("Back", "Menu bar"),
            ],
            3 if search_keyboard => &[("OK", "Type"), ("▶", "Results"), ("Back", "Menu bar")],
            3 => &[
                ("OK", "Play or open"),
                ("Hold OK", "More options"),
                ("◀", "Keyboard"),
            ],
            4 => &[
                ("OK", "Play"),
                ("Hold OK", "More options"),
                ("Back", "Go back"),
            ],
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

/// A new small offset for the resting screens, each -1 to 1, from the clock.
fn drift() -> (f32, f32) {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    let x = (seed % 1000) as f32 / 500.0 - 1.0;
    let y = ((seed / 1000) % 1000) as f32 / 500.0 - 1.0;
    (x, y)
}

/// The line over the queue: how many songs follow, and how many of those
/// autoplay added.
fn queue_summary(upcoming: usize, autoplay: usize) -> String {
    let songs = match upcoming {
        0 => return "This is the last song".to_owned(),
        1 => "1 song after this one".to_owned(),
        count => format!("{count} songs after this one"),
    };
    match autoplay {
        0 => songs,
        count if count == upcoming => format!("{songs}, all from autoplay"),
        count => format!("{songs}, {count} from autoplay"),
    }
}

/// A screenshot as PNG, at half size: enough to see the visuals.
fn encode_png(screenshot: Screenshot) -> Option<Vec<u8>> {
    let image = image::RgbaImage::from_raw(screenshot.width, screenshot.height, screenshot.rgba)?;
    let half = image::imageops::resize(
        &image,
        (screenshot.width / 2).max(1),
        (screenshot.height / 2).max(1),
        image::imageops::FilterType::Triangle,
    );
    let mut png = std::io::Cursor::new(Vec::new());
    half.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(png.into_inner())
}

#[cfg(test)]
mod tests {
    use super::queue_summary;

    #[test]
    fn summarizes_the_queue_with_autoplay() {
        assert_eq!(queue_summary(0, 0), "This is the last song");
        assert_eq!(queue_summary(1, 0), "1 song after this one");
        assert_eq!(queue_summary(3, 0), "3 songs after this one");
        assert_eq!(
            queue_summary(12, 10),
            "12 songs after this one, 10 from autoplay"
        );
        assert_eq!(
            queue_summary(10, 10),
            "10 songs after this one, all from autoplay"
        );
    }
}
