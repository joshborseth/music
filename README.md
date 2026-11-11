<img src="apps/web/public/favicon.svg" width="64" height="64" alt="">

# Music

A phone-first PWA for searching YouTube Music and reading about songs, artists, and albums. Read-only for now: there is no playback.

## What it does

- **Search** songs, artists, or albums. Results update as you type, and your last eight searches are kept on the device.
- **Song page:** artwork, artists, album, length, view count, lyrics, and the "up next" list YouTube Music would play after it.
- **Artist page:** photo, bio, top songs, albums, singles and EPs, and similar artists.
- **Album page:** cover, artists, release kind and year, total length, description, and the numbered tracklist.

## How it fits together

```
apps/web         Foldkit SPA + foldcn components, installable as a PWA
   │  Effect RPC over HTTP (/rpc, NDJSON)
apps/server      Bun + Effect server that asks YouTube Music through youtubei.js
packages/shared  The RPC contract and every Schema both sides use
```

YouTube blocks cross-origin calls from browsers, so the browser never talks to YouTube directly. The server maps YouTube's loosely typed responses into the Schemas in `packages/shared`, and Effect RPC validates them on both ends. Artwork loads straight from Google's image CDN, and the service worker caches it.

## Run it

You need [Bun](https://bun.sh) 1.3 or later.

```sh
bun install
bun run dev
```

This starts the server on port 3001 and Vite on port 5173. Vite forwards `/rpc` to the server. Open http://localhost:5173, or the `Network` address Vite prints to try it on your phone over the LAN or Tailscale.

## Hosting

The installed app runs on this machine as the `music.service` systemd user unit. The Bun server serves the built web app from `apps/web/dist` and `/rpc` together on `127.0.0.1:4310`. Tailscale Serve publishes it to the tailnet only (no Funnel) on port 7443 of this machine's Tailscale name: `https://<machine>.<tailnet>.ts.net:7443`. Run `tailscale serve status` to see the exact address.

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

## Caveats

- `youtubei.js` uses YouTube's private API. A YouTube change can break it until the library is updated, and using it is against YouTube's terms. It is fine for personal use.
- The server picks out some artist-page sections by their English titles ("Albums", "Singles & EPs", "Fans might also like"), so the session is pinned to English.
