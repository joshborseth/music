//! Saves each TV screen as a PNG. See `src/screenshots.rs`.

use std::time::Duration;

use music_tv::catalog::Client;
use music_tv::screenshots::{Step, run, sample_view};

fn main() {
    let server =
        std::env::var("MUSIC_SERVER_URL").unwrap_or_else(|_| "http://127.0.0.1:3105".into());
    let out = std::path::PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| "screens".into()));
    std::fs::create_dir_all(&out).expect("create the output folder");

    // Real songs for a made-up queue.
    let runtime = tokio::runtime::Runtime::new().unwrap();
    // Search results always have songs; the home feed may only have playlists.
    let shelves = runtime
        .block_on(Client::new(server.clone()).search("daft punk"))
        .expect("the server's /tv/search answers");
    let tracks: Vec<_> = shelves
        .iter()
        .flat_map(|shelf| shelf.cards.iter().filter_map(|card| card.track.clone()))
        .take(14)
        .collect();
    // Play a song with timed lyrics, so the screens show them beside it.
    let client = Client::new(server.clone());
    let current = tracks
        .iter()
        .position(|track| {
            runtime
                .block_on(client.lyrics(&track.video_id))
                .ok()
                .flatten()
                .is_some_and(|lyrics| !lyrics.lines.is_empty())
        })
        .unwrap_or(2);
    let elsewhere = (current + 1) % tracks.len().max(1);
    drop(runtime);

    let (up, down, left, right) = ("\u{f700}", "\u{f701}", "\u{f702}", "\u{f703}");
    let ok = "\n";
    // As the patched Slint Android backend sends the media key.
    let fast_forward = "\u{E006}";
    let back = "\u{1b}";
    let wait = |ms| Step::Wait(Duration::from_millis(ms));
    run(
        &server,
        &out,
        vec![
            Step::Session(music_tv::view::View {
                connected: true,
                ..Default::default()
            }),
            wait(4000),
            Step::Shot("01-home"),
            // The settings button ends the tab bar; its menu checks for updates.
            Step::Key(up),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Shot("01a-settings-button"),
            Step::Key(ok),
            Step::Shot("01b-settings-menu"),
            Step::Key(back),
            // Library, which the tab bar passed on its way: Liked songs first.
            Step::Key(left),
            wait(2500),
            Step::Shot("01c-library"),
            Step::Key(left),
            Step::Key(left),
            Step::Key(down),
            Step::Key(down),
            Step::Key(right),
            Step::Key(right),
            wait(1500),
            Step::Shot("02-home-moved"),
            Step::Hold,
            Step::Shot("03-menu"),
            Step::Key(back),
            Step::Key(up),
            Step::Key(up),
            Step::Key(up),
            Step::Key(left),
            Step::Key(down),
            Step::Shot("04-nothing-playing"),
            Step::Session(sample_view(tracks.clone(), current, true)),
            wait(5000),
            Step::Shot("05-now-playing"),
            // The first key brings up the controls.
            Step::Key(right),
            wait(800),
            Step::Shot("06-controls"),
            // Up to the seek bar, and three steps forward.
            Step::Key(up),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Shot("06a-seek"),
            wait(2000),
            Step::Key(down),
            // Past Like, Shuffle, and Repeat to Queue.
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(ok),
            wait(1500),
            Step::Shot("07-queue"),
            Step::Key(back),
            Step::Key(right),
            Step::Key(ok),
            wait(1500),
            Step::Shot("08-lyrics-off"),
            // The queue over the song alone in the middle.
            Step::Key(left),
            Step::Key(ok),
            wait(1500),
            Step::Shot("08a-queue-lyrics-off"),
            Step::Key(back),
            Step::Key(right),
            Step::Key(ok),
            Step::Key(back),
            Step::Session(sample_view(tracks.clone(), elsewhere, false)),
            wait(5000),
            Step::Shot("09-playing-elsewhere"),
            // Up shows the controls, then passes the seek bar to the tabs.
            Step::Key(up),
            Step::Key(up),
            Step::Key(up),
            Step::Key(right),
            Step::Key(right),
            Step::Key(down),
            Step::Key("d"),
            Step::Key("a"),
            Step::Key("f"),
            Step::Key("t"),
            wait(5000),
            Step::Shot("10-search"),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(down),
            wait(1500),
            Step::Shot("11-search-results"),
            Step::Key(down),
            wait(1500),
            Step::Shot("11a-search-next-row"),
            Step::Key(up),
            Step::Key(ok),
            wait(4000),
            Step::Shot("12-collection"),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(down),
            wait(1500),
            Step::Shot("13-collection-list"),
            // Back to now playing.
            Step::Key(back),
            Step::Session(sample_view(tracks.clone(), current, true)),
            Step::Rest,
            wait(2000),
            Step::Shot("14-now-playing"),
            // The remote's fast-forward key, from the resting screen.
            Step::Key(fast_forward),
            Step::Key(fast_forward),
            Step::Shot("15-fast-forward"),
        ],
    );
}
