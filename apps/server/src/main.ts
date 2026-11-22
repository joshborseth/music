import { Config, Effect, Layer, Option } from 'effect'
import {
  HttpMiddleware,
  HttpPlatform,
  HttpRouter,
  HttpServer,
} from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'

import { BunHttpServer, BunRuntime, BunServices } from '@effect/platform-bun'
import { MusicRpcs } from '@music/shared'

import { SongAnalysisLive } from './analysis/service.ts'
import { ArtworkRoutes } from './artwork.ts'
import { AudioRoutes, AudioSourceLive } from './audio.ts'
import { AudioStoreLive } from './audioStore.ts'
import { DepthRoutes } from './depth/routes.ts'
import { CoverDepthLive } from './depth/service.ts'
import { CertificateRoute, LanTlsConfig, lanHttpsServer } from './lanHttps.ts'
import { TimedLyricsLive } from './lyrics/service.ts'
import { MontageRoutes } from './montage/routes.ts'
import { SongMontageLive } from './montage/service.ts'
import { ArtworkPaletteLive } from './palette/service.ts'
import { PlaylistStoreLive } from './playlists/store.ts'
import { PrefetcherLive } from './prefetch.ts'
import { MusicRpcsLive } from './rpcHandlers.ts'
import { SessionHubLive, SessionRoutes } from './session/hub.ts'
import { TvWakerLive } from './session/wake.ts'
import { TvAppRoutes, TvUpdatingRoute } from './tvApp.ts'
import { TvCatalogRoutes } from './tvCatalog/routes.ts'
import { WebAppRoutes } from './webApp.ts'
import { YouTubeMusicLive } from './youtubeMusic/service.ts'

const DEFAULT_PORT = 3001
const DEFAULT_HOSTNAME = '127.0.0.1'

/** Timed lyrics, shared by the RPCs, the TV routes, and the session. */
const LyricsLive = TimedLyricsLive.pipe(Layer.provide(BunServices.layer))

/**
 * Playlists, Liked songs, and the play history: one SQLite file, shared by
 * the catalog (which reads it) and the session (which notes each play).
 */
const PlaylistsLive = PlaylistStoreLive.pipe(Layer.provide(BunServices.layer))

/**
 * Songs on disk, downloaded through yt-dlp, the prefetcher that gets them
 * ready early, and each song's analysis, its cover's depth, and its montage
 * for the TV's visuals: shared by the RPCs and playback.
 */
const AudioLive = PrefetcherLive.pipe(
  Layer.provideMerge(SongMontageLive.pipe(Layer.provide(YouTubeMusicLive))),
  Layer.provideMerge(SongAnalysisLive),
  Layer.provideMerge(CoverDepthLive),
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
const CatalogRoutes = Layer.mergeAll(
  RpcRoutes,
  TvCatalogRoutes,
  MontageRoutes,
).pipe(
  Layer.provide(YouTubeMusicLive),
  Layer.provide(ArtworkPaletteLive),
  Layer.provide(LyricsLive),
  Layer.provide(PlaylistsLive),
  Layer.provide(AudioLive),
)

const PlaybackRoutes = Layer.mergeAll(
  AudioRoutes,
  SessionRoutes,
  TvUpdatingRoute,
  DepthRoutes,
).pipe(
  Layer.provide(SessionHubLive.pipe(Layer.provide(BunServices.layer))),
  Layer.provide(YouTubeMusicLive),
  Layer.provide(LyricsLive),
  Layer.provide(PlaylistsLive),
  Layer.provide(TvWakerLive),
  Layer.provideMerge(AudioLive),
)

const AppRoutes = Layer.mergeAll(
  CatalogRoutes,
  PlaybackRoutes,
  ArtworkRoutes,
  TvAppRoutes.pipe(Layer.provide(BunServices.layer)),
  WebAppRoutes.pipe(Layer.provide(BunServices.layer)),
  CertificateRoute,
)

const Hostname = Config.String('HOST').pipe(
  Config.withDefault(DEFAULT_HOSTNAME),
)

/**
 * One router, served on plain HTTP (`PORT`, for the TV and guests) and, when
 * there is a certificate, on HTTPS (`TLS_PORT`, for the phone: `lanHttps.ts`).
 * Both listeners share every service, so a phone on HTTPS and the TV on HTTP
 * are in the same session.
 */
const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const handler = yield* HttpRouter.toHttpEffect(AppRoutes)
    const serveOn = <E, R>(
      server: Layer.Layer<
        HttpServer.HttpServer | HttpPlatform.HttpPlatform,
        E,
        R
      >,
    ) =>
      HttpServer.serve(handler, HttpMiddleware.logger).pipe(
        Layer.provide(server),
      )
    const hostname = yield* Hostname
    const http = serveOn(
      BunHttpServer.layerConfig({
        port: Config.Port('PORT').pipe(Config.withDefault(DEFAULT_PORT)),
        hostname: Config.succeed(hostname),
      }).pipe(HttpServer.withLogAddress),
    )
    const maybeTls = yield* LanTlsConfig
    return Option.match(maybeTls, {
      onNone: () => http,
      onSome: tls =>
        Layer.mergeAll(
          http,
          serveOn(lanHttpsServer(hostname, tls)),
          Layer.effectDiscard(
            Effect.logInfo(`Listening on https://${hostname}:${tls.port}`),
          ),
        ),
    })
  }),
).pipe(Layer.provide(BunHttpServer.layerHttpServices))

BunRuntime.runMain(Layer.launch(ServerLive))
