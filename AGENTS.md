# Agent notes

YouTube Music on the phone (Foldkit PWA) and the TV (Rust Android TV app), sharing one playback session. See `README.md` for what it does and how to run it.

## Layout

- `packages/shared`: the Effect RPC group (`MusicRpcs`) and the domain Schemas. Change the contract here first; both apps compile against it directly from source (no build step).
- `apps/server`: Bun + `@effect/platform-bun`. `src/youtubeMusic/mapping.ts` turns `youtubei.js` nodes into shared Schemas and holds all of the YouTube-specific parsing. `service.ts` is the `YouTubeMusic` Effect service. `rpcHandlers.ts` wires it to `MusicRpcs`.
- `apps/server`: also `audio.ts` (yt-dlp resolution and the `/audio/:videoId` relay) and `session/` (`model.ts` holds the pure session state transitions, `hub.ts` the WebSocket, `wake.ts` the Home Assistant wake call).
- `apps/web`: a Foldkit app. Read `apps/web/FOLDKIT.md` before changing it; it is Foldkit's own convention guide. Playback lives in `src/playback/` (ManagedResources for the session socket and the audio element, their Subscriptions, Commands, and update helpers) and `src/view/player.ts`.
- `apps/tv`: the Rust Android TV app, the only member of the root Cargo workspace. `audio/` is the playback engine, `controller.rs` reconciles session state with it, `ui/app.slint` is the screen.

## Conventions

- Effect 4 (`effect@4.1.x`). Versions shared across packages live in the root `catalog`. Keep `effect` on one version everywhere, because the RPC Schemas cross package boundaries.
- Foldkit and Effect APIs: check the vendored Foldkit source in `apps/web/repos/foldkit` (a git subtree pinned to the installed release) before writing from memory. After upgrading Foldkit, re-pin it with `git subtree pull --prefix=apps/web/repos/foldkit https://github.com/foldkit/foldkit.git foldkit@<version> --squash` and copy its `packages/create-foldkit-app/templates/base/FOLDKIT.md` over `apps/web/FOLDKIT.md`. `examples/api-cache-query` (Query), `examples/query-sync` (URL-owned search state), and `packages/typing-game` (Effect RPC) are the closest references.
- Remote data uses `Query.define` from `foldkit/experimental` (`apps/web/src/query.ts`). Each lookup is cached in the Model by its arguments.
- The search query and kind live in the URL (`/?q=…&kind=Artists`); the Model holds only the text being typed. Typing waits `SEARCH_DEBOUNCE` and then replaces the URL.

## Session protocol

The session protocol is defined twice: Effect Schemas in `packages/shared/src/session.ts` and serde types in `apps/tv/src/protocol.rs`. Change both together, and add or update a file in `fixtures/session/`. The server tests (`apps/server/src/session/model.test.ts`) and the Rust tests (`cargo test -p music-tv`) both decode those fixtures, so a field that changes on one side only fails a test. Keep wire fields plain JSON (`null`, never `Option`).

The server owns the session. Players never change it directly: they follow `State` and report `Progress`, `Advanced`, `TrackEnded`, and `TrackFailed`. A player reloads when `currentEntryId` or `seekSeq` changes.

## TV app

Build it with `scripts/build-tv-apk.sh` (see README). Slint's Android backend always uses Skia. 64-bit Skia comes prebuilt; 32-bit is compiled from source. `cargo test -p music-tv` runs on the host: there cpal is left out and a thread drains the audio ring in real time, so the engine runs unchanged.

## foldcn components

`apps/web/src/components/ui` and `apps/web/src/lib` are copied in from the foldcn registry (https://foldcn.elianiva.com) with the shadcn CLI. Leave them as upstream ships them so `shadcn add` can update them; lint and format skip both folders. Because of these files, `apps/web/tsconfig.json` turns off `exactOptionalPropertyTypes`.

`shadcn add @foldcn/<name>` rewrites `apps/web/package.json` to older `foldkit`/`effect` versions. After adding a component, restore the pinned versions and the `catalog:` entries, then run `bun install`.
