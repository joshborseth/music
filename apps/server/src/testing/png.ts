import { deflateSync } from 'node:zlib'

/*
 * PNGs for tests, written the way an encoder writes them, so the reader in
 * `tvFrame.ts` meets every scanline filter.
 */

export const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** A chunk with its length and type. The reader skips the CRC. */
const chunk = (type: string, data: Uint8Array): ReadonlyArray<number> => [
  (data.byteLength >>> 24) & 0xff,
  (data.byteLength >>> 16) & 0xff,
  (data.byteLength >>> 8) & 0xff,
  data.byteLength & 0xff,
  ...Array.from(type, letter => letter.charCodeAt(0)),
  ...data,
  0,
  0,
  0,
  0,
]

const paeth = (left: number, up: number, upLeft: number): number => {
  const estimate = left + up - upLeft
  const [toLeft, toUp, toUpLeft] = [left, up, upLeft].map(value =>
    Math.abs(estimate - value),
  )
  if (toLeft! <= toUp! && toLeft! <= toUpLeft!) return left
  return toUp! <= toUpLeft! ? up : upLeft
}

/**
 * An 8-bit PNG of `width` × `height` pixels of `channels` bytes each, from
 * `pixel(x, y)`. Each row uses the next of the five filters, as encoders do.
 */
export const encodePng = (
  width: number,
  height: number,
  channels: 3 | 4,
  pixel: (x: number, y: number) => ReadonlyArray<number>,
): Uint8Array<ArrayBuffer> => {
  const stride = width * channels
  const rows = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => pixel(x, y)).flat(),
  )
  const filtered = rows.flatMap((row, y) => {
    const filter = y % 5
    const above = rows[y - 1] ?? new Array<number>(stride).fill(0)
    return [
      filter,
      ...row.map((value, index) => {
        const left = index >= channels ? row[index - channels]! : 0
        const up = above[index]!
        const upLeft = index >= channels ? above[index - channels]! : 0
        const predicted = [
          0,
          left,
          up,
          Math.floor((left + up) / 2),
          paeth(left, up, upLeft),
        ][filter]!
        return (value - predicted) & 0xff
      }),
    ]
  })
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8)
  return new Uint8Array([
    ...PNG_SIGNATURE,
    ...chunk('IHDR', header),
    ...chunk('IDAT', deflateSync(new Uint8Array(filtered))),
    ...chunk('IEND', new Uint8Array()),
  ])
}
