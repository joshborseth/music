import { Config, Effect, Layer, Option } from 'effect'
import { HttpRouter, HttpStaticServer } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'

import { BunHttpServer, BunRuntime, BunServices } from '@effect/platform-bun'
import { MusicRpcs } from '@music/shared'

import { SongAnalysisLive } from './analysis/service.ts'
import { ArtworkRoutes } from './artwork.ts'
import { AudioRoutes, AudioSourceLive } from './audio.ts'
import { AudioStoreLive } from './audioStore.ts'
import { TimedLyricsLive } from './lyrics/service.ts'
import { NowPlayingFeedLive, NowPlayingRoutes } from './nowPlaying.ts'
import { ArtworkPaletteLive } from './palette/service.ts'
import { PlaylistStoreLive } from './playlists/store.ts'
import { PrefetcherLive } from './prefetch.ts'
import { MusicRpcsLive } from './rpcHandlers.ts'
import { SessionHubLive, SessionRoutes } from './session/hub.ts'
import { TvWakerLive } from './session/wake.ts'
import { TvAppRoutes, TvUpdatingRoute } from './tvApp.ts'
import { TvCatalogRoutes } from './tvCatalog/routes.ts'
import { YouTubeMusicLive } from './youtubeMusic/service.ts'

const DEFAULT_PORT = 3001
const DEFAULT_HOSTNAME = '127.0.0.1'

const STATIC_MIME_TYPES = { webmanifest: 'application/manifest+json' }

/** Timed lyrics, shared by the RPCs, the TV routes, and the session. */
const LyricsLive = TimedLyricsLive.pipe(Layer.provide(BunServices.layer))

/**
 * Songs on disk, downloaded through yt-dlp, the prefetcher that gets them
 * ready early, and each song's analysis for the TV's visuals: shared by the
 * RPCs and playback.
 */
const AudioLive = PrefetcherLive.pipe(
  Layer.provideMerge(SongAnalysisLive),
  Layer.provideMerge(AudioStoreLive),
  Layer.provideMerge(AudioSourceLive),
  Layer.provide(BunServices.layer),
)

const RpcRoutes = RpcServer.layerHttp({
  group: MusicRpcs,
  path: '/rpc',
  protocol: 'http',
}).pipe(
  Layer.provide(MusicRpcsLive),
  Layer.provide(RpcSerialization.layerNdjson),
)

/**
 * The catalog in both shapes: Effect RPC for the web app, plain JSON under
 * `/tv/` for the TV app. They share one playlist store and one prefetcher.
 */
const CatalogRoutes = Layer.mergeAll(RpcRoutes, TvCatalogRoutes).pipe(
  Layer.provide(YouTubeMusicLive),
  Layer.provide(ArtworkPaletteLive),
  Layer.provide(LyricsLive),
  Layer.provide(PlaylistStoreLive.pipe(Layer.provide(BunServices.layer))),
  Layer.provide(AudioLive),
)

/**
 * Serves the built web app when `WEB_DIST_DIR` is set, so one origin carries
 * both the app and its RPC endpoint. In development Vite serves the app.
 */
const WebAppRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const maybeWebDistDir = yield* Config.option(Config.String('WEB_DIST_DIR'))
    return Option.match(maybeWebDistDir, {
      onNone: () => Layer.empty,
      onSome: root =>
        HttpStaticServer.layer({
          root,
          spa: true,
          cacheControl: 'no-cache',
          mimeTypes: STATIC_MIME_TYPES,
        }),
    })
  }),
)

const PlaybackRoutes = Layer.mergeAll(
  AudioRoutes,
  SessionRoutes,
  NowPlayingRoutes,
  TvUpdatingRoute,
).pipe(
  Layer.provide(NowPlayingFeedLive),
  Layer.provide(SessionHubLive.pipe(Layer.provide(BunServices.layer))),
  Layer.provide(YouTubeMusicLive),
  Layer.provide(LyricsLive),
  Layer.provide(ArtworkPaletteLive),
  Layer.provide(TvWakerLive),
  Layer.provideMerge(AudioLive),
)

const ServerLive = HttpRouter.serve(
  Layer.mergeAll(
    CatalogRoutes,
    PlaybackRoutes,
    ArtworkRoutes,
    TvAppRoutes.pipe(Layer.provide(BunServices.layer)),
    WebAppRoutes,
  ),
).pipe(
  Layer.provide(
    BunHttpServer.layerConfig({
      port: Config.Port('PORT').pipe(Config.withDefault(DEFAULT_PORT)),
      hostname: Config.String('HOST').pipe(
        Config.withDefault(DEFAULT_HOSTNAME),
      ),
    }),
  ),
)

BunRuntime.runMain(Layer.launch(ServerLive))
