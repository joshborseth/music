//! Saves each TV screen as a PNG. See `src/screenshots.rs`.

use std::time::Duration;

use music_tv::catalog::{CardKind, Client, Shelf};
use music_tv::protocol::{PlayingFrom, PlayingFromKind};
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
    // Home with short rows, which spread their few cards across.
    let of_kind = |kind: CardKind, count: usize| {
        shelves
            .iter()
            .flat_map(|shelf| shelf.cards.iter())
            .filter(|card| card.kind == kind)
            .take(count)
            .cloned()
            .collect::<Vec<_>>()
    };
    let short_home = vec![
        Shelf {
            title: "Jump back in".into(),
            cards: of_kind(CardKind::Album, 4),
        },
        Shelf {
            title: "Your playlists".into(),
            cards: of_kind(CardKind::Playlist, 2),
        },
        Shelf {
            title: "Liked Songs".into(),
            cards: of_kind(CardKind::Song, 1),
        },
    ];
    // The queue running short: the song playing and two after it.
    let short_queue = {
        let mut view = sample_view(tracks.clone(), current, true);
        view.queue.truncate(current + 3);
        view
    };

    let (up, down, left, right) = ("\u{f700}", "\u{f701}", "\u{f702}", "\u{f703}");
    let ok = "\n";
    // As the patched Slint Android backend sends the media key.
    let fast_forward = "\u{E006}";
    let back = "\u{1b}";
    let backspace = "\u{8}";
    let wait = |ms| Step::Wait(Duration::from_millis(ms));
    // The queue opens on the song playing; Clear sits above the first song.
    let up_to_clear = (0..=current).map(|_| Step::Key(up)).collect::<Vec<_>>();
    let steps = vec![
        vec![
            Step::Session(music_tv::view::View {
                connected: true,
                ..Default::default()
            }),
            wait(4000),
            Step::Shot("01-home"),
            Step::Home(short_home),
            Step::Shot("01e-home-short-rows"),
            Step::Key(down),
            wait(1000),
            Step::Shot("01f-home-short-rows-down"),
            Step::Key(up),
            // The settings button ends the tab bar; its menu checks for updates.
            Step::Key(up),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Shot("01a-settings-button"),
            Step::Key(ok),
            Step::Shot("01b-settings-menu"),
            Step::Key(back),
            // The settings menu shows the scan code, large.
            Step::Key(ok),
            Step::Key(down),
            Step::Key(ok),
            Step::Shot("01d-scan-code"),
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
            // Holding OK opens the song's menu; its album and artists
            // join it as the server finds them.
            Step::Hold,
            wait(4000),
            Step::Shot("06b-song-menu"),
            // Add to a playlist lists the ones made on the phone.
            Step::Key(down),
            Step::Key(ok),
            wait(1500),
            Step::Shot("06c-add-to-playlist"),
            Step::Key(back),
            // The controls rested meanwhile: a key brings them back.
            Step::Key(down),
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
            Step::Hold,
            Step::Shot("07a-queue-menu"),
            Step::Key(back),
            // The queue's header says how shuffle and repeat are set.
            Step::Session(music_tv::view::View {
                shuffle: true,
                repeat: music_tv::protocol::RepeatMode::One,
                ..sample_view(tracks.clone(), current, true)
            }),
            wait(500),
            Step::Shot("07b-queue-shuffle-repeat"),
            Step::Session(sample_view(tracks.clone(), current, true)),
        ],
        up_to_clear,
        vec![
            Step::Shot("07c-queue-clear"),
            // Clear asks first, with "Cancel" selected.
            Step::Key(ok),
            Step::Shot("07d-queue-clear-confirm"),
            Step::Key(back),
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
            // Past Shuffle and Queue to Follow, and follow.
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Shot("12a-follow-button"),
            Step::Key(ok),
            wait(1000),
            Step::Shot("12b-following"),
            Step::Key(right),
            Step::Key(down),
            wait(1500),
            Step::Shot("13-collection-list"),
            // Down past the songs to the first album, and hold for its menu.
            Step::Key(down),
            Step::Key(down),
            Step::Key(down),
            Step::Key(down),
            Step::Hold,
            wait(1000),
            Step::Shot("13a-album-menu"),
            Step::Key(back),
            // Back to search; the search just used is now a recent one.
            Step::Key(back),
            Step::Key(backspace),
            Step::Key(backspace),
            Step::Key(backspace),
            Step::Key(backspace),
            wait(500),
            Step::Shot("13b-search-recent"),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Key(right),
            Step::Shot("13c-search-recent-selected"),
            // Back to now playing.
            Step::Key(back),
            Step::Session(sample_view(tracks.clone(), current, true)),
            Step::Rest,
            wait(2000),
            Step::Shot("14-now-playing"),
            // An album with a long name is cut short to the song's width.
            Step::Session(music_tv::view::View {
                playing_from: Some(PlayingFrom {
                    kind: PlayingFromKind::Album,
                    title: "Random Access Memories (10th Anniversary Edition, Remastered Deluxe)"
                        .into(),
                    id: "MPREb_example".into(),
                }),
                ..sample_view(tracks.clone(), current, true)
            }),
            Step::Shot("14a-now-playing-from-album"),
            Step::Session(sample_view(tracks.clone(), current, true)),
            // The remote's fast-forward key, from the resting screen.
            Step::Key(fast_forward),
            Step::Key(fast_forward),
            Step::Shot("15-fast-forward"),
            // Once the controls rest and the song has been on a while, the
            // scan code goes too.
            wait(21_000),
            Step::Shot("16-resting"),
            // Later in the song, the controls leave the room to Up Next...
            Step::Key(right),
            wait(800),
            Step::Shot("16a-controls-later"),
            // ...unless the queue runs short.
            Step::Session(short_queue),
            wait(600),
            Step::Shot("16b-controls-short-queue"),
            // Back to the results, from the song's menu (the last item
            // before Cancel), searches again.
            Step::Key(right),
            Step::Hold,
            wait(3000),
        ],
        (0..10).map(|_| Step::Key(down)).collect(),
        vec![
            Step::Key(up),
            Step::Shot("16c-song-menu-back-to-results"),
            Step::Key(ok),
            wait(5000),
            Step::Shot("17-go-to-search"),
        ],
    ];
    run(&server, &out, steps.into_iter().flatten().collect());
}
