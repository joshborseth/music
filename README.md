<img src="apps/web/public/favicon.svg" width="64" height="64" alt="">

# Joshify

Browse YouTube Music on your phone and play it on the phone or on the TV. The phone app is a PWA built to feel like a native music app; the TV app is a native Android TV app written in Rust. Every device shares one queue, and the phone works as the TV's remote.

## What it does

- **Three tabs:** Home, Search, and Library, like a native app. Each tab remembers the page it was on. Tapping the open tab again goes back to its top.
- **Home:** only your own music: what you played lately, your playlists, and your latest liked songs. Nothing from YouTube Music's recommendations.
- **Search** songs, artists, albums, or playlists. Results update as you type. Songs come under a **Top result** card, YouTube Music's best match: an artist, album, or playlist opens, a song plays. Before you type, Search shows your last eight searches (kept on the device) and YouTube Music's moods and genres. Each one opens a page of its songs, playlists, and albums.
- **Library:** your playlists, with Liked songs first, then songs played and albums, artists, and playlists opened on this device, newest first. **Clear** forgets those after you confirm it.
- **Tap a song to play it.** Its list plays from there. The ⋯ button opens a sheet to play it next, add it to the queue, like it, add it to a playlist, or go to its album, artist, or lyrics.
- **Your playlists:** make a playlist in the Library, or from Add to a Playlist on any song. The ⋯ button on a playlist renames or deletes it, and ⋯ on one of its songs removes that song. The heart in the player and on every song adds it to Liked songs, newest first. The button at the top right of an album or a YouTube Music playlist saves a copy of its songs to one of your playlists or a new one. Playlists live on the music server, so every phone sees the same ones.
- **Playlist page:** cover, title, description, and every song (up to 500), with Play and Shuffle. Your own playlists show a mosaic of four of their album covers.
- **Song page:** artwork, artists, album, length, view count, lyrics, and a Play button.
- **Artist page:** photo, bio, top songs, albums, and singles and EPs.
- **Album page:** cover, artists, release kind and year, total length, description, and the numbered tracklist with each track's length and an E on explicit tracks. A track names its artists only when they differ from the album's.
- **Playback:** play or shuffle an album, a playlist, or an artist's top songs, or add songs to the queue to play next or last. A mini player floats above the tabs. Tap it for the full player: artwork over a blurred backdrop, a seek bar, lyrics, the queue, and the devices you can play on. Pull it down to close it.
- **Shuffle and repeat:** the buttons at the top of the player's queue, and on the TV's controls. Shuffle puts the songs still to come in a random order, and turning it off puts the list back in its order around the song playing. Shuffle on an album or playlist turns it on and starts from a random song. Repeat steps from off to the whole queue to one song. Next still moves on with repeat one, and Previous from the first song goes to the last while repeat is on. A repeating queue gets no autoplay songs.
- **Autoplay:** when the queue gets down to its last two songs, the server adds ten similar songs after it: YouTube Music's radio for the last song, leaving out songs already in the queue. They keep coming the same way, each batch picked from the last song added, so the music drifts on from where you started. They show under **Autoplay** in the player's queue, after the songs you queued, and songs you add go in front of them. The ∞ button there turns autoplay off, which removes the autoplay songs still to come, or back on. It starts on. The TV's queue says how many of its songs autoplay added.
- **Synced lyrics:** when a timed copy of a song's lyrics exists, the lyrics follow the song. The line being sung springs up bright, the lines glide up in a wave as it moves on, words light up one at a time when the lyrics are timed word by word, and a pause in the singing shows three breathing dots that light up as the next line nears. Tap a line to jump to it. Scroll to read ahead; the lyrics catch up a few seconds after you let go.
- **Play on the TV:** pick the TV in the player. If the TV is off, the server turns it on and opens the TV app. Playback moves over at the same position, and the phone stays in control. The phone can then lock or go offline; the TV keeps playing.
- **Where it plays:** the mini player and the player's device button always say where the music is: this phone, or "Playing on TV", "Paused on TV", "Turning on TV…", or "Reconnecting to TV…" while the TV has dropped off. When the device that played goes away and the music pauses, the phone takes over again, so Play plays on the phone. The speaker button at the top of Home opens **Play on** even when nothing plays. It lists every device with what it is doing: this phone, the TV (playing, paused, Joshify open, on with Joshify closed, or off, from Home Assistant), and other phones. Tap a device to move the music there. **Open** (or **Turn on** when the TV is off) starts Joshify on the TV without moving the music, so you can pick songs on the TV or watch what plays.
- **TV app:** works on its own with the remote, no phone needed. Four tabs along the top:
  - **Now playing:** the screen the app rests on. Visuals made from the music fill the screen in the cover's main color, made strong, the cover and song sit on the left, and every line of the lyrics runs down the right, the line being sung big and bright. A song without lyrics takes the middle instead. The controls stay hidden until you press a key: then buttons for previous, play or pause, next, like, the queue, and lyrics on or off come up along the bottom with the next song and the scan code, and the tab bar slides down. Up from the buttons selects the seek bar: Left and Right move the knob 10 seconds a press, holding one scrubs faster the longer it is held, and the song jumps there once the keys rest (OK jumps at once, Back drops it). They hide again after six seconds without a key (an open queue after thirty); Back hides them at once.
  - **Home:** what played lately on any device: albums to jump back into, then the songs themselves, then your latest liked songs. Before anything has played, your playlists instead.
  - **Search:** an on-screen keyboard. Results appear as you type.
  - **Library:** Liked songs and your playlists.

  OK on a song plays its row from there. OK on an album, playlist, or artist opens it, with Play, Shuffle, and Queue buttons. **Hold OK** on anything for more: play next, add to the queue, like, or go to the artist. The queue slides in from the right: OK jumps to a song, and holding OK removes one. Timed lyrics glide along with the song, the line being sung springs up bright, and pauses show breathing dots; plain lyrics scroll with the song. Back steps back, and pressing Back twice on the top level leaves the app. A minute without a key, with a song up, brings the app back to Now playing. The remote's media keys work from any screen: play and pause, next and previous, and fast-forward and rewind, which seek like the seek bar. Slint's Android backend drops those keys, so the app builds a patched copy of it (`vendor/i-slint-backend-android-activity`, see the root `Cargo.toml`).

- **Scan to play:** the TV shows a QR code for the server's address on the home Wi-Fi (`http://192.168.1.67:4310`). Anyone on the Wi-Fi can scan it and use the full app on their phone, without Tailscale.
- **Visuals:** ten scenes painted in shades of the cover's main color, pushed to full strength: a waveform tunnel, a kaleidoscope, a starfield that bursts on each kick, the cover stirred into a whirlpool, the cover folded into a kaleidoscope that flows outward, spectrum petals, plasma, an oscilloscope, shockwave rings fired by each kick, and a road of light toward the spectrum's mountains. The music picks them: calm songs get the slow, liquid scenes and loud songs with a strong kick get the fast ones. A new scene takes over when the music surges (a drop, a chorus coming in) or the song changes, and after a minute at most. While the TV isn't the one playing (paused, or playing on a phone), a slow made-up pulse keeps the calm scenes drifting. The screen shifts by a few pixels every 40 seconds so nothing burns in.

## How it fits together

```
apps/web         Foldkit SPA + foldcn components, installable as a PWA
apps/tv          Rust Android TV app: Slint UI, Symphonia (AAC), cpal (AAudio)
   │  Effect RPC over HTTP (/rpc, NDJSON)      catalog: search and pages (web only)
   │  JSON over HTTP (/tv/…)                   the same catalog shaped for the TV (TV only)
   │  WebSocket (/session, JSON)               the shared queue and who plays it
   │  HTTP with byte ranges (/audio/:videoId)  the songs themselves
apps/server      Bun + Effect server: youtubei.js for the catalog, yt-dlp for audio,
                 SQLite (bun:sqlite) for the playlists made in the app
packages/shared  The RPC contract, the session protocol, and every Schema
fixtures/session Example session messages that the TypeScript and Rust tests both decode
fixtures/tv      Example TV catalog responses, decoded the same way
```

**The session.** The server holds one queue for every device, and one device at a time plays it (the active device). Each device opens `/session`, says `Hello`, and then receives the whole session state after every change. Commands (play, pause, seek, skip, enqueue, transfer) go to the server, never directly to a player. The active device plays the current song and reports its position about once a second. A player that pauses says where it stopped, so every device agrees on the spot. A player that reconnects says in its `Hello` what it is playing, and the server follows it unless the session jumped meanwhile (a seek, a skip, or another device taking over). Volume belongs to each device, not to the session: the TV reports its Android music volume (`Volume`) when it connects and whenever it changes, and the server passes a `SetDeviceVolume` request on to the TV (`SetVolume`). The phone doesn't change the TV's volume: its hardware buttons can't, because iOS gives web apps no way to read them, and the slider it once had was removed. Use the TV remote. The protocol is defined in `packages/shared/src/session.ts` and mirrored in `apps/tv/src/protocol.rs`. The server keeps the session in `~/.local/share/music/session.json` (`SESSION_STATE_PATH`), written a second after each change and again as it stops, so a restart or deploy keeps the queue and the song. After a restart the song waits paused where it was, and a player that kept playing through the restart takes it back when it reconnects.

**Timed lyrics.** YouTube Music only gives signed-out clients plain lyrics, so timed ones come from [LRCLIB](https://lrclib.net), a free, open lyrics database that needs no account or key (`apps/server/src/lyrics/`). The server looks a song up by title, first artist, and length, and only trusts a copy whose length is within two seconds of the song's, so a music video with a longer intro never sings out of sync. It reads the LRC text into lines (and words, when timed word by word), and keeps every answer in a SQLite file so each song is looked up once; a song LRCLIB had nothing for is asked again after a week. A song page waits at most four seconds for a lookup, and the session looks up the current and next song ahead of time. When nothing matches, the player shows YouTube's plain lyrics as before. The phone and the TV work out the line being sung from their own playback clock (`apps/web/src/lyrics.ts`, `apps/tv/src/lyrics.rs`).

**The TV catalog.** The TV app browses without the phone through plain JSON routes under `/tv/`: home, library, search, albums, playlists, artists, lyrics, and Liked songs. They reshape the same catalog and playlist store the web app reaches through RPC into shelves of cards and lists of queue tracks, and they get songs ready the same way when a page opens. The contract is `packages/shared/src/tv.ts`, mirrored in `apps/tv/src/catalog.rs`; both sides' tests decode the examples in `fixtures/tv/`. The routes are in `apps/server/src/tvCatalog/`.

**Playlists.** The playlists made in the app, and Liked songs, are kept in one SQLite file on the server (`~/.local/share/music/playlists.sqlite`), opened with Bun's built-in `bun:sqlite`. Each entry keeps a copy of the song (title, artists, album, length, artwork), so a playlist opens without asking YouTube anything, and a song stays listed even if YouTube later drops it. A song appears once per playlist. The web app shows a change at once (a heart fills, a removed row leaves) and then takes the server's answer; if the server cannot save it, the app says so and reloads. A playlist plays through the same session commands as an album, so the TV app needs nothing new. `apps/server/src/playlists/store.ts` holds the tables and every change.

**Audio.** yt-dlp finds each song's AAC stream (format 140), using the proof-of-origin token service already on this machine (`yt-music-token`, `127.0.0.1:4416`). YouTube's links only work from the address that requested them, only with yt-dlp's User-Agent, and only a few seconds after they are issued. A request without a byte range is throttled to playback speed, so the server always asks for a range. The server downloads each song whole, once, into a disk cache (`~/.cache/music/audio`, 1 GB). `/audio/:videoId` serves a song with byte ranges while it is still downloading, then from disk. A song nobody prepared takes about 6 seconds to start: finding the link and YouTube's wait are most of it. A prepared song starts, and seeks, instantly for every device.

When the cache is full, songs played once or twice go first, least recently used first. Favorites (3 plays or more) go last, and the current song and the next five are never dropped. Play counts are kept in `plays.json` next to the songs.

**Getting songs ready early.** The prefetcher (`apps/server/src/prefetch.ts`) downloads some songs whole and only finds links for others. A song with a link already found starts in about a second.

| What happens               | Downloaded whole                | Link found only   |
| -------------------------- | ------------------------------- | ----------------- |
| Playing a queue            | The current song and the next 5 | The 5 after those |
| Opening an album or artist | The first 2 songs               | Songs 3 to 5      |
| Searching songs            | The top result                  | The next 2        |
| Opening a song page        | That song                       |                   |

Two workers take the most urgent job first, and a new page replaces the previous page's jobs. A song someone presses Play on never waits behind them: players go straight to the cache, and prefetching uses at most two of yt-dlp's three slots. To keep YouTube from flagging the server, prefetching may run yt-dlp 400 times a day, and it pauses for 15 minutes after 3 failures in a row.

**The phone's player.** The phone keeps up to 500 MB of songs in its own cache (Cache Storage), and asks the browser to keep it. A cached song plays from a local copy, so it starts and seeks with no network at all. A song that isn't cached streams right away and is saved for next time. While the phone is the player, it saves the current song and the next five, in queue order, again whenever the queue changes. When the cache is full, it drops songs the same way the server does; sizes and play counts live in localStorage. Seeking jumps within the loaded song, and play and pause respond before the server confirms. The full player has a seek bar that shows the position while you drag it, buttons to skip back and forward 15 seconds, and a spinner while audio loads.

**On the lock screen.** A locked phone may hear from the server late or not at all, and iOS stops a page that goes quiet in the background. So while the phone is the player, it does everything it can on its own first and tells the server after. When a song ends, the next one starts at once. Next, previous, play, pause, and the scrubber act on the phone right away; play and pause run inside the lock screen's own handler, where iOS counts them as a tap and lets audio start again. When the system pauses the song (a call, Siri, headphones unplugged), the session pauses too, so the play button works afterwards. Every state the server sends says how many of the phone's messages it includes, and the phone keeps its own changes until one does, so the answer to one press never undoes the next. If the connection dropped meanwhile, the phone reports what it played when it reconnects.

**The TV app.** Rust from top to bottom. The audio engine (`apps/tv/src/audio`) downloads each song into memory, decodes it with Symphonia while it arrives, and writes samples into a lock-free ring buffer that the AAudio callback drains. The next song is downloaded and opened while the current one plays, so it follows without a gap. The screen is a single Slint window drawn by Skia on the GPU, and it only redraws when something on it changes. Navigation lives in Rust (`nav.rs`): each remote key moves a plain state machine, which the tests drive, and `ui.rs` draws that state into Slint models, updating only the rows that changed. The now-playing visuals (`apps/tv/src/visuals`) are GLSL shaders drawn on the GPU under the Slint UI, through Slint's rendering notifier on the same OpenGL ES context, every frame while that screen shows. They follow the song two ways. The server analyzes each song once, before it plays (`/tv/analysis`: beats, bars, sections, drops), so the visuals land on the beat, build up before a drop, cut on it, and give a chorus that comes back the scene it had before. And `visualizer.rs` runs an FFT over what the TV is playing (`audio/scope.rs`, lock-free, delayed by the output latency the audio device reports so it matches what you hear) for the spectrum, the waveform, and the kick. `music.rs` joins the two, `director.rs` picks scenes, and `gpu.rs` draws them: each scene into its own pair of textures (for trails), then bloom, then `final.glsl` onto the screen. The scenes get smaller when frames come late and grow back when there is room. To browse, the TV reads the server's `/tv/...` routes (`packages/shared/src/tv.ts`, mirrored in `apps/tv/src/catalog.rs`), and it plays through the same session commands as the phone. The font is Inter (SIL Open Font License, `apps/tv/ui/fonts`). The app only speaks plain HTTP to the server, so it carries no TLS stack. The server relays album art at `/artwork?url=…`, for Google's image hosts only. If the app crashes, it posts the panic to `/tv-log`, and the report appears in the server's log (`journalctl --user -u music.service`).

**Waking the TV.** Home Assistant is already paired with the TV's Android TV Remote service. When you pick the TV while it is off, the server calls Home Assistant's `remote.turn_on` with `activity: music://play`. That turns the TV on and opens the app through its deep link. If the TV has not connected within 60 seconds, the phone shows a notice and playback pauses.

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

To install it, open `http://192.168.1.67:4310/tv.apk` in the TV's Downloader app. The server serves the file at `TV_APK_PATH` there. Send Files to TV works too. Joshify then appears in the TV's app list.

After that first install, the app updates itself. Each build gets an id (`<commit>-<UTC time>`), which the build script compiles into the app and writes to `dist/music-tv.build`; the server answers it at `/tv/version`. The app checks only when it starts and when you pick Check for updates in its settings, so a deploy never closes it while you use it. When the server has another build, the app downloads it, waits until nothing has played on the TV for 30 seconds, and installs it. If Joshify was on screen, the server then reopens it through Home Assistant when it doesn't come back by itself within 20 seconds. If the TV was in standby or showing another app, Joshify stays closed until you open it. Once, the first time, allow "Install unknown apps" for Joshify when the app asks. After that, updates install by themselves on Android 12 and later while nothing plays. Older Android versions, or a TV that wants a confirmation anyway, show Android's Install prompt instead. Failures show in the app and in `journalctl --user -u music.service`. A build that fails to install three times is left alone until the next one.

To see the screens without a TV, render them to PNG files. This needs a server with the `/tv` routes; it reads the catalog and artwork from it, and makes up its own queue instead of joining the session:

```sh
MUSIC_SERVER_URL=http://127.0.0.1:3001 cargo run -p music-tv --features screenshots --example screens -- /path/to/folder
```

The visuals' shaders also run in a browser. The lab draws the same shader files with WebGL 2, driven by a made-up song (or your own cover image), with a button per scene:

```sh
bun apps/tv/visuals-lab/build.ts   # then open apps/tv/visuals-lab/dist/index.html
```

`dist/sheet.html` shows every scene still, side by side. To see the real TV, ask it for screenshots while its visuals show: `curl -X POST 'http://127.0.0.1:4310/tv/capture?count=3'`. They land in `~/.cache/music/tv-frames/`. The TV also reports its GPU, any shader that failed to compile, and how large it draws the scenes to `/tv-log`, which shows in the server's log.

Tests run on this machine without a TV:

```sh
cargo test -p music-tv
# Plays real songs through a running server into a silent output.
MUSIC_TEST_SERVER=http://127.0.0.1:3001 cargo test -p music-tv -- --ignored
```

The logo lives in `branding/` as SVG. After changing it, run `scripts/render-icons.sh` to redraw the web app's icons, the TV launcher icon, and the logo the TV app shows.

What the TV app does not do yet: it has no TV banner image (cargo-apk can't declare one), so the launcher shows its icon instead. If you leave the app, Android can stop the music whenever it likes, because keeping music playing in the background needs a small Java service. The phone's own player has a short gap between songs.

## Hosting

The installed app runs on this machine as the `music.service` systemd user unit. The Bun server serves the built web app from `apps/web/dist`, along with `/rpc`, `/session`, and `/audio`, on port 4310. It listens on every interface (`HOST=0.0.0.0`) so the TV can reach it over the home network. The unit sets `YTDLP_PATH` and `TV_APK_PATH`. `AUDIO_CACHE_DIR` and `AUDIO_CACHE_MAX_BYTES` change where songs are kept and how much space they may use. `PLAYLISTS_DB_PATH` changes where the playlists are kept, and `LYRICS_DB_PATH` where timed lyrics are cached (`~/.local/share/music/lyrics.sqlite`). `LRCLIB_URL` points the lyrics lookup at a self-hosted LRCLIB. `bun run dev` uses the same playlist file by default, so set it to a scratch path when you try changes against real playlists. The unit also reads the Home Assistant settings from `~/.config/music/server.env`:

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
| `bun apps/tv/visuals-lab/build.ts`     | Builds the visuals lab: the TV's shaders in a browser         |

## Caveats

- `youtubei.js` uses YouTube's private API. A YouTube change can break it until the library is updated, and using it is against YouTube's terms. It is fine for personal use.
- Audio depends on yt-dlp and the token service keeping up with YouTube. When songs stop playing, update yt-dlp first: `uv tool upgrade yt-dlp`.
- yt-dlp solves YouTube's challenges with Bun. It warns that Bun 1.4 is newer than it has been tested with; installing Deno and setting `YTDLP_JS_RUNTIME=deno` is the supported route if that ever breaks.
- The server picks out some artist-page sections by their English titles ("Albums", "Singles & EPs"), so the session is pinned to English.
