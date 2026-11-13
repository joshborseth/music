//! Where the remote is: which tab, page, and item is selected, and what each
//! key does there. Plain data with no Slint in it, so every move is testable
//! on the host. [`Nav::key`] returns [`Effect`]s for the caller to carry out
//! (session commands, catalog loads); their results come back through the
//! `on_*` methods.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::catalog::{Card, Collection, CollectionKind, SaveKind, Shelf};
use crate::controller::UiAction;
use crate::lyrics::SongLyrics;
use crate::protocol::{Placement, QueueTrack};
use crate::view::{View, clock};

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
    // The remote's media keys. They act on the music from any screen.
    PlayPause,
    Play,
    Pause,
    Stop,
    Next,
    Previous,
    FastForward,
    Rewind,
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
    /// Ask whether an album is saved or an artist followed.
    LoadSaved {
        kind: SaveKind,
        id: String,
    },
    /// Save an album or follow an artist, or undo it.
    SetSaved {
        kind: SaveKind,
        id: String,
        saved: bool,
    },
    /// Keep these recent searches on the TV, latest first.
    SaveSearches(Vec<String>),
    OpenUpdateSettings,
    /// Open the settings menu ([`Nav::show_settings`]), which shows the
    /// version and how updates stand.
    OpenSettings,
    CheckForUpdates,
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
    /// Save an album or follow an artist (`saved: true`), or undo it.
    SetSaved {
        kind: SaveKind,
        id: String,
        title: String,
        saved: bool,
    },
    PlayEntry(String),
    RemoveEntry(String),
    /// Ask before clearing the songs queued after this one.
    AskClearUpcoming,
    ClearUpcoming,
    RemoveSearch(String),
    ClearSearches,
    OpenUpdateSettings,
    CheckForUpdates,
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
            MenuAction::SetSaved { kind, saved, .. } => match (kind, saved) {
                (SaveKind::Album, true) => "Save to library",
                (SaveKind::Album, false) => "Remove from library",
                (SaveKind::Artist, true) => "Follow",
                (SaveKind::Artist, false) => "Unfollow",
            },
            MenuAction::PlayEntry(_) => "Play now",
            MenuAction::RemoveEntry(_) => "Remove from queue",
            MenuAction::AskClearUpcoming => "Clear the queue",
            MenuAction::ClearUpcoming => "Clear",
            MenuAction::RemoveSearch(_) => "Remove from recent searches",
            MenuAction::ClearSearches => "Clear recent searches",
            MenuAction::OpenUpdateSettings => "Open settings",
            MenuAction::CheckForUpdates => "Check for updates",
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
            MenuAction::SetSaved { saved: true, .. } => "add",
            MenuAction::SetSaved { saved: false, .. } => "remove",
            MenuAction::RemoveEntry(_)
            | MenuAction::AskClearUpcoming
            | MenuAction::ClearUpcoming
            | MenuAction::RemoveSearch(_)
            | MenuAction::ClearSearches => "remove",
            MenuAction::OpenUpdateSettings => "settings",
            MenuAction::CheckForUpdates => "update",
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
}

/// The buttons under the progress bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Previous,
    PlayPause,
    Next,
    Like,
    Shuffle,
    Repeat,
    Queue,
    Lyrics,
}

pub const CONTROLS: [Control; 8] = [
    Control::Previous,
    Control::PlayPause,
    Control::Next,
    Control::Like,
    Control::Shuffle,
    Control::Repeat,
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

/// A seek being picked. Left and Right on the seek bar, or fast-forward and
/// rewind, move it; it goes to the session once the keys rest, as one seek,
/// so a run of presses doesn't make the player load the song again and again.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scrub {
    /// Seconds to add to where the song is: what the seek will do.
    pub offset: f64,
    /// The last seek key.
    pub last: Instant,
    /// Since when a seek key has been held down, while it is.
    pub held_since: Option<Instant>,
    pub forward: bool,
}

/// One press of a seek key moves this far.
pub const SEEK_STEP: f64 = 10.0;
/// Holding a seek key moves this many seconds a second, then faster.
const SCRUB_SPEED: f64 = 20.0;
const SCRUB_FAST_SPEED: f64 = 60.0;
const SCRUB_FAST_AFTER: Duration = Duration::from_millis(1500);
/// The seek goes to the session once the keys rest this long.
pub const SCRUB_SETTLE: Duration = Duration::from_millis(700);
/// After a seek, the bar shows where it went until the session catches up.
const SEEK_SHOWN_FOR: Duration = Duration::from_millis(1500);

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

/// Music starts fresh or moves to this TV: a new queue (from this TV or any
/// other device), or playback handed to this TV. Moving to the next song,
/// pausing, or queueing more does not count.
fn music_starts(before: &View, after: &View) -> bool {
    let Some(entry) = after.current_entry() else {
        return false;
    };
    let new_queue = !before
        .queue
        .iter()
        .any(|queued| queued.entry_id == entry.entry_id);
    new_queue || (after.here && !before.here)
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
    /// Save an album to the library, or follow an artist; or undo it.
    Save,
}

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

    /// The buttons beside the collection: Play, Shuffle, and Queue when it
    /// has songs, then Save for an album or Follow for an artist.
    pub fn buttons(&self) -> Vec<CollectionButton> {
        let Some(collection) = self.content.loaded() else {
            return Vec::new();
        };
        let mut buttons = if collection.tracks.is_empty() {
            Vec::new()
        } else {
            vec![
                CollectionButton::Play,
                CollectionButton::Shuffle,
                CollectionButton::Queue,
            ]
        };
        if SaveKind::from_collection(self.kind).is_some() {
            buttons.push(CollectionButton::Save);
        }
        buttons
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
    /// The searches whose results were used lately, latest first. They show
    /// before anything is typed.
    pub recent: Vec<String>,
    /// The recent searches have the selection.
    pub in_recent: bool,
    pub recent_row: usize,
}

/// How many recent searches the TV keeps, as many as the phone.
pub const MAX_RECENT_SEARCHES: usize = 8;

impl SearchNav {
    fn new() -> Self {
        Self {
            query: String::new(),
            key: 0,
            in_results: false,
            browse: BrowseNav::new(),
            results_for: String::new(),
            recent: Vec::new(),
            in_recent: false,
            recent_row: 0,
        }
    }

    /// Before anything is typed, Search lists the recent searches.
    pub fn showing_recent(&self) -> bool {
        self.query.trim().is_empty() && !self.recent.is_empty()
    }

    /// Put `query` first among the recent searches. Returns whether they changed.
    fn remember(&mut self, query: &str) -> bool {
        let query = query.trim();
        if query.is_empty() || self.recent.first().is_some_and(|first| first == query) {
            return false;
        }
        self.recent.retain(|recent| recent != query);
        self.recent.insert(0, query.to_owned());
        self.recent.truncate(MAX_RECENT_SEARCHES);
        true
    }

    fn clamp_recent(&mut self) {
        self.recent_row = self.recent_row.min(self.recent.len().saturating_sub(1));
        if !self.showing_recent() {
            self.in_recent = false;
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
    /// The settings button at the end of the tab bar, right of the last tab.
    Settings,
    Content,
}

/// How many cards fit across a row, and list rows down a page, on each
/// page. They match the sizes in `ui/app.slint` on a 16:9 screen.
pub const HOME_CARDS_VISIBLE: usize = 7;
pub const SEARCH_CARDS_VISIBLE: usize = 5;
pub const COLLECTION_ROWS_VISIBLE: usize = 9;
pub const QUEUE_ROWS_VISIBLE: usize = 8;

const BACK_TO_LEAVE: Duration = Duration::from_millis(2500);
/// The now-playing controls hide after this long without a key.
pub const CONTROLS_LINGER: Duration = Duration::from_secs(6);
/// An open queue closes after this long without a key.
pub const QUEUE_LINGER: Duration = Duration::from_secs(30);
/// The scan code shows this long after each song starts, then only with
/// the controls, so it never sits on the screen for a whole song.
pub const SCAN_CODE_AFTER_START: Duration = Duration::from_secs(20);
const NOTICE_DURATION: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq)]
pub struct Nav {
    pub tab: Tab,
    pub focus: Focus,
    pub control: usize,
    /// The seek bar above the buttons has the selection instead of a button.
    pub on_bar: bool,
    /// A seek being picked, see [`Scrub`].
    pub scrub: Option<Scrub>,
    /// Where the last seek went, and when.
    seek_sent: Option<(f64, Instant)>,
    pub idle_button: usize,
    pub panel: Panel,
    /// When a key last touched the now-playing controls; `None` while they
    /// are hidden and the screen shows only the song, its lyrics, and the
    /// visuals.
    pub controls: Option<Instant>,
    /// The lyrics show beside the song; the Lyrics button turns them off.
    pub show_lyrics: bool,
    pub queue_row: usize,
    pub queue_top: usize,
    /// The queue's Clear button has the selection instead of a song.
    pub queue_on_clear: bool,
    pub home: BrowseNav,
    pub library: BrowseNav,
    pub search: SearchNav,
    pub menu: Option<Menu>,
    pub session: View,
    /// Whether the current song is in Liked songs, once known.
    pub liked: Option<(String, bool)>,
    /// Which albums are saved and artists followed, as last heard.
    pub saved: HashMap<(SaveKind, String), bool>,
    /// Lyrics for the song with this videoId.
    pub lyrics: Option<(String, Load<Option<SongLyrics>>)>,
    notice: Option<(String, Instant)>,
    back_pressed: Option<Instant>,
    /// The entry the queue panel last followed, to keep it on the current song.
    queue_followed: Option<String>,
    /// No session state has arrived yet.
    first_session: bool,
    /// When the song playing now came up, for the scan code.
    song_started: Option<Instant>,
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
            on_bar: false,
            scrub: None,
            seek_sent: None,
            idle_button: 0,
            panel: Panel::None,
            controls: None,
            show_lyrics: true,
            queue_row: 0,
            queue_top: 0,
            queue_on_clear: false,
            home: BrowseNav::new(),
            library: BrowseNav::new(),
            search: SearchNav::new(),
            menu: None,
            session: View::default(),
            liked: None,
            saved: HashMap::new(),
            lyrics: None,
            notice: None,
            back_pressed: None,
            queue_followed: None,
            first_session: true,
            song_started: None,
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

    pub fn say(&mut self, text: impl Into<String>, now: Instant) {
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
        let starts_here = !self.first_session && music_starts(&self.session, &view);
        self.session = view;
        let mut effects = Vec::new();
        let current = self
            .session
            .current_entry()
            .map(|entry| entry.track.video_id.clone());
        if current != before {
            self.liked = None;
            self.scrub = None;
            self.seek_sent = None;
            self.song_started = current.is_some().then(Instant::now);
            if let Some(video_id) = &current {
                effects.push(Effect::LoadLiked(video_id.clone()));
                effects.extend(self.request_lyrics());
            }
        }
        // Opened with music already going (or woken to play): show it.
        if self.first_session && self.session.connected {
            self.first_session = false;
            if !self.session.is_idle() {
                self.show_now_playing();
            }
        }
        // New music from any device, or music moved to this TV: show it.
        // The remote can still leave for another tab afterwards.
        if starts_here {
            self.show_now_playing();
        }
        if was_idle && !self.session.is_idle() && self.tab == Tab::NowPlaying {
            self.control = 1;
            self.on_bar = false;
        }
        if self.session.is_idle() && self.panel != Panel::None {
            self.panel = Panel::None;
        }
        if self.clearable() == 0 {
            self.queue_on_clear = false;
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

    /// Nobody has touched the remote for a while and a song is up: go back
    /// to the now-playing screen, the screen the app rests on.
    pub fn rest(&mut self) {
        if !self.session.is_idle() && self.tab != Tab::NowPlaying && self.menu.is_none() {
            self.show_now_playing();
        }
    }

    fn show_now_playing(&mut self) {
        if self.tab != Tab::NowPlaying {
            self.panel = Panel::None;
        }
        self.tab = Tab::NowPlaying;
        self.menu = None;
        self.hide_controls();
    }

    /// Whether the now-playing screen shows its controls and the tab bar.
    /// Other screens always do.
    pub fn controls_shown(&self) -> bool {
        self.tab != Tab::NowPlaying || self.session.is_idle() || self.controls.is_some()
    }

    /// Whether the now-playing screen shows the scan code: with the
    /// controls, and for a short while after each song starts. Nothing
    /// playing has its own, larger code.
    pub fn scan_code_shown(&self, now: Instant) -> bool {
        self.controls_shown()
            || self
                .song_started
                .is_some_and(|at| now.saturating_duration_since(at) < SCAN_CODE_AFTER_START)
    }

    fn hide_controls(&mut self) {
        self.controls = None;
        self.focus = Focus::Content;
        self.control = 1;
        self.on_bar = false;
    }

    // SEEKING

    /// Whether Left and Right seek: the seek bar has the selection.
    pub fn on_seek_bar(&self) -> bool {
        self.tab == Tab::NowPlaying
            && !self.session.is_idle()
            && self.controls.is_some()
            && self.focus == Focus::Content
            && self.panel == Panel::None
            && self.menu.is_none()
            && self.on_bar
    }

    /// Move the seek being picked: a step for a press, and for a key held
    /// down, as far as it has been held, faster the longer it is.
    fn scrub(&mut self, forward: bool, held: bool, now: Instant) {
        let duration = self.session.duration_seconds;
        if self.session.is_idle() || duration <= 0.0 {
            return;
        }
        let position = self.session.position_seconds;
        let scrub = self.scrub.get_or_insert(Scrub {
            offset: 0.0,
            last: now,
            held_since: None,
            forward,
        });
        if scrub.forward != forward {
            scrub.forward = forward;
            scrub.held_since = None;
        }
        let distance = if held {
            let since = *scrub.held_since.get_or_insert(scrub.last);
            let speed = if now.duration_since(since) < SCRUB_FAST_AFTER {
                SCRUB_SPEED
            } else {
                SCRUB_FAST_SPEED
            };
            // A late repeat must not jump far.
            speed * now.duration_since(scrub.last).as_secs_f64().min(0.25)
        } else {
            scrub.held_since = None;
            SEEK_STEP
        };
        scrub.last = now;
        let step = if forward { distance } else { -distance };
        let target = (position + scrub.offset + step).clamp(0.0, (duration - 1.0).max(0.0));
        scrub.offset = target - position;
    }

    /// Send the seek being picked once the keys have rested, or `now` when
    /// `at_once`.
    fn send_seek(&mut self, now: Instant, at_once: bool) -> Vec<Effect> {
        let Some(scrub) = self.scrub else {
            return Vec::new();
        };
        if !at_once && now.duration_since(scrub.last) < SCRUB_SETTLE {
            return Vec::new();
        }
        self.scrub = None;
        if scrub.offset.abs() < 0.5 {
            return Vec::new();
        }
        let target = self.session.position_seconds + scrub.offset;
        self.seek_sent = Some((target, now));
        // Off the now-playing screen there is no bar to show it.
        if self.tab != Tab::NowPlaying {
            self.say(format!("Skipped to {}", clock(target)), now);
        }
        vec![Effect::Session(UiAction::SeekBy(scrub.offset))]
    }

    /// Send a picked seek once the keys have rested. Called on a timer.
    pub fn settle_seek(&mut self, now: Instant) -> Vec<Effect> {
        self.send_seek(now, false)
    }

    /// Where the seek bar shows the song: where a seek being picked would
    /// go, where a seek just sent went, or where it plays.
    pub fn shown_position(&self, now: Instant) -> f64 {
        let position = self.session.position_seconds;
        if let Some(scrub) = self.scrub {
            return position + scrub.offset;
        }
        match self.seek_sent {
            Some((target, at))
                if now.duration_since(at) < SEEK_SHOWN_FOR && (position - target).abs() > 2.0 =>
            {
                target
            }
            _ => position,
        }
    }

    /// A media key: it acts on the music from any screen, and brings up the
    /// now-playing controls to show what it did. `None` for other keys.
    fn media_key(&mut self, key: Key, now: Instant, effects: &mut Vec<Effect>) -> Option<bool> {
        let playing = self.session.playing;
        let action = match key {
            Key::PlayPause if playing => Some(UiAction::Pause),
            Key::PlayPause => Some(UiAction::Resume),
            Key::Play if !playing => Some(UiAction::Resume),
            Key::Pause | Key::Stop if playing => Some(UiAction::Pause),
            Key::Play | Key::Pause | Key::Stop => None,
            Key::Next => Some(UiAction::Next),
            Key::Previous => Some(UiAction::Previous),
            Key::FastForward | Key::Rewind => None,
            _ => return None,
        };
        if self.session.is_idle() {
            return Some(true);
        }
        if self.tab == Tab::NowPlaying && self.menu.is_none() {
            self.controls = Some(now);
        }
        match key {
            Key::FastForward | Key::Rewind => self.scrub(key == Key::FastForward, false, now),
            _ => effects.extend(action.map(Effect::Session)),
        }
        Some(true)
    }

    /// A key that repeats because it is held down. Held seek keys scrub;
    /// held media keys act once; anything else repeats like presses.
    pub fn key_held(&mut self, key: Key, now: Instant) -> (bool, Vec<Effect>) {
        let seek = match key {
            Key::FastForward | Key::Rewind => !self.session.is_idle(),
            Key::Left | Key::Right => self.on_seek_bar(),
            Key::PlayPause | Key::Play | Key::Pause | Key::Stop | Key::Next | Key::Previous => {
                return (true, Vec::new());
            }
            _ => false,
        };
        if !seek {
            return self.key(key, now);
        }
        if self.tab == Tab::NowPlaying && self.menu.is_none() {
            self.controls = Some(now);
        }
        self.scrub(matches!(key, Key::FastForward | Key::Right), true, now);
        (true, Vec::new())
    }

    /// Hide the now-playing controls once nobody has used them for a while.
    /// Returns whether anything changed.
    pub fn settle(&mut self, now: Instant) -> bool {
        let Some(touched) = self.controls else {
            return false;
        };
        if self.tab != Tab::NowPlaying || self.menu.is_some() {
            return false;
        }
        let linger = match self.panel {
            Panel::None => CONTROLS_LINGER,
            Panel::Queue => QUEUE_LINGER,
        };
        if now.duration_since(touched) < linger {
            return false;
        }
        self.panel = Panel::None;
        self.hide_controls();
        true
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
                page.button = 0;
                // With no buttons (a playlist with no songs), the list has it.
                page.in_list = page.content.loaded().is_some() && page.buttons().is_empty();
            }
        }
    }

    pub fn on_lyrics(&mut self, video_id: &str, result: Result<Option<SongLyrics>, String>) {
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

    /// Whether an album is saved or an artist followed, from the server. An
    /// open menu's Save or Follow item follows it.
    pub fn on_saved(&mut self, kind: SaveKind, id: &str, saved: bool) {
        self.saved.insert((kind, id.to_owned()), saved);
        if let Some(menu) = &mut self.menu {
            for item in &mut menu.items {
                if let MenuAction::SetSaved {
                    kind: item_kind,
                    id: item_id,
                    saved: wanted,
                    ..
                } = item
                    && *item_kind == kind
                    && item_id == id
                {
                    *wanted = !saved;
                }
            }
        }
    }

    pub fn is_saved(&self, kind: SaveKind, id: &str) -> bool {
        self.saved
            .get(&(kind, id.to_owned()))
            .copied()
            .unwrap_or(false)
    }

    /// The recent searches kept on the TV, latest first.
    pub fn set_recent_searches(&mut self, recent: Vec<String>) {
        self.search.recent = recent
            .into_iter()
            .map(|query| query.trim().to_owned())
            .filter(|query| !query.is_empty())
            .take(MAX_RECENT_SEARCHES)
            .collect();
        self.search.clamp_recent();
    }

    /// The server could not play a collection the menu asked for.
    pub fn on_failure(&mut self, message: &str, now: Instant) {
        self.say(message.to_owned(), now);
    }

    /// The updater needs permission to install: ask once.
    pub fn ask_update_permission(&mut self) {
        self.menu = Some(Menu {
            title: "Let Joshify update itself?".into(),
            subtitle: "Turn on “Install unknown apps” for Joshify once. After that, updates install by themselves while nothing is playing.".into(),
            items: vec![MenuAction::OpenUpdateSettings, MenuAction::Close],
            selected: 0,
        });
    }

    /// The settings menu: `about` is the version and how updates stand.
    pub fn show_settings(&mut self, about: String) {
        self.menu = Some(Menu {
            title: "Joshify".into(),
            subtitle: about,
            items: vec![MenuAction::CheckForUpdates, MenuAction::Close],
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
        if let Some(used) = self.media_key(key, now, &mut effects) {
            return (used, effects);
        }
        if self.menu.is_some() {
            self.menu_key(key, now, &mut effects);
            return (true, effects);
        }
        if let Key::Char(_) | Key::Backspace = key {
            return (self.typed(key, &mut effects), effects);
        }
        if self.tab == Tab::NowPlaying && !self.session.is_idle() {
            if self.controls.is_none() {
                // The first key only brings the controls back; Back still
                // leaves, the way it does from any top-level screen.
                if key == Key::Back {
                    return (self.back_to_leave(now), effects);
                }
                self.controls = Some(now);
                self.focus = Focus::Content;
                return (true, effects);
            }
            self.controls = Some(now);
        }
        let used = match self.focus {
            Focus::Tabs => self.tabs_key(key, now, &mut effects),
            Focus::Settings => self.settings_key(key, now, &mut effects),
            Focus::Content => match self.tab {
                Tab::NowPlaying => self.player_key(key, now, &mut effects),
                Tab::Home | Tab::Library | Tab::Search if self.collection().is_some() => {
                    self.collection_key(key, now, &mut effects)
                }
                Tab::Home | Tab::Library => self.shelves_key(key, now, &mut effects),
                Tab::Search => self.search_key(key, now, &mut effects),
            },
        };
        // Arriving on now playing along the tab bar keeps the bar up.
        if self.tab == Tab::NowPlaying && self.focus == Focus::Tabs && self.controls.is_none() {
            self.controls = Some(now);
        }
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
                self.say("Press Back again to leave Joshify", now);
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
            Key::Right => self.focus = Focus::Settings,
            Key::Down | Key::Ok => self.enter_content(),
            Key::Back if self.tab != Tab::NowPlaying && !self.session.is_idle() => {
                self.show_now_playing();
            }
            Key::Back if self.tab == Tab::NowPlaying && !self.session.is_idle() => {
                self.hide_controls();
            }
            Key::Back => return self.back_to_leave(now),
            _ => {}
        }
        true
    }

    /// Down from the tab bar. On now playing the seek bar is the nearest row.
    fn enter_content(&mut self) {
        self.focus = Focus::Content;
        if self.tab == Tab::NowPlaying && self.panel == Panel::None && !self.session.is_idle() {
            self.on_bar = true;
        }
    }

    /// The settings button: the tab bar's last stop.
    fn settings_key(&mut self, key: Key, now: Instant, effects: &mut Vec<Effect>) -> bool {
        match key {
            Key::Ok => effects.push(Effect::OpenSettings),
            Key::Left => self.focus = Focus::Tabs,
            Key::Down => self.enter_content(),
            Key::Back => {
                self.focus = Focus::Tabs;
                return self.tabs_key(key, now, effects);
            }
            _ => {}
        }
        true
    }

    // NOW PLAYING

    fn player_key(&mut self, key: Key, now: Instant, effects: &mut Vec<Effect>) -> bool {
        if self.session.is_idle() {
            return self.idle_key(key, now, effects);
        }
        if self.panel == Panel::Queue {
            return self.queue_key(key, effects);
        }
        if self.on_bar {
            return self.bar_key(key, now, effects);
        }
        match key {
            Key::Left => self.control = self.control.saturating_sub(1),
            Key::Right => self.control = (self.control + 1).min(CONTROLS.len() - 1),
            Key::Up => self.on_bar = true,
            Key::Down => {}
            Key::Ok => self.press_control(now, effects),
            Key::Hold => self.song_menu(),
            Key::Back => self.hide_controls(),
            _ => {}
        }
        true
    }

    /// The seek bar: Left and Right pick a seek, OK sends it at once (or
    /// plays and pauses), and Back drops it.
    fn bar_key(&mut self, key: Key, now: Instant, effects: &mut Vec<Effect>) -> bool {
        match key {
            Key::Left | Key::Right => self.scrub(key == Key::Right, false, now),
            Key::Up => self.focus = Focus::Tabs,
            Key::Down => self.on_bar = false,
            Key::Ok if self.scrub.is_some() => effects.extend(self.send_seek(now, true)),
            Key::Ok => effects.push(Effect::Session(UiAction::PlayPause)),
            Key::Hold => self.song_menu(),
            Key::Back if self.scrub.is_some() => self.scrub = None,
            Key::Back => self.hide_controls(),
            _ => {}
        }
        true
    }

    fn song_menu(&mut self) {
        if let Some(entry) = self.session.current_entry() {
            self.menu = Some(Menu {
                title: entry.track.title.clone(),
                subtitle: entry.track.artists.clone(),
                items: vec![MenuAction::Like(entry.track.clone()), MenuAction::Close],
                selected: 0,
            });
        }
    }

    fn press_control(&mut self, now: Instant, effects: &mut Vec<Effect>) {
        match CONTROLS[self.control] {
            Control::Previous => effects.push(Effect::Session(UiAction::Previous)),
            Control::Next => effects.push(Effect::Session(UiAction::Next)),
            Control::PlayPause => effects.push(Effect::Session(UiAction::PlayPause)),
            Control::Shuffle => effects.push(Effect::Session(UiAction::ToggleShuffle)),
            Control::Repeat => effects.push(Effect::Session(UiAction::CycleRepeat)),
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
                self.queue_on_clear = false;
                self.queue_followed = None;
                self.follow_queue();
            }
            Control::Lyrics => {
                self.show_lyrics = !self.show_lyrics;
                if self.show_lyrics {
                    effects.extend(self.request_lyrics());
                }
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

    /// How many songs Clear would take out of the queue: those someone
    /// queued after the song playing (all of them with none), not
    /// autoplay's. The same rule as the server's `clearUpcoming`.
    pub fn clearable(&self) -> usize {
        let after = self.session.current.map_or(0, |index| index + 1);
        self.session
            .queue
            .iter()
            .skip(after)
            .filter(|entry| !entry.autoplay)
            .count()
    }

    /// Clear takes songs out of the queue, so it asks first. "Not now" has
    /// the selection, so a stray OK changes nothing.
    fn ask_clear_upcoming(&mut self) {
        let count = self.clearable();
        if count == 0 {
            return;
        }
        let songs = if count == 1 {
            "the song".to_owned()
        } else {
            format!("the {count} songs")
        };
        let after = self.session.current.map_or(0, |index| index + 1);
        let autoplay = self
            .session
            .queue
            .iter()
            .skip(after)
            .any(|entry| entry.autoplay);
        let after_this = if self.session.current.is_some() {
            " after this one"
        } else {
            ""
        };
        let mut subtitle = format!("This takes out {songs} queued{after_this}.");
        if autoplay {
            subtitle.push_str(" Autoplay’s songs stay.");
        }
        self.menu = Some(Menu {
            title: "Clear the queue?".into(),
            subtitle,
            items: vec![MenuAction::ClearUpcoming, MenuAction::Close],
            selected: 1,
        });
    }

    fn queue_key(&mut self, key: Key, effects: &mut Vec<Effect>) -> bool {
        let count = self.session.queue.len();
        if self.queue_on_clear {
            match key {
                Key::Down => self.queue_on_clear = false,
                Key::Ok => self.ask_clear_upcoming(),
                Key::Back | Key::Left => {
                    self.queue_on_clear = false;
                    self.panel = Panel::None;
                }
                _ => {}
            }
            return true;
        }
        match key {
            // Clear sits over the first song.
            Key::Up if self.queue_row == 0 && self.clearable() > 0 => self.queue_on_clear = true,
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
                    if self.clearable() > 0 {
                        items.push(MenuAction::AskClearUpcoming);
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
                    self.card_menu(&card, effects);
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
        if let Some(save_kind) = SaveKind::from_collection(kind) {
            effects.push(Effect::LoadSaved {
                kind: save_kind,
                id: id.clone(),
            });
        }
        effects.push(Effect::LoadCollection { tab, kind, id });
    }

    /// Save an album or follow an artist, or undo it, showing it at once.
    fn set_saved(
        &mut self,
        kind: SaveKind,
        id: String,
        title: &str,
        saved: bool,
        now: Instant,
        effects: &mut Vec<Effect>,
    ) {
        self.saved.insert((kind, id.clone()), saved);
        effects.push(Effect::SetSaved { kind, id, saved });
        self.say(
            match (kind, saved) {
                (SaveKind::Album, true) => "Saved to your library".to_owned(),
                (SaveKind::Album, false) => "Removed from your library".to_owned(),
                (SaveKind::Artist, true) => format!("Following {title}"),
                (SaveKind::Artist, false) => format!("Unfollowed {title}"),
            },
            now,
        );
    }

    fn card_menu(&mut self, card: &Card, effects: &mut Vec<Effect>) {
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
                if let Some(save_kind) = SaveKind::from_collection(kind) {
                    // Shown as last heard, and corrected when the server answers.
                    items.push(MenuAction::SetSaved {
                        kind: save_kind,
                        id: card.id.clone(),
                        title: card.title.clone(),
                        saved: !self.is_saved(save_kind, &card.id),
                    });
                    effects.push(Effect::LoadSaved {
                        kind: save_kind,
                        id: card.id.clone(),
                    });
                }
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
                        self.remember_search(effects);
                        self.open_card(&card, songs, now, effects);
                    }
                }
                Key::Hold => {
                    if let Some(card) = shelves.selected_card().cloned() {
                        self.remember_search(effects);
                        self.card_menu(&card, effects);
                    }
                }
                Key::Back => self.search.in_results = false,
                _ => {}
            }
            return true;
        }
        if self.search.in_recent {
            return self.recent_key(key, effects);
        }
        match key {
            Key::Up | Key::Down | Key::Left | Key::Right => {
                let at_right_edge = key == Key::Right
                    && (self.search.key % KEY_COLUMNS == KEY_COLUMNS - 1
                        || self.search.key == SearchNav::key_count() - 1);
                if at_right_edge {
                    if self.search.showing_recent() {
                        self.search.clamp_recent();
                        self.search.in_recent = true;
                    } else if self.search.browse.shelves.selected().is_some() {
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

    /// The results of a search were used: keep it among the recent ones,
    /// as the phone does.
    fn remember_search(&mut self, effects: &mut Vec<Effect>) {
        let query = self.search.results_for.clone();
        if self.search.remember(&query) {
            effects.push(Effect::SaveSearches(self.search.recent.clone()));
        }
    }

    /// The recent searches, listed before anything is typed: OK searches
    /// again, and holding OK removes one or all.
    fn recent_key(&mut self, key: Key, effects: &mut Vec<Effect>) -> bool {
        let search = &mut self.search;
        search.clamp_recent();
        if !search.in_recent {
            return true;
        }
        let count = search.recent.len();
        match key {
            Key::Up if search.recent_row == 0 => self.focus = Focus::Tabs,
            Key::Up => search.recent_row -= 1,
            Key::Down => search.recent_row = (search.recent_row + 1).min(count - 1),
            Key::Left | Key::Back => search.in_recent = false,
            Key::Ok => {
                let query = search.recent[search.recent_row].clone();
                search.query = query;
                search.in_recent = false;
                effects.extend(self.query_changed());
            }
            Key::Hold => {
                let query = search.recent[search.recent_row].clone();
                self.menu = Some(Menu {
                    title: format!("“{query}”"),
                    subtitle: "Recent search".into(),
                    items: vec![
                        MenuAction::RemoveSearch(query),
                        MenuAction::ClearSearches,
                        MenuAction::Close,
                    ],
                    selected: 0,
                });
            }
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
        self.search.in_recent = false;
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
            let buttons = page.buttons();
            match key {
                Key::Left => page.button = page.button.saturating_sub(1),
                Key::Right if page.button + 1 < buttons.len() => page.button += 1,
                Key::Right | Key::Down if !rows.is_empty() => page.in_list = true,
                Key::Up => self.focus = Focus::Tabs,
                Key::Ok => match buttons.get(page.button).copied() {
                    Some(CollectionButton::Save) => {
                        let Some(kind) = SaveKind::from_collection(page.kind) else {
                            return true;
                        };
                        let id = page.id.clone();
                        let title = page
                            .content
                            .loaded()
                            .map(|collection| collection.title.clone())
                            .unwrap_or_default();
                        let saved = !self.is_saved(kind, &id);
                        self.set_saved(kind, id, &title, saved, now, effects);
                    }
                    Some(button) => {
                        let tracks = page.tracks();
                        self.play_tracks(tracks, button, now, effects);
                    }
                    None => {}
                },
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
                                self.card_menu(&card, effects);
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
            CollectionButton::Save => {}
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
            MenuAction::SetSaved {
                kind,
                id,
                title,
                saved,
            } => self.set_saved(kind, id, &title, saved, now, effects),
            MenuAction::AskClearUpcoming => self.ask_clear_upcoming(),
            MenuAction::ClearUpcoming => {
                let count = self.clearable();
                if count > 0 {
                    effects.push(Effect::Session(UiAction::ClearUpcoming));
                    self.queue_on_clear = false;
                    self.say(
                        if count == 1 {
                            "Took 1 song out of the queue".to_owned()
                        } else {
                            format!("Took {count} songs out of the queue")
                        },
                        now,
                    );
                }
            }
            MenuAction::RemoveSearch(query) => {
                self.search.recent.retain(|recent| *recent != query);
                self.search.clamp_recent();
                effects.push(Effect::SaveSearches(self.search.recent.clone()));
            }
            MenuAction::ClearSearches => {
                self.search.recent.clear();
                self.search.clamp_recent();
                effects.push(Effect::SaveSearches(Vec::new()));
            }
            MenuAction::OpenUpdateSettings => effects.push(Effect::OpenUpdateSettings),
            MenuAction::CheckForUpdates => effects.push(Effect::CheckForUpdates),
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
                    autoplay: false,
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
            vec![
                Effect::LoadSaved {
                    kind: SaveKind::Album,
                    id: "a1".into(),
                },
                Effect::LoadCollection {
                    tab: Tab::Home,
                    kind: CollectionKind::Album,
                    id: "a1".into(),
                }
            ]
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
        // Past Shuffle, Queue, and Save into the list.
        let effects = press(
            &mut nav,
            &[
                Key::Right,
                Key::Right,
                Key::Right,
                Key::Right,
                Key::Down,
                Key::Ok,
            ],
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
    fn the_settings_button_ends_the_tab_bar() {
        let mut nav = Nav::new();
        nav.switch_tab(Tab::Library, &mut Vec::new());
        nav.focus = Focus::Tabs;
        press(&mut nav, &[Key::Right]);
        assert_eq!((nav.tab, nav.focus), (Tab::Library, Focus::Settings));
        assert_eq!(press(&mut nav, &[Key::Ok]), vec![Effect::OpenSettings]);
        nav.show_settings("Version f3a82b03 (12 Nov 2026)".into());
        assert_eq!(press(&mut nav, &[Key::Ok]), vec![Effect::CheckForUpdates]);
        assert!(nav.menu.is_none());
        press(&mut nav, &[Key::Left]);
        assert_eq!((nav.tab, nav.focus), (Tab::Library, Focus::Tabs));
        press(&mut nav, &[Key::Right, Key::Down]);
        assert_eq!(nav.focus, Focus::Content);
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
        // The first key only shows the controls.
        assert_eq!(press(&mut nav, &[Key::Ok]), vec![]);
        assert!(nav.controls_shown());
        assert_eq!(
            press(&mut nav, &[Key::Ok]),
            vec![Effect::Session(UiAction::PlayPause)]
        );
        assert_eq!(
            press(&mut nav, &[Key::Right, Key::Ok]),
            vec![Effect::Session(UiAction::Next)]
        );
        // Shuffle and repeat are next.
        assert_eq!(
            press(&mut nav, &[Key::Right, Key::Right, Key::Ok]),
            vec![Effect::Session(UiAction::ToggleShuffle)]
        );
        assert_eq!(
            press(&mut nav, &[Key::Right, Key::Ok]),
            vec![Effect::Session(UiAction::CycleRepeat)]
        );
        // Open the queue, go down three, and skip to that song.
        press(&mut nav, &[Key::Right, Key::Ok]);
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
        assert_eq!(
            effects,
            vec![
                Effect::LoadLiked("q0".into()),
                Effect::LoadLyrics("q0".into())
            ]
        );
        nav.on_liked("q0", false);
        let effects = press(&mut nav, &[Key::Down, Key::Right, Key::Right, Key::Ok]);
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
    fn the_controls_hide_and_come_back() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        assert_eq!(nav.tab, Tab::NowPlaying);
        assert!(!nav.controls_shown());
        let now = Instant::now();
        assert!(nav.key(Key::Right, now).0);
        assert!(nav.controls_shown());
        assert_eq!(nav.control, 1, "showing them moves nothing");
        nav.key(Key::Right, now);
        assert_eq!(nav.control, 2);
        assert!(!nav.settle(now + Duration::from_secs(2)));
        assert!(nav.settle(now + CONTROLS_LINGER));
        assert!(!nav.controls_shown());
        assert_eq!((nav.control, nav.focus), (1, Focus::Content));
    }

    #[test]
    fn the_scan_code_shows_as_a_song_starts_and_with_the_controls() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        let start = Instant::now();
        assert!(nav.scan_code_shown(start), "a song just started");
        let later = start + SCAN_CODE_AFTER_START + Duration::from_secs(1);
        assert!(!nav.scan_code_shown(later), "then it goes");
        nav.key(Key::Right, later);
        assert!(nav.scan_code_shown(later), "the controls bring it back");
        assert!(nav.settle(later + CONTROLS_LINGER));
        assert!(!nav.scan_code_shown(later + CONTROLS_LINGER));
        // The next song shows it again.
        let mut next = playing_view();
        next.current = Some(1);
        nav.on_session(next);
        assert!(nav.scan_code_shown(Instant::now()));
    }

    #[test]
    fn the_queue_keeps_the_controls_up_for_a_while() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        let now = Instant::now();
        let to_queue = [
            Key::Down,
            Key::Right,
            Key::Right,
            Key::Right,
            Key::Right,
            Key::Right,
        ];
        for key in to_queue.into_iter().chain([Key::Ok]) {
            nav.key(key, now);
        }
        assert_eq!(nav.panel, Panel::Queue);
        assert!(!nav.settle(now + CONTROLS_LINGER * 3));
        assert!(nav.controls_shown());
        assert!(nav.settle(now + QUEUE_LINGER));
        assert_eq!(nav.panel, Panel::None);
        assert!(!nav.controls_shown());
    }

    #[test]
    fn back_hides_the_controls_then_leaves() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        let now = Instant::now();
        // The first key shows the controls, then up goes by the seek bar.
        nav.key(Key::Up, now);
        nav.key(Key::Up, now);
        assert!(nav.on_seek_bar());
        nav.key(Key::Up, now);
        assert_eq!(nav.focus, Focus::Tabs);
        assert!(nav.key(Key::Back, now).0);
        assert!(!nav.controls_shown());
        assert!(nav.key(Key::Back, now).0);
        assert!(!nav.key(Key::Back, now + Duration::from_millis(300)).0);
    }

    #[test]
    fn the_tab_bar_stays_up_on_the_way_to_now_playing() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        nav.switch_tab(Tab::Home, &mut Vec::new());
        nav.focus = Focus::Tabs;
        press(&mut nav, &[Key::Left]);
        assert_eq!(nav.tab, Tab::NowPlaying);
        assert!(nav.controls_shown());
    }

    #[test]
    fn the_lyrics_button_turns_the_lyrics_off_and_on() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        nav.on_lyrics("q0", Err("offline".into()));
        assert!(nav.show_lyrics);
        let keys = [
            Key::Down,
            Key::Right,
            Key::Right,
            Key::Right,
            Key::Right,
            Key::Right,
            Key::Right,
        ];
        press(&mut nav, &keys);
        assert_eq!(CONTROLS[nav.control], Control::Lyrics);
        assert_eq!(press(&mut nav, &[Key::Ok]), vec![]);
        assert!(!nav.show_lyrics);
        // Back on: a failed lookup is tried again.
        assert_eq!(
            press(&mut nav, &[Key::Ok]),
            vec![Effect::LoadLyrics("q0".into())]
        );
        assert!(nav.show_lyrics);
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
        assert_eq!(idle.tab, Tab::NowPlaying);
    }

    #[test]
    fn rests_on_now_playing() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        nav.tab = Tab::Home;
        nav.rest();
        assert_eq!(nav.tab, Tab::NowPlaying);
    }

    /// The phone plays a new queue on another device; the TV only watches.
    fn queue_from_phone(prefix: &str) -> View {
        let mut view = playing_view();
        for entry in &mut view.queue {
            entry.entry_id = format!("{prefix}{}", entry.entry_id);
        }
        view.here = false;
        view.player_name = Some("Phone".into());
        view
    }

    #[test]
    fn shows_now_playing_when_new_music_starts() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        nav.switch_tab(Tab::Library, &mut Vec::new());
        nav.on_session(queue_from_phone("phone-"));
        assert_eq!(nav.tab, Tab::NowPlaying);
        assert_eq!(nav.focus, Focus::Content);
    }

    #[test]
    fn shows_now_playing_when_music_moves_to_the_tv() {
        let mut nav = Nav::new();
        nav.on_session(queue_from_phone("phone-"));
        nav.switch_tab(Tab::Search, &mut Vec::new());
        let mut moved = queue_from_phone("phone-");
        moved.here = true;
        moved.player_name = None;
        nav.on_session(moved);
        assert_eq!(nav.tab, Tab::NowPlaying);
    }

    #[test]
    fn stays_where_the_remote_left_it_as_the_queue_plays_on() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        nav.switch_tab(Tab::Library, &mut Vec::new());
        let mut next = playing_view();
        next.current = Some(1);
        nav.on_session(next.clone());
        next.playing = false;
        nav.on_session(next.clone());
        next.queue.push(QueueEntry {
            entry_id: "added".into(),
            track: track("added"),
            autoplay: false,
        });
        nav.on_session(next);
        assert_eq!(nav.tab, Tab::Library);
    }

    #[test]
    fn back_twice_leaves() {
        let mut nav = Nav::new();
        nav.tab = Tab::NowPlaying;
        nav.on_session(playing_view());
        let now = Instant::now();
        assert!(nav.key(Key::Back, now).0);
        assert_eq!(nav.notice(now), Some("Press Back again to leave Joshify"));
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

    /// A song 200 seconds long, 50 seconds in.
    fn midway_view() -> View {
        View {
            position_seconds: 50.0,
            duration_seconds: 200.0,
            ..playing_view()
        }
    }

    #[test]
    fn media_keys_play_pause_and_skip_from_any_screen() {
        let mut nav = Nav::new();
        nav.on_session(midway_view());
        assert!(!nav.controls_shown());
        // No "first key only shows the controls" for media keys.
        assert_eq!(
            press(&mut nav, &[Key::PlayPause]),
            vec![Effect::Session(UiAction::Pause)]
        );
        assert!(nav.controls_shown(), "they show what the key did");
        assert_eq!(press(&mut nav, &[Key::Play]), vec![]);
        assert_eq!(
            press(&mut nav, &[Key::Pause, Key::Stop]),
            vec![
                Effect::Session(UiAction::Pause),
                Effect::Session(UiAction::Pause)
            ]
        );
        nav.switch_tab(Tab::Home, &mut Vec::new());
        assert_eq!(
            press(&mut nav, &[Key::Next, Key::Previous]),
            vec![
                Effect::Session(UiAction::Next),
                Effect::Session(UiAction::Previous)
            ]
        );
        nav.on_session(View {
            playing: false,
            ..midway_view()
        });
        assert_eq!(
            press(&mut nav, &[Key::PlayPause, Key::Play]),
            vec![
                Effect::Session(UiAction::Resume),
                Effect::Session(UiAction::Resume)
            ]
        );
        assert_eq!(nav.tab, Tab::Home, "media keys never change the screen");
        // They work over a menu too, and leave it open.
        nav.on_home(Ok(shelves()));
        press(&mut nav, &[Key::Hold]);
        assert!(nav.menu.is_some());
        assert_eq!(
            press(&mut nav, &[Key::Next]),
            vec![Effect::Session(UiAction::Next)]
        );
        assert!(nav.menu.is_some());
        // Held, they act once.
        let now = Instant::now();
        assert_eq!(nav.key_held(Key::Next, now), (true, vec![]));
    }

    #[test]
    fn media_keys_do_nothing_with_nothing_playing() {
        let mut nav = Nav::new();
        nav.on_session(View {
            connected: true,
            ..View::default()
        });
        let now = Instant::now();
        for key in [Key::PlayPause, Key::Next, Key::FastForward] {
            assert_eq!(nav.key(key, now), (true, vec![]));
        }
        assert_eq!(nav.settle_seek(now + SCRUB_SETTLE), vec![]);
    }

    #[test]
    fn up_from_the_buttons_reaches_the_seek_bar_then_the_tabs() {
        let mut nav = Nav::new();
        nav.on_session(midway_view());
        press(&mut nav, &[Key::Ok, Key::Up]);
        assert!(nav.on_seek_bar());
        press(&mut nav, &[Key::Down]);
        assert!(!nav.on_seek_bar());
        assert_eq!(nav.control, 1);
        press(&mut nav, &[Key::Up, Key::Up]);
        assert_eq!(nav.focus, Focus::Tabs);
        // Down from the tab bar lands on the nearest row: the seek bar.
        press(&mut nav, &[Key::Down]);
        assert!(nav.on_seek_bar());
        // OK on the bar plays and pauses.
        assert_eq!(
            press(&mut nav, &[Key::Ok]),
            vec![Effect::Session(UiAction::PlayPause)]
        );
    }

    #[test]
    fn the_seek_bar_seeks_once_the_keys_rest() {
        let mut nav = Nav::new();
        nav.on_session(midway_view());
        let now = Instant::now();
        for key in [
            Key::Ok,
            Key::Up,
            Key::Right,
            Key::Right,
            Key::Right,
            Key::Left,
        ] {
            assert_eq!(nav.key(key, now), (true, vec![]));
        }
        assert_eq!(nav.scrub.map(|scrub| scrub.offset), Some(20.0));
        assert_eq!(nav.shown_position(now), 70.0);
        assert_eq!(nav.settle_seek(now + SCRUB_SETTLE / 2), vec![]);
        assert_eq!(
            nav.settle_seek(now + SCRUB_SETTLE),
            vec![Effect::Session(UiAction::SeekBy(20.0))]
        );
        assert_eq!(nav.scrub, None);
        // The bar stays where the seek went until the session catches up.
        assert_eq!(nav.shown_position(now + SCRUB_SETTLE), 70.0);
        nav.on_session(View {
            position_seconds: 70.0,
            ..midway_view()
        });
        assert_eq!(nav.shown_position(now + SCRUB_SETTLE), 70.0);
        assert!(nav.notice(now + SCRUB_SETTLE).is_none(), "the bar shows it");
    }

    #[test]
    fn ok_seeks_at_once_and_back_drops_the_seek() {
        let mut nav = Nav::new();
        nav.on_session(midway_view());
        press(&mut nav, &[Key::Ok, Key::Up, Key::Left]);
        assert_eq!(
            press(&mut nav, &[Key::Ok]),
            vec![Effect::Session(UiAction::SeekBy(-10.0))]
        );
        press(&mut nav, &[Key::Right, Key::Back]);
        assert_eq!(nav.scrub, None);
        assert!(nav.controls_shown(), "the first Back only drops the seek");
        assert_eq!(nav.settle_seek(Instant::now() + SCRUB_SETTLE * 2), vec![]);
    }

    #[test]
    fn holding_a_seek_key_scrubs_faster_the_longer_it_is_held() {
        let mut nav = Nav::new();
        nav.on_session(midway_view());
        let start = Instant::now();
        nav.key(Key::Ok, start);
        nav.key(Key::Up, start);
        nav.key(Key::Right, start);
        // Repeats every 100 ms: 2 seconds a repeat, then 6 after 1.5 s held.
        let mut now = start;
        for _ in 0..10 {
            now += Duration::from_millis(100);
            nav.key_held(Key::Right, now);
        }
        let offset = nav.scrub.unwrap().offset;
        assert!((offset - 30.0).abs() < 1e-6, "{offset}");
        for _ in 0..10 {
            now += Duration::from_millis(100);
            nav.key_held(Key::Right, now);
        }
        let offset = nav.scrub.unwrap().offset;
        assert!(offset > 50.0 && offset < 80.0, "{offset}");
        // It stops a second short of the end.
        for _ in 0..100 {
            now += Duration::from_millis(100);
            nav.key_held(Key::Right, now);
        }
        assert_eq!(nav.shown_position(now), 199.0);
        assert_eq!(nav.settle_seek(now), vec![]);
        assert_eq!(
            nav.settle_seek(now + SCRUB_SETTLE),
            vec![Effect::Session(UiAction::SeekBy(149.0))]
        );
    }

    #[test]
    fn fast_forward_and_rewind_seek_from_any_screen() {
        let mut nav = Nav::new();
        nav.on_session(midway_view());
        nav.switch_tab(Tab::Home, &mut Vec::new());
        let now = Instant::now();
        for key in [Key::FastForward, Key::FastForward, Key::Rewind] {
            nav.key(key, now);
        }
        assert_eq!(nav.tab, Tab::Home);
        let later = now + SCRUB_SETTLE;
        assert_eq!(
            nav.settle_seek(later),
            vec![Effect::Session(UiAction::SeekBy(10.0))]
        );
        assert_eq!(nav.notice(later), Some("Skipped to 1:00"));
        // Rewind stops at the start.
        for _ in 0..8 {
            nav.key(Key::Rewind, later);
        }
        assert_eq!(nav.shown_position(later), 0.0);
        // A new song drops a seek picked for the last one.
        nav.on_session(View {
            current: Some(1),
            ..midway_view()
        });
        assert_eq!(nav.scrub, None);
    }

    #[test]
    fn left_and_right_on_the_buttons_still_move_between_them() {
        let mut nav = Nav::new();
        nav.on_session(midway_view());
        let now = Instant::now();
        nav.key(Key::Ok, now);
        nav.key_held(Key::Right, now);
        nav.key_held(Key::Right, now);
        assert_eq!(nav.control, 3);
        assert_eq!(nav.scrub, None);
    }

    fn collection(kind: CollectionKind, id: &str, tracks: usize) -> Collection {
        Collection {
            kind,
            id: id.into(),
            title: format!("Collection {id}"),
            subtitle: String::new(),
            description: None,
            artwork_url: None,
            tracks: (0..tracks)
                .map(|index| track(&format!("t{index}")))
                .collect(),
            shelves: Vec::new(),
        }
    }

    fn artist_card(id: &str) -> Card {
        Card {
            kind: CardKind::Artist,
            id: id.into(),
            title: format!("Artist {id}"),
            subtitle: "Artist".into(),
            artwork_url: None,
            track: None,
        }
    }

    #[test]
    fn saves_an_album_from_its_page_and_takes_the_servers_word() {
        let mut nav = Nav::new();
        nav.on_home(Ok(shelves()));
        press(&mut nav, &[Key::Down, Key::Ok]);
        nav.on_collection(
            Tab::Home,
            CollectionKind::Album,
            "a0",
            Ok(collection(CollectionKind::Album, "a0", 2)),
        );
        let page = nav.collection().unwrap();
        assert_eq!(
            page.buttons(),
            vec![
                CollectionButton::Play,
                CollectionButton::Shuffle,
                CollectionButton::Queue,
                CollectionButton::Save,
            ]
        );
        // Right past Shuffle and Queue to Save.
        let effects = press(&mut nav, &[Key::Right, Key::Right, Key::Right, Key::Ok]);
        assert_eq!(
            effects,
            vec![Effect::SetSaved {
                kind: SaveKind::Album,
                id: "a0".into(),
                saved: true,
            }]
        );
        assert!(nav.is_saved(SaveKind::Album, "a0"));
        assert_eq!(nav.notice(Instant::now()), Some("Saved to your library"));
        // Pressing again undoes it.
        let effects = press(&mut nav, &[Key::Ok]);
        assert_eq!(
            effects,
            vec![Effect::SetSaved {
                kind: SaveKind::Album,
                id: "a0".into(),
                saved: false,
            }]
        );
        // The server has the last word.
        nav.on_saved(SaveKind::Album, "a0", true);
        assert!(nav.is_saved(SaveKind::Album, "a0"));
    }

    #[test]
    fn an_artist_without_songs_still_has_follow() {
        let mut nav = Nav::new();
        nav.on_home(Ok(vec![Shelf {
            title: "Artists".into(),
            cards: vec![artist_card("UC1")],
        }]));
        press(&mut nav, &[Key::Ok]);
        nav.on_collection(
            Tab::Home,
            CollectionKind::Artist,
            "UC1",
            Ok(collection(CollectionKind::Artist, "UC1", 0)),
        );
        let page = nav.collection().unwrap();
        assert_eq!(page.buttons(), vec![CollectionButton::Save]);
        assert!(!page.in_list);
        let effects = press(&mut nav, &[Key::Ok]);
        assert_eq!(
            effects,
            vec![Effect::SetSaved {
                kind: SaveKind::Artist,
                id: "UC1".into(),
                saved: true,
            }]
        );
        assert_eq!(nav.notice(Instant::now()), Some("Following Collection UC1"));
    }

    #[test]
    fn a_playlist_has_no_save_button() {
        let mut nav = Nav::new();
        nav.on_home(Ok(vec![Shelf {
            title: "Playlists".into(),
            cards: vec![Card {
                kind: CardKind::Playlist,
                ..album_card("p1")
            }],
        }]));
        let effects = press(&mut nav, &[Key::Ok]);
        assert!(
            !effects
                .iter()
                .any(|effect| matches!(effect, Effect::LoadSaved { .. }))
        );
        nav.on_collection(
            Tab::Home,
            CollectionKind::Playlist,
            "p1",
            Ok(collection(CollectionKind::Playlist, "p1", 0)),
        );
        let page = nav.collection().unwrap();
        assert!(page.buttons().is_empty());
        assert!(page.in_list);
    }

    #[test]
    fn the_menu_on_an_artist_card_follows_and_tracks_the_server() {
        let mut nav = Nav::new();
        nav.on_home(Ok(vec![Shelf {
            title: "Artists".into(),
            cards: vec![artist_card("UC1")],
        }]));
        let effects = press(&mut nav, &[Key::Hold]);
        assert_eq!(
            effects,
            vec![Effect::LoadSaved {
                kind: SaveKind::Artist,
                id: "UC1".into(),
            }]
        );
        let follow = |nav: &Nav| {
            nav.menu
                .as_ref()
                .unwrap()
                .items
                .iter()
                .find(|item| matches!(item, MenuAction::SetSaved { .. }))
                .cloned()
                .unwrap()
        };
        assert_eq!(follow(&nav).label(), "Follow");
        // The server says they're followed already: the item offers Unfollow.
        nav.on_saved(SaveKind::Artist, "UC1", true);
        assert_eq!(follow(&nav).label(), "Unfollow");
        let index = nav
            .menu
            .as_ref()
            .unwrap()
            .items
            .iter()
            .position(|item| matches!(item, MenuAction::SetSaved { .. }))
            .unwrap();
        nav.menu.as_mut().unwrap().selected = index;
        let effects = press(&mut nav, &[Key::Ok]);
        assert_eq!(
            effects,
            vec![Effect::SetSaved {
                kind: SaveKind::Artist,
                id: "UC1".into(),
                saved: false,
            }]
        );
        assert_eq!(nav.notice(Instant::now()), Some("Unfollowed Artist UC1"));
    }

    /// Twelve songs, the first playing, the last four added by autoplay.
    fn view_with_autoplay() -> View {
        let mut view = playing_view();
        for entry in view.queue.iter_mut().skip(8) {
            entry.autoplay = true;
        }
        view
    }

    #[test]
    fn clears_the_queue_after_asking() {
        let mut nav = Nav::new();
        nav.tab = Tab::NowPlaying;
        nav.on_session(view_with_autoplay());
        assert_eq!(nav.clearable(), 7);
        // Controls, over to Queue, open it.
        press(&mut nav, &[Key::Ok]);
        nav.control = CONTROLS
            .iter()
            .position(|control| *control == Control::Queue)
            .unwrap();
        press(&mut nav, &[Key::Ok]);
        assert_eq!(nav.panel, Panel::Queue);
        // Up from the first song reaches Clear, which asks first.
        press(&mut nav, &[Key::Up]);
        assert!(nav.queue_on_clear);
        assert_eq!(press(&mut nav, &[Key::Ok]), vec![]);
        let menu = nav.menu.clone().unwrap();
        assert_eq!(menu.title, "Clear the queue?");
        assert_eq!(
            menu.subtitle,
            "This takes out the 7 songs queued after this one. Autoplay’s songs stay."
        );
        // "Not now" has the selection: OK changes nothing.
        assert_eq!(menu.items[menu.selected], MenuAction::Close);
        assert_eq!(press(&mut nav, &[Key::Ok]), vec![]);
        assert!(nav.menu.is_none());
        let effects = press(&mut nav, &[Key::Ok, Key::Up, Key::Ok]);
        assert_eq!(effects, vec![Effect::Session(UiAction::ClearUpcoming)]);
        assert_eq!(
            nav.notice(Instant::now()),
            Some("Took 7 songs out of the queue")
        );
        // Once only autoplay's songs follow, Clear goes and the songs have it.
        let mut cleared = view_with_autoplay();
        cleared.queue.drain(1..8);
        nav.on_session(cleared);
        assert_eq!(nav.clearable(), 0);
        assert!(!nav.queue_on_clear);
        press(&mut nav, &[Key::Up]);
        assert!(!nav.queue_on_clear);
    }

    #[test]
    fn the_queue_menu_offers_clear_too() {
        let mut nav = Nav::new();
        nav.tab = Tab::NowPlaying;
        nav.on_session(playing_view());
        press(&mut nav, &[Key::Ok]);
        nav.control = CONTROLS
            .iter()
            .position(|control| *control == Control::Queue)
            .unwrap();
        press(&mut nav, &[Key::Ok, Key::Down, Key::Hold]);
        let menu = nav.menu.clone().unwrap();
        let index = menu
            .items
            .iter()
            .position(|item| *item == MenuAction::AskClearUpcoming)
            .unwrap();
        nav.menu.as_mut().unwrap().selected = index;
        press(&mut nav, &[Key::Ok]);
        assert_eq!(nav.menu.as_ref().unwrap().title, "Clear the queue?");
    }

    /// Type `query` on a real keyboard, and answer the search.
    fn search_for(nav: &mut Nav, query: &str) {
        for character in query.chars() {
            nav.key(Key::Char(character), Instant::now());
        }
        nav.on_search(query, Ok(shelves()));
    }

    #[test]
    fn remembers_searches_whose_results_were_used() {
        let mut nav = Nav::new();
        nav.tab = Tab::Search;
        search_for(&mut nav, "daft");
        // Merely typing remembers nothing.
        assert!(nav.search.recent.is_empty());
        nav.search.in_results = true;
        let effects = press(&mut nav, &[Key::Ok]);
        assert_eq!(effects[0], Effect::SaveSearches(vec!["daft".into()]));
        // Clear the query: the recent searches show, Right reaches them.
        for _ in 0..4 {
            nav.key(Key::Backspace, Instant::now());
        }
        assert!(nav.search.showing_recent());
        nav.search.key = KEY_COLUMNS - 1;
        press(&mut nav, &[Key::Right]);
        assert!(nav.search.in_recent);
        // OK searches again.
        let effects = press(&mut nav, &[Key::Ok]);
        assert_eq!(nav.search.query, "daft");
        assert_eq!(effects, vec![Effect::Search("daft".into())]);
        assert!(!nav.search.in_recent);
    }

    #[test]
    fn keeps_the_latest_eight_searches_once_each() {
        let mut nav = Nav::new();
        nav.set_recent_searches(
            ["a", " ", "b", "c", "d", "e", "f", "g", "h", "i"]
                .map(String::from)
                .to_vec(),
        );
        assert_eq!(nav.search.recent.len(), MAX_RECENT_SEARCHES);
        assert_eq!(nav.search.recent[1], "b");
        assert!(nav.search.remember("c"));
        assert_eq!(nav.search.recent[..3], ["c", "a", "b"]);
        assert!(!nav.search.remember("c"));
        assert!(nav.search.remember("new"));
        assert_eq!(nav.search.recent.len(), MAX_RECENT_SEARCHES);
        assert_eq!(nav.search.recent[0], "new");
    }

    #[test]
    fn removes_and_clears_recent_searches() {
        let mut nav = Nav::new();
        nav.tab = Tab::Search;
        nav.set_recent_searches(vec!["one".into(), "two".into()]);
        nav.search.key = KEY_COLUMNS - 1;
        press(&mut nav, &[Key::Right, Key::Down, Key::Hold]);
        let menu = nav.menu.clone().unwrap();
        assert_eq!(menu.items[0], MenuAction::RemoveSearch("two".into()));
        let effects = press(&mut nav, &[Key::Ok]);
        assert_eq!(effects, vec![Effect::SaveSearches(vec!["one".into()])]);
        assert_eq!(nav.search.recent_row, 0);
        press(&mut nav, &[Key::Hold, Key::Down]);
        let effects = press(&mut nav, &[Key::Ok]);
        assert_eq!(effects, vec![Effect::SaveSearches(Vec::new())]);
        assert!(!nav.search.in_recent);
        assert!(!nav.search.showing_recent());
    }

    #[test]
    fn shuffles_every_item_once() {
        let mut items = shuffled((0..50).collect::<Vec<_>>(), Instant::now());
        items.sort_unstable();
        assert_eq!(items, (0..50).collect::<Vec<_>>());
    }
}
