<img src="apps/web/public/favicon.svg" width="64" height="64" alt="">

# Music

Search YouTube Music on your phone and play it on the phone or on the TV. The phone app is a PWA; the TV app is a native Android TV app written in Rust. Every device shares one queue, and the phone works as the TV's remote.

## What it does

- **Search** songs, artists, or albums. Results update as you type, and your last eight searches are kept on the device.
- **Song page:** artwork, artists, album, length, view count, lyrics, and the "up next" list YouTube Music would play after it.
- **Artist page:** photo, bio, top songs, albums, singles and EPs, and similar artists.
- **Album page:** cover, artists, release kind and year, total length, description, and the numbered tracklist.
- **Playback:** play a song, an album, or an artist's top songs, or add them to the queue to play next or last. The player shows the queue and the devices you can play on.
- **Play on the TV:** pick the TV in the player. If the TV is off, the server turns it on and opens the TV app. Playback moves over at the same position, and the phone stays in control. The phone can then lock or go offline; the TV keeps playing.
- **TV app:** a now-playing screen with artwork, progress, and what comes next. The remote's center button plays and pauses, left and right skip 10 seconds, and up and down go to the previous or next song.

## How it fits together

```
apps/web         Foldkit SPA + foldcn components, installable as a PWA
apps/tv          Rust Android TV app: Slint UI, Symphonia (AAC), cpal (AAudio)
   │  Effect RPC over HTTP (/rpc, NDJSON)      catalog: search and pages (web only)
   │  WebSocket (/session, JSON)               the shared queue and who plays it
   │  HTTP with byte ranges (/audio/:videoId)  the songs themselves
apps/server      Bun + Effect server: youtubei.js for the catalog, yt-dlp for audio
packages/shared  The RPC contract, the session protocol, and every Schema
fixtures/session Example session messages that the TypeScript and Rust tests both decode
```

**The session.** The server holds one queue for every device, and one device at a time plays it (the active device). Each device opens `/session`, says `Hello`, and then receives the whole session state after every change. Commands (play, pause, seek, skip, enqueue, transfer) go to the server, never directly to a player. The active device plays the current song and reports its position about once a second. The protocol is defined in `packages/shared/src/session.ts` and mirrored in `apps/tv/src/protocol.rs`.

**Audio.** yt-dlp finds each song's AAC stream (format 140), using the proof-of-origin token service already on this machine (`yt-music-token`, `127.0.0.1:4416`). The server then relays it at `/audio/:videoId`. YouTube's links only work from the address that requested them, only with yt-dlp's User-Agent, and only a few seconds after they are issued, so the server resolves the current song and the next two ahead of time. It always asks YouTube for a byte range, because a plain request is throttled to playback speed. The first play of a song takes about 7 seconds; songs resolved ahead of time start right away.

**The TV app.** Rust from top to bottom. The audio engine (`apps/tv/src/audio`) downloads each song into memory, decodes it with Symphonia while it arrives, and writes samples into a lock-free ring buffer that the AAudio callback drains. The next song is downloaded and opened while the current one plays, so it follows without a gap. The screen is a single Slint window drawn by Skia on the GPU, and it only redraws when something on it changes. The app only speaks plain HTTP to the server, so it carries no TLS stack. The server relays album art at `/artwork?url=…`, for Google's image hosts only. If the app crashes, it posts the panic to `/tv-log`, and the report appears in the server's log (`journalctl --user -u music.service`).

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

To install it, open `http://192.168.1.67:4310/tv.apk` in the TV's Downloader app. The server serves the file at `TV_APK_PATH` there. Send Files to TV works too. Music then appears in the TV's app list.

Tests run on this machine without a TV:

```sh
cargo test -p music-tv
# Plays real songs through a running server into a silent output.
MUSIC_TEST_SERVER=http://127.0.0.1:3001 cargo test -p music-tv -- --ignored
```

What v1 does not do yet: the app has no TV banner image, so the launcher shows its icon instead. If you leave the app, Android can stop the music whenever it likes, because keeping music playing in the background needs a small Java service. The phone's own player has a short gap between songs.

## Hosting

The installed app runs on this machine as the `music.service` systemd user unit. The Bun server serves the built web app from `apps/web/dist`, along with `/rpc`, `/session`, and `/audio`, on port 4310. It listens on every interface (`HOST=0.0.0.0`) so the TV can reach it over the home network. The unit sets `YTDLP_PATH` and `TV_APK_PATH`, and reads the Home Assistant settings from `~/.config/music/server.env`:

```sh
HA_TOKEN=<a long-lived access token from your Home Assistant profile>
TV_HA_ENTITY=remote.joshies_gamer_tv
```

Without those two values, the TV only shows up in the device list while its app is open. Tailscale Serve publishes it to the tailnet only (no Funnel) on port 7443 of this machine's Tailscale name: `https://<machine>.<tailnet>.ts.net:7443`. Run `tailscale serve status` to see the exact address.

On the iPhone, open that address in Safari, tap Share, then **Add to Home Screen**.

- Ship changes: `bun run deploy` builds the web app and restarts the service.
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
| `cargo test -p music-tv`               | TV app tests: protocol fixtures, streaming, formatting        |

## Caveats

- `youtubei.js` uses YouTube's private API. A YouTube change can break it until the library is updated, and using it is against YouTube's terms. It is fine for personal use.
- Audio depends on yt-dlp and the token service keeping up with YouTube. When songs stop playing, update yt-dlp first: `uv tool upgrade yt-dlp`.
- yt-dlp solves YouTube's challenges with Bun. It warns that Bun 1.4 is newer than it has been tested with; installing Deno and setting `YTDLP_JS_RUNTIME=deno` is the supported route if that ever breaks.
- The server picks out some artist-page sections by their English titles ("Albums", "Singles & EPs", "Fans might also like"), so the session is pinned to English.
