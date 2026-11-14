import { Config, Effect, FileSystem, Option } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'

import { BunHttpServer } from '@effect/platform-bun'

/**
 * The app over HTTPS on the home network, for the phone.
 *
 * A Home Screen app keeps the address it was added from, and needs HTTPS for
 * its service worker, its downloads, and its song cache. The Tailscale name
 * only reaches this machine while Tailscale is on, so the phone's address is
 * the machine's own on the Wi-Fi instead, with a certificate from a small
 * certificate authority of this machine's own (`scripts/lan-cert.sh`), which
 * the phone trusts once. Away from home, Tailscale's subnet route reaches the
 * same address. The TV and guests who scan its QR code keep plain HTTP.
 */
export interface LanTls {
  readonly port: number
  readonly certPath: string
  readonly keyPath: string
}

/**
 * `TLS_PORT`, `TLS_CERT_PATH`, and `TLS_KEY_PATH`, when all three are set and
 * both files exist. A missing certificate only logs a warning, so the app
 * still serves plain HTTP when making one failed.
 */
export const LanTlsConfig = Effect.gen(function* () {
  const maybeSettings = yield* Config.option(
    Config.all({
      port: Config.Port('TLS_PORT'),
      certPath: Config.String('TLS_CERT_PATH'),
      keyPath: Config.String('TLS_KEY_PATH'),
    }),
  )
  if (Option.isNone(maybeSettings)) {
    return Option.none<LanTls>()
  }
  const settings = maybeSettings.value
  const fs = yield* FileSystem.FileSystem
  const exists = (path: string) =>
    fs.exists(path).pipe(Effect.orElseSucceed(() => false))
  if (
    !(yield* exists(settings.certPath)) ||
    !(yield* exists(settings.keyPath))
  ) {
    yield* Effect.logWarning(
      'No HTTPS: the certificate is missing',
      settings.certPath,
    )
    return Option.none<LanTls>()
  }
  return Option.some<LanTls>(settings)
})

/** A Bun server on every interface for `tls`. */
export const lanHttpsServer = (hostname: string, tls: LanTls) =>
  BunHttpServer.layer({
    hostname,
    port: tls.port,
    tls: { cert: Bun.file(tls.certPath), key: Bun.file(tls.keyPath) },
  })

/**
 * `GET /certificate`: the certificate authority's own certificate
 * (`TLS_CA_PATH`), for the phone to install and trust. Safari offers a file
 * of this type as a profile.
 */
export const CertificateRoute = HttpRouter.use(router =>
  Effect.gen(function* () {
    const maybePath = yield* Config.option(Config.String('TLS_CA_PATH'))
    if (Option.isNone(maybePath)) {
      return
    }
    yield* router.add(
      'GET',
      '/certificate',
      HttpServerResponse.file(maybePath.value, {
        contentType: 'application/x-x509-ca-cert',
        headers: {
          'content-disposition': 'attachment; filename="joshify.crt"',
          'cache-control': 'no-cache',
        },
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text('There is no certificate yet', {
              status: 404,
            }),
          ),
        ),
      ),
    )
  }),
)
