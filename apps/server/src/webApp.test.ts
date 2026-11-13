import { afterAll, describe, expect, test } from 'bun:test'
import { ConfigProvider, Layer, Option } from 'effect'
import { HttpRouter } from 'effect/http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { BunHttpServer } from '@effect/platform-bun'

import {
  IMMUTABLE,
  REVALIDATE,
  WebAppRoutes,
  preferredEncoding,
} from './webApp.ts'

const directory = mkdtempSync(join(tmpdir(), 'music-web-app-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const script = `console.log(${JSON.stringify('Joshify '.repeat(200))})\n`
const page = '<!doctype html><title>Joshify</title><div id="app"></div>\n'
mkdirSync(join(directory, 'assets'))
writeFileSync(join(directory, 'assets', 'index-D9hMkoc5.js'), script)
writeFileSync(join(directory, 'index.html'), page)
writeFileSync(join(directory, 'sw.js'), 'self.skipWaiting()\n')
writeFileSync(join(directory, 'pwa-192x192.png'), new Uint8Array([137, 80]))

const { handler, dispose } = HttpRouter.toWebHandler(
  WebAppRoutes.pipe(
    Layer.provide(BunHttpServer.layerHttpServices),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ WEB_DIST_DIR: directory }),
      ),
    ),
  ),
  { disableLogger: true },
)
afterAll(() => dispose())

const get = (path: string, headers: Record<string, string> = {}) =>
  handler(new Request(`http://music.test${path}`, { headers }))

const BROWSER = { 'accept-encoding': 'gzip, deflate, br' }

describe('serving the web app', () => {
  test('sends a hashed asset compressed with Brotli, cached for good', async () => {
    const response = await get('/assets/index-D9hMkoc5.js', BROWSER)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBe('br')
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE)
    expect(response.headers.get('vary')).toBe('Accept-Encoding')
    expect(response.headers.get('content-type')).toContain('text/javascript')
    const body = new Uint8Array(await response.arrayBuffer())
    expect(body.byteLength).toBeLessThan(script.length / 4)
    expect(brotliDecompressSync(body).toString()).toBe(script)
  })

  test('falls back to gzip, and to the plain file', async () => {
    const gzipped = await get('/assets/index-D9hMkoc5.js', {
      'accept-encoding': 'gzip',
    })
    expect(gzipped.headers.get('content-encoding')).toBe('gzip')
    expect(
      gunzipSync(new Uint8Array(await gzipped.arrayBuffer())).toString(),
    ).toBe(script)

    const plain = await get('/assets/index-D9hMkoc5.js')
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(plain.headers.get('cache-control')).toBe(IMMUTABLE)
    expect(await plain.text()).toBe(script)
  })

  test('has index.html and the service worker checked every time', async () => {
    const index = await get('/', BROWSER)
    expect(index.headers.get('cache-control')).toBe(REVALIDATE)
    expect(index.headers.get('content-encoding')).toBe('br')
    expect(index.headers.get('content-type')).toContain('text/html')

    const worker = await get('/sw.js', BROWSER)
    expect(worker.headers.get('cache-control')).toBe(REVALIDATE)
  })

  test('answers an unchanged file with 304', async () => {
    const first = await get('/sw.js', BROWSER)
    const etag = first.headers.get('etag') ?? ''
    expect(etag).not.toBe('')

    const again = await get('/sw.js', { ...BROWSER, 'if-none-match': etag })
    expect(again.status).toBe(304)
    expect(again.headers.get('cache-control')).toBe(REVALIDATE)
  })

  test('opens the app’s own pages with index.html', async () => {
    const response = await get('/album/MPREb_1', {
      ...BROWSER,
      accept: 'text/html',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(REVALIDATE)
    expect(
      brotliDecompressSync(
        new Uint8Array(await response.arrayBuffer()),
      ).toString(),
    ).toBe(page)
  })

  test('leaves images and missing files to the static server', async () => {
    const icon = await get('/pwa-192x192.png', BROWSER)
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-encoding')).toBeNull()
    expect(icon.headers.get('cache-control')).toBe(REVALIDATE)

    expect((await get('/assets/missing.js', BROWSER)).status).toBe(404)
  })
})

describe('preferredEncoding', () => {
  test('prefers Brotli, then gzip, and skips refused ones', () => {
    expect(preferredEncoding('gzip, deflate, br')).toEqual(Option.some('br'))
    expect(preferredEncoding('br;q=0, gzip')).toEqual(Option.some('gzip'))
    expect(preferredEncoding('identity')).toEqual(Option.none())
    expect(preferredEncoding(undefined)).toEqual(Option.none())
  })
})
