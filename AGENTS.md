# Agent notes

Phone-first, read-only YouTube Music browser. See `README.md` for what it does and how to run it.

## Layout

- `packages/shared`: the Effect RPC group (`MusicRpcs`) and the domain Schemas. Change the contract here first; both apps compile against it directly from source (no build step).
- `apps/server`: Bun + `@effect/platform-bun`. `src/youtubeMusic/mapping.ts` turns `youtubei.js` nodes into shared Schemas and holds all of the YouTube-specific parsing. `service.ts` is the `YouTubeMusic` Effect service. `rpcHandlers.ts` wires it to `MusicRpcs`.
- `apps/web`: a Foldkit app. Read `apps/web/FOLDKIT.md` before changing it; it is Foldkit's own convention guide.

## Conventions

- Effect 4 (`effect@4.1.x`). Versions shared across packages live in the root `catalog`. Keep `effect` on one version everywhere, because the RPC Schemas cross package boundaries.
- Foldkit and Effect APIs: check the Foldkit repo (`~/.cache/reference-repos/foldkit`, or `apps/web/repos/foldkit` if vendored) before writing from memory. `examples/api-cache-query` (Query), `examples/query-sync` (URL-owned search state), and `packages/typing-game` (Effect RPC) are the closest references.
- Remote data uses `Query.define` from `foldkit/experimental` (`apps/web/src/query.ts`). Each lookup is cached in the Model by its arguments.
- The search query and kind live in the URL (`/?q=…&kind=Artists`); the Model holds only the text being typed. Typing waits `SEARCH_DEBOUNCE` and then replaces the URL.

## foldcn components

`apps/web/src/components/ui` and `apps/web/src/lib` are copied in from the foldcn registry (https://foldcn.elianiva.com) with the shadcn CLI. Leave them as upstream ships them so `shadcn add` can update them; lint and format skip both folders. Because of these files, `apps/web/tsconfig.json` turns off `exactOptionalPropertyTypes`.

`shadcn add @foldcn/<name>` rewrites `apps/web/package.json` to older `foldkit`/`effect` versions. After adding a component, restore the pinned versions and the `catalog:` entries, then run `bun install`.
