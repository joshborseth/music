import { describe, expect, test } from 'bun:test'

import { SongDownload, pump, responseLength } from './songDownload.ts'

const collect = async (iterable: AsyncIterable<Uint8Array>) => {
  const pieces: Array<number> = []
  for await (const piece of iterable) pieces.push(...piece)
  return pieces
}

describe('SongDownload', () => {
  test('a reader gets its range as the bytes arrive', async () => {
    const download = new SongDownload(6)
    const reading = collect(download.read(1, 4))
    download.append(new Uint8Array([0, 1, 2]))
    await Promise.resolve()
    download.append(new Uint8Array([3, 4, 5]))
    download.finish()
    expect(await reading).toEqual([1, 2, 3, 4])
    expect(await download.finished).toBe(true)
  })

  test('a download that ends short fails its waiting readers', async () => {
    const download = new SongDownload(4)
    const reading = collect(download.read(0, 3))
    download.append(new Uint8Array([0, 1]))
    download.finish()
    expect(reading).rejects.toThrow()
    expect(await download.finished).toBe(false)
  })

  test('pump copies a response body', async () => {
    const download = new SongDownload(3)
    const body = new Response(new Uint8Array([7, 8, 9])).body
    if (body === null) throw new Error('no body')
    await pump(body, download)
    expect([...download.buffer]).toEqual([7, 8, 9])
  })

  test('responseLength reads content-length, then content-range', () => {
    expect(responseLength(new Headers({ 'content-length': '42' }))).toBe(42)
    expect(
      responseLength(new Headers({ 'content-range': 'bytes 0-9/100' })),
    ).toBe(10)
    expect(responseLength(new Headers())).toBeUndefined()
  })
})
