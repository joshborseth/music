import { Context, Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcClient, RpcClientError, RpcSerialization } from 'effect/rpc'

import { MusicRpcs } from '@music/shared'

const RPC_PATH = '/rpc'

type MusicRpcClient = RpcClient.FromGroup<
  typeof MusicRpcs,
  RpcClientError.RpcClientError
>

/** The typed client for the music server's RPC endpoint. */
export class MusicClient extends Context.Service<MusicClient, MusicRpcClient>()(
  'MusicClient',
) {}

const ProtocolLive = Layer.unwrap(
  Effect.sync(() =>
    RpcClient.layerProtocolHttp({
      url: new URL(RPC_PATH, globalThis.location.origin).toString(),
    }),
  ),
).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]))

export const MusicClientLive = Layer.effect(
  MusicClient,
  RpcClient.make(MusicRpcs),
).pipe(Layer.provide(ProtocolLive))
