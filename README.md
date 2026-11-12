<img src="apps/web/public/favicon.svg" width="64" height="64" alt="">

# Music

Browse YouTube Music on your phone and play it on the phone or on the TV. The phone app is a PWA built to feel like a native music app; the TV app is a native Android TV app written in Rust. Every device shares one queue, and the phone works as the TV's remote.

## What it does

- **Three tabs:** Home, Search, and Library, like a native app. Each tab remembers the page it was on. Tapping the open tab again goes back to its top.
- **Home:** what you played lately, then YouTube Music's home feed: quick picks, new releases, and playlists. The server keeps the feed for 15 minutes.
- **Search** songs, artists, albums, or playlists. Results update as you type, and your last eight searches are kept on the device.
- **Library:** your playlists, with Liked songs first, then songs played and albums, artists, and playlists opened on this device, newest first.
- **Tap a song to play it.** Its list plays from there. The ⋯ button opens a sheet to play it next, add it to the queue, like it, add it to a playlist, or go to its album, artist, or lyrics.
- **Your playlists:** make a playlist in the Library, or from Add to a Playlist on any song. The ⋯ button on a playlist renames or deletes it, and ⋯ on one of its songs removes that song. The heart in the player and on every song adds it to Liked songs, newest first. The button at the top right of an album or a YouTube Music playlist saves a copy of its songs to one of your playlists or a new one. Playlists live on the music server, so every phone sees the same ones.
- **Playlist page:** cover, title, description, and every song (up to 500), with Play and Shuffle. Your own playlists show a mosaic of four of their album covers.
- **Song page:** artwork, artists, album, length, view count, lyrics, and the "up next" list YouTube Music would play after it.
- **Artist page:** photo, bio, top songs, albums, singles and EPs, and similar artists.
- **Album page:** cover, artists, release kind and year, total length, description, and the numbered tracklist.
- **Playback:** play or shuffle an album, a playlist, or an artist's top songs, or add songs to the queue to play next or last. A mini player floats above the tabs. Tap it for the full player: artwork over a blurred backdrop, a seek bar, lyrics, the queue, and the devices you can play on. While the TV plays, a volume slider under the controls sets the TV's volume. Pull it down to close it.
- **Play on the TV:** pick the TV in the player. If the TV is off, the server turns it on and opens the TV app. Playback moves over at the same position, and the phone stays in control. The phone can then lock or go offline; the TV keeps playing.
- **TV app:** works on its own with the remote, no phone needed. Four tabs along the top:
  - **Now playing:** the cover over a blurred copy of itself, the song, a progress bar, and buttons for previous, play or pause, next, like, the queue, and the lyrics. Bars along the bottom move with the music while the TV plays.
  - **Home:** your playlists, then YouTube Music's home feed, as rows of covers.
  - **Search:** an on-screen keyboard. Results appear as you type.
  - **Library:** Liked songs and your playlists.

  OK on a song plays its row from there. OK on an album, playlist, or artist opens it, with Play, Shuffle, and Queue buttons. **Hold OK** on anything for more: play next, add to the queue, like, or go to the artist. The queue slides in from the right: OK jumps to a song, and holding OK removes one. Lyrics slide in the same way and scroll with the song. Back steps back, and pressing Back twice on the top level leaves the app.

- **Scan to play:** the TV shows a QR code for the server's address on the home Wi-Fi (`http://192.168.1.67:4310`). Anyone on the Wi-Fi can scan it and use the full app on their phone, without Tailscale.
- **Screensaver:** after two and a half minutes without a key press, the screen goes black with the cover, the song, and the time drifting slowly, so nothing burns in. Any key brings the app back.

## How it fits together

```
apps/web         Foldkit SPA + foldcn components, installable as a PWA
apps/tv          Rust Android TV app: Slint UI, Symphonia (AAC), cpal (AAudio)
   │  Effect RPC over HTTP (/rpc, NDJSON)      catalog: search and pages (web only)
   │  JSON over HTTP (/tv/…)                   the same catalog shaped for the TV (TV only)
   │  WebSocket (/session, JSON)               the shared queue and who plays it
   │  HTTP with byte ranges (/audio/:videoId)  the songs themselves
   │  WebSocket (/now-playing, JSON)           read-only: the song and its cover's colors
apps/server      Bun + Effect server: youtubei.js for the catalog, yt-dlp for audio,
                 SQLite (bun:sqlite) for the playlists made in the app
packages/shared  The RPC contract, the session protocol, and every Schema
fixtures/session Example session messages that the TypeScript and Rust tests both decode
fixtures/tv      Example TV catalog responses, decoded the same way
```

**The session.** The server holds one queue for every device, and one device at a time plays it (the active device). Each device opens `/session`, says `Hello`, and then receives the whole session state after every change. Commands (play, pause, seek, skip, enqueue, transfer) go to the server, never directly to a player. The active device plays the current song and reports its position about once a second. A player that pauses says where it stopped, so every device agrees on the spot. A player that reconnects says in its `Hello` what it is playing, and the server follows it unless the session jumped meanwhile (a seek, a skip, or another device taking over). Volume belongs to each device, not to the session: the TV reports its Android music volume (`Volume`) when it connects and whenever it changes, and a phone's slider asks for a new one (`SetDeviceVolume`), which the server passes to the TV (`SetVolume`). The phone's hardware volume buttons only reach the phone: iOS gives web apps no way to read them. The protocol is defined in `packages/shared/src/session.ts` and mirrored in `apps/tv/src/protocol.rs`.

**The TV catalog.** The TV app browses without the phone through plain JSON routes under `/tv/`: home, library, search, albums, playlists, artists, lyrics, and Liked songs. They reshape the same catalog and playlist store the web app reaches through RPC into shelves of cards and lists of queue tracks, and they get songs ready the same way when a page opens. The contract is `packages/shared/src/tv.ts`, mirrored in `apps/tv/src/catalog.rs`; both sides' tests decode the examples in `fixtures/tv/`. The routes are in `apps/server/src/tvCatalog/`.

**Playlists.** The playlists made in the app, and Liked songs, are kept in one SQLite file on the server (`~/.local/share/music/playlists.sqlite`), opened with Bun's built-in `bun:sqlite`. Each entry keeps a copy of the song (title, artists, album, length, artwork), so a playlist opens without asking YouTube anything, and a song stays listed even if YouTube later drops it. A song appears once per playlist. The web app shows a change at once (a heart fills, a removed row leaves) and then takes the server's answer; if the server cannot save it, the app says so and reloads. A playlist plays through the same session commands as an album, so the TV app needs nothing new. `apps/server/src/playlists/store.ts` holds the tables and every change.

**Audio.** yt-dlp finds each song's AAC stream (format 140), using the proof-of-origin token service already on this machine (`yt-music-token`, `127.0.0.1:4416`). YouTube's links only work from the address that requested them, only with yt-dlp's User-Agent, and only a few seconds after they are issued. A request without a byte range is throttled to playback speed, so the server always asks for a range. The server downloads each song whole, once, into a disk cache (`~/.cache/music/audio`, 1 GB). `/audio/:videoId` serves a song with byte ranges while it is still downloading, then from disk. A song nobody prepared takes about 6 seconds to start: finding the link and YouTube's wait are most of it. A prepared song starts, and seeks, instantly for every device.

When the cache is full, songs played once or twice go first, least recently used first. Favorites (3 plays or more) go last, and the current song and the next five are never dropped. Play counts are kept in `plays.json` next to the songs.

**Getting songs ready early.** The prefetcher (`apps/server/src/prefetch.ts`) downloads some songs whole and only finds links for others. A song with a link already found starts in about a second.

| What happens               | Downloaded whole                | Link found only                       |
| -------------------------- | ------------------------------- | ------------------------------------- |
| Playing a queue            | The current song and the next 5 | The 5 after those                     |
| Opening an album or artist | The first 2 songs               | Songs 3 to 5                          |
| Searching songs            | The top result                  | The next 2                            |
| Opening a song page        | That song                       |                                       |
| Two or fewer songs left    |                                 | YouTube Music's next 3 after the last |

Two workers take the most urgent job first, and a new page replaces the previous page's jobs. A song someone presses Play on never waits behind them: players go straight to the cache, and prefetching uses at most two of yt-dlp's three slots. To keep YouTube from flagging the server, prefetching may run yt-dlp 400 times a day, and it pauses for 15 minutes after 3 failures in a row.

**The phone's player.** The phone keeps up to 500 MB of songs in its own cache (Cache Storage), and asks the browser to keep it. A cached song plays from a local copy, so it starts and seeks with no network at all. A song that isn't cached streams right away and is saved for next time. While the phone is the player, it saves the current song and the next five, in queue order, again whenever the queue changes. When the cache is full, it drops songs the same way the server does; sizes and play counts live in localStorage. Seeking jumps within the loaded song, and play and pause respond before the server confirms. The full player has a seek bar that shows the position while you drag it, buttons to skip back and forward 15 seconds, and a spinner while audio loads.

**On the lock screen.** A locked phone may hear from the server late or not at all, and iOS stops a page that goes quiet in the background. So while the phone is the player, it does everything it can on its own first and tells the server after. When a song ends, the next one starts at once. Next, previous, play, pause, and the scrubber act on the phone right away; play and pause run inside the lock screen's own handler, where iOS counts them as a tap and lets audio start again. When the system pauses the song (a call, Siri, headphones unplugged), the session pauses too, so the play button works afterwards. Every state the server sends says how many of the phone's messages it includes, and the phone keeps its own changes until one does, so the answer to one press never undoes the next. If the connection dropped meanwhile, the phone reports what it played when it reconnects.

**The TV app.** Rust from top to bottom. The audio engine (`apps/tv/src/audio`) downloads each song into memory, decodes it with Symphonia while it arrives, and writes samples into a lock-free ring buffer that the AAudio callback drains. The next song is downloaded and opened while the current one plays, so it follows without a gap. The screen is a single Slint window drawn by Skia on the GPU, and it only redraws when something on it changes. Navigation lives in Rust (`nav.rs`): each remote key moves a plain state machine, which the tests drive, and `ui.rs` draws that state into Slint models, updating only the rows that changed. `visualizer.rs` runs an FFT over the samples the audio callback just played (`audio/scope.rs`, lock-free) about 30 times a second, only while the TV plays. To browse, the TV reads the server's `/tv/...` routes (`packages/shared/src/tv.ts`, mirrored in `apps/tv/src/catalog.rs`), and it plays through the same session commands as the phone. The font is Inter (SIL Open Font License, `apps/tv/ui/fonts`). The app only speaks plain HTTP to the server, so it carries no TLS stack. The server relays album art at `/artwork?url=…`, for Google's image hosts only. If the app crashes, it posts the panic to `/tv-log`, and the report appears in the server's log (`journalctl --user -u music.service`).

**Waking the TV.** Home Assistant is already paired with the TV's Android TV Remote service. When you pick the TV while it is off, the server calls Home Assistant's `remote.turn_on` with `activity: music://play`. That turns the TV on and opens the app through its deep link. If the TV has not connected within 60 seconds, the phone shows a notice and playback pauses.

**Now playing, for the house.** `/now-playing` is a read-only WebSocket for things outside the app, such as the lights. It sends the current song, whether it is playing, which device plays it, and the cover's colors when it connects, then again after every change. Listeners send nothing and never appear as a device. The server finds the colors with k-means in OKLab on a 48×48 copy of the cover (decoded with sharp), drops black, white, grey, and specks, and ranks what is left by area and colorfulness. That takes about 50 ms per cover, and each cover's colors are cached. A cover with no usable color sends an empty palette. The contract is `packages/shared/src/nowPlaying.ts`.

YouTube blocks cross-origin calls from browsers, so the browser never talks to YouTube directly. The server maps YouTube's loosely typed responses into the Schemas in `packages/shared`, and Effect RPC validates them on both ends. Artwork loads straight from Google's image CDN, and the service worker caches it.

## Run it

You need [Bun](https://bun.sh) 1.3 or later, and for audio [yt-dlp](https://github.com/yt-dlp/yt-dlp) with the PO token plugin: `uv tool install 'yt-dlp[default]' --with bgutil-ytdlp-pot-provider`.

```sh
bun install
bun run dev
```

This starts the server on port 3001 and Vite on port 5173. Vite forwards `/rpc`, `/audio`, and `/session` to the server. Open http://localhost:5173, or the `Network` address Vite prints to try it on your phone over the LAN or Tailscale.

## TV app

The TV app needs Rust (via rustup, with the `aarch64-linux-android` and `armv7-linux-androideabi` targets), the Android SDK with build-tools 35 and NDK 27 in `~/Android/Sdk`, a JDK, `cargo-apk`, `ninja`, and `libclang-dev`.

```sh
scripts/build-tv-apk.sh          # dist/music-tv.apk for 64- and 32-bit ARM TVs
scripts/build-tv-apk.sh arm64    # 64-bit only, much faster to build the first time
```

The 32-bit build compiles Skia from source the first time, because rust-skia publishes no 32-bit Android binaries. The APK is signed with `~/.config/music/tv-release.keystore`. Keep that file: Android only installs an update over an app signed with the same key.

The app connects to `http://192.168.1.67:4310`. To point it somewhere else, set `MUSIC_SERVER_URL` when building.

To install it, open `http://192.168.1.67:4310/tv.apk` in the TV's Downloader app. The server serves the file at `TV_APK_PATH` there. Send Files to TV works too. Music then appears in the TV's app list.

After that first install, the app updates itself. Each build gets an id (`<commit>-<UTC time>`), which the build script compiles into the app and writes to `dist/music-tv.build`; the server answers it at `/tv/version`. The app checks at start and every 15 minutes. When the server has another build, the app downloads it, waits until nothing has played on the TV for 30 seconds, and installs it. If Music was on screen, the server then reopens it through Home Assistant when it doesn't come back by itself within 20 seconds. If the TV was in standby or showing another app, Music stays closed until you open it. Once, the first time, allow "Install unknown apps" for Music when the app asks. After that, updates install by themselves on Android 12 and later while nothing plays. Older Android versions, or a TV that wants a confirmation anyway, show Android's Install prompt instead. Failures show in the app and in `journalctl --user -u music.service`. A build that fails to install three times is left alone until the next one.

To see the screens without a TV, render them to PNG files. This needs a server with the `/tv` routes; it reads the catalog and artwork from it, and makes up its own queue instead of joining the session:

```sh
MUSIC_SERVER_URL=http://127.0.0.1:3001 cargo run -p music-tv --features screenshots --example screens -- /path/to/folder
```

Tests run on this machine without a TV:

```sh
cargo test -p music-tv
# Plays real songs through a running server into a silent output.
MUSIC_TEST_SERVER=http://127.0.0.1:3001 cargo test -p music-tv -- --ignored
```

The logo lives in `branding/` as SVG. After changing it, run `scripts/render-icons.sh` to redraw the web app's icons, the TV launcher icon, and the logo the TV app shows.

What the TV app does not do yet: it has no TV banner image (cargo-apk can't declare one), so the launcher shows its icon instead. If you leave the app, Android can stop the music whenever it likes, because keeping music playing in the background needs a small Java service. The phone's own player has a short gap between songs.

## Hosting

The installed app runs on this machine as the `music.service` systemd user unit. The Bun server serves the built web app from `apps/web/dist`, along with `/rpc`, `/session`, and `/audio`, on port 4310. It listens on every interface (`HOST=0.0.0.0`) so the TV can reach it over the home network. The unit sets `YTDLP_PATH` and `TV_APK_PATH`. `AUDIO_CACHE_DIR` and `AUDIO_CACHE_MAX_BYTES` change where songs are kept and how much space they may use. `PLAYLISTS_DB_PATH` changes where the playlists are kept. `bun run dev` uses the same playlist file by default, so set it to a scratch path when you try changes against real playlists. The unit also reads the Home Assistant settings from `~/.config/music/server.env`:

```sh
HA_TOKEN=<a long-lived access token from your Home Assistant profile>
TV_HA_ENTITY=remote.joshies_gamer_tv
```

Without those two values, the TV only shows up in the device list while its app is open. Tailscale Serve publishes it to the tailnet only (no Funnel) on port 7443 of this machine's Tailscale name: `https://<machine>.<tailnet>.ts.net:7443`. Run `tailscale serve status` to see the exact address.

On the iPhone, open that address in Safari, tap Share, then **Add to Home Screen**.

- Ship changes: `bun run deploy` (`scripts/deploy-main.sh`) fast-forwards this checkout to `origin/main`, builds the web app, restarts the service, and rebuilds the TV app when it changed. Pass `--tv` to the script to rebuild the TV app anyway.
- Logs: `journalctl --user -u music.service -f`
- Stop publishing it: `sudo tailscale serve --https=7443 off`

The unit file lives at `~/.config/systemd/user/music.service`.

## Scripts

| Command                                | What it does                                                  |
| -------------------------------------- | ------------------------------------------------------------- |
| `bun run dev`                          | Server and web app with live reload                           |
| `bun run build`                        | Production build of the web app, including the service worker |
| `bun run typecheck`                    | Type-checks every package                                     |
| `bun run test`                         | Story and Scene tests (web) and mapping tests (server)        |
| `bun run lint`                         | oxlint with the Foldkit and Effect rule sets                  |
| `bun run format`                       | oxfmt                                                         |
| `bun run --filter @music/server smoke` | Calls every RPC against a running server                      |
| `scripts/build-tv-apk.sh`              | Builds the signed TV app into `dist/music-tv.apk`             |
| `scripts/render-icons.sh`              | Renders every app icon from the logo in `branding/`           |
| `cargo test -p music-tv`               | TV app tests: fixtures, navigation, streaming, the visualizer |

## Caveats

- `youtubei.js` uses YouTube's private API. A YouTube change can break it until the library is updated, and using it is against YouTube's terms. It is fine for personal use.
- Audio depends on yt-dlp and the token service keeping up with YouTube. When songs stop playing, update yt-dlp first: `uv tool upgrade yt-dlp`.
- yt-dlp solves YouTube's challenges with Bun. It warns that Bun 1.4 is newer than it has been tested with; installing Deno and setting `YTDLP_JS_RUNTIME=deno` is the supported route if that ever breaks.
- The server picks out some artist-page sections by their English titles ("Albums", "Singles & EPs", "Fans might also like"), so the session is pinned to English.
