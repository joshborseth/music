import { Effect } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

/*
 * `GET /artwork?url=…`: relays YouTube Music artwork for the TV app, so the
 * TV only ever talks plain HTTP to this server and carries no TLS stack.
 * Only Google's image hosts are relayed.
 */

const ALLOWED_HOSTS = /(^|\.)(googleusercontent\.com|ytimg\.com|ggpht\.com)$/
const CACHE_CONTROL = 'public, max-age=604800, immutable'

export const allowedArtworkUrl = (raw: string | null): URL | undefined => {
  if (raw === null || !URL.canParse(raw)) {
    return undefined
  }
  const url = new URL(raw)
  return url.protocol === 'https:' && ALLOWED_HOSTS.test(url.hostname)
    ? url
    : undefined
}

const relayArtwork = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = allowedArtworkUrl(
    new URL(request.url, 'http://localhost').searchParams.get('url'),
  )
  if (url === undefined) {
    return HttpServerResponse.text('Not an artwork URL', { status: 400 })
  }
  const response = yield* Effect.tryPromise({
    try: signal => fetch(url, { signal }),
    catch: () => 'Unreachable' as const,
  }).pipe(Effect.orElseSucceed(() => undefined))
  if (response === undefined || !response.ok) {
    return HttpServerResponse.text('Artwork unavailable', { status: 502 })
  }
  return HttpServerResponse.fromWeb(
    new Response(response.body, {
      headers: {
        'content-type': response.headers.get('content-type') ?? 'image/jpeg',
        'cache-control': CACHE_CONTROL,
      },
    }),
  )
})

export const ArtworkRoutes = HttpRouter.add('GET', '/artwork', relayArtwork)
