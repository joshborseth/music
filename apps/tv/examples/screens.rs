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
    drop(runtime);

    let (up, down, left, right) = ("\u{f700}", "\u{f701}", "\u{f702}", "\u{f703}");
    let ok = "\n";
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
            Step::Key(left),
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
            Step::Session(sample_view(tracks.clone(), 2, true)),
            wait(5000),
            Step::Shot("05-now-playing"),
            // The first key brings up the controls.
            Step::Key(right),
            wait(800),
            Step::Shot("06-controls"),
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
            Step::Key(ok),
            Step::Key(back),
            Step::Session(sample_view(tracks.clone(), 3, false)),
            wait(5000),
            Step::Shot("09-playing-elsewhere"),
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
            Step::Key(ok),
            wait(4000),
            Step::Shot("12-collection"),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(down),
            wait(1500),
            Step::Shot("13-collection-list"),
            // Back to now playing, then one shot per scene of its visuals.
            Step::Key(back),
            Step::Session(sample_view(tracks.clone(), 2, true)),
            Step::NextScene,
            wait(4000),
            Step::Shot("14-visuals-1"),
            Step::NextScene,
            wait(4000),
            Step::Shot("15-visuals-2"),
            Step::NextScene,
            wait(4000),
            Step::Shot("16-visuals-3"),
            Step::NextScene,
            wait(4000),
            Step::Shot("17-visuals-4"),
            Step::NextScene,
            wait(4000),
            Step::Shot("18-visuals-5"),
            Step::NextScene,
            wait(4000),
            Step::Shot("19-visuals-6"),
            Step::NextScene,
            wait(4000),
            Step::Shot("20-visuals-7"),
            Step::NextScene,
            wait(4000),
            Step::Shot("21-visuals-8"),
            Step::NextScene,
            wait(4000),
            Step::Shot("22-visuals-9"),
            Step::NextScene,
            wait(4000),
            Step::Shot("23-visuals-10"),
        ],
    );
}
