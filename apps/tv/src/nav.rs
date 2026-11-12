//! Where the remote is: which tab, page, and item is selected, and what each
//! key does there. Plain data with no Slint in it, so every move is testable
//! on the host. [`Nav::key`] returns [`Effect`]s for the caller to carry out
//! (session commands, catalog loads); their results come back through the
//! `on_*` methods.

use std::time::{Duration, Instant};

use crate::catalog::{Card, Collection, CollectionKind, Shelf};
use crate::controller::UiAction;
use crate::protocol::{Placement, QueueTrack};
use crate::view::View;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Up,
    Down,
    Left,
    Right,
    Ok,
    /// OK held down: options for the selected item.
    Hold,
    Back,
    /// A character typed on a keyboard or a phone's remote app.
    Char(char),
    Backspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    NowPlaying,
    Home,
    Search,
    Library,
}

impl Tab {
    pub const ALL: [Tab; 4] = [Tab::NowPlaying, Tab::Home, Tab::Search, Tab::Library];

    pub fn index(self) -> usize {
        Self::ALL.iter().position(|tab| *tab == self).unwrap_or(0)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Load<T> {
    NotLoaded,
    Loading,
    Failed(String),
    Loaded(T),
}

impl<T> Load<T> {
    pub fn loaded(&self) -> Option<&T> {
        match self {
            Load::Loaded(value) => Some(value),
            _ => None,
        }
    }
}

/// Something for the caller to do.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Session(UiAction),
    LoadHome,
    LoadLibrary,
    /// Run this search after a short pause in typing.
    Search(String),
    LoadCollection {
        tab: Tab,
        kind: CollectionKind,
        id: String,
    },
    /// Fetch a collection, then play or queue its tracks.
    PlayCollection {
        kind: CollectionKind,
        id: String,
        mode: PlayMode,
    },
    LoadLyrics(String),
    LoadLiked(String),
    SetLiked {
        track: QueueTrack,
        liked: bool,
    },
    OpenUpdateSettings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayMode {
    Play,
    Shuffle,
    Next,
    Last,
}

/// What a menu item does.
#[derive(Debug, Clone, PartialEq)]
pub enum MenuAction {
    Play(Target),
    Shuffle(Target),
    PlayNext(Target),
    AddToQueue(Target),
    Open(CollectionKind, String),
    Like(QueueTrack),
    PlayEntry(String),
    RemoveEntry(String),
    OpenUpdateSettings,
    Close,
}

impl MenuAction {
    pub fn label(&self) -> &'static str {
        match self {
            MenuAction::Play(_) => "Play now",
            MenuAction::Shuffle(_) => "Shuffle",
            MenuAction::PlayNext(_) => "Play next",
            MenuAction::AddToQueue(_) => "Add to queue",
            MenuAction::Open(CollectionKind::Artist, _) => "Go to artist",
            MenuAction::Open(_, _) => "Open",
            MenuAction::Like(_) => "Add to Liked songs",
            MenuAction::PlayEntry(_) => "Play now",
            MenuAction::RemoveEntry(_) => "Remove from queue",
            MenuAction::OpenUpdateSettings => "Open settings",
            MenuAction::Close => "Not now",
        }
    }

    pub fn icon(&self) -> &'static str {
        match self {
            MenuAction::Play(_) | MenuAction::PlayEntry(_) => "play",
            MenuAction::Shuffle(_) => "shuffle",
            MenuAction::PlayNext(_) => "play-next",
            MenuAction::AddToQueue(_) => "queue",
            MenuAction::Open(CollectionKind::Artist, _) => "artist",
            MenuAction::Open(_, _) => "album",
            MenuAction::Like(_) => "heart",
            MenuAction::RemoveEntry(_) => "remove",
            MenuAction::OpenUpdateSettings => "settings",
            MenuAction::Close => "close",
        }
    }
}

/// What a menu acts on: songs in hand, or a collection to fetch first.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Tracks(Vec<QueueTrack>),
    Collection(CollectionKind, String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Menu {
    pub title: String,
    pub subtitle: String,
    pub items: Vec<MenuAction>,
    pub selected: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Panel {
    None,
    Queue,
    Lyrics,
}

/// The buttons under the progress bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Previous,
    PlayPause,
    Next,
    Like,
    Queue,
    Lyrics,
}

pub const CONTROLS: [Control; 6] = [
    Control::Previous,
    Control::PlayPause,
    Control::Next,
    Control::Like,
    Control::Queue,
    Control::Lyrics,
];

/// The buttons on the screen shown when nothing is queued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleButton {
    Browse,
    Search,
}

pub const IDLE_BUTTONS: [IdleButton; 2] = [IdleButton::Browse, IdleButton::Search];

/// Rows of cards with a remembered column per row.
#[derive(Debug, Clone, PartialEq)]
pub struct ShelvesNav {
    pub content: Load<Vec<Shelf>>,
    pub row: usize,
    pub columns: Vec<usize>,
    /// The first visible card of each row.
    pub offsets: Vec<usize>,
}

impl Default for ShelvesNav {
    fn default() -> Self {
        Self::new()
    }
}

impl ShelvesNav {
    pub fn new() -> Self {
        Self {
            content: Load::NotLoaded,
            row: 0,
            columns: Vec::new(),
            offsets: Vec::new(),
        }
    }

    pub fn set(&mut self, content: Load<Vec<Shelf>>) {
        let rows = content.loaded().map_or(0, Vec::len);
        self.content = content;
        self.row = self.row.min(rows.saturating_sub(1));
        self.columns.resize(rows, 0);
        self.offsets.resize(rows, 0);
        if let Some(shelves) = self.content.loaded() {
            for (index, shelf) in shelves.iter().enumerate() {
                let last = shelf.cards.len().saturating_sub(1);
                self.columns[index] = self.columns[index].min(last);
                self.offsets[index] = self.offsets[index].min(self.columns[index]);
            }
        }
    }

    fn shelves(&self) -> &[Shelf] {
        self.content.loaded().map_or(&[], Vec::as_slice)
    }

    pub fn selected(&self) -> Option<(usize, usize)> {
        let shelf = self.shelves().get(self.row)?;
        let column = *self.columns.get(self.row)?;
        (column < shelf.cards.len()).then_some((self.row, column))
    }

    pub fn selected_card(&self) -> Option<&Card> {
        let (row, column) = self.selected()?;
        self.shelves().get(row)?.cards.get(column)
    }

    /// Move within the rows. Returns false at an edge, so the caller can
    /// move focus elsewhere.
    fn step(&mut self, key: Key, visible: usize) -> bool {
        let rows = self.shelves().len();
        if rows == 0 {
            return false;
        }
        match key {
            Key::Up if self.row > 0 => self.row -= 1,
            Key::Down if self.row + 1 < rows => self.row += 1,
            Key::Left if self.columns[self.row] > 0 => self.columns[self.row] -= 1,
            Key::Right if self.columns[self.row] + 1 < self.shelves()[self.row].cards.len() => {
                self.columns[self.row] += 1;
            }
            _ => return false,
        }
        let column = self.columns[self.row];
        let count = self.shelves()[self.row].cards.len();
        let offset = &mut self.offsets[self.row];
        *offset = keep_visible(*offset, column, visible, count);
        true
    }

    /// The songs on the selected row, and where the selected card is among them.
    fn row_songs(&self) -> (Vec<QueueTrack>, usize) {
        let Some((row, column)) = self.selected() else {
            return (Vec::new(), 0);
        };
        let cards = &self.shelves()[row].cards;
        let start = cards[..column]
            .iter()
            .filter(|card| card.track.is_some())
            .count();
        let tracks = cards.iter().filter_map(|card| card.track.clone()).collect();
        (tracks, start)
    }
}

/// Keep `selected` visible in a window of `visible` items starting at `first`,
/// with one item of context on either side when there is room.
pub fn keep_visible(first: usize, selected: usize, visible: usize, count: usize) -> usize {
    let visible = visible.max(1);
    let max_first = count.saturating_sub(visible);
    let mut first = first;
    if selected < first + 1 {
        first = selected.saturating_sub(1);
    } else if selected + 2 > first + visible {
        first = (selected + 2).saturating_sub(visible);
    }
    first.min(max_first)
}

/// One line of a collection page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowRef {
    Track(usize),
    Header(usize),
    Card(usize, usize),
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollectionNav {
    pub kind: CollectionKind,
    pub id: String,
    pub content: Load<Collection>,
    pub in_list: bool,
    pub button: usize,
    pub row: usize,
    pub top: usize,
}

/// The buttons beside a collection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollectionButton {
    Play,
    Shuffle,
    Queue,
}

pub const COLLECTION_BUTTONS: [CollectionButton; 3] = [
    CollectionButton::Play,
    CollectionButton::Shuffle,
    CollectionButton::Queue,
];

impl CollectionNav {
    fn new(kind: CollectionKind, id: String) -> Self {
        Self {
            kind,
            id,
            content: Load::Loading,
            in_list: false,
            button: 0,
            row: 0,
            top: 0,
        }
    }

    pub fn rows(&self) -> Vec<RowRef> {
        let Some(collection) = self.content.loaded() else {
            return Vec::new();
        };
        let mut rows: Vec<RowRef> = (0..collection.tracks.len()).map(RowRef::Track).collect();
        for (shelf_index, shelf) in collection.shelves.iter().enumerate() {
            if shelf.cards.is_empty() {
                continue;
            }
            rows.push(RowRef::Header(shelf_index));
            rows.extend((0..shelf.cards.len()).map(|card| RowRef::Card(shelf_index, card)));
        }
        rows
    }

    fn first_selectable(&self) -> usize {
        self.rows()
            .iter()
            .position(|row| !matches!(row, RowRef::Header(_)))
            .unwrap_or(0)
    }

    fn tracks(&self) -> Vec<QueueTrack> {
        self.content
            .loaded()
            .map(|collection| collection.tracks.clone())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BrowseNav {
    pub shelves: ShelvesNav,
    pub stack: Vec<CollectionNav>,
}

impl BrowseNav {
    fn new() -> Self {
        Self {
            shelves: ShelvesNav::new(),
            stack: Vec::new(),
        }
    }
}

/// The on-screen keyboard: 26 letters and 10 digits in six columns, then
/// Space, Delete, and Clear, each two columns wide.
pub const KEYBOARD: &str = "abcdefghijklmnopqrstuvwxyz1234567890";
pub const KEY_COLUMNS: usize = 6;
pub const WIDE_KEYS: [&str; 3] = ["Space", "Delete", "Clear"];

#[derive(Debug, Clone, PartialEq)]
pub struct SearchNav {
    pub query: String,
    /// Index into the keyboard: 0..36 letters and digits, 36..39 wide keys.
    pub key: usize,
    pub in_results: bool,
    pub browse: BrowseNav,
    /// The query the shown results are for.
    pub results_for: String,
}

impl SearchNav {
    fn new() -> Self {
        Self {
            query: String::new(),
            key: 0,
            in_results: false,
            browse: BrowseNav::new(),
            results_for: String::new(),
        }
    }

    fn key_count() -> usize {
        KEYBOARD.len() + WIDE_KEYS.len()
    }

    fn move_key(&mut self, key: Key) -> bool {
        let letters = KEYBOARD.len();
        let rows = letters / KEY_COLUMNS;
        if self.key >= letters {
            let wide = self.key - letters;
            match key {
                Key::Left if wide > 0 => self.key -= 1,
                Key::Right if wide + 1 < WIDE_KEYS.len() => self.key += 1,
                Key::Up => self.key = (rows - 1) * KEY_COLUMNS + wide * 2,
                _ => return false,
            }
            return true;
        }
        let (row, column) = (self.key / KEY_COLUMNS, self.key % KEY_COLUMNS);
        match key {
            Key::Left if column > 0 => self.key -= 1,
            Key::Right if column + 1 < KEY_COLUMNS => self.key += 1,
            Key::Up if row > 0 => self.key -= KEY_COLUMNS,
            Key::Down if row + 1 < rows => self.key += KEY_COLUMNS,
            Key::Down => self.key = letters + column / 2,
            _ => return false,
        }
        true
    }

    /// Press the selected key. Returns whether the query changed.
    fn press(&mut self) -> bool {
        let letters = KEYBOARD.len();
        let before = self.query.clone();
        match self.key {
            index if index < letters => self.query.push(KEYBOARD.as_bytes()[index] as char),
            index if index == letters => {
                if !self.query.is_empty() && !self.query.ends_with(' ') {
                    self.query.push(' ');
                }
            }
            index if index == letters + 1 => {
                self.query.pop();
            }
            _ => self.query.clear(),
        }
        self.query != before
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Tabs,
    Content,
}

/// How many cards fit across a row, and list rows down a page, on each
/// page. They match the sizes in `ui/app.slint` on a 16:9 screen.
pub const HOME_CARDS_VISIBLE: usize = 7;
pub const SEARCH_CARDS_VISIBLE: usize = 5;
pub const COLLECTION_ROWS_VISIBLE: usize = 10;
pub const QUEUE_ROWS_VISIBLE: usize = 8;

const BACK_TO_LEAVE: Duration = Duration::from_millis(2500);
const NOTICE_DURATION: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq)]
pub struct Nav {
    pub tab: Tab,
    pub focus: Focus,
    pub control: usize,
    pub idle_button: usize,
    pub panel: Panel,
    pub queue_row: usize,
    pub queue_top: usize,
    pub home: BrowseNav,
    pub library: BrowseNav,
    pub search: SearchNav,
    pub menu: Option<Menu>,
    pub session: View,
    /// Whether the current song is in Liked songs, once known.
    pub liked: Option<(String, bool)>,
    /// Lyrics for the song with this videoId.
    pub lyrics: Option<(String, Load<Option<String>>)>,
    notice: Option<(String, Instant)>,
    back_pressed: Option<Instant>,
    /// The entry the queue panel last followed, to keep it on the current song.
    queue_followed: Option<String>,
    /// No session state has arrived yet.
    first_session: bool,
}

impl Default for Nav {
    fn default() -> Self {
        Self::new()
    }
}

impl Nav {
    pub fn new() -> Self {
        Self {
            tab: Tab::Home,
            focus: Focus::Content,
            control: 1,
            idle_button: 0,
            panel: Panel::None,
            queue_row: 0,
            queue_top: 0,
            home: BrowseNav::new(),
            library: BrowseNav::new(),
            search: SearchNav::new(),
            menu: None,
            session: View::default(),
            liked: None,
            lyrics: None,
            notice: None,
            back_pressed: None,
            queue_followed: None,
            first_session: true,
        }
    }

    /// Effects to run when the app starts.
    pub fn start(&mut self) -> Vec<Effect> {
        self.home.shelves.content = Load::Loading;
        vec![Effect::LoadHome]
    }

    pub fn notice(&self, now: Instant) -> Option<&str> {
        self.notice
            .as_ref()
            .filter(|(_, at)| now.duration_since(*at) < NOTICE_DURATION)
            .map(|(text, _)| text.as_str())
    }

    fn say(&mut self, text: impl Into<String>, now: Instant) {
        self.notice = Some((text.into(), now));
    }

    /// The browse state of a tab with pages, if it has one.
    fn browse_mut(&mut self, tab: Tab) -> Option<&mut BrowseNav> {
        match tab {
            Tab::Home => Some(&mut self.home),
            Tab::Library => Some(&mut self.library),
            Tab::Search => Some(&mut self.search.browse),
            Tab::NowPlaying => None,
        }
    }

    pub fn browse(&self, tab: Tab) -> Option<&BrowseNav> {
        match tab {
            Tab::Home => Some(&self.home),
            Tab::Library => Some(&self.library),
            Tab::Search => Some(&self.search.browse),
            Tab::NowPlaying => None,
        }
    }

    /// The open collection on the current tab.
    pub fn collection(&self) -> Option<&CollectionNav> {
        self.browse(self.tab)?.stack.last()
    }

    fn collection_mut(&mut self) -> Option<&mut CollectionNav> {
        let tab = self.tab;
        self.browse_mut(tab)?.stack.last_mut()
    }

    // SESSION

    /// A new view of the session from the controller.
    pub fn on_session(&mut self, view: View) -> Vec<Effect> {
        let before = self
            .session
            .current_entry()
            .map(|entry| entry.track.video_id.clone());
        let was_idle = self.session.is_idle();
        self.session = view;
        let mut effects = Vec::new();
        let current = self
            .session
            .current_entry()
            .map(|entry| entry.track.video_id.clone());
        if current != before {
            self.liked = None;
            if let Some(video_id) = &current {
                effects.push(Effect::LoadLiked(video_id.clone()));
                if self.panel == Panel::Lyrics {
                    effects.extend(self.request_lyrics());
                }
            }
        }
        // Opened with music already going (or woken to play): show it.
        if self.first_session && self.session.connected {
            self.first_session = false;
            if !self.session.is_idle() {
                self.tab = Tab::NowPlaying;
                self.focus = Focus::Content;
            }
        }
        if was_idle && !self.session.is_idle() && self.tab == Tab::NowPlaying {
            self.control = 1;
        }
        if self.session.is_idle() && self.panel != Panel::None {
            self.panel = Panel::None;
        }
        self.follow_queue();
        self.clamp_queue();
        effects
    }

    fn follow_queue(&mut self) {
        let current = self
            .session
            .current_entry()
            .map(|entry| entry.entry_id.clone());
        if current != self.queue_followed {
            if let Some(index) = self.session.current {
                self.queue_row = index;
                self.queue_top = keep_visible(
                    self.queue_top,
                    index,
                    QUEUE_ROWS_VISIBLE,
                    self.session.queue.len(),
                );
            }
            self.queue_followed = current;
        }
    }

    fn clamp_queue(&mut self) {
        let count = self.session.queue.len();
        self.queue_row = self.queue_row.min(count.saturating_sub(1));
        self.queue_top = keep_visible(self.queue_top, self.queue_row, QUEUE_ROWS_VISIBLE, count);
    }

    /// Nobody has touched the remote for a while and music is playing: go
    /// back to the now-playing screen, the way a TV app rests.
    pub fn rest(&mut self) {
        if self.session.playing && self.tab != Tab::NowPlaying && self.menu.is_none() {
            self.tab = Tab::NowPlaying;
            self.focus = Focus::Content;
            self.panel = Panel::None;
            self.control = 1;
        }
    }

    // CATALOG RESULTS

    pub fn on_home(&mut self, result: Result<Vec<Shelf>, String>) {
        self.home.shelves.set(to_load(result));
    }

    pub fn on_library(&mut self, result: Result<Vec<Shelf>, String>) {
        self.library.shelves.set(to_load(result));
    }

    pub fn on_search(&mut self, query: &str, result: Result<Vec<Shelf>, String>) {
        if query != self.search.query.trim() {
            return;
        }
        self.search.results_for = query.to_owned();
        let shelves = &mut self.search.browse.shelves;
        shelves.row = 0;
        shelves.columns.clear();
        shelves.offsets.clear();
        shelves.set(match to_load(result) {
            Load::Loaded(found) if found.is_empty() => {
                Load::Failed(format!("Nothing found for “{query}”"))
            }
            other => other,
        });
    }

    pub fn on_collection(
        &mut self,
        tab: Tab,
        kind: CollectionKind,
        id: &str,
        result: Result<Collection, String>,
    ) {
        let Some(browse) = self.browse_mut(tab) else {
            return;
        };
        for page in browse.stack.iter_mut() {
            if page.kind == kind && page.id == id && page.content == Load::Loading {
                page.content = to_load(result.clone());
                page.row = page.first_selectable();
                page.in_list = false;
                if page
                    .content
                    .loaded()
                    .is_some_and(|collection| collection.tracks.is_empty())
                {
                    page.in_list = true;
                }
            }
        }
    }

    pub fn on_lyrics(&mut self, video_id: &str, result: Result<Option<String>, String>) {
        if let Some((current, load)) = &mut self.lyrics
            && current == video_id
        {
            *load = to_load(result);
        }
    }

    pub fn on_liked(&mut self, video_id: &str, liked: bool) {
        if self
            .session
            .current_entry()
            .is_some_and(|entry| entry.track.video_id == video_id)
        {
            self.liked = Some((video_id.to_owned(), liked));
        }
    }

    /// The server could not play a collection the menu asked for.
    pub fn on_failure(&mut self, message: &str, now: Instant) {
        self.say(message.to_owned(), now);
    }

    /// The updater needs permission to install: ask once.
    pub fn ask_update_permission(&mut self) {
        self.menu = Some(Menu {
            title: "Let Music update itself?".into(),
            subtitle: "Turn on “Install unknown apps” for Music once. After that, updates install by themselves while nothing is playing.".into(),
            items: vec![MenuAction::OpenUpdateSettings, MenuAction::Close],
            selected: 0,
        });
    }

    // KEYS

    /// Handle one key. Returns whether the app used it (an unused Back leaves
    /// the app) and what the caller should do.
    pub fn key(&mut self, key: Key, now: Instant) -> (bool, Vec<Effect>) {
        let mut effects = Vec::new();
        if key != Key::Back {
            self.back_pressed = None;
        }
        if self.menu.is_some() {
            self.menu_key(key, now, &mut effects);
            return (true, effects);
        }
        if let Key::Char(_) | Key::Backspace = key {
            return (self.typed(key, &mut effects), effects);
        }
        let used = match self.focus {
            Focus::Tabs => self.tabs_key(key, now, &mut effects),
            Focus::Content => match self.tab {
                Tab::NowPlaying => self.player_key(key, now, &mut effects),
                Tab::Home | Tab::Library | Tab::Search if self.collection().is_some() => {
                    self.collection_key(key, now, &mut effects)
                }
                Tab::Home | Tab::Library => self.shelves_key(key, now, &mut effects),
                Tab::Search => self.search_key(key, now, &mut effects),
            },
        };
        (used, effects)
    }

    /// Back where nothing else uses it: the second press leaves the app.
    fn back_to_leave(&mut self, now: Instant) -> bool {
        match self.back_pressed {
            Some(at) if now.duration_since(at) < BACK_TO_LEAVE => {
                self.back_pressed = None;
                false
            }
            _ => {
                self.back_pressed = Some(now);
                self.say("Press Back again to leave Music", now);
                true
            }
        }
    }

    pub fn switch_tab(&mut self, tab: Tab, effects: &mut Vec<Effect>) {
        self.tab = tab;
        match tab {
            Tab::Home if self.home.shelves.content == Load::NotLoaded => {
                self.home.shelves.content = Load::Loading;
                effects.push(Effect::LoadHome);
            }
            Tab::Library => {
                // Playlists change on the phone, so reload every visit.
                if self.library.shelves.content == Load::NotLoaded {
                    self.library.shelves.content = Load::Loading;
                }
                effects.push(Effect::LoadLibrary);
            }
            _ => {}
        }
    }

    fn tabs_key(&mut self, key: Key, now: Instant, effects: &mut Vec<Effect>) -> bool {
        let index = self.tab.index();
        match key {
            Key::Left if index > 0 => self.switch_tab(Tab::ALL[index - 1], effects),
            Key::Right if index + 1 < Tab::ALL.len() => {
                self.switch_tab(Tab::ALL[index + 1], effects);
            }
            Key::Down | Key::Ok => self.focus = Focus::Content,
            Key::Back if self.tab != Tab::NowPlaying && !self.session.is_idle() => {
                self.switch_tab(Tab::NowPlaying, effects);
            }
            Key::Back => return self.back_to_leave(now),
            _ => {}
        }
        true
    }

    // NOW PLAYING

    fn player_key(&mut self, key: Key, now: Instant, effects: &mut Vec<Effect>) -> bool {
        if self.session.is_idle() {
            return self.idle_key(key, now, effects);
        }
        match self.panel {
            Panel::Queue => return self.queue_key(key, effects),
            Panel::Lyrics => {
                if matches!(key, Key::Back | Key::Ok | Key::Left) {
                    self.panel = Panel::None;
                }
                return true;
            }
            Panel::None => {}
        }
        match key {
            Key::Left => self.control = self.control.saturating_sub(1),
            Key::Right => self.control = (self.control + 1).min(CONTROLS.len() - 1),
            Key::Up => self.focus = Focus::Tabs,
            Key::Down => {}
            Key::Ok => self.press_control(now, effects),
            Key::Hold => {
                if let Some(entry) = self.session.current_entry() {
                    self.menu = Some(Menu {
                        title: entry.track.title.clone(),
                        subtitle: entry.track.artists.clone(),
                        items: vec![MenuAction::Like(entry.track.clone()), MenuAction::Close],
                        selected: 0,
                    });
                }
            }
            Key::Back => return self.back_to_leave(now),
            _ => {}
        }
        true
    }

    fn press_control(&mut self, now: Instant, effects: &mut Vec<Effect>) {
        match CONTROLS[self.control] {
            Control::Previous => effects.push(Effect::Session(UiAction::Previous)),
            Control::Next => effects.push(Effect::Session(UiAction::Next)),
            Control::PlayPause => effects.push(Effect::Session(UiAction::PlayPause)),
            Control::Like => {
                let Some(entry) = self.session.current_entry() else {
                    return;
                };
                let video_id = entry.track.video_id.clone();
                let liked = self
                    .liked
                    .as_ref()
                    .is_some_and(|(id, liked)| *id == video_id && *liked);
                effects.push(Effect::SetLiked {
                    track: entry.track.clone(),
                    liked: !liked,
                });
                self.liked = Some((video_id, !liked));
                self.say(
                    if liked {
                        "Removed from Liked songs"
                    } else {
                        "Added to Liked songs"
                    },
                    now,
                );
            }
            Control::Queue => {
                self.panel = Panel::Queue;
                self.queue_followed = None;
                self.follow_queue();
            }
            Control::Lyrics => {
                self.panel = Panel::Lyrics;
                effects.extend(self.request_lyrics());
            }
        }
    }

    fn request_lyrics(&mut self) -> Vec<Effect> {
        let Some(entry) = self.session.current_entry() else {
            return Vec::new();
        };
        let video_id = entry.track.video_id.clone();
        if self
            .lyrics
            .as_ref()
            .is_some_and(|(id, load)| *id == video_id && !matches!(load, Load::Failed(_)))
        {
            return Vec::new();
        }
        self.lyrics = Some((video_id.clone(), Load::Loading));
        vec![Effect::LoadLyrics(video_id)]
    }

    fn queue_key(&mut self, key: Key, effects: &mut Vec<Effect>) -> bool {
        let count = self.session.queue.len();
        match key {
            Key::Up => self.queue_row = self.queue_row.saturating_sub(1),
            Key::Down => self.queue_row = (self.queue_row + 1).min(count.saturating_sub(1)),
            Key::Back | Key::Left => self.panel = Panel::None,
            Key::Ok => {
                if let Some(entry) = self.session.queue.get(self.queue_row) {
                    effects.push(Effect::Session(UiAction::SkipTo(entry.entry_id.clone())));
                }
            }
            Key::Hold => {
                if let Some(entry) = self.session.queue.get(self.queue_row) {
                    let mut items = vec![
                        MenuAction::PlayEntry(entry.entry_id.clone()),
                        MenuAction::Like(entry.track.clone()),
                    ];
                    if Some(self.queue_row) != self.session.current {
                        items.push(MenuAction::RemoveEntry(entry.entry_id.clone()));
                    }
                    items.push(MenuAction::Close);
                    self.menu = Some(Menu {
                        title: entry.track.title.clone(),
                        subtitle: entry.track.artists.clone(),
                        items,
                        selected: 0,
                    });
                }
            }
            _ => {}
        }
        self.queue_top = keep_visible(self.queue_top, self.queue_row, QUEUE_ROWS_VISIBLE, count);
        true
    }

    fn idle_key(&mut self, key: Key, now: Instant, effects: &mut Vec<Effect>) -> bool {
        match key {
            Key::Left => self.idle_button = self.idle_button.saturating_sub(1),
            Key::Right => self.idle_button = (self.idle_button + 1).min(IDLE_BUTTONS.len() - 1),
            Key::Up => self.focus = Focus::Tabs,
            Key::Ok => match IDLE_BUTTONS[self.idle_button] {
                IdleButton::Browse => self.switch_tab(Tab::Home, effects),
                IdleButton::Search => self.switch_tab(Tab::Search, effects),
            },
            Key::Back => return self.back_to_leave(now),
            _ => {}
        }
        true
    }

    // SHELVES

    fn shelves_key(&mut self, key: Key, now: Instant, effects: &mut Vec<Effect>) -> bool {
        let tab = self.tab;
        let Some(browse) = self.browse_mut(tab) else {
            return false;
        };
        match key {
            Key::Up | Key::Down | Key::Left | Key::Right => {
                if !browse.shelves.step(key, HOME_CARDS_VISIBLE) && key == Key::Up {
                    self.focus = Focus::Tabs;
                }
            }
            Key::Ok => {
                let card = browse.shelves.selected_card().cloned();
                let songs = browse.shelves.row_songs();
                if let Some(card) = card {
                    self.open_card(&card, songs, now, effects);
                }
            }
            Key::Hold => {
                if let Some(card) = browse.shelves.selected_card().cloned() {
                    self.card_menu(&card);
                }
            }
            Key::Back => self.focus = Focus::Tabs,
            _ => {}
        }
        true
    }

    /// OK on a card: a song plays its row from there; anything else opens.
    fn open_card(
        &mut self,
        card: &Card,
        (tracks, start): (Vec<QueueTrack>, usize),
        now: Instant,
        effects: &mut Vec<Effect>,
    ) {
        if card.track.is_some() {
            effects.push(Effect::Session(UiAction::PlayTracks { tracks, start }));
            self.say(format!("Playing “{}”", card.title), now);
            return;
        }
        if let Some(kind) = CollectionKind::from_card(card.kind) {
            self.open_collection(kind, card.id.clone(), effects);
        }
    }

    fn open_collection(&mut self, kind: CollectionKind, id: String, effects: &mut Vec<Effect>) {
        let tab = self.tab;
        let Some(browse) = self.browse_mut(tab) else {
            return;
        };
        browse.stack.push(CollectionNav::new(kind, id.clone()));
        effects.push(Effect::LoadCollection { tab, kind, id });
    }

    fn card_menu(&mut self, card: &Card) {
        let target = match (&card.track, CollectionKind::from_card(card.kind)) {
            (Some(track), _) => Target::Tracks(vec![track.clone()]),
            (None, Some(kind)) => Target::Collection(kind, card.id.clone()),
            (None, None) => return,
        };
        let mut items = vec![
            MenuAction::Play(target.clone()),
            MenuAction::PlayNext(target.clone()),
            MenuAction::AddToQueue(target.clone()),
        ];
        match (&card.track, CollectionKind::from_card(card.kind)) {
            (Some(track), _) => items.push(MenuAction::Like(track.clone())),
            (None, Some(kind)) => {
                items.insert(1, MenuAction::Shuffle(target));
                items.push(MenuAction::Open(kind, card.id.clone()));
            }
            _ => {}
        }
        items.push(MenuAction::Close);
        self.menu = Some(Menu {
            title: card.title.clone(),
            subtitle: card.subtitle.clone(),
            items,
            selected: 0,
        });
    }

    // SEARCH

    fn search_key(&mut self, key: Key, now: Instant, effects: &mut Vec<Effect>) -> bool {
        if self.search.in_results {
            let shelves = &mut self.search.browse.shelves;
            match key {
                Key::Up | Key::Down | Key::Left | Key::Right => {
                    if !shelves.step(key, SEARCH_CARDS_VISIBLE) {
                        match key {
                            Key::Left => self.search.in_results = false,
                            Key::Up => self.focus = Focus::Tabs,
                            _ => {}
                        }
                    }
                }
                Key::Ok => {
                    let card = shelves.selected_card().cloned();
                    let songs = shelves.row_songs();
                    if let Some(card) = card {
                        self.open_card(&card, songs, now, effects);
                    }
                }
                Key::Hold => {
                    if let Some(card) = shelves.selected_card().cloned() {
                        self.card_menu(&card);
                    }
                }
                Key::Back => self.search.in_results = false,
                _ => {}
            }
            return true;
        }
        match key {
            Key::Up | Key::Down | Key::Left | Key::Right => {
                let at_right_edge = key == Key::Right
                    && (self.search.key % KEY_COLUMNS == KEY_COLUMNS - 1
                        || self.search.key == SearchNav::key_count() - 1);
                if at_right_edge {
                    if self.search.browse.shelves.selected().is_some() {
                        self.search.in_results = true;
                    }
                } else if !self.search.move_key(key) && key == Key::Up {
                    self.focus = Focus::Tabs;
                }
            }
            Key::Ok => {
                if self.search.press() {
                    effects.extend(self.query_changed());
                }
            }
            Key::Back => self.focus = Focus::Tabs,
            _ => {}
        }
        true
    }

    fn query_changed(&mut self) -> Vec<Effect> {
        let query = self.search.query.trim().to_owned();
        let shelves = &mut self.search.browse.shelves;
        if query.is_empty() {
            shelves.set(Load::NotLoaded);
            self.search.results_for.clear();
            return Vec::new();
        }
        if shelves.content == Load::NotLoaded || matches!(shelves.content, Load::Failed(_)) {
            shelves.content = Load::Loading;
        }
        vec![Effect::Search(query)]
    }

    /// Typing on a real keyboard goes to search.
    fn typed(&mut self, key: Key, effects: &mut Vec<Effect>) -> bool {
        if self.tab != Tab::Search || self.collection().is_some() {
            return false;
        }
        match key {
            Key::Char(character) => self.search.query.push(character.to_ascii_lowercase()),
            Key::Backspace => {
                self.search.query.pop();
            }
            _ => return false,
        }
        self.focus = Focus::Content;
        self.search.in_results = false;
        effects.extend(self.query_changed());
        true
    }

    // COLLECTION

    fn collection_key(&mut self, key: Key, now: Instant, effects: &mut Vec<Effect>) -> bool {
        if key == Key::Back {
            let tab = self.tab;
            if let Some(browse) = self.browse_mut(tab) {
                browse.stack.pop();
            }
            return true;
        }
        let Some(page) = self.collection_mut() else {
            return false;
        };
        let rows = page.rows();
        if !page.in_list {
            match key {
                Key::Left => page.button = page.button.saturating_sub(1),
                Key::Right if page.button + 1 < COLLECTION_BUTTONS.len() => page.button += 1,
                Key::Right | Key::Down if !rows.is_empty() => page.in_list = true,
                Key::Up => self.focus = Focus::Tabs,
                Key::Ok => {
                    let tracks = page.tracks();
                    let button = COLLECTION_BUTTONS[page.button];
                    self.play_tracks(tracks, button, now, effects);
                }
                _ => {}
            }
            return true;
        }
        match key {
            Key::Up | Key::Down => {
                let mut row = page.row;
                loop {
                    let next = if key == Key::Up {
                        row.checked_sub(1)
                    } else {
                        Some(row + 1)
                    };
                    match next {
                        Some(next) if next < rows.len() => {
                            row = next;
                            if !matches!(rows[row], RowRef::Header(_)) {
                                page.row = row;
                                break;
                            }
                        }
                        _ => {
                            if key == Key::Up {
                                self.focus = Focus::Tabs;
                            }
                            break;
                        }
                    }
                }
            }
            Key::Left => page.in_list = false,
            Key::Ok | Key::Hold => {
                let Some(collection) = page.content.loaded().cloned() else {
                    return true;
                };
                match rows.get(page.row).copied() {
                    Some(RowRef::Track(index)) if key == Key::Ok => {
                        effects.push(Effect::Session(UiAction::PlayTracks {
                            tracks: collection.tracks.clone(),
                            start: index,
                        }));
                        if let Some(track) = collection.tracks.get(index) {
                            self.say(format!("Playing “{}”", track.title), now);
                        }
                    }
                    Some(RowRef::Track(index)) => {
                        if let Some(track) = collection.tracks.get(index) {
                            let target = Target::Tracks(vec![track.clone()]);
                            self.menu = Some(Menu {
                                title: track.title.clone(),
                                subtitle: track.artists.clone(),
                                items: vec![
                                    MenuAction::Play(target.clone()),
                                    MenuAction::PlayNext(target.clone()),
                                    MenuAction::AddToQueue(target),
                                    MenuAction::Like(track.clone()),
                                    MenuAction::Close,
                                ],
                                selected: 0,
                            });
                        }
                    }
                    Some(RowRef::Card(shelf, card)) => {
                        if let Some(card) = collection
                            .shelves
                            .get(shelf)
                            .and_then(|shelf| shelf.cards.get(card))
                            .cloned()
                        {
                            if key == Key::Ok {
                                let songs = (card.track.clone().into_iter().collect(), 0);
                                self.open_card(&card, songs, now, effects);
                            } else {
                                self.card_menu(&card);
                            }
                        }
                    }
                    _ => {}
                }
                return true;
            }
            _ => {}
        }
        if let Some(page) = self.collection_mut() {
            let count = page.rows().len();
            page.top = keep_visible(page.top, page.row, COLLECTION_ROWS_VISIBLE, count);
        }
        true
    }

    fn play_tracks(
        &mut self,
        tracks: Vec<QueueTrack>,
        button: CollectionButton,
        now: Instant,
        effects: &mut Vec<Effect>,
    ) {
        if tracks.is_empty() {
            return;
        }
        match button {
            CollectionButton::Play => {
                effects.push(Effect::Session(UiAction::PlayTracks { tracks, start: 0 }));
            }
            CollectionButton::Shuffle => {
                effects.push(Effect::Session(UiAction::PlayTracks {
                    tracks: shuffled(tracks, now),
                    start: 0,
                }));
            }
            CollectionButton::Queue => {
                let count = tracks.len();
                effects.push(Effect::Session(UiAction::Enqueue {
                    tracks,
                    placement: Placement::Last,
                }));
                self.say(
                    if count == 1 {
                        "Added 1 song to the queue".to_owned()
                    } else {
                        format!("Added {count} songs to the queue")
                    },
                    now,
                );
            }
        }
    }

    // MENU

    fn menu_key(&mut self, key: Key, now: Instant, effects: &mut Vec<Effect>) {
        let Some(menu) = &mut self.menu else { return };
        match key {
            Key::Up => menu.selected = menu.selected.saturating_sub(1),
            Key::Down => menu.selected = (menu.selected + 1).min(menu.items.len() - 1),
            Key::Back | Key::Left => self.menu = None,
            Key::Ok => {
                let action = menu.items[menu.selected].clone();
                self.menu = None;
                self.run_menu(action, now, effects);
            }
            _ => {}
        }
    }

    fn run_menu(&mut self, action: MenuAction, now: Instant, effects: &mut Vec<Effect>) {
        let play = |target: Target, mode: PlayMode, effects: &mut Vec<Effect>| match target {
            Target::Tracks(tracks) => effects.push(Effect::Session(match mode {
                PlayMode::Play => UiAction::PlayTracks { tracks, start: 0 },
                PlayMode::Shuffle => UiAction::PlayTracks {
                    tracks: shuffled(tracks, now),
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
            })),
            Target::Collection(kind, id) => effects.push(Effect::PlayCollection { kind, id, mode }),
        };
        match action {
            MenuAction::Play(target) => play(target, PlayMode::Play, effects),
            MenuAction::Shuffle(target) => play(target, PlayMode::Shuffle, effects),
            MenuAction::PlayNext(target) => {
                play(target, PlayMode::Next, effects);
                self.say("Playing next", now);
            }
            MenuAction::AddToQueue(target) => {
                play(target, PlayMode::Last, effects);
                self.say("Added to the queue", now);
            }
            MenuAction::Open(kind, id) => self.open_collection(kind, id, effects),
            MenuAction::Like(track) => {
                if self
                    .session
                    .current_entry()
                    .is_some_and(|entry| entry.track.video_id == track.video_id)
                {
                    self.liked = Some((track.video_id.clone(), true));
                }
                effects.push(Effect::SetLiked { track, liked: true });
                self.say("Added to Liked songs", now);
            }
            MenuAction::PlayEntry(entry_id) => {
                effects.push(Effect::Session(UiAction::SkipTo(entry_id)));
            }
            MenuAction::RemoveEntry(entry_id) => {
                effects.push(Effect::Session(UiAction::Remove(entry_id)));
                self.say("Removed from the queue", now);
            }
            MenuAction::OpenUpdateSettings => effects.push(Effect::OpenUpdateSettings),
            MenuAction::Close => {}
        }
    }
}

fn to_load<T>(result: Result<T, String>) -> Load<T> {
    match result {
        Ok(value) => Load::Loaded(value),
        Err(message) => Load::Failed(message),
    }
}

/// A shuffle good enough for a playlist: Fisher-Yates with xorshift,
/// seeded from the clock.
pub fn shuffled<T>(mut items: Vec<T>, now: Instant) -> Vec<T> {
    let mut seed = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos() as u64)
        ^ (now.elapsed().as_nanos() as u64))
        | 1;
    for index in (1..items.len()).rev() {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        items.swap(index, (seed % (index as u64 + 1)) as usize);
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::CardKind;
    use crate::protocol::QueueEntry;

    fn track(id: &str) -> QueueTrack {
        QueueTrack {
            video_id: id.into(),
            title: format!("Song {id}"),
            artists: "Artist".into(),
            album: None,
            duration_seconds: Some(200.0),
            artwork_url: None,
        }
    }

    fn song_card(id: &str) -> Card {
        Card {
            kind: CardKind::Song,
            id: id.into(),
            title: format!("Song {id}"),
            subtitle: "Artist".into(),
            artwork_url: None,
            track: Some(track(id)),
        }
    }

    fn album_card(id: &str) -> Card {
        Card {
            kind: CardKind::Album,
            id: id.into(),
            title: format!("Album {id}"),
            subtitle: "Album".into(),
            artwork_url: None,
            track: None,
        }
    }

    fn shelves() -> Vec<Shelf> {
        vec![
            Shelf {
                title: "Quick picks".into(),
                cards: (0..10)
                    .map(|index| song_card(&format!("s{index}")))
                    .collect(),
            },
            Shelf {
                title: "Albums".into(),
                cards: vec![album_card("a0"), album_card("a1")],
            },
        ]
    }

    fn playing_view() -> View {
        View {
            connected: true,
            queue: (0..12)
                .map(|index| QueueEntry {
                    entry_id: format!("e{index}"),
                    track: track(&format!("q{index}")),
                })
                .collect(),
            current: Some(0),
            playing: true,
            here: true,
            ..View::default()
        }
    }

    fn press(nav: &mut Nav, keys: &[Key]) -> Vec<Effect> {
        let now = Instant::now();
        keys.iter().flat_map(|key| nav.key(*key, now).1).collect()
    }

    #[test]
    fn keeps_the_selection_in_view() {
        assert_eq!(keep_visible(0, 0, 7, 10), 0);
        assert_eq!(keep_visible(0, 5, 7, 10), 0);
        assert_eq!(keep_visible(0, 6, 7, 10), 1);
        assert_eq!(keep_visible(3, 3, 7, 10), 2);
        assert_eq!(keep_visible(0, 9, 7, 10), 3);
        assert_eq!(keep_visible(0, 1, 7, 3), 0);
    }

    #[test]
    fn plays_a_song_card_with_the_rest_of_its_row() {
        let mut nav = Nav::new();
        nav.on_home(Ok(shelves()));
        let effects = press(&mut nav, &[Key::Right, Key::Right, Key::Ok]);
        let Effect::Session(UiAction::PlayTracks { tracks, start }) = &effects[0] else {
            panic!("expected PlayTracks, got {effects:?}");
        };
        assert_eq!(tracks.len(), 10);
        assert_eq!(*start, 2);
    }

    #[test]
    fn opens_an_album_and_plays_it_from_a_track() {
        let mut nav = Nav::new();
        nav.on_home(Ok(shelves()));
        let effects = press(&mut nav, &[Key::Down, Key::Right, Key::Ok]);
        assert_eq!(
            effects,
            vec![Effect::LoadCollection {
                tab: Tab::Home,
                kind: CollectionKind::Album,
                id: "a1".into(),
            }]
        );
        nav.on_collection(
            Tab::Home,
            CollectionKind::Album,
            "a1",
            Ok(Collection {
                kind: CollectionKind::Album,
                id: "a1".into(),
                title: "Album a1".into(),
                subtitle: String::new(),
                description: None,
                artwork_url: None,
                tracks: vec![track("t0"), track("t1"), track("t2")],
                shelves: Vec::new(),
            }),
        );
        let effects = press(
            &mut nav,
            &[Key::Right, Key::Right, Key::Right, Key::Down, Key::Ok],
        );
        let Effect::Session(UiAction::PlayTracks { start, .. }) = &effects[0] else {
            panic!("expected PlayTracks, got {effects:?}");
        };
        assert_eq!(*start, 1);
        press(&mut nav, &[Key::Back]);
        assert!(nav.collection().is_none());
    }

    #[test]
    fn up_from_the_first_row_reaches_the_tabs() {
        let mut nav = Nav::new();
        nav.on_home(Ok(shelves()));
        press(&mut nav, &[Key::Up]);
        assert_eq!(nav.focus, Focus::Tabs);
        let effects = press(&mut nav, &[Key::Right]);
        assert_eq!(nav.tab, Tab::Search);
        assert!(effects.is_empty());
        let effects = press(&mut nav, &[Key::Right]);
        assert_eq!(nav.tab, Tab::Library);
        assert_eq!(effects, vec![Effect::LoadLibrary]);
    }

    #[test]
    fn types_a_search_with_the_keyboard() {
        let mut nav = Nav::new();
        nav.tab = Tab::Search;
        // a, then down to "g", then right to "h".
        let effects = press(&mut nav, &[Key::Ok, Key::Down, Key::Right, Key::Ok]);
        assert_eq!(nav.search.query, "ah");
        assert_eq!(effects.last(), Some(&Effect::Search("ah".into())));
        // Down to the wide keys and press Delete.
        let effects = press(
            &mut nav,
            &[
                Key::Down,
                Key::Down,
                Key::Down,
                Key::Down,
                Key::Down,
                Key::Down,
                Key::Right,
                Key::Ok,
            ],
        );
        assert_eq!(nav.search.query, "a");
        assert_eq!(effects, vec![Effect::Search("a".into())]);
        nav.on_search("a", Ok(shelves()));
        press(
            &mut nav,
            &[
                Key::Up,
                Key::Right,
                Key::Right,
                Key::Right,
                Key::Right,
                Key::Right,
            ],
        );
        assert!(nav.search.in_results);
    }

    #[test]
    fn drops_stale_search_results() {
        let mut nav = Nav::new();
        nav.tab = Tab::Search;
        nav.search.query = "abc".into();
        nav.on_search("ab", Ok(shelves()));
        assert_eq!(nav.search.browse.shelves.content, Load::NotLoaded);
    }

    #[test]
    fn drives_the_player_and_the_queue() {
        let mut nav = Nav::new();
        nav.tab = Tab::NowPlaying;
        nav.on_session(playing_view());
        assert_eq!(
            press(&mut nav, &[Key::Ok]),
            vec![Effect::Session(UiAction::PlayPause)]
        );
        assert_eq!(
            press(&mut nav, &[Key::Right, Key::Ok]),
            vec![Effect::Session(UiAction::Next)]
        );
        // Open the queue, go down three, and skip to that song.
        press(&mut nav, &[Key::Right, Key::Right, Key::Ok]);
        assert_eq!(nav.panel, Panel::Queue);
        let effects = press(&mut nav, &[Key::Down, Key::Down, Key::Down, Key::Ok]);
        assert_eq!(
            effects,
            vec![Effect::Session(UiAction::SkipTo("e3".into()))]
        );
        // Hold for the menu, then remove the song.
        press(&mut nav, &[Key::Hold]);
        let menu = nav.menu.clone().unwrap();
        assert_eq!(menu.items[2], MenuAction::RemoveEntry("e3".into()));
        let effects = press(&mut nav, &[Key::Down, Key::Down, Key::Ok]);
        assert_eq!(
            effects,
            vec![Effect::Session(UiAction::Remove("e3".into()))]
        );
        assert!(nav.menu.is_none());
        press(&mut nav, &[Key::Back]);
        assert_eq!(nav.panel, Panel::None);
    }

    #[test]
    fn likes_the_current_song() {
        let mut nav = Nav::new();
        nav.tab = Tab::NowPlaying;
        let effects = nav.on_session(playing_view());
        assert_eq!(effects, vec![Effect::LoadLiked("q0".into())]);
        nav.on_liked("q0", false);
        let effects = press(&mut nav, &[Key::Right, Key::Right, Key::Ok]);
        assert_eq!(
            effects,
            vec![Effect::SetLiked {
                track: track("q0"),
                liked: true,
            }]
        );
        assert_eq!(nav.liked, Some(("q0".into(), true)));
    }

    #[test]
    fn opens_on_now_playing_when_music_is_going() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        assert_eq!(nav.tab, Tab::NowPlaying);
        let mut idle = Nav::new();
        idle.on_session(View {
            connected: true,
            ..View::default()
        });
        assert_eq!(idle.tab, Tab::Home);
        idle.on_session(playing_view());
        assert_eq!(idle.tab, Tab::Home);
        idle.rest();
        assert_eq!(idle.tab, Tab::NowPlaying);
    }

    #[test]
    fn back_twice_leaves() {
        let mut nav = Nav::new();
        nav.tab = Tab::NowPlaying;
        nav.on_session(playing_view());
        let now = Instant::now();
        assert!(nav.key(Key::Back, now).0);
        assert_eq!(nav.notice(now), Some("Press Back again to leave Music"));
        assert!(!nav.key(Key::Back, now + Duration::from_millis(500)).0);
    }

    #[test]
    fn back_from_a_tab_goes_to_now_playing() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        nav.tab = Tab::Home;
        nav.on_home(Ok(shelves()));
        press(&mut nav, &[Key::Back, Key::Back]);
        assert_eq!(nav.tab, Tab::NowPlaying);
    }

    #[test]
    fn menu_on_an_album_card_plays_it_next() {
        let mut nav = Nav::new();
        nav.on_home(Ok(shelves()));
        press(&mut nav, &[Key::Down, Key::Hold]);
        let menu = nav.menu.clone().unwrap();
        assert_eq!(menu.items[2].label(), "Play next");
        let effects = press(&mut nav, &[Key::Down, Key::Down, Key::Ok]);
        assert_eq!(
            effects,
            vec![Effect::PlayCollection {
                kind: CollectionKind::Album,
                id: "a0".into(),
                mode: PlayMode::Next,
            }]
        );
    }

    #[test]
    fn shuffles_every_item_once() {
        let mut items = shuffled((0..50).collect::<Vec<_>>(), Instant::now());
        items.sort_unstable();
        assert_eq!(items, (0..50).collect::<Vec<_>>());
    }
}
