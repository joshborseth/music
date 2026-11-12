import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import sharp from 'sharp'

import {
  backdropFromPixels,
  colorFromPixels,
  oklabToRgb,
  rgbToOklab,
} from './extract.ts'
import { samplePixels } from './service.ts'

type Rgb = readonly [number, number, number]

/** Packed pixels: each color repeated `count` times. */
const pixels = (...runs: ReadonlyArray<readonly [Rgb, number]>): Uint8Array =>
  Uint8Array.from(
    runs.flatMap(([color, count]) =>
      Array.from({ length: count }, () => color).flat(),
    ),
  )

const channels = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]

const near = (hex: string, [red, green, blue]: Rgb, tolerance = 6) => {
  const [r, g, b] = channels(hex)
  return (
    Math.abs(r - red) <= tolerance &&
    Math.abs(g - green) <= tolerance &&
    Math.abs(b - blue) <= tolerance
  )
}

describe('colorFromPixels', () => {
  test('round-trips sRGB through OKLab', () => {
    const colors: ReadonlyArray<Rgb> = [
      [255, 0, 0],
      [18, 129, 182],
      [139, 206, 0],
      [0, 0, 0],
      [255, 255, 255],
    ]
    for (const [red, green, blue] of colors) {
      expect(oklabToRgb(rgbToOklab(red, green, blue))).toEqual([
        red,
        green,
        blue,
      ])
    }
  })

  test('a single-color cover gives that color', () => {
    expect(colorFromPixels(pixels([[139, 206, 0], 2304]))).toBe('#8bce00')
  })

  test('black, white, and grey covers give no color', () => {
    expect(
      colorFromPixels(
        pixels(
          [[0, 0, 0], 1500],
          [[255, 255, 255], 500],
          [[128, 128, 128], 300],
        ),
      ),
    ).toBeNull()
  })

  test('a large colorful area beats a small brighter one', () => {
    const color = colorFromPixels(
      pixels([[20, 60, 160], 1600], [[250, 220, 20], 120], [[0, 0, 0], 584]),
    )
    expect(near(color ?? '', [20, 60, 160])).toBe(true)
  })

  test('a colored area beats a larger black one', () => {
    const color = colorFromPixels(
      pixels([[0, 0, 0], 1400], [[20, 60, 160], 900]),
    )
    expect(near(color ?? '', [20, 60, 160])).toBe(true)
  })

  test('merges shades that look alike', () => {
    const color = colorFromPixels(
      pixels(
        [[200, 30, 30], 1000],
        [[205, 34, 32], 1000],
        [[30, 200, 30], 20],
        [[255, 255, 255], 284],
      ),
    )
    expect(near(color ?? '', [202, 32, 31])).toBe(true)
  })

  test('the lights and the backdrop share one hue', () => {
    const rgb = pixels([[250, 200, 30], 1200], [[20, 60, 160], 1100])
    const color = rgbToOklab(...channels(colorFromPixels(rgb) ?? ''))
    const backdrop = rgbToOklab(...channels(backdropFromPixels(rgb) ?? ''))
    expect(
      Math.abs(
        Math.atan2(color.b, color.a) - Math.atan2(backdrop.b, backdrop.a),
      ),
    ).toBeLessThan(0.1)
  })

  test('an empty image gives no color', () => {
    expect(colorFromPixels(new Uint8Array())).toBeNull()
  })
})

describe('backdropFromPixels', () => {
  const lab = (hex: string) => rgbToOklab(...channels(hex))
  const hue = ({ a, b }: { a: number; b: number }) => Math.atan2(b, a)

  test('a bright cover gives a dark color of the same hue', () => {
    const backdrop = backdropFromPixels(pixels([[250, 200, 30], 2304])) ?? ''
    const color = lab(backdrop)
    expect(color.l).toBeLessThanOrEqual(0.365)
    expect(color.l).toBeGreaterThanOrEqual(0.235)
    expect(Math.hypot(color.a, color.b)).toBeGreaterThan(0.04)
    expect(Math.abs(hue(color) - hue(rgbToOklab(250, 200, 30)))).toBeLessThan(
      0.1,
    )
  })

  test('a colored area beats a larger black one', () => {
    const backdrop =
      backdropFromPixels(pixels([[0, 0, 0], 1400], [[20, 60, 160], 900])) ?? ''
    const color = lab(backdrop)
    expect(Math.abs(hue(color) - hue(rgbToOklab(20, 60, 160)))).toBeLessThan(
      0.1,
    )
  })

  test('a black-and-white cover gives a dark grey', () => {
    const backdrop =
      backdropFromPixels(pixels([[255, 255, 255], 1800], [[0, 0, 0], 504])) ??
      ''
    const [red, green, blue] = channels(backdrop)
    expect(
      Math.max(red, green, blue) - Math.min(red, green, blue),
    ).toBeLessThan(3)
    expect(lab(backdrop).l).toBeLessThanOrEqual(0.365)
  })

  test('an empty image gives no backdrop', () => {
    expect(backdropFromPixels(new Uint8Array())).toBeNull()
  })
})

describe('samplePixels', () => {
  test('trims the black bars off a letterboxed video thumbnail', async () => {
    // 480x360 with 45px black bars, like i.ytimg.com's hqdefault.
    const frame = await sharp({
      create: { width: 480, height: 360, channels: 3, background: '#000000' },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 480,
              height: 270,
              channels: 3,
              background: '#e03070',
            },
          })
            .png()
            .toBuffer(),
          top: 45,
          left: 0,
        },
      ])
      .jpeg()
      .toBuffer()
    const image = new Uint8Array(frame)
    const share = (rgb: Uint8Array) => {
      let matching = 0
      for (let offset = 0; offset + 2 < rgb.length; offset += 3) {
        if ((rgb[offset] ?? 0) > 100) matching++
      }
      return matching / (rgb.length / 3)
    }
    const trimmed = await Effect.runPromise(samplePixels(image, true))
    expect(colorFromPixels(trimmed)).toBe('#e03070')
    expect(share(trimmed)).toBeGreaterThan(0.95)
    const untrimmed = await Effect.runPromise(samplePixels(image, false))
    expect(share(untrimmed)).toBeLessThan(0.8)
  })
})
