//! Where the remote is: which tab, page, and item is selected, and what each
//! key does there. Plain data with no Slint in it, so every move is testable
//! on the host. [`Nav::key`] returns [`Effect`]s for the caller to carry out
//! (session commands, catalog loads); their results come back through the
//! `on_*` methods.

use std::borrow::Cow;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::catalog::{
    Card, CardKind, Collection, CollectionKind, LIKED_PLAYLIST_ID, Link, SaveKind, Shelf, SongLinks,
};
use crate::controller::UiAction;
use crate::lyrics::SongLyrics;
use crate::protocol::{Placement, PlayingFrom, PlayingFromKind, QueueTrack};
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
    /// Find the album and artists of the song with this videoId
    /// ([`Nav::on_song_links`]).
    LoadSongLinks(String),
    /// Fetch the playlists made in the app, then offer them for this song
    /// ([`Nav::show_playlists`]).
    LoadPlaylists(QueueTrack),
    AddToPlaylist {
        playlist_id: String,
        track: QueueTrack,
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
    InstallUpdate,
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
    /// Open an album or artist, named by it: one of a song's artists.
    OpenLink(CollectionKind, Link),
    /// Pick which of the song's artists to open.
    ChooseArtist(Vec<Link>),
    Like(QueueTrack),
    Unlike(QueueTrack),
    /// Play the song's radio (`UiAction::StartRadio`).
    StartRadio(QueueTrack),
    /// Pick one of your playlists to add the song to.
    ChoosePlaylist(QueueTrack),
    /// Add the song to this playlist, named by its title.
    AddToPlaylist {
        id: String,
        title: String,
        track: QueueTrack,
    },
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
    InstallUpdate,
    /// Open what the queue plays from: its page, or its search.
    GoTo(PlayingFrom),
    /// Show the code guests scan to add songs, large.
    ShowScanCode,
    /// Turn Sound Check on (`true`) or off, for the whole session.
    SetSoundCheck(bool),
    /// Close the menu.
    Close,
    /// Close the menu, declining what it offers.
    Decline,
}

impl MenuAction {
    pub fn label(&self) -> Cow<'_, str> {
        Cow::Borrowed(match self {
            MenuAction::Play(_) => "Play now",
            MenuAction::Shuffle(_) => "Shuffle",
            MenuAction::PlayNext(_) => "Play next",
            MenuAction::AddToQueue(_) => "Add to queue",
            MenuAction::Open(CollectionKind::Artist, _) => "Go to artist",
            MenuAction::Open(CollectionKind::Album, _) => "Go to album",
            MenuAction::Open(CollectionKind::Playlist | CollectionKind::MyPlaylist, _) => {
                "Go to playlist"
            }
            MenuAction::OpenLink(_, link) => &link.name,
            MenuAction::ChooseArtist(_) => "Go to artist",
            MenuAction::Like(_) => "Add to Liked Songs",
            MenuAction::Unlike(_) => "Remove from Liked Songs",
            MenuAction::StartRadio(_) => "Start radio",
            MenuAction::ChoosePlaylist(_) => "Add to a playlist",
            MenuAction::AddToPlaylist { title, .. } => title,
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
            MenuAction::InstallUpdate => "Install update",
            MenuAction::GoTo(from) => match from.kind {
                PlayingFromKind::Album => "Go to album",
                PlayingFromKind::Playlist | PlayingFromKind::MyPlaylist => "Go to playlist",
                PlayingFromKind::Artist => "Go to artist",
                PlayingFromKind::Mix => "Go to mix",
                PlayingFromKind::Radio => "Go to radio",
                PlayingFromKind::Search => {
                    return Cow::Owned(format!("Back to “{}” results", from.title));
                }
            },
            MenuAction::ShowScanCode => "Show code to add songs",
            MenuAction::SetSoundCheck(true) => "Turn on Sound Check",
            MenuAction::SetSoundCheck(false) => "Turn off Sound Check",
            MenuAction::Close => "Cancel",
            MenuAction::Decline => "Not now",
        })
    }

    pub fn icon(&self) -> &'static str {
        match self {
            MenuAction::Play(_) | MenuAction::PlayEntry(_) => "play",
            MenuAction::Shuffle(_) => "shuffle",
            MenuAction::PlayNext(_) => "play-next",
            MenuAction::AddToQueue(_) => "queue",
            MenuAction::Open(CollectionKind::Artist, _)
            | MenuAction::OpenLink(CollectionKind::Artist, _)
            | MenuAction::ChooseArtist(_) => "artist",
            MenuAction::Open(_, _) | MenuAction::OpenLink(_, _) => "open",
            MenuAction::Like(_) => "heart",
            MenuAction::Unlike(_) => "heart-outline",
            MenuAction::StartRadio(_) => "radio",
            MenuAction::ChoosePlaylist(_) | MenuAction::AddToPlaylist { .. } => "add",
            MenuAction::SetSaved { saved: true, .. } => "add",
            MenuAction::SetSaved { saved: false, .. } => "remove",
            MenuAction::RemoveEntry(_)
            | MenuAction::AskClearUpcoming
            | MenuAction::ClearUpcoming
            | MenuAction::RemoveSearch(_)
            | MenuAction::ClearSearches => "remove",
            MenuAction::OpenUpdateSettings => "settings",
            MenuAction::CheckForUpdates | MenuAction::InstallUpdate => "update",
            MenuAction::GoTo(from) => match from.kind {
                PlayingFromKind::Artist => "artist",
                PlayingFromKind::Search => "search",
                PlayingFromKind::Album
                | PlayingFromKind::Playlist
                | PlayingFromKind::MyPlaylist
                | PlayingFromKind::Mix
                | PlayingFromKind::Radio => "open",
            },
            MenuAction::ShowScanCode => "qr",
            MenuAction::SetSoundCheck(_) => "now",
            MenuAction::Close | MenuAction::Decline => "close",
        }
    }
}

/// What a collection played from its page is, for the session's
/// `playingFrom`. A playlist whose id is one of YouTube Music's radios (a
/// mix made on Home) plays as a mix, as on the phone.
pub fn playing_from(kind: CollectionKind, id: &str, title: &str) -> PlayingFrom {
    let kind = match kind {
        CollectionKind::Album => PlayingFromKind::Album,
        CollectionKind::Artist => PlayingFromKind::Artist,
        CollectionKind::MyPlaylist => PlayingFromKind::MyPlaylist,
        CollectionKind::Playlist if id.starts_with("RD") => PlayingFromKind::Mix,
        CollectionKind::Playlist => PlayingFromKind::Playlist,
    };
    PlayingFrom {
        kind,
        title: title.to_owned(),
        id: id.to_owned(),
    }
}

/// Songs played from search results say what was searched for.
pub fn playing_from_search(query: &str) -> PlayingFrom {
    PlayingFrom {
        kind: PlayingFromKind::Search,
        title: query.to_owned(),
        id: query.to_owned(),
    }
}

/// A song's radio, as the phone names it: YouTube Music's radio playlist
/// for the song (`songRadioPlaylistId` in `packages/shared`), titled by it.
pub fn playing_from_radio(track: &QueueTrack) -> PlayingFrom {
    PlayingFrom {
        kind: PlayingFromKind::Radio,
        title: track.title.clone(),
        id: format!("RDAMVM{}", track.video_id),
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

    /// Takes the shelves loaded again (Home and Library reload on every
    /// visit). The selection stays on the same card, even when its shelf
    /// moved or cards came before it, and each row keeps its place by its
    /// title. A reload that fails keeps the shelves already shown.
    pub fn refresh(&mut self, result: Result<Vec<Shelf>, String>, visible: usize) {
        let after = match (self.content.loaded(), result) {
            (Some(_), Err(_)) => return,
            (None, result) => return self.set(to_load(result)),
            (Some(_), Ok(after)) => after,
        };
        let before = self.shelves();
        // Where each new row was, and the card selected on it.
        let places: Vec<Option<(usize, usize)>> = after
            .iter()
            .map(|shelf| {
                let index = before.iter().position(|old| old.title == shelf.title)?;
                let column = self.columns.get(index).copied().unwrap_or(0);
                let found = before[index].cards.get(column).and_then(|selected| {
                    shelf.cards.iter().position(|card| card.id == selected.id)
                });
                let offset = self.offsets.get(index).copied().unwrap_or(0);
                Some((found.unwrap_or(column), offset))
            })
            .collect();
        let row = before
            .get(self.row)
            .and_then(|selected| after.iter().position(|shelf| shelf.title == selected.title))
            .unwrap_or(self.row);
        self.columns = places
            .iter()
            .map(|place| place.map_or(0, |(column, _)| column))
            .collect();
        self.offsets = places
            .iter()
            .map(|place| place.map_or(0, |(_, offset)| offset))
            .collect();
        self.row = row;
        let counts: Vec<usize> = after.iter().map(|shelf| shelf.cards.len()).collect();
        self.set(Load::Loaded(after));
        // A card that moved along its row stays in view.
        for (index, count) in counts.into_iter().enumerate() {
            self.offsets[index] =
                keep_visible(self.offsets[index], self.columns[index], visible, count);
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
/// The Library's shelf titles (`libraryShelves` in the server's
/// `tvCatalog/mapping.ts`).
pub const LIBRARY_PLAYLISTS: &str = "Your playlists";
pub const LIBRARY_ALBUMS: &str = "Albums";
pub const LIBRARY_ARTISTS: &str = "Artists";

/// A Library row with fewer cards than this gets a tip beside them.
pub const LIBRARY_TIP_BELOW: usize = 4;

/// What a short Library row says in the room beside its cards: how to fill
/// it, so a new library looks meant rather than empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShelfTip {
    pub title: &'static str,
    pub body: &'static str,
}

const SAVE_ALBUMS: ShelfTip = ShelfTip {
    title: "Save albums",
    body: "Open an album and pick +, or hold OK on one. Albums saved on your phone show up here too.",
};
const FOLLOW_ARTISTS: ShelfTip = ShelfTip {
    title: "Follow artists",
    body: "Open an artist and pick +, or hold OK on one. Their new releases then show up on Home.",
};
const SAVE_BOTH: ShelfTip = ShelfTip {
    title: "Save albums and follow artists",
    body: "Pick + on an album or an artist, or hold OK on one. They show up here and on your phone.",
};
const MAKE_PLAYLISTS: ShelfTip = ShelfTip {
    title: "Make playlists",
    body: "Playlists you make on your phone show up here, Liked Songs first.",
};

/// The tip for Library row `index`, when the row is short. The last row
/// also says how to add the kinds the Library has none of yet.
pub fn library_tip(shelves: &[Shelf], index: usize) -> Option<ShelfTip> {
    let shelf = shelves.get(index)?;
    if shelf.cards.len() >= LIBRARY_TIP_BELOW {
        return None;
    }
    let has = |title: &str| shelves.iter().any(|shelf| shelf.title == title);
    let last = index + 1 == shelves.len();
    if last && !(has(LIBRARY_ALBUMS) && has(LIBRARY_ARTISTS)) {
        return Some(SAVE_BOTH);
    }
    match shelf.title.as_str() {
        LIBRARY_PLAYLISTS => Some(MAKE_PLAYLISTS),
        LIBRARY_ALBUMS => Some(SAVE_ALBUMS),
        LIBRARY_ARTISTS => Some(FOLLOW_ARTISTS),
        _ => None,
    }
}

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

    /// What songs played from this page come from.
    fn playing_from(&self) -> Option<PlayingFrom> {
        let collection = self.content.loaded()?;
        Some(playing_from(self.kind, &self.id, &collection.title))
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
/// After that, the controls bring the scan code only while this many songs
/// or fewer are queued after this one (autoplay's don't count), so it asks
/// for songs when they run short and otherwise leaves the room to Up Next.
pub const SHORT_QUEUE: usize = 3;
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
    /// The current song's album and artists, for its menu, once asked.
    pub links: Option<(String, Load<SongLinks>)>,
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
    /// The scan code shows large, from the settings menu.
    pub scan_card: bool,
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
            links: None,
            saved: HashMap::new(),
            lyrics: None,
            notice: None,
            back_pressed: None,
            queue_followed: None,
            first_session: true,
            song_started: None,
            scan_card: false,
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
            self.links = None;
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
        if !self.session.is_idle()
            && self.tab != Tab::NowPlaying
            && self.menu.is_none()
            && !self.scan_card
        {
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

    /// Whether the now-playing screen shows the scan code: for a short
    /// while after each song starts, and with the controls while the queue
    /// runs short ([`SHORT_QUEUE`]). Nothing playing has its own, larger
    /// code, and the settings menu shows it any time.
    pub fn scan_code_shown(&self, now: Instant) -> bool {
        let starting = self
            .song_started
            .is_some_and(|at| now.saturating_duration_since(at) < SCAN_CODE_AFTER_START);
        starting || (self.controls_shown() && self.clearable() <= SHORT_QUEUE)
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
        self.home.shelves.refresh(result, HOME_CARDS_VISIBLE);
    }

    pub fn on_library(&mut self, result: Result<Vec<Shelf>, String>) {
        self.library.shelves.refresh(result, HOME_CARDS_VISIBLE);
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
            self.refresh_song_menu(video_id);
        }
    }

    /// The album and artists of the song with this videoId, for its menu.
    /// An open menu for the song takes them in, keeping its selection.
    pub fn on_song_links(&mut self, video_id: &str, result: Result<SongLinks, String>) {
        if let Some((current, load)) = &mut self.links
            && current == video_id
        {
            *load = to_load(result);
            self.refresh_song_menu(video_id);
        }
    }

    /// Offer the playlists made in the app (the MyPlaylist cards of the
    /// Library's shelves, but Liked songs) to add `track` to.
    pub fn show_playlists(
        &mut self,
        track: QueueTrack,
        library: Result<Vec<Shelf>, String>,
        now: Instant,
    ) {
        let shelves = match library {
            Ok(shelves) => shelves,
            Err(message) => return self.say(message, now),
        };
        let mut items: Vec<MenuAction> = shelves
            .iter()
            .flat_map(|shelf| shelf.cards.iter())
            .filter(|card| card.kind == CardKind::MyPlaylist && card.id != LIKED_PLAYLIST_ID)
            .map(|card| MenuAction::AddToPlaylist {
                id: card.id.clone(),
                title: card.title.clone(),
                track: track.clone(),
            })
            .collect();
        if items.is_empty() {
            return self.say("Make a playlist on your phone first", now);
        }
        items.push(MenuAction::Close);
        self.menu = Some(Menu {
            title: "Add to a playlist".into(),
            subtitle: track.title,
            items,
            selected: 0,
        });
    }

    /// The server added a song to a playlist, or found it there already.
    pub fn on_added_to_playlist(&mut self, title: &str, added: bool, now: Instant) {
        self.say(
            if added {
                format!("Added to {title}")
            } else {
                format!("Already in {title}")
            },
            now,
        );
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
            subtitle: "Turn on “Install unknown apps” for Joshify once. After that, pick Install update in Settings when an update is ready.".into(),
            items: vec![MenuAction::OpenUpdateSettings, MenuAction::Decline],
            selected: 0,
        });
    }

    /// The settings menu: `about` is the version and how updates stand.
    /// With an update `ready`, it offers to install it instead of checking.
    /// Sound Check belongs to the session, so it shows once the TV is in it.
    pub fn show_settings(&mut self, about: String, ready: bool) {
        let update = if ready {
            MenuAction::InstallUpdate
        } else {
            MenuAction::CheckForUpdates
        };
        let mut items = vec![update, MenuAction::ShowScanCode];
        if self.session.connected {
            items.push(MenuAction::SetSoundCheck(!self.session.sound_check));
        }
        items.push(MenuAction::Close);
        self.menu = Some(Menu {
            title: "Joshify".into(),
            subtitle: about,
            items,
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
        if self.scan_card {
            if matches!(key, Key::Ok | Key::Back) {
                self.scan_card = false;
            }
            return (true, effects);
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
            // What played lately changes all the time, so Home reloads on
            // every visit too, showing what it had meanwhile.
            Tab::Home if self.home.shelves.content != Load::Loading => {
                if self.home.shelves.content == Load::NotLoaded {
                    self.home.shelves.content = Load::Loading;
                }
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
            Key::Hold => self.song_menu(effects),
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
            Key::Hold => self.song_menu(effects),
            Key::Back if self.scrub.is_some() => self.scrub = None,
            Key::Back => self.hide_controls(),
            _ => {}
        }
        true
    }

    /// The song playing's menu. Its album and artists come from the server
    /// the first time it opens for a song, and join it when they arrive.
    fn song_menu(&mut self, effects: &mut Vec<Effect>) {
        let Some(track) = self
            .session
            .current_entry()
            .map(|entry| entry.track.clone())
        else {
            return;
        };
        let asked = self
            .links
            .as_ref()
            .is_some_and(|(id, load)| *id == track.video_id && !matches!(load, Load::Failed(_)));
        if !asked {
            self.links = Some((track.video_id.clone(), Load::Loading));
            effects.push(Effect::LoadSongLinks(track.video_id.clone()));
        }
        self.menu = Some(Menu {
            title: track.title.clone(),
            subtitle: track.artists.clone(),
            items: self.song_menu_items(&track),
            selected: 0,
        });
    }

    /// Like or unlike, add to a playlist, start its radio, go to its album
    /// and artists (a choice when there are several), and go to what the
    /// queue plays from when that is something else.
    fn song_menu_items(&self, track: &QueueTrack) -> Vec<MenuAction> {
        let liked = self
            .liked
            .as_ref()
            .is_some_and(|(id, liked)| *id == track.video_id && *liked);
        let mut items = vec![
            if liked {
                MenuAction::Unlike(track.clone())
            } else {
                MenuAction::Like(track.clone())
            },
            MenuAction::ChoosePlaylist(track.clone()),
            MenuAction::StartRadio(track.clone()),
        ];
        let links = self
            .links
            .as_ref()
            .filter(|(id, _)| *id == track.video_id)
            .and_then(|(_, load)| load.loaded());
        let link = |kind: PlayingFromKind, link: &Link| PlayingFrom {
            kind,
            title: link.name.clone(),
            id: link.id.clone(),
        };
        if let Some(links) = links {
            if let Some(album) = &links.album {
                items.push(MenuAction::GoTo(link(PlayingFromKind::Album, album)));
            }
            match links.artists.as_slice() {
                [] => {}
                [artist] => items.push(MenuAction::GoTo(link(PlayingFromKind::Artist, artist))),
                artists => items.push(MenuAction::ChooseArtist(artists.to_vec())),
            }
        }
        if let Some(from) = self.go_to_item() {
            let shown = links.is_some_and(|links| match from {
                MenuAction::GoTo(PlayingFrom {
                    kind: PlayingFromKind::Album,
                    ref id,
                    ..
                }) => links.album.as_ref().is_some_and(|album| album.id == *id),
                MenuAction::GoTo(PlayingFrom {
                    kind: PlayingFromKind::Artist,
                    ref id,
                    ..
                }) => links.artists.iter().any(|artist| artist.id == *id),
                _ => false,
            });
            if !shown {
                items.push(from);
            }
        }
        items.push(MenuAction::Close);
        items
    }

    /// The song menu for `video_id`, if open, built again with what is now
    /// known, keeping the selection on the same item.
    fn refresh_song_menu(&mut self, video_id: &str) {
        let Some(menu) = &self.menu else { return };
        let is_song_menu = menu.items.iter().any(
            |item| matches!(item, MenuAction::StartRadio(track) if track.video_id == video_id),
        );
        let Some(track) = self
            .session
            .current_entry()
            .map(|entry| entry.track.clone())
            .filter(|track| is_song_menu && track.video_id == video_id)
        else {
            return;
        };
        let selected = menu.items.get(menu.selected).cloned();
        let items = self.song_menu_items(&track);
        let selected = selected
            .and_then(|wanted| {
                items.iter().position(|item| {
                    *item == wanted
                        || matches!(
                            (item, &wanted),
                            (MenuAction::Like(_), MenuAction::Unlike(_))
                                | (MenuAction::Unlike(_), MenuAction::Like(_))
                        )
                })
            })
            .unwrap_or(0);
        if let Some(menu) = &mut self.menu {
            menu.items = items;
            menu.selected = selected;
        }
    }

    /// "Go to album" and the like, when the queue plays from something
    /// and the song playing is one of its own, not one autoplay added.
    fn go_to_item(&self) -> Option<MenuAction> {
        if self
            .session
            .current_entry()
            .is_some_and(|entry| entry.autoplay)
        {
            return None;
        }
        self.session.playing_from.clone().map(MenuAction::GoTo)
    }

    /// Like or unlike a song, showing it at once.
    fn set_liked(
        &mut self,
        track: QueueTrack,
        liked: bool,
        now: Instant,
        effects: &mut Vec<Effect>,
    ) {
        if self
            .session
            .current_entry()
            .is_some_and(|entry| entry.track.video_id == track.video_id)
        {
            self.liked = Some((track.video_id.clone(), liked));
        }
        effects.push(Effect::SetLiked { track, liked });
        self.say(
            if liked {
                "Added to Liked Songs"
            } else {
                "Removed from Liked Songs"
            },
            now,
        );
    }

    /// Open what the queue plays from where the phone would: your own
    /// playlists under Library, the rest of YouTube Music under Search, and
    /// a search as the words searched for.
    fn go_to(&mut self, from: PlayingFrom, effects: &mut Vec<Effect>) {
        self.panel = Panel::None;
        self.queue_on_clear = false;
        self.focus = Focus::Content;
        let kind = match from.kind {
            PlayingFromKind::Search => {
                self.switch_tab(Tab::Search, effects);
                let search = &mut self.search;
                search.browse.stack.clear();
                search.query = from.id;
                search.in_results = false;
                search.in_recent = false;
                effects.extend(self.query_changed());
                return;
            }
            PlayingFromKind::Album => CollectionKind::Album,
            PlayingFromKind::Artist => CollectionKind::Artist,
            PlayingFromKind::MyPlaylist => CollectionKind::MyPlaylist,
            PlayingFromKind::Playlist | PlayingFromKind::Mix | PlayingFromKind::Radio => {
                CollectionKind::Playlist
            }
        };
        let tab = if kind == CollectionKind::MyPlaylist {
            Tab::Library
        } else {
            Tab::Search
        };
        self.switch_tab(tab, effects);
        let open = self
            .collection()
            .is_some_and(|page| page.kind == kind && page.id == from.id);
        if !open {
            self.open_collection(kind, from.id, effects);
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
                let Some(track) = self
                    .session
                    .current_entry()
                    .map(|entry| entry.track.clone())
                else {
                    return;
                };
                let liked = self
                    .liked
                    .as_ref()
                    .is_some_and(|(id, liked)| *id == track.video_id && *liked);
                self.set_liked(track, !liked, now, effects);
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

    /// Clear takes songs out of the queue, so it asks first. "Cancel" has
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
                    items.extend(self.go_to_item());
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
                    self.open_card(&card, songs, None, now, effects);
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

    /// OK on a card: a song plays its row from there, saying what the row
    /// comes `from`; anything else opens.
    fn open_card(
        &mut self,
        card: &Card,
        (tracks, start): (Vec<QueueTrack>, usize),
        from: Option<PlayingFrom>,
        now: Instant,
        effects: &mut Vec<Effect>,
    ) {
        if card.track.is_some() {
            effects.push(Effect::Session(UiAction::PlayTracks {
                tracks,
                start,
                from,
                shuffle: None,
            }));
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
                        let from = playing_from_search(&self.search.results_for);
                        self.open_card(&card, songs, Some(from), now, effects);
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
                        let from = page.playing_from();
                        self.play_tracks(tracks, from, button, now, effects);
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
                            from: page.playing_from(),
                            shuffle: None,
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
                                self.open_card(&card, songs, None, now, effects);
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
        from: Option<PlayingFrom>,
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
                effects.push(Effect::Session(UiAction::PlayTracks {
                    tracks,
                    start: 0,
                    from,
                    shuffle: Some(false),
                }));
            }
            CollectionButton::Shuffle => {
                effects.push(Effect::Session(UiAction::PlayTracks {
                    start: random_index(tracks.len(), now),
                    tracks,
                    from,
                    shuffle: Some(true),
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
            // A song played from its menu plays on its own, from nothing.
            Target::Tracks(tracks) => effects.push(Effect::Session(match mode {
                PlayMode::Play => UiAction::PlayTracks {
                    tracks,
                    start: 0,
                    from: None,
                    shuffle: Some(false),
                },
                PlayMode::Shuffle => UiAction::PlayTracks {
                    start: random_index(tracks.len(), now),
                    tracks,
                    from: None,
                    shuffle: Some(true),
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
            MenuAction::Like(track) => self.set_liked(track, true, now, effects),
            MenuAction::Unlike(track) => self.set_liked(track, false, now, effects),
            MenuAction::StartRadio(track) => {
                effects.push(Effect::Session(UiAction::StartRadio(track)));
                self.say("Starting radio", now);
            }
            MenuAction::ChoosePlaylist(track) => effects.push(Effect::LoadPlaylists(track)),
            MenuAction::AddToPlaylist { id, track, .. } => effects.push(Effect::AddToPlaylist {
                playlist_id: id,
                track,
            }),
            MenuAction::ChooseArtist(artists) => {
                let mut items: Vec<MenuAction> = artists
                    .into_iter()
                    .map(|artist| MenuAction::OpenLink(CollectionKind::Artist, artist))
                    .collect();
                items.push(MenuAction::Close);
                self.menu = Some(Menu {
                    title: "Go to artist".into(),
                    subtitle: String::new(),
                    items,
                    selected: 0,
                });
            }
            MenuAction::OpenLink(kind, link) => {
                let kind = match kind {
                    CollectionKind::Artist => PlayingFromKind::Artist,
                    CollectionKind::Album => PlayingFromKind::Album,
                    CollectionKind::MyPlaylist => PlayingFromKind::MyPlaylist,
                    CollectionKind::Playlist => PlayingFromKind::Playlist,
                };
                self.go_to(
                    PlayingFrom {
                        kind,
                        title: link.name,
                        id: link.id,
                    },
                    effects,
                );
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
            MenuAction::InstallUpdate => effects.push(Effect::InstallUpdate),
            MenuAction::GoTo(from) => self.go_to(from, effects),
            MenuAction::ShowScanCode => self.scan_card = true,
            MenuAction::SetSoundCheck(enabled) => {
                effects.push(Effect::Session(UiAction::SetSoundCheck(enabled)));
                self.say(
                    if enabled {
                        "Sound Check is on: every song plays at the same volume"
                    } else {
                        "Sound Check is off"
                    },
                    now,
                );
            }
            MenuAction::Close | MenuAction::Decline => {}
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

/// Where a Shuffle button starts: a random song. The server shuffles the
/// rest and keeps the list's order for when shuffle is turned off.
pub fn random_index(len: usize, now: Instant) -> usize {
    shuffled((0..len).collect(), now)
        .first()
        .copied()
        .unwrap_or(0)
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
    fn short_library_rows_say_how_to_fill_them() {
        let shelf = |title: &str, count: usize| Shelf {
            title: title.into(),
            cards: (0..count)
                .map(|index| album_card(&format!("c{index}")))
                .collect(),
        };
        // Liked Songs and one playlist, one album, no artists yet.
        let sparse = vec![shelf(LIBRARY_PLAYLISTS, 2), shelf(LIBRARY_ALBUMS, 1)];
        assert_eq!(library_tip(&sparse, 0), Some(MAKE_PLAYLISTS));
        assert_eq!(library_tip(&sparse, 1), Some(SAVE_BOTH));
        // Only Liked Songs: the one row says how to add the rest.
        assert_eq!(library_tip(&sparse[..1], 0), Some(SAVE_BOTH));
        let full = vec![
            shelf(LIBRARY_PLAYLISTS, 9),
            shelf(LIBRARY_ALBUMS, 2),
            shelf(LIBRARY_ARTISTS, 1),
        ];
        assert_eq!(library_tip(&full, 0), None);
        assert_eq!(library_tip(&full, 1), Some(SAVE_ALBUMS));
        assert_eq!(library_tip(&full, 2), Some(FOLLOW_ARTISTS));
        assert_eq!(library_tip(&full, 3), None);
    }

    #[test]
    fn a_reload_keeps_the_selection_on_the_same_card() {
        let mut nav = Nav::new();
        nav.on_home(Ok(shelves()));
        press(&mut nav, &[Key::Down, Key::Right]);
        assert_eq!(nav.home.shelves.selected_card().unwrap().id, "a1");
        // Something played meanwhile: a new shelf leads, and a new album
        // comes before the one selected.
        let mut reloaded = shelves();
        reloaded[1].cards.insert(0, album_card("new"));
        reloaded.insert(
            0,
            Shelf {
                title: "More like Song s0".into(),
                cards: vec![song_card("m0")],
            },
        );
        nav.on_home(Ok(reloaded));
        assert_eq!(nav.home.shelves.row, 2);
        assert_eq!(nav.home.shelves.selected_card().unwrap().id, "a1");
    }

    #[test]
    fn a_reload_that_fails_keeps_the_shelves_shown() {
        let mut nav = Nav::new();
        nav.on_home(Ok(shelves()));
        nav.on_home(Err("Can't reach the music server".into()));
        assert_eq!(nav.home.shelves.content, Load::Loaded(shelves()));
        // A first load that fails says so.
        nav.on_library(Err("Can't reach the music server".into()));
        assert!(matches!(nav.library.shelves.content, Load::Failed(_)));
    }

    #[test]
    fn home_reloads_on_every_visit() {
        let mut nav = Nav::new();
        nav.on_home(Ok(shelves()));
        let mut effects = Vec::new();
        nav.switch_tab(Tab::Search, &mut effects);
        nav.switch_tab(Tab::Home, &mut effects);
        assert_eq!(effects, vec![Effect::LoadHome]);
        // Still showing what it had while it reloads.
        assert_eq!(nav.home.shelves.content, Load::Loaded(shelves()));
    }

    #[test]
    fn a_mix_opens_as_a_playlist() {
        let mut nav = Nav::new();
        nav.on_home(Ok(vec![Shelf {
            title: "Your mixes".into(),
            cards: vec![Card {
                kind: CardKind::Playlist,
                id: "RDAMVMcobra".into(),
                title: "Mix: Geese".into(),
                subtitle: "Based on Cobra".into(),
                artwork_url: None,
                track: None,
            }],
        }]));
        assert_eq!(
            press(&mut nav, &[Key::Ok]),
            vec![Effect::LoadCollection {
                tab: Tab::Home,
                kind: CollectionKind::Playlist,
                id: "RDAMVMcobra".into(),
            }]
        );
    }

    #[test]
    fn plays_a_song_card_with_the_rest_of_its_row() {
        let mut nav = Nav::new();
        nav.on_home(Ok(shelves()));
        let effects = press(&mut nav, &[Key::Right, Key::Right, Key::Ok]);
        let Effect::Session(UiAction::PlayTracks {
            tracks,
            start,
            from,
            shuffle,
        }) = &effects[0]
        else {
            panic!("expected PlayTracks, got {effects:?}");
        };
        assert_eq!(tracks.len(), 10);
        assert_eq!(*start, 2);
        // A tapped song plays as shuffle is now.
        assert_eq!(*shuffle, None);
        // A row of Home plays from nothing with a page, as on the phone.
        assert_eq!(*from, None);
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
        let Effect::Session(UiAction::PlayTracks { start, from, .. }) = &effects[0] else {
            panic!("expected PlayTracks, got {effects:?}");
        };
        assert_eq!(*start, 1);
        assert_eq!(
            *from,
            Some(PlayingFrom {
                kind: PlayingFromKind::Album,
                title: "Album a1".into(),
                id: "a1".into(),
            })
        );
        press(&mut nav, &[Key::Back]);
        assert!(nav.collection().is_none());
    }

    /// A loaded collection page of `kind` on the Home tab.
    fn open_page(nav: &mut Nav, kind: CollectionKind, id: &str, title: &str) {
        nav.tab = Tab::Home;
        nav.open_collection(kind, id.into(), &mut Vec::new());
        nav.on_collection(
            Tab::Home,
            kind,
            id,
            Ok(Collection {
                kind,
                id: id.into(),
                title: title.into(),
                subtitle: String::new(),
                description: None,
                artwork_url: None,
                tracks: vec![track("t0"), track("t1")],
                shelves: Vec::new(),
            }),
        );
    }

    fn played_from(effects: &[Effect]) -> Option<PlayingFrom> {
        effects.iter().find_map(|effect| match effect {
            Effect::Session(UiAction::PlayTracks { from, .. }) => from.clone(),
            _ => None,
        })
    }

    /// The songs, start, and shuffle of the first `PlayTracks`.
    fn played(effects: &[Effect]) -> (Vec<String>, usize, Option<bool>) {
        effects
            .iter()
            .find_map(|effect| match effect {
                Effect::Session(UiAction::PlayTracks {
                    tracks,
                    start,
                    shuffle,
                    ..
                }) => Some((
                    tracks.iter().map(|track| track.video_id.clone()).collect(),
                    *start,
                    *shuffle,
                )),
                _ => None,
            })
            .unwrap_or_else(|| panic!("expected PlayTracks, got {effects:?}"))
    }

    #[test]
    fn play_plays_in_order_shuffle_shuffles_and_a_song_keeps_the_setting() {
        let in_order = vec!["t0".to_owned(), "t1".to_owned()];
        // Play: in order, and shuffle off.
        let mut nav = Nav::new();
        open_page(&mut nav, CollectionKind::Album, "a1", "Album a1");
        assert_eq!(
            played(&press(&mut nav, &[Key::Ok])),
            (in_order.clone(), 0, Some(false))
        );
        // Shuffle: the list in its order, so turning shuffle off brings it
        // back, from a random song; the server shuffles the rest.
        let mut nav = Nav::new();
        open_page(&mut nav, CollectionKind::Album, "a1", "Album a1");
        let (tracks, start, shuffle) = played(&press(&mut nav, &[Key::Right, Key::Ok]));
        assert_eq!((tracks, shuffle), (in_order.clone(), Some(true)));
        assert!(start < 2);
        // A song in the list: as shuffle is now.
        let mut nav = Nav::new();
        open_page(&mut nav, CollectionKind::Album, "a1", "Album a1");
        assert_eq!(
            played(&press(&mut nav, &[Key::Down, Key::Down, Key::Ok])),
            (in_order, 1, None)
        );
        // Play now in a song's menu is a Play button.
        let mut nav = Nav::new();
        open_page(&mut nav, CollectionKind::Album, "a1", "Album a1");
        assert_eq!(
            played(&press(&mut nav, &[Key::Down, Key::Hold, Key::Ok])),
            (vec!["t0".to_owned()], 0, Some(false))
        );
    }

    #[test]
    fn random_index_stays_in_the_list() {
        assert_eq!(random_index(0, Instant::now()), 0);
        assert_eq!(random_index(1, Instant::now()), 0);
        assert!((0..20).all(|_| random_index(3, Instant::now()) < 3));
    }

    #[test]
    fn play_and_shuffle_say_what_the_page_is() {
        let mut nav = Nav::new();
        open_page(&mut nav, CollectionKind::MyPlaylist, "liked", "Liked Songs");
        assert_eq!(
            played_from(&press(&mut nav, &[Key::Ok])),
            Some(PlayingFrom {
                kind: PlayingFromKind::MyPlaylist,
                title: "Liked Songs".into(),
                id: "liked".into(),
            })
        );
        // Shuffle.
        let mut nav = Nav::new();
        open_page(&mut nav, CollectionKind::Artist, "UCgeese", "Geese");
        let from = played_from(&press(&mut nav, &[Key::Right, Key::Ok])).unwrap();
        assert_eq!(
            (from.kind, from.id.as_str()),
            (PlayingFromKind::Artist, "UCgeese")
        );
        // A mix made on Home is a playlist of YouTube Music's radio.
        let mut nav = Nav::new();
        open_page(
            &mut nav,
            CollectionKind::Playlist,
            "RDAMVMcobra",
            "Mix: Geese",
        );
        let from = played_from(&press(&mut nav, &[Key::Ok])).unwrap();
        assert_eq!(from.kind, PlayingFromKind::Mix);
        let mut nav = Nav::new();
        open_page(&mut nav, CollectionKind::Playlist, "PLroad", "Road Trip");
        let from = played_from(&press(&mut nav, &[Key::Ok])).unwrap();
        assert_eq!(from.kind, PlayingFromKind::Playlist);
    }

    #[test]
    fn a_song_from_search_results_plays_from_the_search() {
        let mut nav = Nav::new();
        nav.tab = Tab::Search;
        nav.search.query = "geese".into();
        nav.on_search("geese", Ok(shelves()));
        nav.search.in_results = true;
        let effects = press(&mut nav, &[Key::Right, Key::Ok]);
        assert_eq!(
            played_from(&effects),
            Some(PlayingFrom {
                kind: PlayingFromKind::Search,
                title: "geese".into(),
                id: "geese".into(),
            })
        );
    }

    #[test]
    fn the_menu_plays_a_collection_from_its_card() {
        let mut nav = Nav::new();
        nav.on_home(Ok(shelves()));
        // Hold on the album, then Play now: the page is fetched first, and
        // the screen says where it plays from once it has the title.
        press(&mut nav, &[Key::Down, Key::Right, Key::Hold]);
        assert_eq!(
            press(&mut nav, &[Key::Ok]),
            vec![Effect::PlayCollection {
                kind: CollectionKind::Album,
                id: "a1".into(),
                mode: PlayMode::Play,
            }]
        );
        assert_eq!(
            playing_from(CollectionKind::Album, "a1", "Album a1"),
            PlayingFrom {
                kind: PlayingFromKind::Album,
                title: "Album a1".into(),
                id: "a1".into(),
            }
        );
    }

    fn from_album() -> PlayingFrom {
        PlayingFrom {
            kind: PlayingFromKind::Album,
            title: "Getting Killed".into(),
            id: "MPREb_killed".into(),
        }
    }

    #[test]
    fn hold_on_now_playing_goes_to_what_the_queue_plays_from() {
        let mut nav = Nav::new();
        nav.on_session(View {
            playing_from: Some(from_album()),
            ..playing_view()
        });
        assert_eq!(nav.tab, Tab::NowPlaying);
        // The first key brings up the controls; then hold.
        press(&mut nav, &[Key::Right, Key::Hold]);
        let menu = nav.menu.as_ref().unwrap();
        assert_eq!(menu.items[3], MenuAction::GoTo(from_album()));
        assert_eq!(menu.items[3].label(), "Go to album");
        let effects = press(&mut nav, &[Key::Down, Key::Down, Key::Down, Key::Ok]);
        assert_eq!(nav.tab, Tab::Search);
        assert_eq!(nav.focus, Focus::Content);
        assert!(effects.contains(&Effect::LoadCollection {
            tab: Tab::Search,
            kind: CollectionKind::Album,
            id: "MPREb_killed".into(),
        }));
        let page = nav.collection().unwrap();
        assert_eq!(
            (page.kind, page.id.as_str()),
            (CollectionKind::Album, "MPREb_killed")
        );
        // Back returns to Search, and going again doesn't stack it twice.
        nav.show_now_playing();
        press(
            &mut nav,
            &[Key::Right, Key::Hold, Key::Down, Key::Down, Key::Down],
        );
        let effects = press(&mut nav, &[Key::Ok]);
        assert!(
            !effects
                .iter()
                .any(|effect| matches!(effect, Effect::LoadCollection { .. }))
        );
        assert_eq!(nav.search.browse.stack.len(), 1);
    }

    fn links(video_id: &str, artists: &[(&str, &str)]) -> SongLinks {
        SongLinks {
            video_id: video_id.into(),
            album: Some(Link {
                id: "MPREb_killed".into(),
                name: "Getting Killed".into(),
            }),
            artists: artists
                .iter()
                .map(|(id, name)| Link {
                    id: (*id).into(),
                    name: (*name).into(),
                })
                .collect(),
        }
    }

    #[test]
    fn the_song_menu_offers_everything_about_the_song() {
        let mut nav = Nav::new();
        let mix = PlayingFrom {
            kind: PlayingFromKind::Mix,
            title: "Mix: Geese".into(),
            id: "RDAMVMq9".into(),
        };
        nav.on_session(View {
            playing_from: Some(mix.clone()),
            ..playing_view()
        });
        nav.on_liked("q0", true);
        let effects = press(&mut nav, &[Key::Right, Key::Hold]);
        assert_eq!(effects, vec![Effect::LoadSongLinks("q0".into())]);
        let labels = |nav: &Nav| -> Vec<String> {
            let menu = nav.menu.as_ref().unwrap();
            menu.items
                .iter()
                .map(|item| item.label().into_owned())
                .collect()
        };
        assert_eq!(
            labels(&nav),
            [
                "Remove from Liked Songs",
                "Add to a playlist",
                "Start radio",
                "Go to mix",
                "Cancel"
            ]
        );
        // Down to Go to mix; the album and artists arrive and join the
        // menu, and the selection stays on the mix.
        press(&mut nav, &[Key::Down, Key::Down, Key::Down]);
        nav.on_song_links(
            "q0",
            Ok(links("q0", &[("UCg", "Geese"), ("UCc", "Cameron")])),
        );
        assert_eq!(
            labels(&nav),
            [
                "Remove from Liked Songs",
                "Add to a playlist",
                "Start radio",
                "Go to album",
                "Go to artist",
                "Go to mix",
                "Cancel"
            ]
        );
        assert_eq!(nav.menu.as_ref().unwrap().selected, 5);
        // Several artists: pick one.
        press(&mut nav, &[Key::Up, Key::Ok]);
        assert_eq!(labels(&nav), ["Geese", "Cameron", "Cancel"]);
        let effects = press(&mut nav, &[Key::Down, Key::Ok]);
        assert_eq!(nav.tab, Tab::Search);
        assert!(effects.contains(&Effect::LoadCollection {
            tab: Tab::Search,
            kind: CollectionKind::Artist,
            id: "UCc".into(),
        }));
        // The menu again asks for nothing it already knows.
        nav.show_now_playing();
        let effects = press(&mut nav, &[Key::Right, Key::Hold]);
        assert!(effects.is_empty());
    }

    #[test]
    fn the_song_menu_skips_going_to_the_album_twice() {
        let mut nav = Nav::new();
        nav.on_session(View {
            playing_from: Some(from_album()),
            ..playing_view()
        });
        press(&mut nav, &[Key::Right, Key::Hold]);
        nav.on_song_links("q0", Ok(links("q0", &[("UCg", "Geese")])));
        let menu = nav.menu.as_ref().unwrap();
        let goes: Vec<_> = menu
            .items
            .iter()
            .filter(|item| matches!(item, MenuAction::GoTo(_)))
            .map(|item| item.label().into_owned())
            .collect();
        assert_eq!(goes, ["Go to album", "Go to artist"]);
    }

    #[test]
    fn the_song_menu_starts_its_radio_and_likes_it() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        press(&mut nav, &[Key::Right, Key::Hold, Key::Down, Key::Down]);
        let effects = press(&mut nav, &[Key::Ok]);
        assert_eq!(
            effects,
            vec![Effect::Session(UiAction::StartRadio(track("q0")))]
        );
        assert_eq!(
            playing_from_radio(&track("q0")),
            PlayingFrom {
                kind: PlayingFromKind::Radio,
                title: "Song q0".into(),
                id: "RDAMVMq0".into(),
            }
        );
        let effects = press(&mut nav, &[Key::Hold, Key::Ok]);
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
    fn the_song_menu_adds_to_one_of_your_playlists() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        press(&mut nav, &[Key::Right, Key::Hold, Key::Down]);
        let effects = press(&mut nav, &[Key::Ok]);
        assert_eq!(effects, vec![Effect::LoadPlaylists(track("q0"))]);
        let playlist = |id: &str, title: &str| Card {
            kind: CardKind::MyPlaylist,
            id: id.into(),
            title: title.into(),
            subtitle: String::new(),
            artwork_url: None,
            track: None,
        };
        let library = vec![Shelf {
            title: "Your playlists".into(),
            cards: vec![
                playlist(LIKED_PLAYLIST_ID, "Liked Songs"),
                playlist("p1", "Road trip"),
            ],
        }];
        let now = Instant::now();
        nav.show_playlists(track("q0"), Ok(library), now);
        let menu = nav.menu.as_ref().unwrap();
        assert_eq!(menu.items[0].label(), "Road trip");
        assert_eq!(menu.items.len(), 2);
        let effects = press(&mut nav, &[Key::Ok]);
        assert_eq!(
            effects,
            vec![Effect::AddToPlaylist {
                playlist_id: "p1".into(),
                track: track("q0"),
            }]
        );
        nav.on_added_to_playlist("Road trip", false, now);
        assert_eq!(nav.notice(now), Some("Already in Road trip"));
        // With none of your own, it says how to make one.
        nav.show_playlists(track("q0"), Ok(Vec::new()), now);
        assert!(nav.menu.is_none());
        assert_eq!(nav.notice(now), Some("Make a playlist on your phone first"));
    }

    #[test]
    fn nothing_to_go_to_without_a_page() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        press(&mut nav, &[Key::Right, Key::Hold]);
        let menu = nav.menu.as_ref().unwrap();
        assert!(
            !menu
                .items
                .iter()
                .any(|item| matches!(item, MenuAction::GoTo(_)))
        );
    }

    #[test]
    fn the_queue_goes_to_my_playlist_in_the_library() {
        let mut nav = Nav::new();
        let mine = PlayingFrom {
            kind: PlayingFromKind::MyPlaylist,
            title: "Road Trip".into(),
            id: "p1".into(),
        };
        nav.on_session(View {
            playing_from: Some(mine.clone()),
            ..playing_view()
        });
        // Controls up, over to Queue, open it, then hold on a song.
        press(&mut nav, &[Key::Right]);
        nav.control = CONTROLS.iter().position(|c| *c == Control::Queue).unwrap();
        press(&mut nav, &[Key::Ok, Key::Down, Key::Hold]);
        let menu = nav.menu.as_ref().unwrap();
        let index = menu
            .items
            .iter()
            .position(|item| *item == MenuAction::GoTo(mine.clone()))
            .unwrap();
        assert_eq!(menu.items[index].label(), "Go to playlist");
        assert_eq!(menu.items.last(), Some(&MenuAction::Close));
        let mut keys = vec![Key::Down; index];
        keys.push(Key::Ok);
        let effects = press(&mut nav, &keys);
        assert_eq!((nav.tab, nav.panel), (Tab::Library, Panel::None));
        assert!(effects.contains(&Effect::LoadLibrary));
        assert!(effects.contains(&Effect::LoadCollection {
            tab: Tab::Library,
            kind: CollectionKind::MyPlaylist,
            id: "p1".into(),
        }));
    }

    #[test]
    fn going_to_a_search_searches_again() {
        let mut nav = Nav::new();
        nav.search.query = "something else".into();
        nav.on_session(View {
            playing_from: Some(playing_from_search("daft punk")),
            ..playing_view()
        });
        press(&mut nav, &[Key::Right, Key::Hold]);
        assert_eq!(
            nav.menu.as_ref().unwrap().items[3].label(),
            "Back to “daft punk” results"
        );
        let effects = press(&mut nav, &[Key::Down, Key::Down, Key::Down, Key::Ok]);
        assert_eq!(nav.tab, Tab::Search);
        assert_eq!(nav.search.query, "daft punk");
        assert_eq!(effects, vec![Effect::Search("daft punk".into())]);
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
        nav.show_settings("Version f3a82b03 (12 Nov 2026)".into(), false);
        assert_eq!(press(&mut nav, &[Key::Ok]), vec![Effect::CheckForUpdates]);
        assert!(nav.menu.is_none());
        // With an update downloaded, the same item installs it.
        nav.show_settings("An update is ready.".into(), true);
        assert_eq!(press(&mut nav, &[Key::Ok]), vec![Effect::InstallUpdate]);
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
    fn the_scan_code_shows_as_a_song_starts_and_while_the_queue_runs_short() {
        let mut nav = Nav::new();
        nav.on_session(playing_view());
        let start = Instant::now();
        assert!(nav.scan_code_shown(start), "a song just started");
        let later = start + SCAN_CODE_AFTER_START + Duration::from_secs(1);
        assert!(!nav.scan_code_shown(later), "then it goes");
        nav.key(Key::Right, later);
        assert!(nav.controls_shown());
        assert!(
            !nav.scan_code_shown(later),
            "eleven songs to go: the controls leave the room to Up Next"
        );
        // Three songs to go, the rest autoplay's: the controls bring it.
        let mut short = playing_view();
        for entry in short.queue.iter_mut().skip(4) {
            entry.autoplay = true;
        }
        nav.on_session(short);
        assert!(nav.scan_code_shown(later), "the queue runs short");
        assert!(nav.settle(later + CONTROLS_LINGER));
        assert!(!nav.scan_code_shown(later + CONTROLS_LINGER));
        // The next song shows it again.
        let mut next = playing_view();
        next.current = Some(1);
        nav.on_session(next);
        assert!(nav.scan_code_shown(Instant::now()));
    }

    #[test]
    fn the_settings_menu_switches_sound_check_for_the_session() {
        let mut nav = Nav::new();
        nav.on_session(View {
            sound_check: true,
            ..playing_view()
        });
        nav.show_settings("Version f3a82b03 (12 Nov 2026)".into(), false);
        let items = &nav.menu.as_ref().unwrap().items;
        assert_eq!(items[2], MenuAction::SetSoundCheck(false));
        assert_eq!(items[2].label(), "Turn off Sound Check");
        assert_eq!(
            press(&mut nav, &[Key::Down, Key::Down, Key::Ok]),
            vec![Effect::Session(UiAction::SetSoundCheck(false))]
        );
        assert!(nav.menu.is_none());
        // Off, it offers to turn it back on.
        nav.on_session(View {
            sound_check: false,
            ..playing_view()
        });
        nav.show_settings(String::new(), false);
        assert_eq!(
            nav.menu.as_ref().unwrap().items[2],
            MenuAction::SetSoundCheck(true)
        );
    }

    #[test]
    fn the_settings_menu_shows_the_scan_code_large() {
        let mut nav = Nav::new();
        nav.show_settings("Version f3a82b03 (12 Nov 2026)".into(), false);
        let menu = nav.menu.clone().unwrap();
        assert_eq!(
            menu.items.iter().map(MenuAction::label).collect::<Vec<_>>(),
            ["Check for updates", "Show code to add songs", "Cancel"]
        );
        press(&mut nav, &[Key::Down, Key::Ok]);
        assert!(nav.scan_card && nav.menu.is_none());
        // Keys other than OK and Back leave it up.
        assert_eq!(press(&mut nav, &[Key::Down, Key::Right]), vec![]);
        assert!(nav.scan_card);
        press(&mut nav, &[Key::Back]);
        assert!(!nav.scan_card);
    }

    #[test]
    fn menus_cancel_and_the_update_prompt_says_not_now() {
        let mut nav = Nav::new();
        nav.ask_update_permission();
        let menu = nav.menu.clone().unwrap();
        assert_eq!(menu.items[1].label(), "Not now");
        nav.on_home(Ok(shelves()));
        nav.menu = None;
        press(&mut nav, &[Key::Down, Key::Hold]);
        let menu = nav.menu.clone().unwrap();
        assert_eq!(
            menu.items.last().map(|item| item.label()),
            Some("Cancel".into())
        );
        // An album's menu goes to it with an arrow, not a dot.
        let open = menu
            .items
            .iter()
            .find(|item| matches!(item, MenuAction::Open(..)))
            .unwrap();
        assert_eq!(
            (open.label().as_ref(), open.icon()),
            ("Go to album", "open")
        );
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
        // "Cancel" has the selection: OK changes nothing.
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
