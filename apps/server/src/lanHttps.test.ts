import { afterAll, describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect, Layer, Option } from 'effect'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunServices } from '@effect/platform-bun'

import { LanTlsConfig } from './lanHttps.ts'

const dir = mkdtempSync(join(tmpdir(), 'music-lan-https-'))
const certPath = join(dir, 'server.crt')
const keyPath = join(dir, 'server.key')
writeFileSync(certPath, 'cert')
writeFileSync(keyPath, 'key')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const read = (config: Record<string, string>) =>
  Effect.runPromise(
    LanTlsConfig.pipe(
      Effect.provide(
        Layer.merge(
          BunServices.layer,
          ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
        ),
      ),
    ),
  )

describe('LanTlsConfig', () => {
  test('serves HTTPS when the port and both files are there', async () => {
    expect(
      await read({
        TLS_PORT: '4311',
        TLS_CERT_PATH: certPath,
        TLS_KEY_PATH: keyPath,
      }),
    ).toEqual(Option.some({ port: 4311, certPath, keyPath }))
  })

  test('serves plain HTTP alone when nothing is set', async () => {
    expect(await read({})).toEqual(Option.none())
  })

  test('serves plain HTTP alone when the certificate is missing', async () => {
    expect(
      await read({
        TLS_PORT: '4311',
        TLS_CERT_PATH: join(dir, 'missing.crt'),
        TLS_KEY_PATH: keyPath,
      }),
    ).toEqual(Option.none())
  })
})
