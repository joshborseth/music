import { Config, Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'

import { BunHttpServer, BunRuntime } from '@effect/platform-bun'
import { MusicRpcs } from '@music/shared'

import { MusicRpcsLive } from './rpcHandlers.ts'
import { YouTubeMusicLive } from './youtubeMusic/service.ts'

const DEFAULT_PORT = 3001

const RpcRoutes = RpcServer.layerHttp({
  group: MusicRpcs,
  path: '/rpc',
  protocol: 'http',
}).pipe(
  Layer.provide(MusicRpcsLive),
  Layer.provide(YouTubeMusicLive),
  Layer.provide(RpcSerialization.layerNdjson),
)

const ServerLive = HttpRouter.serve(RpcRoutes).pipe(
  Layer.provide(
    BunHttpServer.layerConfig({
      port: Config.Port('PORT').pipe(Config.withDefault(DEFAULT_PORT)),
    }),
  ),
)

BunRuntime.runMain(Layer.launch(ServerLive))
